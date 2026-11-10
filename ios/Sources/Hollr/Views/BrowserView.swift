import SwiftUI
import WebKit

/// In-app browser (WKWebView). Public pages load directly; `localhost:…` pages are
/// fetched from the paired server through its SSH connection (see TunnelManager).
struct BrowserView: View {
    @State private var model: BrowserModel
    @Environment(\.dismiss) private var dismiss
    @Environment(ServerStore.self) private var store
    @FocusState private var addressFocused: Bool

    init(url: URL?) {
        _model = State(initialValue: BrowserModel(start: url))
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                if model.progress < 1 {
                    ProgressView(value: model.progress).tint(Theme.accent).frame(height: 2)
                }
                if let error = model.error {
                    Label(error, icon: .alert)
                        .font(Typo.note).foregroundStyle(Theme.warn)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, Gap.l).padding(.vertical, Gap.s)
                        .background(Theme.warn.opacity(0.12))
                }
                if model.current == nil && !addressFocused {
                    BrowserStart(model: model)
                } else {
                    WebViewHost(model: model)
                }
            }
            .safeAreaInset(edge: .bottom) { toolbar }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) { addressBar }
                ToolbarItem(placement: .topBarLeading) {
                    Button("Fertig") { dismiss() }
                }
            }
        }
        .task { model.configure(servers: store.servers) }
    }

    private var addressBar: some View {
        HStack(spacing: 6) {
            if model.tunneled, let server = model.server {
                IconView(.server, size: 14)
                    .foregroundStyle(Theme.live)
                    .accessibilityLabel("Über \(server.label)")
            }
            TextField("URL oder localhost:3000", text: $model.address)
                .keyboardType(.webSearch)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.go)
                .focused($addressFocused)
                .onSubmit { model.load(model.address) }
        }
        .fieldStyle(focused: addressFocused, radius: Radius.row)
        .frame(minWidth: 220)
    }

    private var toolbar: some View {
        HStack {
            toolButton(HIcon.chevronLeft.symbol, disabled: !model.canGoBack) { model.webView.goBack() }
            Spacer()
            toolButton(HIcon.chevronRight.symbol, disabled: !model.canGoForward) { model.webView.goForward() }
            Spacer()
            toolButton(HIcon.refresh.symbol, disabled: model.current == nil) { model.reload() }
            Spacer()
            if let url = model.current {
                ShareLink(item: url) { Image(systemName: "square.and.arrow.up") }
                    .buttonStyle(.icon())
                Spacer()
                // Safari can't reach the server's localhost
                toolButton("safari", disabled: model.tunneled) { UIApplication.shared.open(url) }
                    .accessibilityLabel("In Safari öffnen")
            } else {
                toolButton("square.and.arrow.up", disabled: true) {}
                Spacer()
                toolButton("safari", disabled: true) {}
                    .accessibilityLabel("In Safari öffnen")
            }
        }
        .padding(.horizontal, Gap.l).padding(.vertical, Gap.xs)
        .background(Theme.side)
        .overlay(alignment: .top) { Rectangle().fill(Theme.border).frame(height: 1) }
    }

    private func toolButton(_ symbol: String, disabled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) { Image(systemName: symbol) }
            .buttonStyle(.icon())
            .disabled(disabled)
            .opacity(disabled ? 0.4 : 1)
    }
}

/// Start page: web services running on the server, recent pages.
private struct BrowserStart: View {
    @Bindable var model: BrowserModel
    @AppStorage("browser.recent") private var recentRaw = ""
    @State private var ports: [WebPort] = []
    @State private var loading = false

    var body: some View {
        let recent = recentRaw.split(separator: "\n").map(String.init)
        List {
            Group {
            if model.servers.count > 1 {
                Picker("localhost auf", selection: Binding(get: { model.server?.id }, set: { id in
                    model.server = model.servers.first { $0.id == id }
                })) {
                    ForEach(model.servers) { Text($0.label).tag(Optional($0.id)) }
                }
            }
            if let server = model.server {
                Section {
                    if ports.isEmpty {
                        HStack(spacing: Gap.s) {
                            if loading { Spinner(color: Theme.muted) }
                            Text(loading ? String(localized: "Suche Web-Dienste …") : String(localized: "Gerade läuft dort kein Web-Dienst auf localhost."))
                        }
                        .foregroundStyle(Theme.muted)
                    }
                    ForEach(ports) { port in
                        Button { model.load("http://localhost:\(port.port)") } label: {
                            HStack(spacing: Gap.m) {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(port.label).font(Typo.md).foregroundStyle(Theme.fg).lineLimit(1)
                                    Text([port.process, port.cwd.map { ($0 as NSString).abbreviatingWithTildeInPath }]
                                        .compactMap { $0 }.joined(separator: " · "))
                                        .font(Typo.sm).foregroundStyle(Theme.muted).lineLimit(1)
                                }
                                Spacer()
                                Text(verbatim: ":\(port.port)").font(Typo.mono).foregroundStyle(Theme.live)
                            }
                        }
                    }
                } header: {
                    Text("Auf \(server.label)")
                } footer: {
                    Text("localhost-Adressen öffnet Hollr über die SSH-Verbindung zum Server.")
                }
                .task(id: server.id) {
                    loading = true
                    ports = (try? await HollrClient.ports(server)) ?? []
                    loading = false
                }
            }
            if !recent.isEmpty {
                Section("Zuletzt") {
                    ForEach(recent, id: \.self) { url in
                        Button { model.load(url) } label: {
                            Label(url, icon: .globe).font(Typo.md).foregroundStyle(Theme.fg)
                                .lineLimit(1).truncationMode(.middle)
                        }
                    }
                }
            }
        }
            .listRowBackground(Theme.card)
        }.themedList()
        .refreshable {
            if let server = model.server { ports = (try? await HollrClient.ports(server)) ?? [] }
        }
    }
}

