import SwiftUI
import UIKit
import VisionKit

struct PairView: View {
    @Environment(ServerStore.self) private var store
    let initialLink: String?
    let onDone: () -> Void

    @State private var deviceName = DeviceKey.defaultDeviceName
    @State private var state: PairState = .scanning
    @State private var mode: NetworkMode = .auto
    @State private var method: Method = .scan
    @State private var code = ""
    @FocusState private var codeFocused: Bool

    enum Method: Hashable { case scan, code }
    #if targetEnvironment(macCatalyst)
    @State private var scannerAvailable = false
    #else
    @State private var scannerAvailable = DataScannerViewController.isSupported && DataScannerViewController.isAvailable
    #endif

    enum PairState: Equatable {
        case scanning
        case pairing(String)
        case done(String)
        case failed(String)
    }

    var body: some View {
        DialogScaffold(icon: .server, title: String(localized: "Server koppeln"), onClose: onDone) {
            switch state {
            case .scanning:
                scanner
            case .pairing(let label):
                VStack(spacing: Gap.s) {
                    Spinner(color: Theme.accent, size: 22)
                        .frame(width: 48, height: 48)
                        .background(Theme.accent.opacity(0.14), in: Circle())
                    Text("Kopple mit \(label) …").font(Typo.lg)
                    networkLabel
                    Text("Falls der Rechner fragt: dort mit „J“ bestätigen.")
                        .font(Typo.sm).foregroundStyle(Theme.dim)
                }
                .multilineTextAlignment(.center)
                .frame(maxWidth: .infinity)
                .padding(.vertical, Gap.xl)
            case .done(let label):
                VStack(spacing: Gap.s) {
                    resultTile(.check, color: Theme.green)
                    Text("\(label) ist gekoppelt").font(Typo.lg)
                    networkLabel
                    if mode == .tailscale, !Tailscale.isActiveOnDevice {
                        Text("Für unterwegs: Tailscale-App auf dem iPhone installieren und mit demselben Konto anmelden.")
                            .font(Typo.sm).foregroundStyle(Theme.dim)
                    }
                }
                .multilineTextAlignment(.center)
                .frame(maxWidth: .infinity)
                .padding(.vertical, Gap.l)
            case .failed(let message):
                VStack(spacing: Gap.s) {
                    resultTile(.alert, color: Theme.red)
                    Text(message).font(Typo.md)
                }
                .multilineTextAlignment(.center)
                .frame(maxWidth: .infinity)
                .padding(.vertical, Gap.l)
            }
        } footer: {
            switch state {
            case .scanning:
                Button("Abbrechen", action: onDone).buttonStyle(.hollr())
                if method == .code {
                    Button("Koppeln", action: pairWithCode)
                        .buttonStyle(.hollr(.primary))
                        .disabled(PairingCode.decode(code) == nil)
                }
            case .pairing:
                Button("Abbrechen", action: onDone).buttonStyle(.hollr())
            case .done:
                Button("Fertig", action: onDone).buttonStyle(.hollr(.primary))
            case .failed:
                Button("Abbrechen", action: onDone).buttonStyle(.hollr())
                Button(method == .code ? "Nochmal versuchen" : "Nochmal scannen") { state = .scanning }
                    .buttonStyle(.hollr(.primary))
            }
        }
        .scrollDismissesKeyboard(.interactively)
        .dialogSheet()
        .task {
            if let initialLink { pair(initialLink) }
        }
    }

    /// How the pairing connects (from the QR code / link).
    private var networkLabel: some View {
        Label(mode.title, systemImage: mode == .tailscale ? HIcon.globe.symbol : "wifi")
            .font(Typo.note).foregroundStyle(Theme.muted)
    }

    /// Round result tile of the pairing dialog (pair__ok-ico).
    private func resultTile(_ icon: HIcon, color: Color) -> some View {
        IconView(icon, size: 22)
            .foregroundStyle(color)
            .frame(width: 48, height: 48)
            .background(color.opacity(0.14), in: Circle())
            .accessibilityHidden(true)
    }

