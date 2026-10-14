import SwiftUI
import UIKit
import VisionKit

struct PairView: View {
    @Environment(ServerStore.self) private var store
    let initialLink: String?
    let onDone: () -> Void

    @State private var deviceName = DeviceKey.defaultDeviceName
    @State private var state: PairState = .scanning
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
                    Spacer()
                case .done(let label):
                    Spacer()
                    Image(systemName: "checkmark.circle.fill").font(.system(size: 64)).foregroundStyle(Theme.live)
                    Text("\(label) ist gekoppelt").font(.title3.bold())
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
        state = .pairing(payload.l)
        let name = deviceName.trimmingCharacters(in: .whitespaces)
        Task {
            do {
                let server = try await HollrClient.pair(payload, deviceName: name.isEmpty ? "iPhone" : name)
                store.add(server)
                state = .done(server.label)
            } catch {
                state = .failed(error.localizedDescription)
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
    private static let viaCurl =
        "curl -fsSL https://raw.githubusercontent.com/\(repo)/main/install.sh | bash && ~/.local/bin/hollr pair"

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Server einrichten").font(.headline)
            Picker("", selection: $os) {
                ForEach(OS.allCases, id: \.self) { Text($0.rawValue).tag($0) }
            }
            .pickerStyle(.segmented)
            if os == .mac {
                step(String(localized: "1. Entfernte Anmeldung (SSH) einschalten"), "sudo systemsetup -setremotelogin on")
            } else {
                step(String(localized: "1. SSH-Server (falls noch nicht da)"),
                     "command -v sshd >/dev/null || (sudo apt-get install -y openssh-server 2>/dev/null || sudo dnf install -y openssh-server 2>/dev/null || sudo pacman -S --noconfirm openssh 2>/dev/null || sudo zypper install -y openssh 2>/dev/null || sudo apk add openssh)")
            }
            step(String(localized: "2. Hollr installieren und QR-Code anzeigen"), Self.viaCurl)
            step(String(localized: "Schon installiert? Nur koppeln:"), "hollr pair")
            step(String(localized: "Für Mac und Desktop: Link statt QR-Code"), "hollr pair --link")
            Text("Der Installer erkennt apt, dnf, yum, pacman, zypper und apk und lässt alles Vorhandene in Ruhe.")
                .font(.caption).foregroundStyle(.secondary)
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
