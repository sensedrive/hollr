import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/// Paperclip in the composer: a photo or a file goes to the server (~/.cache/hollr/uploads, outside
/// the repo) and its path lands in the message – the agent reads it from there.
struct AttachButton: View {
    let ref: AgentRef
    let insert: (String) -> Void
    @State private var photo: PhotosPickerItem?
    @State private var showPhotos = false
    @State private var showFiles = false
    @State private var uploading = false
    @State private var error: String?

    var body: some View {
        Menu {
            Button { showPhotos = true } label: { Label("Foto oder Bildschirmfoto", systemImage: "photo") }
            Button { showFiles = true } label: { Label("Datei", systemImage: "doc") }
            if UIPasteboard.general.hasImages {
                Button { pasteImage() } label: { Label("Bild aus der Zwischenablage", systemImage: "doc.on.clipboard") }
            }
        } label: {
            Group {
                if uploading { ProgressView() } else { Image(systemName: "paperclip") }
            }
            .frame(width: 30, height: 38)
        }
        .disabled(uploading)
        .foregroundStyle(.primary)
        .accessibilityLabel("Anhang")
        .photosPicker(isPresented: $showPhotos, selection: $photo, matching: .images)
        .fileImporter(isPresented: $showFiles, allowedContentTypes: [.item]) { result in
            guard case let .success(url) = result else { return }
            let access = url.startAccessingSecurityScopedResource()
            defer { if access { url.stopAccessingSecurityScopedResource() } }
            guard let data = try? Data(contentsOf: url) else { error = String(localized: "Datei nicht lesbar"); return }
            send(name: url.lastPathComponent, data: data)
        }
        .onChange(of: photo) { _, item in
            guard let item else { return }
            Task {
                defer { photo = nil }
                guard let data = try? await item.loadTransferable(type: Data.self) else { return }
                send(name: "foto.jpg", data: Self.shrink(data) ?? data)
            }
        }
        .alert("Anhang nicht gesendet", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
            Button("OK") { error = nil }
        } message: { Text(error ?? "") }
    }

    private func pasteImage() {
        guard let image = UIPasteboard.general.image, let data = image.jpegData(compressionQuality: 0.85) else { return }
        send(name: "bild.jpg", data: Self.shrink(data) ?? data)
    }

    private func send(name: String, data: Data) {
        guard data.count <= 20 * 1024 * 1024 else { error = String(localized: "Größer als 20 MB"); return }
        uploading = true
        Task {
            defer { uploading = false }
            do {
                let path = try await HollrClient.upload(ref.server, name: name, data: data)
                Haptics.notify(.success)
                insert(path)
            } catch {
                self.error = error.localizedDescription
            }
        }
    }

    /// Photos at most 2048 px and JPEG – a screenshot reads just as well, the upload is a tenth.
    static func shrink(_ data: Data) -> Data? {
        guard let image = UIImage(data: data) else { return nil }
        let longest = max(image.size.width, image.size.height)
        let scale = min(1, 2048 / max(longest, 1))
        let size = CGSize(width: image.size.width * scale, height: image.size.height * scale)
        let resized = UIGraphicsImageRenderer(size: size).image { _ in image.draw(in: CGRect(origin: .zero, size: size)) }
        return resized.jpegData(compressionQuality: 0.8)
    }
}