    @ViewBuilder private var scanner: some View {
        Segmented(label: String(localized: "Methode"),
                  options: [(Method.scan, String(localized: "QR-Code scannen")), (Method.code, String(localized: "Code eingeben"))],
                  selection: $method, boxed: true)
        DialogField(label: String(localized: "Gerätename")) {
            TextField("Gerätename", text: $deviceName)
                .fieldStyle()
            Text("So erscheint dein iPhone in `hollr devices` auf dem Server.")
                .font(Typo.sm).foregroundStyle(Theme.dim)
        }
        if method == .code {
            codeEntry
        } else if scannerAvailable {
            #if !targetEnvironment(macCatalyst)
            QRScanner { pair($0) }
                .frame(height: 340)
                .clipShape(RoundedRectangle(cornerRadius: Radius.xl, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: Radius.xl, style: .continuous).strokeBorder(Theme.accent, lineWidth: 2))
            #endif
        } else {
            VStack(spacing: Gap.s) {
                Image(systemName: "camera")
                    .font(.system(size: 18, weight: .medium))
                    .foregroundStyle(Theme.muted)
                    .frame(width: 44, height: 44)
                    .background(Theme.card, in: Circle())
                Text("Kamera nicht verfügbar").font(Typo.lg)
                Text("Den Link aus `hollr pair --link` kopieren und unten einfügen.")
                    .font(Typo.md).foregroundStyle(Theme.muted)
            }
            .multilineTextAlignment(.center)
            .frame(maxWidth: .infinity)
            .padding(.vertical, Gap.m)
        }
        if method == .scan {
            Text("Auf dem Server `hollr pair` ausführen (oder im herdr-Menü „Hollr: iPhone koppeln“) und den QR-Code scannen.")
                .font(Typo.sm).foregroundStyle(Theme.dim)
            PasteButton(payloadType: String.self) { strings in
                if let link = strings.first { Task { @MainActor in pair(link) } }
            }
            .frame(maxWidth: .infinity)
        }
        SetupCommands()
    }

    @ViewBuilder private var codeEntry: some View {
        DialogField(label: String(localized: "Pairing-Code")) {
            TextField("XXXX-XXXX-XXXX-XXXX", text: $code)
                .multilineTextAlignment(.center)
                .textInputAutocapitalization(.characters)
                .autocorrectionDisabled()
                .keyboardType(.asciiCapable)
                .focused($codeFocused)
                .font(.system(.title3, design: .monospaced, weight: .semibold))
                .fieldStyle(focused: codeFocused)
                .onChange(of: code) { _, new in
                    let formatted = PairingCode.format(new)
                    if formatted != new { code = formatted }
                }
                .onSubmit(pairWithCode)
            // code copied from a message: paste and pair in one tap (no paste prompt)
            PasteButton(payloadType: String.self) { strings in
                guard let text = strings.first else { return }
                Task { @MainActor in
                    code = PairingCode.format(text)
                    pairWithCode()
                }
            }
            .labelStyle(.titleAndIcon)
            .frame(maxWidth: .infinity)
            Text("Am Rechner `hollr pair` ausführen – der Code steht unter dem QR-Code, gilt 10 Minuten und nur einmal. Von unterwegs: am Rechner „Tailscale / Fernzugriff“ wählen und Tailscale auf dem iPhone verbinden.")
                .font(Typo.sm).foregroundStyle(Theme.dim)
        }
        .onAppear { codeFocused = true }
    }

    private func pairWithCode() {
        guard PairingCode.decode(code) != nil else { return }
        codeFocused = false
        let entered = code
        state = .pairing(String(localized: "Code wird geprüft"))
        Task {
            do {
                let payload = try await PairingCode.fetchPayload(entered)
                pair(payload: payload)
            } catch {
                state = .failed(error.localizedDescription)
            }
        }
    }

    private func pair(_ link: String) {
        guard state == .scanning || initialLink != nil else { return }
        let payload: PairingPayload
        do {
            payload = try PairingPayload.parse(link)
        } catch {
            state = .failed(error.localizedDescription)
            return
        }
        pair(payload: payload)
    }

