import Citadel
import NIOCore
import SwiftUI
import WebKit

/// A live terminal on a herdr pane: the server streams the visible screen (`hollr gate term`),
/// xterm.js draws it, typing goes back. Its own SSH connection, like a live call.
@MainActor
@Observable
final class TerminalSession {
    enum Phase: Equatable { case connecting, open, closed(String?) }
    /// pane: the herdr pane itself, natively (`attach`: herdr's attach in a PTY sized to the phone,
    /// like Heeler – older servers: screen snapshots via `term`) · shell: the phone's own shell
    enum Mode: String { case pane, shell }

    /// screen snapshots (`term`) instead of the native attach – kept for wide-screen viewing
    private(set) var legacy = false
    /// a raw terminal stream (attach / shell) – sized by the phone, output written as it comes
    var streams: Bool { mode == .shell || !legacy }

    let ref: AgentRef
    let mode: Mode
    /// shell output (a raw stream for xterm)
    @ObservationIgnored var onOutput: ((String) -> Void)?
    @ObservationIgnored private var size = (cols: 80, rows: 24)
    private(set) var phase: Phase = .connecting
    /// latest screen (ANSI) with its size
    private(set) var screen: (ansi: String, rows: Int, cols: Int)?
    @ObservationIgnored private var task: Task<Void, Never>?
    @ObservationIgnored private var outgoing: AsyncStream<Data>.Continuation?

    init(ref: AgentRef, mode: Mode = .pane) {
        self.ref = ref
        self.mode = mode
    }

    /// shell: starts with the size the phone's terminal has; later sizes resize the PTY
    func resize(cols: Int, rows: Int) {
        let first = size == (80, 24) && task == nil
        size = (cols, rows)
        if streams {
            if first { start() } else { send(["t": "resize", "cols": cols, "rows": rows]) }
        }
    }

    func start() {
        guard task == nil else { return }
        phase = .connecting
        task = Task { await run() }
    }

    func stop() {
        task?.cancel()
        task = nil
        outgoing?.finish()
    }

    func type(_ text: String) {
        send(streams ? ["t": "in", "d": text] : ["t": "text", "text": text])
    }
    func keys(_ keys: [String]) { send(["t": "keys", "keys": keys]) }

    private func send(_ msg: [String: Any]) {
        guard var data = try? JSONSerialization.data(withJSONObject: msg) else { return }
        data.append(0x0a)
        outgoing?.yield(data)
    }

    private func run() async {
        let (stream, continuation) = AsyncStream<Data>.makeStream()
        outgoing = continuation
        do {
            let client = try await HollrClient.connect(ref.server)
            defer { Task { try? await client.close() } }
            let pane = ref.pane.pane
            let command = mode == .shell ? "shell \(pane) \(size.cols) \(size.rows)"
                : legacy ? "term \(pane)" : "attach \(pane) \(size.cols) \(size.rows)"
            try await client.withExec(command) { inbound, outbound in
                let writer = Task {
                    for await chunk in stream { try? await outbound.write(ByteBuffer(bytes: chunk)) }
                }
                defer { writer.cancel() }
                var buffer = Data()
                for try await output in inbound {
                    guard case .stdout(let bytes) = output else { continue }
                    buffer.append(contentsOf: bytes.readableBytesView)
                    while let nl = buffer.firstIndex(of: 0x0a) {
                        let line = buffer[buffer.startIndex..<nl]
                        buffer.removeSubrange(buffer.startIndex...nl)
                        guard let obj = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else { continue }
                        await MainActor.run { self.handle(obj) }
                    }
                }
            }
            if case .closed = phase {} else { phase = .closed(nil) }
        } catch is CancellationError {
            phase = .closed(nil)
        } catch {
            phase = .closed(error.localizedDescription)
        }
    }

    private func handle(_ obj: [String: Any]) {
        switch obj["t"] as? String {
        case "screen":
            screen = (obj["ansi"] as? String ?? "", obj["rows"] as? Int ?? 24, obj["cols"] as? Int ?? 80)
            phase = .open
        case "out":
            if let d = obj["d"] as? String { onOutput?(d) }
            phase = .open
        case "exit":
            phase = .closed(String(localized: "Shell beendet."))
        case "error":
            phase = .closed(obj["error"] as? String == "not_found"
                            ? String(localized: "Die Session gibt es nicht mehr.") : obj["error"] as? String)
        case nil where obj["error"] as? String == "not_allowed":
            // older server without `attach` / `shell`
            phase = .closed(String(localized: "Hollr auf dem Server ist zu alt – unter Server › Werkzeuge aktualisieren."))
        case "closed":
            phase = .closed(String(localized: "Die Sitzung wurde geschlossen."))
        default:
            break
        }
    }
}

