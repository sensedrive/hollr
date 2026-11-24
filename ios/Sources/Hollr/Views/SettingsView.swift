import SwiftUI

struct SettingsView: View {
    var onPair: () -> Void = {}
    @Environment(DictationSettings.self) private var settings
    @Environment(ServerStore.self) private var store
    @AppStorage(AppLock.key) private var lockEnabled = false
    @AppStorage(TextScale.key) private var scaleIndex = TextScale.system
    @Environment(\.dynamicTypeSize) private var typeSize
    @State private var showSpeech = UserDefaults.standard.string(forKey: "hollrTab") == "speech"

    var body: some View {
        List {
            Group {
            Section {
                NavigationLink { SpeechSettingsView() } label: {
                    Label {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Sprache")
                            Text(settings.engine.title + String(localized: " · auf dem Gerät"))
                                .font(Typo.sm).foregroundStyle(Theme.muted)
                        }
                    } icon: { Image(systemName: "waveform") }
                }
                NavigationLink { SnippetSettingsView() } label: {
                    Label("Prompt-Bausteine", systemImage: "text.badge.plus")
                }
            }
            Section {
                scaleRow
            } header: {
                SectionHeader(title: String(localized: "Ansicht"))
            } footer: {
                Text("Skaliert die ganze App. Im Chat geht's auch mit zwei Fingern (auf-/zuziehen) oder im Lesemodus.")
                    .font(Typo.sm).foregroundStyle(Theme.dim)
            }
            Section {
                NavigationLink { DesignSettingsView() } label: {
                    LabeledContent {
                        Text(UserDefaults.standard.bool(forKey: ThemeSettings.followKey)
                             ? "Automatisch" : (UserDefaults.standard.string(forKey: ThemeSettings.selectedKey) ?? Palette.hollr.name))
                            .foregroundStyle(Theme.muted)
                    } label: {
                        Label("Design", icon: .sun)
                    }
                }
            }
            Section {
                Toggle(isOn: Binding(get: { lockEnabled }, set: { on in
                    // confirm with Face ID before switching (also when turning it off)
                    Task { if await AppLock.authenticate(reason: on ? "Sperre einschalten" : "Sperre ausschalten") { lockEnabled = on } }
                })) {
                    Label("Mit \(AppLock.biometryName) sperren", systemImage: "faceid")
                }
            } header: {
                SectionHeader(title: String(localized: "Sicherheit"))
            } footer: {
                Text("Fragt beim Öffnen und nach mehr als 30 Sekunden im Hintergrund.")
                    .font(Typo.sm).foregroundStyle(Theme.dim)
            }
            Section {
                NavigationLink { PushSettingsView() } label: {
                    Label("Mitteilungen", icon: .bell)
                }
                NavigationLink { IntegrationsView() } label: {
                    Label("Integrationen", systemImage: "key")
                }
            }
            Section {
                NavigationLink { ServersView(onPair: onPair) } label: {
                    LabeledContent {
                        Text("\(store.servers.count)").monospacedDigit().foregroundStyle(Theme.muted)
                    } label: {
                        Label("Server & Geräte", icon: .server)
                    }
                }
            }
            Section {
                Button {
                    if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
                } label: {
                    LabeledContent {
                        HStack(spacing: Gap.xs) {
                            Text(Locale.current.localizedString(forLanguageCode: Bundle.main.preferredLocalizations.first ?? "de") ?? "")
                            IconView(.external, size: 12).foregroundStyle(Theme.dim)
                        }
                        .foregroundStyle(Theme.muted)
                    } label: {
                        Label("App-Sprache", icon: .globe)
                    }
                }
                .foregroundStyle(.primary)
            } footer: {
                Text("Deutsch oder Englisch – iOS stellt die Sprache pro App um.")
                    .font(Typo.sm).foregroundStyle(Theme.dim)
            }
            Section {
                NavigationLink { TipsTour(tips: Tips.all) } label: {
                    Label("Tipps & Tricks", icon: .help)
                }
                NavigationLink { ReleaseNotesView() } label: {
                    HStack {
                        Label("Neuigkeiten", icon: .sparkle)
                        Spacer()
                        if ReleaseNotes.hasUnseen {
                            Text("Neu").font(Typo.xs.weight(.semibold)).foregroundStyle(Theme.onAccent)
                                .padding(.horizontal, Gap.s).padding(.vertical, 2)
                                .background(Theme.accent, in: Capsule())
                        }
                    }
                }
            }
            Section {
                LabeledContent {
                    Text(verbatim: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "?")
                        .font(Typo.monoSmall).foregroundStyle(Theme.muted)
                } label: { Text("Version") }
                LabeledContent {
                    Text(verbatim: Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "?")
                        .font(Typo.monoSmall).foregroundStyle(Theme.muted)
                } label: { Text("Build") }
            } header: {
                SectionHeader(title: String(localized: "Über"))
            }
        }
            .listRowBackground(Theme.card)
        }
        .labelStyle(.settings)
        .themedList()
        .navigationTitle("Einstellungen")
        .navigationDestination(isPresented: $showSpeech) { SpeechSettingsView() }
    }

    // MARK: Ansicht skalieren

    private var effectiveSize: DynamicTypeSize { TextScale.size(scaleIndex, system: typeSize) }

    /// "Standard · 100 %": the step's name (or "Wie iOS") and the body text size relative to iOS' default.
    private var scaleValue: String {
        let name = scaleIndex == TextScale.system ? String(localized: "Wie iOS") : TextScale.label(effectiveSize)
        let body = UIFont.preferredFont(forTextStyle: .body,
                                        compatibleWith: UITraitCollection(preferredContentSizeCategory: UIContentSizeCategory(effectiveSize)))
        let standard = UIFont.preferredFont(forTextStyle: .body,
                                            compatibleWith: UITraitCollection(preferredContentSizeCategory: .large))
        return "\(name) · \(Int((body.pointSize / standard.pointSize * 100).rounded())) %"
    }

    /// Ansicht skalieren (Einstellungen zoom card): label + value, then A – slider – A and "Zurücksetzen".
    private var scaleRow: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Ansicht skalieren")
                Spacer()
                Text(verbatim: scaleValue).font(Typo.md).monospacedDigit().foregroundStyle(Theme.muted)
            }
            HStack(spacing: 10) {
                // fixed sizes on purpose: the two A's picture "small" and "large", they don't scale themselves
                Text(verbatim: "A").font(.system(size: 11)).accessibilityHidden(true)
                Slider(value: Binding(
                    get: { Double(TextScale.steps.firstIndex(of: effectiveSize) ?? 3) },
                    set: { scaleIndex = Int($0.rounded()) }
                ), in: 0...Double(TextScale.steps.count - 1), step: 1)
                .tint(Theme.accent)
                .accessibilityLabel("Ansicht skalieren")
                .accessibilityValue(scaleValue)
                Text(verbatim: "A").font(.system(size: 17)).accessibilityHidden(true)
                Button("Zurücksetzen") { scaleIndex = TextScale.system }
                    .buttonStyle(.hollr(small: true))
                    .disabled(scaleIndex == TextScale.system)
                    .accessibilityHint("Wie iOS (Systemeinstellung)")
            }
        }
        .padding(.vertical, Gap.xs)
    }
}

