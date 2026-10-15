import SwiftUI

/// Top of the home screen: what waits for you – answer omp's questions with one tap, reply to a
/// waiting or finished agent without opening the chat.
struct InboxSection: View {
    @Environment(Inbox.self) private var inbox
    let open: (String) -> Void

    var body: some View {
        if !inbox.entries.isEmpty {
            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 8) {
                    Circle().fill(Theme.warn).frame(width: 7, height: 7)
                    SectionHeader(title: String(localized: "Braucht dich"), trailing: "\(inbox.entries.count)")
                }
                ForEach(inbox.entries) { entry in
                    InboxCard(entry: entry, open: { open(entry.id) })
                        .transition(.asymmetric(insertion: .opacity, removal: .move(edge: .leading).combined(with: .opacity)))
                }
            }
            .animation(.easeInOut(duration: 0.25), value: inbox.entries.map(\.id))
        }
    }
}

private struct InboxCard: View {
    let entry: InboxEntry
    let open: () -> Void
    @Environment(Inbox.self) private var inbox
    @Environment(SessionStore.self) private var sessions
    @Environment(DraftStore.self) private var drafts
    @State private var replying = false
    @FocusState private var focused: Bool

    private var color: Color {
        switch entry.kind {
        case .ask, .waiting: return Theme.warn
        case .error: return Color.red
        case .done: return Theme.live
        }
    }

    private var label: String {
        switch entry.kind {
        case .ask: return String(localized: "fragt dich")
        case .waiting: return String(localized: "wartet auf dich")
        case .error: return String(localized: "Fehler")
        case .done: return String(localized: "fertig")
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: entry.kind == .done ? "checkmark.circle.fill"
                      : entry.kind == .error ? "exclamationmark.triangle.fill" : "questionmark.bubble.fill")
                    .foregroundStyle(color)
                Text(entry.ref.title).font(.subheadline.weight(.semibold)).lineLimit(1)
                Text("\(entry.ref.pane.agentName) \(label)").font(.caption).foregroundStyle(color).lineLimit(1)
                Spacer(minLength: 4)
                if entry.kind == .done || entry.kind == .error {
                    Button { withAnimation { inbox.dismiss(entry) } } label: {
                        Image(systemName: "xmark").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                            .frame(width: 26, height: 26)
                    }
                    .buttonStyle(.borderless)
                    .accessibilityLabel("Ausblenden")
                }
            }
            if !entry.text.isEmpty {
                Text(entry.text).font(.subheadline).foregroundStyle(.primary.opacity(0.85)).lineLimit(4)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
                    .onTapGesture(perform: open)
            }
            if entry.kind == .ask {
                VStack(spacing: 6) {
                    ForEach(Array(entry.options.enumerated()), id: \.offset) { index, option in
                        Button { pick(index) } label: {
                            HStack(spacing: 8) {
                                Text("\(index + 1)").font(.caption.monospacedDigit().weight(.bold)).foregroundStyle(Theme.accent)
                                Text(option).font(.subheadline).multilineTextAlignment(.leading)
                                if index == entry.recommended { RecommendedBadge() }
                                Spacer(minLength: 0)
                            }
                            .padding(.vertical, 9).padding(.horizontal, 12)
                            .background(Theme.fg.opacity(0.07), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            if replying {
                replyField
            } else {
                HStack(spacing: 10) {
                    Button { replying = true; focused = true } label: {
                        Label(entry.kind == .ask ? String(localized: "Eigene Antwort") : entry.kind == .done
                              ? String(localized: "Weiter …") : String(localized: "Antworten"),
                              systemImage: "arrowshape.turn.up.left")
                    }
                    .buttonStyle(.bordered)
                    Button(action: open) { Label("Öffnen", systemImage: "arrow.up.right") }
                        .buttonStyle(.bordered)
                    Spacer()
                }
                .font(.subheadline)
                .controlSize(.small)
            }
        }
        .padding(14)
        .background(Theme.raised, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).stroke(color.opacity(0.45), lineWidth: 1))
    }

    /// The reply uses the chat's draft: what you start here is still there in the chat.
    private var replyField: some View {
        let draft = drafts.draft(for: entry.ref)
        return HStack(spacing: 8) {
            TextField("Nachricht an \(entry.ref.pane.agentName) …",
                      text: Binding(get: { draft.text }, set: { draft.text = $0 }), axis: .vertical)
                .lineLimit(1...4)
                .focused($focused)
                .submitLabel(.send)
                .onSubmit(send)
                .padding(.vertical, 8).padding(.horizontal, 12)
                .background(Theme.fg.opacity(0.07), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            Button(action: send) {
                Image(systemName: "arrow.up").font(.body.weight(.semibold))
                    .frame(width: 36, height: 36)
                    .background(Theme.accent, in: Circle())
                    .foregroundStyle(Theme.onAccent)
            }
            .disabled(draft.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            .accessibilityLabel("Senden")
        }
    }

    private func pick(_ index: Int) {
        Haptics.tap(.medium)
        sessions.session(for: entry.ref).answer(option: index)
        withAnimation { inbox.markAnswered(entry) }
    }

    private func send() {
        let draft = drafts.draft(for: entry.ref)
        let text = draft.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        Haptics.notify(.success)
        sessions.session(for: entry.ref).sendText(text)
        draft.clear()
        replying = false
        withAnimation { inbox.markAnswered(entry) }
    }
}