/// Full screen terminal (chat menu › Terminal).
struct TerminalScreen: View {
    let ref: AgentRef
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            TerminalPanel(ref: ref, showsToolbar: true)
                .navigationTitle(ref.title)
                .navigationBarTitleDisplayMode(.inline)
                .toolbarBackground(.visible, for: .navigationBar)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Fertig") { dismiss() } }
                }
        }
        .preferredColorScheme(.dark)
    }
}

/// The terminal itself – full screen or next to the chat (iPhone in landscape): the session's pane,
/// or the phone's own shell in the same folder (sized to the phone, scrolls).
struct TerminalPanel: View {
    let ref: AgentRef
    var showsToolbar = false
    @AppStorage("terminal.mode") private var mode = TerminalSession.Mode.pane.rawValue

    var body: some View {
        VStack(spacing: 0) {
            Picker("Terminal", selection: $mode) {
                Text("Session").tag(TerminalSession.Mode.pane.rawValue)
                Text("Eigene Shell").tag(TerminalSession.Mode.shell.rawValue)
            }
            .pickerStyle(.segmented)
            .padding(.horizontal, 8).padding(.vertical, 5)
            TerminalBody(ref: ref, mode: TerminalSession.Mode(rawValue: mode) ?? .pane, showsToolbar: showsToolbar)
                .id(mode)
        }
        .background(Color(red: 0.06, green: 0.07, blue: 0.09))
    }
}

private struct TerminalBody: View {
    let ref: AgentRef
    let mode: TerminalSession.Mode
    var showsToolbar = false
    @State private var session: TerminalSession
    @State private var ctrl = false
    @State private var keyboard = false
    /// bumped on every tap: the web view takes the focus, the key input takes it back
    @State private var focusRequest = 0
    @State private var web = TerminalWeb()
    /// wide panes (a Mac terminal: 200+ columns) start readable: ~100 columns fill the width
    @AppStorage("terminal.readable") private var readable = true

    /// inside the chat: display only (the composer below types, keys come from its menu)
    var embedded = false

    init(ref: AgentRef, mode: TerminalSession.Mode, showsToolbar: Bool, embedded: Bool = false) {
        self.ref = ref
        self.mode = mode
        self.showsToolbar = showsToolbar
        self.embedded = embedded
        _session = State(initialValue: TerminalSession(ref: ref, mode: mode))
    }

