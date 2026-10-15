import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// "An Hollr senden" in the share sheet: keeps the text / link / image with an optional note;
/// Hollr asks which agent gets it the next time it opens.
final class ShareViewController: UIViewController {
    override func viewDidLoad() {
        super.viewDidLoad()
        Task { await load() }
    }

    private func load() async {
        var text = ""
        var image: Data?
        var fileName: String?
        for item in (extensionContext?.inputItems as? [NSExtensionItem]) ?? [] {
            if let body = item.attributedContentText?.string, !body.isEmpty { text = body }
            for provider in item.attachments ?? [] {
                if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier),
                   let url = try? await provider.loadItem(forTypeIdentifier: UTType.url.identifier) as? URL {
                    if url.isFileURL, let data = try? Data(contentsOf: url) {
                        image = data
                        fileName = url.lastPathComponent
                    } else {
                        text = [text, url.absoluteString].filter { !$0.isEmpty }.joined(separator: "\n")
                    }
                } else if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
                    let loaded = try? await provider.loadItem(forTypeIdentifier: UTType.image.identifier)
                    if let url = loaded as? URL { image = try? Data(contentsOf: url); fileName = url.lastPathComponent }
                    else if let img = loaded as? UIImage { image = img.jpegData(compressionQuality: 0.85); fileName = "bild.jpg" }
                    else if let data = loaded as? Data { image = data; fileName = "bild.jpg" }
                } else if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier),
                          let s = try? await provider.loadItem(forTypeIdentifier: UTType.plainText.identifier) as? String {
                    text = [text, s].filter { !$0.isEmpty }.joined(separator: "\n")
                }
            }
        }
        let host = UIHostingController(rootView: ShareCard(text: text, hasImage: image != nil, done: { [weak self] note in
            self?.finish(note: note, text: text, image: image, fileName: fileName)
        }, cancel: { [weak self] in
            self?.extensionContext?.cancelRequest(withError: NSError(domain: "hollr", code: 0))
        }))
        addChild(host)
        host.view.frame = view.bounds
        host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(host.view)
        host.didMove(toParent: self)
    }

    private func finish(note: String, text: String, image: Data?, fileName: String?) {
        var item = SharedItem(text: [note, text].filter { !$0.isEmpty }.joined(separator: "\n\n"))
        if let image {
            let data = Self.shrink(image) ?? image
            if data.count <= SharedItem.maxFile {
                item.file = data
                item.fileName = fileName ?? "datei"
            }
        }
        SharedItem.add(item)
        extensionContext?.completeRequest(returningItems: nil)
    }

    /// photos: at most 2048 px as JPEG (other files stay as they are)
    private static func shrink(_ data: Data) -> Data? {
        guard let image = UIImage(data: data) else { return nil }
        let scale = min(1, 2048 / max(image.size.width, image.size.height, 1))
        let size = CGSize(width: image.size.width * scale, height: image.size.height * scale)
        return UIGraphicsImageRenderer(size: size).image { _ in image.draw(in: CGRect(origin: .zero, size: size)) }
            .jpegData(compressionQuality: 0.8)
    }
}

private struct ShareCard: View {
    let text: String
    let hasImage: Bool
    let done: (String) -> Void
    let cancel: () -> Void
    @State private var note = ""

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Was soll der Agent damit tun?", text: $note, axis: .vertical).lineLimit(2...5)
                }
                Section("Geteilt") {
                    if hasImage { Label("Bild / Datei", systemImage: "photo") }
                    if !text.isEmpty { Text(text).font(.footnote).lineLimit(6) }
                }
                Section {
                    Text("Beim nächsten Öffnen fragt Hollr, an welchen Agent es geht.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            }
            .navigationTitle("An Hollr")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Abbrechen", action: cancel) }
                ToolbarItem(placement: .confirmationAction) { Button("Sichern") { done(note) }.bold() }
            }
        }
    }
}