@Observable @MainActor
final class BrowserModel: NSObject, WKNavigationDelegate, WKUIDelegate {
    let webView: WKWebView
    var address = ""
    /// the page as the user knows it (localhost:3000/… for tunneled pages)
    var current: URL?
    var progress: Double = 1
    var canGoBack = false
    var canGoForward = false
    var error: String?
    var servers: [Server] = []
    var server: Server?
    /// phone port → server port
    private var tunnels: [Int: Int] = [:]
    private var start: URL?
    private var observers: [NSKeyValueObservation] = []
    /// false: pages aren't added to the recent list (plugin URLs carry a token)
    private let remembers: Bool

    var tunneled: Bool { current.map(ServerLocal.isLoopback) ?? false }

    /// `popupsOutside`: window.open / target=_blank to public pages opens Safari (embedded plugin UIs)
    init(start: URL?, remembers: Bool = true, popupsOutside: Bool = false) {
        self.start = start
        self.remembers = remembers
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        webView = WKWebView(frame: .zero, configuration: config)
        webView.allowsBackForwardNavigationGestures = true
        webView.isInspectable = true
        super.init()
        webView.navigationDelegate = self
        if popupsOutside { webView.uiDelegate = self }
        observers = [
            webView.observe(\.estimatedProgress) { [weak self] view, _ in
                Task { @MainActor in self?.progress = view.isLoading ? view.estimatedProgress : 1 }
            },
            webView.observe(\.url) { [weak self] view, _ in
                Task { @MainActor in self?.sync(view) }
            },
            webView.observe(\.canGoBack) { [weak self] view, _ in
                Task { @MainActor in self?.canGoBack = view.canGoBack }
            },
            webView.observe(\.canGoForward) { [weak self] view, _ in
                Task { @MainActor in self?.canGoForward = view.canGoForward }
            },
        ]
    }

    func configure(servers: [Server]) {
        self.servers = servers
        if server == nil { server = servers.first }
        if let start {
            self.start = nil
            open(start)
        }
    }

    func load(_ input: String) {
        guard let url = Self.url(from: input) else { return }
        open(url)
    }

    func reload() {
        if webView.url == nil, let current { open(current) } else { webView.reload() }
    }

    func open(_ url: URL) {
        error = nil
        current = url
        address = Self.display(url)
        if remembers { remember(url) }
        guard ServerLocal.isLoopback(url) else {
            webView.load(URLRequest(url: url))
            return
        }
        guard let server else {
            error = String(localized: "Für localhost-Adressen zuerst einen Server koppeln.")
            return
        }
        let remotePort = ServerLocal.port(url)
        Task {
            do {
                let local = try await TunnelManager.shared.localPort(server: server, remotePort: remotePort)
                tunnels[local] = remotePort
                var parts = URLComponents(url: url, resolvingAgainstBaseURL: false)
                parts?.host = "127.0.0.1"
                parts?.port = local
                if let target = parts?.url { webView.load(URLRequest(url: target)) }
            } catch {
                self.error = String(localized: "Verbindung zu \(server.label) fehlgeschlagen: \(error.localizedDescription)")
            }
        }
    }

    /// Shows tunneled pages under their server address again (127.0.0.1:local → localhost:remote).
    private func sync(_ view: WKWebView) {
        guard var url = view.url else { return }
        if url.host() == "127.0.0.1", let port = url.port, let remote = tunnels[port],
           var parts = URLComponents(url: url, resolvingAgainstBaseURL: false) {
            parts.host = "localhost"
            parts.port = remote
            url = parts.url ?? url
        }
        current = url
        address = Self.display(url)
    }

    static func display(_ url: URL) -> String {
        ServerLocal.isLoopback(url) ? url.absoluteString.replacingOccurrences(of: "http://", with: "") : url.absoluteString
    }