    var body: some View {
        VStack(spacing: 0) {
            ZStack(alignment: .topTrailing) {
                // the native key input sits behind the terminal: typing, paste and dictation go through it
                TerminalKeyInput(focused: keyboard, request: focusRequest) { text in
                    var out = text
                    if ctrl, out.count == 1, let scalar = out.uppercased().unicodeScalars.first,
                       (64...95).contains(scalar.value) {
                        out = String(UnicodeScalar(scalar.value - 64)!)
                        ctrl = false
                    }
                    session.type(out)
                }
                .frame(width: 1, height: 1)
                .opacity(0.01)
                TerminalWebView(web: web, onInput: { session.type($0) }, onCtrlUsed: { ctrl = false },
                                onSize: { session.resize(cols: $0, rows: $1) })
                switch session.phase {
                case .connecting:
                    ProgressView("Verbinde …").tint(.white).foregroundStyle(.white)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                case let .closed(message):
                    VStack(spacing: 10) {
                        Text(message ?? String(localized: "Verbindung beendet.")).foregroundStyle(.white.opacity(0.8))
                        Button("Neu verbinden") { session.stop(); session.start() }.buttonStyle(.borderedProminent)
                    }
                    .padding()
                    .background(.black.opacity(0.6), in: RoundedRectangle(cornerRadius: 14))
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                case .open:
                    if !showsToolbar && !embedded { overlayButtons.padding(8) }
                }
            }
            if !embedded || keyboard { keyBar }
        }
        .background(Color(red: 0.06, green: 0.07, blue: 0.09))
        .toolbar {
            if showsToolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button { keyboard.toggle() } label: { Image(systemName: keyboard ? "keyboard.chevron.compact.down" : "keyboard") }.accessibilityLabel("Tastatur")
                }
                if mode == .pane, (session.screen?.cols ?? 0) > 120 {
                    ToolbarItem(placement: .primaryAction) { readableButton }
                }
            }
        }
        .onAppear {
            if session.streams {
                // starts once the terminal knows its size (TerminalWeb → onSize)
                session.onOutput = { [web] in web.write($0) }
                web.shellMode()
            } else {
                session.start()
            }
        }
        .onDisappear { session.stop() }
        // a tap on the terminal brings up the keyboard
        .simultaneousGesture(TapGesture().onEnded {
            // in the chat a tap is for scrolling and links – the keyboard button types into the TUI
            guard !embedded else { return }
            keyboard = true
            focusRequest += 1
        })
        .onChange(of: session.screen?.ansi) { _, _ in
            if let s = session.screen { web.render(s.ansi, rows: s.rows, cols: s.cols) }
        }
        .onChange(of: ctrl) { _, on in web.armCtrl(on) }
        .onChange(of: readable, initial: true) { _, on in web.setReadable(on ? 100 : 0) }
    }

    private var readableButton: some View {
        Button { readable.toggle() } label: {
            Image(systemName: readable ? "arrow.left.and.right.square" : "textformat.size.larger")
        }
        .accessibilityLabel(readable ? "Ganze Breite zeigen" : "Lesbar (Ausschnitt)")
    }

    /// embedded (no navigation bar): keyboard and readable as small floating buttons
    private var overlayButtons: some View {
        HStack(spacing: 6) {
            if mode == .pane, (session.screen?.cols ?? 0) > 120 { readableButton }
            Button { keyboard.toggle() } label: { Image(systemName: keyboard ? "keyboard.chevron.compact.down" : "keyboard") }.accessibilityLabel("Tastatur")
        }
        .font(.footnote)
        .padding(6)
        .background(.ultraThinMaterial, in: Capsule())
        .foregroundStyle(.white)
    }

    /// Moshi-style row above the keyboard: the keys a phone keyboard doesn't have.
    private var keyBar: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                key("esc") { session.type("\u{1b}") }
                key("tab") { session.type("\t") }
                key("ctrl", on: ctrl) { ctrl.toggle() }
                key("^C") { session.type("\u{03}") }
                key("↑") { session.type("\u{1b}[A") }
                key("↓") { session.type("\u{1b}[B") }
                key("←") { session.type("\u{1b}[D") }
                key("→") { session.type("\u{1b}[C") }
                key("|") { session.type("|") }
                key("~") { session.type("~") }
                key("/") { session.type("/") }
                key("-") { session.type("-") }
                key("⏎") { session.type("\r") }
            }
            .padding(.horizontal, 8).padding(.vertical, 6)
        }
        .background(.ultraThinMaterial)
    }

    private func key(_ title: String, on: Bool = false, action: @escaping () -> Void) -> some View {
        Button {
            Haptics.tap(.light)
            action()
        } label: {
            Text(title)
                .font(.system(.callout, design: .monospaced).weight(.medium))
                .frame(minWidth: 38, minHeight: 34)
                .padding(.horizontal, 4)
                .background(on ? Theme.accent : Color.white.opacity(0.12), in: RoundedRectangle(cornerRadius: 8))
                .foregroundStyle(on ? Theme.onAccent : .white)
        }
        .buttonStyle(.plain)
    }
}

/// The WKWebView with xterm.js (Resources/Terminal) – drawn screens in, typed text out.
@MainActor
final class TerminalWeb {
    let view: WKWebView
    private var ready = false
    private var pending: (String, Int, Int)?
    private var readCols = 100
    fileprivate var onInput: (String) -> Void = { _ in }
    fileprivate var onCtrlUsed: () -> Void = {}
    fileprivate var onSize: (Int, Int) -> Void = { _, _ in }
    private var wantsShell = false
    private let bridge = Bridge()

    init() {
        let config = WKWebViewConfiguration()
        config.userContentController.add(bridge, name: "input")
        config.userContentController.add(bridge, name: "ready")
        config.userContentController.add(bridge, name: "ctrlUsed")
        config.userContentController.add(bridge, name: "size")
        view = WKWebView(frame: .zero, configuration: config)
        view.isOpaque = false
        view.backgroundColor = .clear
        // wide panes (a Mac terminal has 200+ columns): pinch to zoom into a part, drag to move
        view.scrollView.isScrollEnabled = true
        view.scrollView.bounces = false
        view.scrollView.maximumZoomScale = 6
        bridge.owner = self
        if let url = Bundle.main.url(forResource: "terminal", withExtension: "html") {
            view.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
        }
    }

    func render(_ ansi: String, rows: Int, cols: Int) {
        guard ready else { pending = (ansi, rows, cols); return }
        guard let json = try? JSONSerialization.data(withJSONObject: [ansi]),
              let arg = String(data: json, encoding: .utf8) else { return }
        view.evaluateJavaScript("render(\(arg)[0], \(rows), \(cols))")
    }

    func shellMode() {
        wantsShell = true
        if ready { view.evaluateJavaScript("shellMode()") }
    }

    func write(_ data: String) {
        guard let json = try? JSONSerialization.data(withJSONObject: [data]),
              let arg = String(data: json, encoding: .utf8) else { return }
        view.evaluateJavaScript("writeRaw(\(arg)[0])")
    }

