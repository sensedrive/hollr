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

    let ref: AgentRef
    private(set) var phase: Phase = .connecting
    /// latest screen (ANSI) with its size
    private(set) var screen: (ansi: String, rows: Int, cols: Int)?
    @ObservationIgnored private var task: Task<Void, Never>?
    @ObservationIgnored private var outgoing: AsyncStream<Data>.Continuation?

    init(ref: AgentRef) { self.ref = ref }

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

    func type(_ text: String) { send(["t": "text", "text": text]) }
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
            try await client.withExec("term \(ref.pane.pane)") { inbound, outbound in
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
        case "error":
            phase = .closed(obj["error"] as? String)
        case "closed":
            phase = .closed(String(localized: "Die Sitzung wurde geschlossen."))
        default:
            break
        }
    }
}

struct TerminalScreen: View {
    let ref: AgentRef
    @Environment(\.dismiss) private var dismiss
    @State private var session: TerminalSession
    @State private var ctrl = false
    @State private var web = TerminalWeb()

    init(ref: AgentRef) {
        self.ref = ref
        _session = State(initialValue: TerminalSession(ref: ref))
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                ZStack {
                    TerminalWebView(web: web, onInput: { session.type($0) }, onCtrlUsed: { ctrl = false })
                    switch session.phase {
                    case .connecting:
                        ProgressView("Verbinde …").tint(.white).foregroundStyle(.white)
                    case let .closed(message):
                        VStack(spacing: 10) {
                            Text(message ?? String(localized: "Verbindung beendet.")).foregroundStyle(.white.opacity(0.8))
                            Button("Neu verbinden") { session.stop(); session.start() }.buttonStyle(.borderedProminent)
                        }
                        .padding()
                        .background(.black.opacity(0.6), in: RoundedRectangle(cornerRadius: 14))
                    case .open:
                        EmptyView()
                    }
                }
                keyBar
            }
            .background(Color(red: 0.06, green: 0.07, blue: 0.09))
            .navigationTitle(ref.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(.visible, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Fertig") { dismiss() } }
                ToolbarItem(placement: .primaryAction) {
                    Button { web.focus() } label: { Image(systemName: "keyboard") }.accessibilityLabel("Tastatur")
                }
            }
        }
        .preferredColorScheme(.dark)
        .onAppear { session.start() }
        .onDisappear { session.stop() }
        .onChange(of: session.screen?.ansi) { _, _ in
            if let s = session.screen { web.render(s.ansi, rows: s.rows, cols: s.cols) }
        }
        .onChange(of: ctrl) { _, on in web.armCtrl(on) }
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
    fileprivate var onInput: (String) -> Void = { _ in }
    fileprivate var onCtrlUsed: () -> Void = {}
    private let bridge = Bridge()

    init() {
        let config = WKWebViewConfiguration()
        config.userContentController.add(bridge, name: "input")
        config.userContentController.add(bridge, name: "ready")
        config.userContentController.add(bridge, name: "ctrlUsed")
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

    func armCtrl(_ on: Bool) { view.evaluateJavaScript("armCtrl(\(on))") }
    func focus() { view.evaluateJavaScript("focusTerm()") }

    fileprivate func received(_ name: String, _ body: Any) {
        switch name {
        case "ready":
            ready = true
            if let p = pending { render(p.0, rows: p.1, cols: p.2); pending = nil }
        case "input":
            if let text = body as? String { onInput(text) }
        case "ctrlUsed":
            onCtrlUsed()
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

    func makeUIView(context: Context) -> WKWebView {
        web.onInput = onInput
        web.onCtrlUsed = onCtrlUsed
        return web.view
    }

    func updateUIView(_ view: WKWebView, context: Context) {
        web.onInput = onInput
        web.onCtrlUsed = onCtrlUsed
    }
}
