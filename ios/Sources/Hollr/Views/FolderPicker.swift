import SwiftUI

/// `hollr gate dirs` – subfolders of a path in the server's home directory.
struct DirListing: Decodable {
    struct Entry: Decodable, Identifiable, Hashable {
        let name: String
        let path: String
        let repo: Bool
        let branch: String?
        var id: String { path }
    }
    let path: String
    let parent: String?
    let repo: Bool
    let dirs: [Entry]
    let places: [String]
}

extension HollrClient {
    static func dirs(_ server: Server, path: String) async throws -> DirListing {
        try await fs(server, ["path": path], as: DirListing.self, command: "dirs")
    }
}

/// Browse the server's folders (home and below) and pick one for a new space.
struct FolderPicker: View {
    let server: Server
    var start = "~"
    let onPick: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var path = "~"
    @State private var listing: DirListing?
    @State private var error: String?
    @State private var newName = ""
    @State private var filter = ""

    private var shown: [DirListing.Entry] {
        let all = listing?.dirs ?? []
        let f = filter.trimmingCharacters(in: .whitespaces)
        return f.isEmpty ? all : all.filter { $0.name.localizedCaseInsensitiveContains(f) }
    }

    var body: some View {
        NavigationStack {
            List {
                Group {
                    Section {
                        HStack(spacing: 8) {
                            if let parent = listing?.parent {
                                Button { Task { await load(parent) } } label: {
                                    Image(systemName: "chevron.up").frame(width: 28, height: 28)
                                }
                                .buttonStyle(.bordered)
                            }
                            Text(listing?.path ?? path).font(.callout.monospaced()).lineLimit(2).truncationMode(.head)
                            if listing?.repo == true {
                                Image(systemName: "arrow.triangle.branch").foregroundStyle(Theme.accent)
                            }
                        }
                    }
                    if let places = listing?.places, !places.isEmpty {
                        Section("Projekt-Orte") {
                            ForEach(places, id: \.self) { place in
                                Button { Task { await load(place) } } label: {
                                    Label(place, systemImage: "star").font(.callout.monospaced())
                                }
                            }
                        }
                    }
                    if let error {
                        Text(error).foregroundStyle(Theme.warn)
                    }
                    Section {
                        if listing == nil, error == nil {
                            ForEach(0..<6, id: \.self) { _ in SkeletonBar(width: 200, height: 14).shimmer() }
                        } else if shown.isEmpty {
                            Text(filter.isEmpty ? "Keine Unterordner." : "Nichts gefunden.").foregroundStyle(.secondary)
                        }
                        ForEach(shown) { entry in
                            Button { Task { await load(entry.path) } } label: {
                                HStack(spacing: 10) {
                                    Image(systemName: entry.repo ? "arrow.triangle.branch" : "folder")
                                        .foregroundStyle(entry.repo ? Theme.accent : .secondary)
                                        .frame(width: 22)
                                    VStack(alignment: .leading, spacing: 1) {
                                        Text(entry.name).foregroundStyle(.primary)
                                        if let branch = entry.branch {
                                            Text(branch).font(.caption.monospaced()).foregroundStyle(.secondary)
                                        }
                                    }
                                    Spacer()
                                    Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
                                }
                            }
                            .swipeActions(edge: .trailing) {
                                Button("Wählen") { pick(entry.path) }.tint(Theme.accent)
                            }
                        }
                    } header: {
                        Text("Ordner")
                    } footer: {
                        Text("Antippen öffnet den Ordner, nach links wischen wählt ihn direkt. Git-Repos sind markiert.")
                    }
                    Section {
                        HStack {
                            TextField("Neuer Unterordner", text: $newName)
                                .textInputAutocapitalization(.never).autocorrectionDisabled()
                            Button("Anlegen") {
                                let name = newName.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: "/", with: "-")
                                pick("\(listing?.path ?? path)/\(name)")
                            }
                            .disabled(newName.trimmingCharacters(in: .whitespaces).isEmpty)
                        }
                    } footer: {
                        Text("Wird beim Anlegen des Space erstellt.")
                    }
                }
                .listRowBackground(Theme.card)
            }
            .themedList()
            .searchable(text: $filter, prompt: Text("Ordner filtern"))
            .navigationTitle("Ordner wählen")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Abbrechen") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Diesen wählen") { pick(listing?.path ?? path) }
                        .disabled(listing == nil)
                }
            }
            .task { await load(start) }
        }
    }

    private func pick(_ chosen: String) {
        onPick(chosen)
        dismiss()
    }

    private func load(_ target: String) async {
        filter = ""
        do {
            let result = try await HollrClient.dirs(server, path: target)
            listing = result
            path = result.path
            error = nil
        } catch {
            // a folder typed in the field may not exist yet: show home instead
            if target != "~", listing == nil {
                await load("~")
                return
            }
            self.error = error.localizedDescription
        }
    }
}
