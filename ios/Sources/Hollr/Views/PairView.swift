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
        NavigationStack {
            VStack(spacing: 20) {
                switch state {
                case .scanning:
                    ScrollView {
                        VStack(spacing: 20) { scanner }
                    }
                    .scrollDismissesKeyboard(.interactively)
                case .pairing(let label):
                    Spacer()
                    ProgressView("Kopple mit \(label) …")
                    Label(mode.title, systemImage: mode == .tailscale ? "globe" : "wifi")
                        .font(.subheadline).foregroundStyle(.secondary)
                    Text("Falls der Rechner fragt: dort mit „J“ bestätigen.")
                        .font(.footnote).foregroundStyle(.tertiary).multilineTextAlignment(.center)
                    Spacer()
                case .done(let label):
                    Spacer()
                    Image(systemName: "checkmark.circle.fill").font(.system(size: 64)).foregroundStyle(Theme.live)
                    Text("\(label) ist gekoppelt").font(.title3.bold())
                    Label(mode.title, systemImage: mode == .tailscale ? "globe" : "wifi")
                        .font(.subheadline).foregroundStyle(.secondary)
                    if mode == .tailscale, !Tailscale.isActiveOnDevice {
                        Text("Für unterwegs: Tailscale-App auf dem iPhone installieren und mit demselben Konto anmelden.")
                            .font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center)
                    }
                    Spacer()
                    Button("Fertig", action: onDone).buttonStyle(.borderedProminent).controlSize(.large)
                case .failed(let message):
                    Spacer()
                    Image(systemName: "xmark.octagon.fill").font(.system(size: 56)).foregroundStyle(Theme.warn)
                    Text(message).multilineTextAlignment(.center)
                    Spacer()
                    Button("Nochmal scannen") { state = .scanning }.buttonStyle(.bordered)
                }
            }
            .padding()
            .navigationTitle("Server koppeln")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Abbrechen", action: onDone) }
            }
            .task {
                if let initialLink { pair(initialLink) }
            }
        }
    }

    @ViewBuilder private var scanner: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Gerätename").font(.caption).foregroundStyle(.secondary)
            TextField("Gerätename", text: $deviceName)
                .padding(12)
                .background(Theme.card, in: RoundedRectangle(cornerRadius: 12))
            Text("So erscheint dein iPhone in `hollr devices` auf dem Server.")
                .font(.caption2).foregroundStyle(.secondary)
        }
        if scannerAvailable {
            #if !targetEnvironment(macCatalyst)
            QRScanner { pair($0) }
                .frame(height: 360)
                .clipShape(RoundedRectangle(cornerRadius: 20))
                .overlay(RoundedRectangle(cornerRadius: 20).stroke(Theme.accent.opacity(0.6), lineWidth: 2))
            #endif
        } else {
            ContentUnavailableView(
                "Kamera nicht verfügbar", systemImage: "camera",
                description: Text("Den Link aus `hollr pair --link` kopieren und unten einfügen.")
            )
        }
        Text("Auf dem Server `hollr pair` ausführen (oder im herdr-Menü „Hollr: iPhone koppeln“) und den QR-Code scannen.")
            .font(.footnote).foregroundStyle(.secondary)
        PasteButton(payloadType: String.self) { strings in
            if let link = strings.first { Task { @MainActor in pair(link) } }
        }
        .frame(maxWidth: .infinity)
        SetupCommands()
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
        VStack(alignment: .leading, spacing: 12) {
            Text("Server einrichten").font(.headline)
            Picker("", selection: $os) {
                ForEach(OS.allCases, id: \.self) { Text($0.rawValue).tag($0) }
            }
            .pickerStyle(.segmented)
            if os == .mac {
                step(String(localized: "Entfernte Anmeldung (SSH) einschalten"), "sudo systemsetup -setremotelogin on")
            }
            step(String(localized: "Auf dem Server ausführen"), Self.install)
            step(String(localized: "Schon installiert? Nur koppeln:"), Self.pair)
        }
        .padding(.top, 12)
    }

    private func step(_ title: String, _ command: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.subheadline).foregroundStyle(.secondary)
            HStack(alignment: .top, spacing: 8) {
                Text(command)
                    .font(.system(.caption, design: .monospaced))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Button {
                    UIPasteboard.general.string = command
                    copied = command
                } label: {
                    Image(systemName: copied == command ? "checkmark" : "doc.on.doc")
                }
                .accessibilityLabel("Befehl kopieren")
            }
            .padding(10)
            .background(Theme.fg.opacity(0.06), in: RoundedRectangle(cornerRadius: 10))
        }
    }
}