/// Local speech-to-text: engines, models, vocabulary, fine tuning – everything on-device.
struct SpeechSettingsView: View {
    @Environment(DictationSettings.self) private var settings
    /// the app's one microphone – the test uses the same dictation as the chats
    @Environment(Dictator.self) private var dictator
    private var models: ModelManager { .shared }
    @State private var testText = ""
    @State private var testing: DictationRequest?

    var body: some View {
        @Bindable var settings = settings
        List {
            Group {
            Section {
                readiness
                Button {
                    testing = DictationRequest(before: "", after: "")
                } label: {
                    HStack(spacing: 14) {
                        IconView(.mic, size: 16).foregroundStyle(Theme.onAccent)
                            .frame(width: 36, height: 36)
                            .background(Theme.accent, in: Circle())
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Diktat ausprobieren").foregroundStyle(Theme.fg)
                            Text(testText.isEmpty ? String(localized: "Sprich ein paar Sätze – so klingt es im Chat.") : testText)
                                .font(Typo.sm).foregroundStyle(testText.isEmpty ? Theme.muted : Theme.fg)
                                .lineLimit(4)
                        }
                        Spacer(minLength: 0)
                    }
                }
                .disabled(!settings.engineReady || dictator.isBusy)
            } header: {
                SectionHeader(title: String(localized: "Diktat"))
            }

            if !downloadedKeys.isEmpty { onDeviceSection }

            Section {
                engineRow(.parakeet, note: String(localized: "NVIDIA, 25 Sprachen, Deutsch + Englisch im selben Satz"), icon: "bird")
                engineRow(.whisper, note: String(localized: "OpenAI, 99 Sprachen, höchste Genauigkeit mit Large v3"), icon: "waveform.badge.magnifyingglass")
                engineRow(.apple, note: String(localized: "Ohne Download, Text erscheint schon beim Sprechen"), icon: "apple.logo")
            } header: {
                SectionHeader(title: String(localized: "Sprach-Engine"))
            } footer: {
                Text(engineFooter).font(Typo.sm).foregroundStyle(Theme.dim)
            }

            switch settings.engine {
            case .parakeet: parakeetSection
            case .whisper: whisperSection
            case .apple: appleSection
            }

            Section {
                Picker(selection: $settings.language) {
                    ForEach(DictationSettings.languages, id: \.code) { Text($0.name).tag($0.code) }
                } label: { Label("Sprache", systemImage: "globe") }
                Toggle(isOn: $settings.autoSend) {
                    Label("Nach dem Diktieren automatisch senden", systemImage: "paperplane")
                }
                Toggle(isOn: $settings.voiceSend) {
                    Label("„… senden“ am Ende schickt ab", systemImage: "text.bubble")
                }
            } header: {
                SectionHeader(title: String(localized: "Allgemein"))
            } footer: {
                (Text(settings.engine == .parakeet
                     ? String(localized: "Parakeet erkennt die Sprache selbst – auch gemischt Deutsch/Englisch.")
                     : String(localized: "Für Deutsch mit englischen Fachbegriffen „Deutsch“ wählen – das ist genauer als „Automatisch“."))
                + Text(" ") + Text("Mikrofon antippen öffnet das Diktat: der große Knopf pausiert, ✓ beendet – danach kannst du den Text noch bearbeiten und senden."))
                    .font(Typo.sm).foregroundStyle(Theme.dim)
            }

            Section {
                Toggle(isOn: $settings.sessionVocabulary) {
                    Label("Wörter aus der offenen Session", systemImage: "text.magnifyingglass")
                }
                Toggle(isOn: $settings.removeFillers) {
                    Label("Füllwörter entfernen („ähm“, „äh“)", systemImage: "scissors")
                }
                Toggle(isOn: $settings.polish) {
                    Label("Feinschliff mit Apple Intelligence (Beta)", systemImage: "sparkles")
                }
                .disabled(!LocalPolish.isAvailable && !settings.polish)
                if settings.polish || !LocalPolish.isAvailable, let reason = LocalPolish.unavailableReason {
                    Text(reason).font(Typo.sm).foregroundStyle(Theme.muted)
                }
            } header: {
                SectionHeader(title: String(localized: "Text"))
            } footer: {
                Text("Session-Wörter: Projekt, Ordner, Tickets (z. B. TENDR-725) und Dateinamen aus dem Chat helfen der Erkennung und werden richtig geschrieben. Der Feinschliff korrigiert Satzzeichen und Schreibweisen auf dem Gerät – dauert etwa eine Sekunde.")
                    .font(Typo.sm).foregroundStyle(Theme.dim)
            }

            Section {
                Toggle(isOn: $settings.noiseSuppression) {
                    Label("Rauschfilter", systemImage: "waveform.path.ecg")
                }
                Toggle(isOn: $settings.preferBuiltInMic) {
                    Label("Immer iPhone-Mikrofon", systemImage: "iphone")
                }
            } header: {
                SectionHeader(title: String(localized: "Mikrofon"))
            } footer: {
                Text("Der Rauschfilter dämpft Straße, Café und Lüfter. „Immer iPhone-Mikrofon“ nimmt nicht über AirPods auf – deren Mikro klingt am Telefon-Kanal dünner und wird schlechter erkannt.")
                    .font(Typo.sm).foregroundStyle(Theme.dim)
            }

            Section {
                Toggle("Fachwörter verwenden", isOn: $settings.useVocabulary)
                TextEditor(text: $settings.vocabularyText)
                    .font(Typo.mono)
                    .scrollContentBackground(.hidden)
                    .frame(minHeight: 180)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                    .disabled(!settings.useVocabulary)
                Button("Standardliste wiederherstellen") { settings.vocabularyText = DictationSettings.defaultVocabulary }
                    .buttonStyle(.hollr(small: true))
            } header: {
                SectionHeader(title: String(localized: "Fachwörter"), trailing: "\(settings.terms.count)")
            } footer: {
                Text("Ein Begriff pro Zeile, falsch verstandene Varianten nach „=“: z. B. „JIRA = Jira, Dschira“. Die Liste fließt in alle Engines ein (Apple-Kontext, Whisper-Prompt, Parakeet-Boost) und korrigiert danach Schreibweisen.")
                    .font(Typo.sm).foregroundStyle(Theme.dim)
            }

            Section {
                ForEach($settings.replacements) { $r in
                    HStack {
                        TextField("gehört", text: $r.from).autocorrectionDisabled()
                        Image(systemName: "arrow.right").foregroundStyle(Theme.dim)
                        TextField("ersetzen durch", text: $r.to).autocorrectionDisabled()
                    }
                    .font(Typo.md)
                }
                .onDelete { settings.replacements.remove(atOffsets: $0) }
                Button { settings.replacements.append(.init(from: "", to: "")) } label: {
                    Label("Ersetzung hinzufügen", icon: .plus)
                        .labelStyle(.titleAndIcon)
                        .foregroundStyle(Theme.accent)
                }
            } header: {
                SectionHeader(title: String(localized: "Wortersetzungen"))
            } footer: {
                Text("Feste Ersetzungen nach der Erkennung, z. B. „Komma“ → „,“.")
                    .font(Typo.sm).foregroundStyle(Theme.dim)
            }
        }
            .listRowBackground(Theme.card)
        }
        .labelStyle(.settings)
        .themedList()
        .navigationTitle("Sprache")
        .navigationBarTitleDisplayMode(.inline)
        .id(models.revision)
        .onAppear { models.measure(downloadedKeys) }
        .fullScreenCover(item: $testing) { _ in
            DictationOverlay(before: "", after: "", context: DictationContext(), owner: "settings-test",
                             mode: .test(done: { testText = $0 }))
        }
    }

    // MARK: Status and models on this device

    /// every model key that is completely on the device (Parakeet: `parakeet-<id>`, Whisper: the variant)
    private var downloadedKeys: [String] {
        DictationSettings.parakeetModels.map { "parakeet-\($0.id)" }.filter { models.isDownloaded($0) }
            + DictationSettings.whisperModels.map(\.id).filter { models.isDownloaded($0) }
    }

    /// what dictates now – or what's missing before it can, with the download right here
    @ViewBuilder private var readiness: some View {
        if settings.engineReady {
            Label {
                Text("Bereit: \(settings.engineLabel)").foregroundStyle(Theme.fg)
            } icon: {
                Image(systemName: "checkmark.circle.fill").foregroundStyle(Theme.green)
            }
        } else if let missing = missingModel {
            let progress = models.progress[missing.key]
            VStack(alignment: .leading, spacing: Gap.s) {
                Label {
                    Text("\(settings.engineLabel) ist noch nicht auf diesem iPhone").foregroundStyle(Theme.fg)
                } icon: {
                    Image(systemName: "exclamationmark.circle.fill").foregroundStyle(Theme.warn)
                }
                if let progress {
                    HStack(spacing: Gap.s) {
                        ProgressView(value: progress).tint(Theme.accent)
                        Text(verbatim: "\(Int(progress * 100)) %").font(Typo.monoSmall).foregroundStyle(Theme.muted)
                    }
                    Text("Der Bildschirm bleibt an, bis der Download fertig ist.").font(Typo.sm).foregroundStyle(Theme.muted)
                } else {
                    if let error = models.errors[missing.key] {
                        Text(error).font(Typo.sm).foregroundStyle(Theme.warn)
                    }
                    Button("Jetzt laden (\(missing.model.size))", action: missing.download)
                        .buttonStyle(.hollr(.primary, small: true))
                }
            }
            .padding(.vertical, 2)
        }
    }

    private var missingModel: (key: String, model: DictationSettings.Model, download: () -> Void)? {
        let settings = settings
        switch settings.engine {
        case .parakeet:
            guard let m = DictationSettings.parakeetModels.first(where: { $0.id == settings.parakeetModel }) else { return nil }
            return ("parakeet-\(m.id)", m, { models.downloadParakeet(m.id, settings: settings) })
        case .whisper:
            guard let m = DictationSettings.whisperModels.first(where: { $0.id == settings.whisperModel }) else { return nil }
            return (m.id, m, { models.downloadWhisper(m.id, settings: settings) })
        case .apple:
            return nil
        }
    }

    /// everything downloaded, with its real size; the one in use is marked, the rest can go
    private var onDeviceSection: some View {
        let keys = downloadedKeys
        let total = keys.compactMap { models.sizes[$0] }.reduce(0, +)
        return Section {
            ForEach(keys, id: \.self) { key in
                HStack(spacing: 14) {
                    Image(systemName: key.hasPrefix("parakeet-") ? "bird" : "waveform.badge.magnifyingglass")
                        .frame(width: 28).foregroundStyle(Theme.muted)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(displayName(key))
                        Text(models.sizes[key].map { ByteCountFormatter.string(fromByteCount: $0, countStyle: .file) } ?? "…")
                            .font(Typo.sm).foregroundStyle(Theme.muted)
                    }
                    Spacer()
                    if isActive(key) {
                        Text("In Verwendung").font(Typo.sm.weight(.semibold)).foregroundStyle(Theme.green)
                    } else {
                        Button(role: .destructive) { models.delete(key) } label: { IconView(.trash, size: 15) }
                            .buttonStyle(.icon())
                            .accessibilityLabel("\(displayName(key)) löschen")
                    }
                }
            }
        } header: {
            SectionHeader(title: String(localized: "Auf diesem iPhone"),
                          trailing: total > 0 ? ByteCountFormatter.string(fromByteCount: total, countStyle: .file) : nil)
        }
    }

    private func displayName(_ key: String) -> String {
        if key.hasPrefix("parakeet-") {
            let id = String(key.dropFirst("parakeet-".count))
            return DictationSettings.parakeetModels.first { $0.id == id }?.name ?? key
        }
        return "Whisper " + (DictationSettings.whisperModels.first { $0.id == key }?.name ?? key)
    }

    private func isActive(_ key: String) -> Bool {
        switch settings.engine {
        case .parakeet: return key == "parakeet-\(settings.parakeetModel)"
        case .whisper: return key == settings.whisperModel
        case .apple: return false
        }
    }

    private var engineFooter: String {
        switch settings.engine {
        case .parakeet: return String(localized: "Empfohlen: sehr genau bei Deutsch mit englischen Fachwörtern, läuft auf der Neural Engine.")
        case .whisper: return String(localized: "Large v3 ist am genauesten, braucht aber mehr Zeit und Speicher.")
        case .apple: return String(localized: "Schnellster Start, Fachwörter werden als Kontext genutzt (max. 100).")
        }
    }

    // MARK: Engine sections

    private var parakeetSection: some View {
        @Bindable var settings = settings
        return Section {
            ForEach(DictationSettings.parakeetModels) { model in
                let key = "parakeet-\(model.id)"
                modelRow(model, key: key, selected: settings.parakeetModel == model.id,
                         select: { settings.parakeetModel = model.id },
                         download: { models.downloadParakeet(model.id, settings: settings) })
            }
            Toggle(isOn: $settings.parakeetBoost) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Fachwort-Boost")
                    Text("Zusatzmodell (≈ 100 MB) erkennt deine Fachwörter im Audio und korrigiert sie")
                        .font(Typo.sm).foregroundStyle(Theme.muted)
                }
            }
        } header: {
            SectionHeader(title: String(localized: "Parakeet-Modelle"))
        }
    }

    private var whisperSection: some View {
        @Bindable var settings = settings
        return Group {
            Section {
                ForEach(DictationSettings.whisperModels) { model in
                    modelRow(model, key: model.id, selected: settings.whisperModel == model.id,
                             select: { settings.whisperModel = model.id },
                             download: { models.downloadWhisper(model.id, settings: settings) })
                }
            } header: {
                SectionHeader(title: String(localized: "Whisper-Modelle (mehrsprachig)"))
            }
            Section {
                Stepper(value: $settings.whisperFallbacks, in: 0...5) {
                    LabeledContent {
                        Text(verbatim: "\(settings.whisperFallbacks)").font(Typo.monoSmall).foregroundStyle(Theme.muted)
                    } label: {
                        Text("Wiederholungen bei Unsicherheit")
                    }
                }
                Toggle("Lange Aufnahmen an Pausen teilen (VAD)", isOn: $settings.whisperVAD)
            } header: {
                SectionHeader(title: String(localized: "Feintuning"))
            } footer: {
                Text("Mehr Wiederholungen = robuster bei schwierigen Stellen, aber langsamer.")
                    .font(Typo.sm).foregroundStyle(Theme.dim)
            }
        }
    }

    private var appleSection: some View {
        @Bindable var settings = settings
        return Section {
            Toggle("Satzzeichen & Großschreibung", isOn: $settings.applePunctuation)
        } header: {
            SectionHeader(title: String(localized: "Apple"))
        }
    }

    private func engineRow(_ engine: DictationSettings.Engine, note: String, icon: String) -> some View {
        Button { settings.engine = engine } label: {
            HStack(spacing: 14) {
                Image(systemName: icon).frame(width: 28).foregroundStyle(Theme.muted)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(engine.title).foregroundStyle(Theme.fg)
                        if engine == .parakeet { RecommendedBadge() }
                    }
                    Text(note).font(Typo.sm).foregroundStyle(Theme.muted)
                }
                Spacer()
                if settings.engine == engine { Image(.check).foregroundStyle(Theme.accent) }
            }
        }
        .accessibilityAddTraits(settings.engine == engine ? .isSelected : [])
    }

    /// One model: loaded (tap = use it), loading (bar and percent), or not here (download with its size).
    private func modelRow(_ model: DictationSettings.Model, key: String, selected: Bool,
                          select: @escaping () -> Void, download: @escaping () -> Void) -> some View {
        let progress = models.progress[key]
        let downloaded = models.isDownloaded(key)
        return Button {
            if downloaded { select() } else if progress == nil { download() }
        } label: {
            HStack(spacing: 14) {
                Image(systemName: selected && downloaded ? "largecircle.fill.circle" : "circle")
                    .font(.system(size: 20))
                    .foregroundStyle(selected && downloaded ? Theme.accent : Theme.dim)
                    .frame(width: 28)
                VStack(alignment: .leading, spacing: 3) {
                    Text(model.name).foregroundStyle(Theme.fg)
                    Text(model.note).font(Typo.sm).foregroundStyle(Theme.muted)
                    if let progress {
                        HStack(spacing: Gap.s) {
                            ProgressView(value: progress).tint(Theme.accent)
                            Text(verbatim: "\(Int(progress * 100)) %").font(Typo.monoSmall).foregroundStyle(Theme.muted)
                        }
                    } else if let error = models.errors[key] {
                        Text(error).font(Typo.xs).foregroundStyle(Theme.warn)
                    }
                }
                Spacer(minLength: Gap.s)
                if progress != nil {
                    EmptyView()
                } else if downloaded {
                    Text("Geladen").font(Typo.sm.weight(.semibold)).foregroundStyle(Theme.green)
                } else {
                    HStack(spacing: 4) {
                        Image(systemName: "arrow.down.circle")
                        Text(model.size)
                    }
                    .font(Typo.sm).foregroundStyle(Theme.accent)
                }
            }
        }
        .disabled(progress != nil)
        .accessibilityHint(downloaded ? String(localized: "Verwenden") : String(localized: "Laden"))
        .swipeActions {
            if downloaded && !selected { Button("Löschen", role: .destructive) { models.delete(key) } }
        }
    }
}