    func armCtrl(_ on: Bool) { view.evaluateJavaScript("armCtrl(\(on))") }
    func setReadable(_ cols: Int) {
        readCols = cols
        if ready { view.evaluateJavaScript("setReadable(\(cols))") }
    }
    func focus() { view.evaluateJavaScript("focusTerm()") }

    fileprivate func received(_ name: String, _ body: Any) {
        switch name {
        case "ready":
            ready = true
            view.evaluateJavaScript(wantsShell ? "shellMode()" : "setReadable(\(readCols))")
            if let p = pending { render(p.0, rows: p.1, cols: p.2); pending = nil }
        case "input":
            if let text = body as? String {
                #if DEBUG
                HollrLog.info("terminal input: \(text.debugDescription.prefix(80))")
                #endif
                onInput(text)
            }
        case "ctrlUsed":
            onCtrlUsed()
        case "size":
            if let d = body as? [String: Any], let c = d["cols"] as? Int, let r = d["rows"] as? Int { onSize(c, r) }
        default:
            break
        }
    }

    private final class Bridge: NSObject, WKScriptMessageHandler {
        weak var owner: TerminalWeb?
        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            let name = message.name, body = message.body
            MainActor.assumeIsolated { owner?.received(name, body) }
        }
    }
}

private struct TerminalWebView: UIViewRepresentable {
    let web: TerminalWeb
    let onInput: (String) -> Void
    let onCtrlUsed: () -> Void
    var onSize: (Int, Int) -> Void = { _, _ in }

    func makeUIView(context: Context) -> WKWebView {
        web.onInput = onInput
        web.onCtrlUsed = onCtrlUsed
        web.onSize = onSize
        return web.view
    }

    func updateUIView(_ view: WKWebView, context: Context) {
        web.onInput = onInput
        web.onCtrlUsed = onCtrlUsed
        web.onSize = onSize
    }
}

/// Native keyboard input for the terminal (a WKWebView's hidden textarea drops pasted and dictated
/// text): every typed character, paste and delete goes straight to the shell.
private struct TerminalKeyInput: UIViewRepresentable {
    let focused: Bool
    let request: Int
    let onText: (String) -> Void

    func makeUIView(context: Context) -> KeyInputView {
        let view = KeyInputView()
        view.onText = onText
        return view
    }

    func updateUIView(_ view: KeyInputView, context: Context) {
        view.onText = onText
        // after the web view has handled the tap
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
            if focused, !view.isFirstResponder {
                let ok = view.becomeFirstResponder()
                #if DEBUG
                HollrLog.info("terminal keyboard: first responder \(ok)")
                #endif
            }
            if !focused, view.isFirstResponder { view.resignFirstResponder() }
        }
    }

    /// A hidden text field: typing, paste, dictation and accessibility input all arrive as text
    /// changes; each change goes to the shell and the field is emptied again.
    final class KeyInputView: UITextField, UITextFieldDelegate {
        var onText: (String) -> Void = { _ in }

        override init(frame: CGRect) {
            super.init(frame: frame)
            delegate = self
            autocorrectionType = .no
            autocapitalizationType = .none
            spellCheckingType = .no
            smartQuotesType = .no
            smartDashesType = .no
            smartInsertDeleteType = .no
            keyboardAppearance = .dark
            keyboardType = .asciiCapable
            returnKeyType = .default
            tintColor = .clear
            textColor = .clear
            addTarget(self, action: #selector(changed), for: .editingChanged)
        }

        required init?(coder: NSCoder) { fatalError() }

        @objc private func changed() {
            guard let typed = text, !typed.isEmpty else { return }
            text = ""
            #if DEBUG
            HollrLog.info("terminal key input: \(typed.debugDescription.prefix(60))")
            #endif
            onText(typed.replacingOccurrences(of: "\r\n", with: "\r").replacingOccurrences(of: "\n", with: "\r"))
        }

        // set from outside (accessibility, automation) – not an edit event
        override var text: String? {
            didSet {
                if let t = text, !t.isEmpty { DispatchQueue.main.async { self.changed() } }
            }
        }

        /// backspace on the (always empty) field
        override func deleteBackward() {
            onText("\u{7f}")
        }

        func textFieldShouldReturn(_ textField: UITextField) -> Bool {
            onText("\r")
            return false
        }
    }
}

/// The agent's own terminal inside the chat (Chat | Terminal): its real TUI at the phone's width.
struct AgentTerminalView: View {
    let ref: AgentRef

    var body: some View {
        TerminalBody(ref: ref, mode: .pane, showsToolbar: false, embedded: true)
            .id(ref.id)
    }
}
