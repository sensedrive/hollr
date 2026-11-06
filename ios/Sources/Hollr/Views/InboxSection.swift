import SwiftUI

/// Top of the home screen ("Braucht dich"): what waits for you as focus cards – answer omp's questions with
/// one tap, reply to a waiting or finished agent without opening the chat.
struct InboxSection: View {
    @Environment(Inbox.self) private var inbox
    @Environment(HerdrStore.self) private var herdr
    let open: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Gap.m) {
            SectionHeader(title: String(localized: "Braucht dich"),
                          trailing: inbox.entries.isEmpty ? nil : "\(inbox.entries.count)",
                          dot: inbox.entries.isEmpty ? Theme.dim : Theme.warn)
            if inbox.entries.isEmpty {
                quiet
            } else {
                ForEach(inbox.entries) { entry in
                    InboxCard(entry: entry, branch: herdr.branch(of: entry.ref), open: { open(entry.id) })
                        .transition(.asymmetric(insertion: .opacity, removal: .move(edge: .leading).combined(with: .opacity)))
                }
            }
        }
        .animation(.easeInOut(duration: 0.25), value: inbox.entries.map(\.id))
    }

    /// nothing waits (dash__quiet): a calm card instead of an empty gap
    private var quiet: some View {
        HStack(alignment: .top, spacing: Gap.m) {
            IconView(.check, size: 14)
                .foregroundStyle(Theme.live)
                .frame(width: 24, height: 24)
                .background(Theme.live.opacity(0.14), in: Circle())
            VStack(alignment: .leading, spacing: 2) {
                Text(herdr.loaded ? String(localized: "Nichts wartet auf dich.") : String(localized: "Lädt …"))
                    .font(Typo.md)
                if herdr.loaded {
                    Text("Fragen, neue Ergebnisse und Fehler erscheinen hier.")
                        .font(Typo.sm).foregroundStyle(Theme.muted)
                }
            }
            Spacer(minLength: 0)
        }
        .cardStyle(padding: EdgeInsets(top: Gap.l, leading: Gap.l, bottom: Gap.l, trailing: Gap.l))
    }
}

private struct InboxCard: View {
    let entry: InboxEntry
    /// the space's git branch, when known
    let branch: String?
    let open: () -> Void
    @Environment(Inbox.self) private var inbox
    @Environment(SessionStore.self) private var sessions
    @Environment(DraftStore.self) private var drafts
    @State private var replying = false
    @State private var showTerminal = false
    @FocusState private var focused: Bool

    private var kind: FocusKind {
        switch entry.kind {
        case .ask: return .ask
        case .waiting: return .waiting
        case .done: return .done
        case .error: return .error
        }
    }

    /// results and errors can be marked as seen (hidden until something new happens)
    private var onSeen: (() -> Void)? {
        guard entry.kind == .done || entry.kind == .error else { return nil }
        return { withAnimation { inbox.dismiss(entry) } }
    }

    /// questions and errors want an answer: the reply field is there right away
    private var showsReply: Bool { replying || entry.kind == .ask || entry.kind == .error }

    var body: some View {
        VStack(alignment: .leading, spacing: Gap.m) {
            FocusCardHead(kind: kind, project: entry.ref.workspace, projectColor: Theme.identity(entry.ref.workspace),
                          branch: branch, onSeen: onSeen)
            Button(action: open) {
                HStack(alignment: .firstTextBaseline, spacing: Gap.s) {
                    Text(entry.ref.title).font(Typo.lg).foregroundStyle(Theme.fg).lineLimit(1)
                    Text(AgentKind(entry.ref.pane.agent).name).font(Typo.sm).foregroundStyle(Theme.muted).lineLimit(1)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if !entry.text.isEmpty {
                Text(entry.text).font(Typo.md).foregroundStyle(Theme.fg).lineLimit(4)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
                    .onTapGesture(perform: open)
            }
            if entry.kind == .ask {
                VStack(spacing: 6) {
                    ForEach(Array(entry.options.enumerated()), id: \.offset) { index, option in
                        Button { pick(index) } label: {
                            OptionRow(index: index, label: option, recommended: index == entry.recommended)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .accessibilityElement(children: .contain)
                .accessibilityLabel("Antwortoptionen")
            }
            if showsReply { replyField }
            actions
        }
        .focusCardStyle(kind)
        .fullScreenCover(isPresented: $showTerminal) { TerminalScreen(ref: entry.ref) }
    }

    /// one main thing per kind: the options or the reply for questions and errors, else "Chat öffnen"
    private var actions: some View {
        HStack(spacing: Gap.s) {
            Button(action: open) { Label("Chat öffnen", icon: .message) }
                .buttonStyle(.hollr(kind.calm ? .primary : .secondary, small: true))
            if !showsReply {
                Button { replying = true; focused = true } label: {
                    Label(entry.kind == .done ? String(localized: "Weiter …") : String(localized: "Antworten"), icon: .reply)
                }
                .buttonStyle(.hollr(.secondary, small: true))
            }
            Button { showTerminal = true } label: { Label("Terminal", icon: .terminal) }
                .buttonStyle(.hollr(.ghost, small: true))
            Spacer(minLength: 0)
        }
    }

    /// The reply uses the chat's draft: what you start here is still there in the chat.
    private var replyField: some View {
        let draft = drafts.draft(for: entry.ref)
        let ready = !draft.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        return HStack(spacing: Gap.s) {
            TextField(entry.kind == .ask ? String(localized: "Oder eigene Antwort …")
                      : String(localized: "Nachricht an \(entry.ref.pane.agentName) …"),
                      text: Binding(get: { draft.text }, set: { draft.text = $0 }), axis: .vertical)
                .lineLimit(1...4)
                .focused($focused)
                .submitLabel(.send)
                .onSubmit(send)
                .fieldStyle(focused: focused)
            Button(action: send) { SendButtonLabel(ready: ready, size: 38) }
                .buttonStyle(.plain)
                .disabled(!ready)
                .accessibilityLabel("Senden")
        }
    }

    private func pick(_ index: Int) {
        Haptics.tap(.medium)
        let session = sessions.session(for: entry.ref)
        let ask = entry.turn
        Task { await session.answer(ask: ask, picks: [AskPick(options: [index])]) }
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