    private func remember(_ url: URL) {
        let key = "browser.recent"
        var list = (UserDefaults.standard.string(forKey: key) ?? "").split(separator: "\n").map(String.init)
        list.removeAll { $0 == url.absoluteString }
        list.insert(url.absoluteString, at: 0)
        UserDefaults.standard.set(list.prefix(12).joined(separator: "\n"), forKey: key)
    }

    // MARK: WKNavigationDelegate

    /// Links inside a server page to other localhost ports go through the tunnel too.
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
        guard let url = action.request.url, ServerLocal.isLoopback(url) else { return .allow }
        if url.host() == "127.0.0.1", let port = url.port, tunnels[port] != nil { return .allow }
        open(url)
        return .cancel
    }

    // MARK: WKUIDelegate (only with popupsOutside)

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url, let scheme = url.scheme?.lowercased(), ["http", "https"].contains(scheme),
           !ServerLocal.isLoopback(url) {
            UIApplication.shared.open(url)
        }
        return nil
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        report(error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        report(error)
    }

    private func report(_ error: Error) {
        let ns = error as NSError
        if ns.code == NSURLErrorCancelled { return }
        if tunneled, let current {
            self.error = String(localized: "Auf \(server?.label ?? "dem Server") antwortet nichts auf Port \(ServerLocal.port(current)).")
        } else {
            self.error = error.localizedDescription
        }
    }

    /// "example.com" → https, "localhost:3000" → http, other text → search.
    static func url(from input: String) -> URL? {
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        if let url = URL(string: text), let scheme = url.scheme, ["http", "https"].contains(scheme.lowercased()) {
            return url
        }
        if let port = Int(text.trimmingCharacters(in: CharacterSet(charactersIn: ":"))), (1...65535).contains(port) {
            return URL(string: "http://localhost:\(port)")
        }
        let local = text.hasPrefix("localhost") || text.hasPrefix("127.0.0.1") || text.range(of: #"^\d+\.\d+\.\d+\.\d+"#, options: .regularExpression) != nil
        if !text.contains(" "), text.contains(".") || text.contains(":") {
            return URL(string: (local ? "http://" : "https://") + text)
        }
        var search = URLComponents(string: "https://duckduckgo.com/")!
        search.queryItems = [URLQueryItem(name: "q", value: text)]
        return search.url
    }
}

struct WebViewHost: UIViewRepresentable {
    let model: BrowserModel
    func makeUIView(context: Context) -> WKWebView { model.webView }
    func updateUIView(_ view: WKWebView, context: Context) {}
}

// MARK: - Link handling (chat links ask: Hollr browser or Safari)

/// Put at the root: every link tapped in the app asks where to open it.
struct LinkChooser: ViewModifier {
    @State private var pending: URL?
    @State private var browserURL: BrowserTarget?

    func body(content: Content) -> some View {
        content
            .environment(\.openURL, OpenURLAction { url in
                guard ["http", "https"].contains(url.scheme?.lowercased() ?? "") else { return .systemAction }
                pending = url
                return .handled
            })
            .environment(\.openInBrowser, OpenInBrowser { browserURL = BrowserTarget(url: $0) })
            .confirmationDialog(pending?.host() ?? "Link", isPresented: Binding(get: { pending != nil }, set: { if !$0 { pending = nil } }),
                                titleVisibility: .visible, presenting: pending) { url in
                Button("Im Hollr-Browser") { browserURL = BrowserTarget(url: url); pending = nil }
                Button("In Safari") { UIApplication.shared.open(url); pending = nil }
                Button("Link kopieren") { UIPasteboard.general.url = url; pending = nil }
                Button("Abbrechen", role: .cancel) { pending = nil }
            } message: { url in
                Text(url.absoluteString)
            }
            .fullScreenCover(item: $browserURL) { target in
                BrowserView(url: target.url)
            }
            #if DEBUG
            .task {
                let d = UserDefaults.standard
                if let raw = d.string(forKey: "hollrBrowse") { browserURL = BrowserTarget(url: URL(string: raw)) }
                if let raw = d.string(forKey: "hollrLink") { pending = URL(string: raw) }
            }
            #endif
    }
}

struct BrowserTarget: Identifiable {
    let id = UUID()
    let url: URL?
}

struct OpenInBrowser {
    var open: (URL?) -> Void = { _ in }
    func callAsFunction(_ url: URL? = nil) { open(url) }
}

private struct OpenInBrowserKey: EnvironmentKey {
    static let defaultValue = OpenInBrowser()
}

extension EnvironmentValues {
    var openInBrowser: OpenInBrowser {
        get { self[OpenInBrowserKey.self] }
        set { self[OpenInBrowserKey.self] = newValue }
    }
}

extension View {
    func linkChooser() -> some View { modifier(LinkChooser()) }
}