    /// QR code, link and one-time code all end here: the same pairing.
    private func pair(payload: PairingPayload) {
        mode = payload.network
        state = .pairing(payload.l)
        let name = deviceName.trimmingCharacters(in: .whitespaces)
        Task {
            do {
                let server = try await HollrClient.pair(payload, deviceName: name.isEmpty ? "iPhone" : name)
                store.add(server)
                state = .done(server.label)
            } catch {
                var message = error.localizedDescription
                if payload.network == .tailscale, !Tailscale.isActiveOnDevice, case HollrError.unreachable = error {
                    message += "\n\n" + String(localized: "Tailscale ist auf dem iPhone nicht verbunden – Tailscale-App öffnen, verbinden und nochmal scannen.")
                }
                state = .failed(message)
            }
        }
    }
}

/// Live camera QR scanner (VisionKit).
#if !targetEnvironment(macCatalyst)
struct QRScanner: UIViewControllerRepresentable {
    let onCode: (String) -> Void

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let vc = DataScannerViewController(
            recognizedDataTypes: [.barcode(symbologies: [.qr])],
            qualityLevel: .balanced,
            isHighlightingEnabled: true
        )
        vc.delegate = context.coordinator
        try? vc.startScanning()
        return vc
    }

    func updateUIViewController(_ vc: DataScannerViewController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(onCode: onCode) }

    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        let onCode: (String) -> Void
        private var fired = false
        init(onCode: @escaping (String) -> Void) { self.onCode = onCode }

        func dataScanner(_ scanner: DataScannerViewController, didAdd items: [RecognizedItem], allItems: [RecognizedItem]) {
            for item in items {
                if case .barcode(let code) = item, let value = code.payloadStringValue,
                   value.hasPrefix("hollr://"), !fired {
                    fired = true
                    scanner.stopScanning()
                    onCode(value)
                }
            }
        }
    }
}
#endif

/// Copy-paste commands to install Hollr on a server and show the pairing QR code.
struct SetupCommands: View {
    enum OS: String, CaseIterable { case linux = "Linux", mac = "macOS" }
    @State private var os: OS = .linux
    @State private var copied: String?

    private static let repo = "sensedrive/hollr"
    #if targetEnvironment(macCatalyst)
    private static let pair = "hollr pair --link"   // the Mac app pastes a link, it has no camera scanner
    #else
    private static let pair = "hollr pair"
    #endif
    private static let install =
        "curl -fsSL https://raw.githubusercontent.com/\(repo)/main/install.sh | bash && ~/.local/bin/\(pair)"

    var body: some View {
        VStack(alignment: .leading, spacing: Gap.m) {
            Text("Server einrichten").font(Typo.lg)
            Segmented(label: String(localized: "Server einrichten"),
                      options: OS.allCases.map { ($0, $0.rawValue) }, selection: $os, boxed: true)
            if os == .mac {
                step(String(localized: "Entfernte Anmeldung (SSH) einschalten"), "sudo systemsetup -setremotelogin on")
            }
            step(String(localized: "Auf dem Server ausführen"), Self.install)
            step(String(localized: "Schon installiert? Nur koppeln:"), Self.pair)
        }
        .padding(.top, Gap.s)
    }

    private func step(_ title: String, _ command: String) -> some View {
        DialogField(label: title) {
            HStack(alignment: .top, spacing: Gap.s) {
                Text(verbatim: command)
                    .font(Typo.monoSmall)
                    .textSelection(.enabled)
                    .padding(.vertical, 7)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Button {
                    UIPasteboard.general.string = command
                    copied = command
                } label: {
                    IconView(copied == command ? .check : .copy, size: 14)
                        .foregroundStyle(copied == command ? Theme.green : Theme.muted)
                }
                .buttonStyle(.icon(size: 32))
                .accessibilityLabel("Befehl kopieren")
            }
            .padding(.vertical, Gap.xs).padding(.leading, 10).padding(.trailing, Gap.xs)
            .background(Theme.raised, in: RoundedRectangle(cornerRadius: Radius.md, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: Radius.md, style: .continuous).strokeBorder(Theme.border, lineWidth: 1))
        }
    }
}
