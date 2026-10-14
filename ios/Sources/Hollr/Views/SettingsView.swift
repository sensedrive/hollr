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
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    } icon: { Image(systemName: "waveform") }
                }
            }
            Section {
                VStack(alignment: .leading, spacing: 10) {
                    HStack {
                        Label("Textgröße", systemImage: "textformat.size")
                        Spacer()
                        Text(scaleIndex == TextScale.system ? "Wie iOS" : TextScale.label(TextScale.steps[scaleIndex]))
                            .foregroundStyle(.secondary)
                    }
                    HStack(spacing: 12) {
                        Image(systemName: "textformat.size.smaller").foregroundStyle(.secondary)
                        Slider(value: Binding(
                            get: { Double(TextScale.steps.firstIndex(of: TextScale.size(scaleIndex, system: typeSize)) ?? 3) },
                            set: { scaleIndex = Int($0.rounded()) }
                        ), in: 0...Double(TextScale.steps.count - 1), step: 1)
                        Image(systemName: "textformat.size.larger").foregroundStyle(.secondary)
                    }
                }
                if scaleIndex != TextScale.system {
                    Button("Wie iOS (Systemeinstellung)") { scaleIndex = TextScale.system }
                }
            } header: {
                Text("Ansicht")
            } footer: {
                Text("Skaliert die ganze App. Im Chat geht's auch mit zwei Fingern (auf-/zuziehen) oder im Lesemodus.")
            }
            Section {
                NavigationLink { DesignSettingsView() } label: {
                    LabeledContent {
                        Text(UserDefaults.standard.bool(forKey: ThemeSettings.followKey)
                             ? "Automatisch" : (UserDefaults.standard.string(forKey: ThemeSettings.selectedKey) ?? Palette.hollr.name))
                    } label: {
                        Label("Design", systemImage: "paintpalette")
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
                Text("Sicherheit")
            } footer: {
                Text("Fragt beim Öffnen und nach mehr als 30 Sekunden im Hintergrund.")
            }
            Section {
                NavigationLink { PushSettingsView() } label: {
                    Label("Mitteilungen", systemImage: "bell.badge")
                }
            }
            Section {
                NavigationLink { ServersView(onPair: onPair) } label: {
                    LabeledContent {
                        Text("\(store.servers.count)")
                    } label: {
                        Label("Server & Geräte", systemImage: "server.rack")
                    }
                }
            }
            Section {
                Button {
                    if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
                } label: {
                    LabeledContent {
                        Text(Locale.current.localizedString(forLanguageCode: Bundle.main.preferredLocalizations.first ?? "de") ?? "")
                    } label: {
                        Label("App-Sprache", systemImage: "globe")
                    }
                }
                .foregroundStyle(.primary)
            } footer: {
                Text("Deutsch oder Englisch – iOS stellt die Sprache pro App um.")
            }
            Section {
                NavigationLink { ReleaseNotesView() } label: {
                    HStack {
                        Label("Neuigkeiten", systemImage: "sparkles")
                        Spacer()
                        if ReleaseNotes.hasUnseen {
                            Text("Neu").font(.caption.weight(.semibold)).foregroundStyle(Theme.onAccent)
                                .padding(.horizontal, 8).padding(.vertical, 3)
                                .background(Theme.accent, in: Capsule())
                        }
                    }
                }
            }
            Section("Über") {
                LabeledContent("Version", value: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "?")
                LabeledContent("Build", value: Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "?")
            }
        }
            .listRowBackground(Theme.card)
        }.themedList()
        .navigationTitle("Einstellungen")
        .navigationDestination(isPresented: $showSpeech) { SpeechSettingsView() }
    }

}

/// Local speech-to-text: engines, models, vocabulary, fine tuning – everything on-device.
struct SpeechSettingsView: View {
    @Environment(DictationSettings.self) private var settings
    @State private var dictator = Dictator()
    @State private var models = ModelManager()
    @State private var testText = ""

    var body: some View {
        @Bindable var settings = settings
        List {
            Group {
            Section("Transkription testen") {
                HStack(spacing: 12) {
                    Text(testDisplay)
                        .foregroundStyle(testText.isEmpty && !dictator.isRecording ? .secondary : .primary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .textSelection(.enabled)
                    Button {
                        Task {
                            if dictator.isRecording {
                                testText = await dictator.stop(settings: settings)
                            } else {
                                testText = ""
                                await dictator.start(settings: settings)
                            }
                        }
                    } label: {
                        Group {
                            if dictator.state == .transcribing { ProgressView().tint(.white) }
                            else { Image(systemName: dictator.isRecording ? "stop.fill" : "mic.fill") }
                        }
                        .foregroundStyle(.white)
                        .frame(width: 44, height: 44)
                        .background(Color.red, in: Circle())
                    }
                    .buttonStyle(.plain)
                    .disabled(dictator.state == .transcribing)
                }
                if case .failed(let message) = dictator.state {
                    Text(message).font(.caption).foregroundStyle(Theme.warn)
                }
            }

            Section {
                engineRow(.parakeet, note: String(localized: "NVIDIA, 25 Sprachen, Deutsch + Englisch im selben Satz"), icon: "bird")
                engineRow(.whisper, note: String(localized: "OpenAI, 99 Sprachen, höchste Genauigkeit mit Large v3"), icon: "waveform.badge.magnifyingglass")
                engineRow(.apple, note: String(localized: "Ohne Download, Text erscheint schon beim Sprechen"), icon: "apple.logo")
            } header: {
                Text("Sprach-Engine")
            } footer: {
                Text(engineFooter)
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
                Text("Allgemein")
            } footer: {
                Text(settings.engine == .parakeet
                     ? String(localized: "Parakeet erkennt die Sprache selbst – auch gemischt Deutsch/Englisch.")
                     : String(localized: "Für Deutsch mit englischen Fachbegriffen „Deutsch“ wählen – das ist genauer als „Automatisch“."))
                + Text(" ") + Text("Mikrofon antippen startet und beendet, gedrückt halten diktiert bis zum Loslassen.")
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
                    Text(reason).font(.caption).foregroundStyle(.secondary)
                }
            } header: {
                Text("Text")
            } footer: {
                Text("Session-Wörter: Projekt, Ordner, Tickets (z. B. TENDR-725) und Dateinamen aus dem Chat helfen der Erkennung und werden richtig geschrieben. Der Feinschliff korrigiert Satzzeichen und Schreibweisen auf dem Gerät – dauert etwa eine Sekunde.")
            }

            Section {
                Toggle(isOn: $settings.noiseSuppression) {
                    Label("Rauschfilter", systemImage: "waveform.path.ecg")
                }
                Toggle(isOn: $settings.preferBuiltInMic) {
                    Label("Immer iPhone-Mikrofon", systemImage: "iphone")
                }
            } header: {
                Text("Mikrofon")
            } footer: {
                Text("Der Rauschfilter dämpft Straße, Café und Lüfter. „Immer iPhone-Mikrofon“ nimmt nicht über AirPods auf – deren Mikro klingt am Telefon-Kanal dünner und wird schlechter erkannt.")
            }

            Section {
                Toggle("Fachwörter verwenden", isOn: $settings.useVocabulary)
                TextEditor(text: $settings.vocabularyText)
                    .font(.system(.footnote, design: .monospaced))
                    .frame(minHeight: 180)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                    .disabled(!settings.useVocabulary)
                Button("Standardliste wiederherstellen") { settings.vocabularyText = DictationSettings.defaultVocabulary }
                    .font(.footnote)
            } header: {
                Text("Fachwörter (\(settings.terms.count))")
            } footer: {
                Text("Ein Begriff pro Zeile, falsch verstandene Varianten nach „=“: z. B. „JIRA = Jira, Dschira“. Die Liste fließt in alle Engines ein (Apple-Kontext, Whisper-Prompt, Parakeet-Boost) und korrigiert danach Schreibweisen.")
            }

            Section {
                ForEach($settings.replacements) { $r in
                    HStack {
                        TextField("gehört", text: $r.from).autocorrectionDisabled()
                        Image(systemName: "arrow.right").foregroundStyle(.secondary)
                        TextField("ersetzen durch", text: $r.to).autocorrectionDisabled()
                    }
                }
                .onDelete { settings.replacements.remove(atOffsets: $0) }
                Button { settings.replacements.append(.init(from: "", to: "")) } label: {
                    Label("Ersetzung hinzufügen", systemImage: "plus")
                }
            } header: {
                Text("Wortersetzungen")
            } footer: {
                Text("Feste Ersetzungen nach der Erkennung, z. B. „Komma“ → „,“.")
            }
        }
            .listRowBackground(Theme.card)
        }.themedList()
        .navigationTitle("Sprache")
        .navigationBarTitleDisplayMode(.inline)
        .id(models.revision)
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
                modelRow(model, key: "parakeet-\(model.id)", downloaded: ParakeetCache.isDownloaded(model.id),
                         selected: settings.parakeetModel == model.id,
                         select: { settings.parakeetModel = model.id },
                         download: { models.downloadParakeet(model.id, boost: settings.parakeetBoost) },
                         delete: { models.deleteParakeet(model.id) })
            }
            Toggle(isOn: $settings.parakeetBoost) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Fachwort-Boost")
                    Text("Zusatzmodell (≈ 100 MB) erkennt deine Fachwörter im Audio und korrigiert sie")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
        } header: {
            Text("Parakeet-Modelle")
        }
    }

    private var whisperSection: some View {
        @Bindable var settings = settings
        return Group {
            Section("Whisper-Modelle (mehrsprachig)") {
                ForEach(DictationSettings.whisperModels) { model in
                    modelRow(model, key: model.id, downloaded: settings.downloaded[model.id] != nil,
                             selected: settings.whisperModel == model.id,
                             select: { settings.whisperModel = model.id },
                             download: { models.downloadWhisper(model.id, settings: settings) },
                             delete: { models.deleteWhisper(model.id, settings: settings) })
                }
            }
            Section {
                Stepper(value: $settings.whisperFallbacks, in: 0...5) {
                    LabeledContent("Wiederholungen bei Unsicherheit", value: "\(settings.whisperFallbacks)")
                }
                Toggle("Lange Aufnahmen an Pausen teilen (VAD)", isOn: $settings.whisperVAD)
            } header: {
                Text("Feintuning")
            } footer: {
                Text("Mehr Wiederholungen = robuster bei schwierigen Stellen, aber langsamer.")
            }
        }
    }

    private var appleSection: some View {
        @Bindable var settings = settings
        return Section("Apple") {
            Toggle("Satzzeichen & Großschreibung", isOn: $settings.applePunctuation)
        }
    }

    private var testDisplay: String {
        if dictator.isRecording { return dictator.text.isEmpty ? String(localized: "Ich höre zu … (zum Beenden tippen)") : dictator.text }
        if dictator.state == .transcribing { return "Transkribiere …" }
        if case .preparing(let m) = dictator.state { return m }
        return testText.isEmpty ? String(localized: "Tippen, um eine Testtranskription aufzunehmen") : testText
    }

    private func engineRow(_ engine: DictationSettings.Engine, note: String, icon: String) -> some View {
        Button { settings.engine = engine } label: {
            HStack(spacing: 14) {
                Image(systemName: icon).frame(width: 28)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(engine.title).foregroundStyle(.primary)
                        if engine == .parakeet {
                            Text("EMPFOHLEN").font(.caption2.bold()).foregroundStyle(Theme.live)
                                .padding(.horizontal, 6).padding(.vertical, 2)
                                .background(Theme.live.opacity(0.15), in: Capsule())
                        }
                    }
                    Text(note).font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                if settings.engine == engine { Image(systemName: "checkmark").foregroundStyle(Theme.live) }
            }
        }
    }

    private func modelRow(_ model: DictationSettings.Model, key: String, downloaded: Bool, selected: Bool,
                          select: @escaping () -> Void, download: @escaping () -> Void,
                          delete: @escaping () -> Void) -> some View {
        let progress = models.progress[key]
        return HStack(spacing: 14) {
            Image(systemName: "cpu").frame(width: 28).foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 2) {
                Text(model.name)
                Text("\(model.size) · \(model.note)").font(.caption).foregroundStyle(.secondary)
                if let error = models.errors[key] { Text(error).font(.caption2).foregroundStyle(Theme.warn) }
            }
            Spacer()
            if let progress {
                ProgressView(value: progress).frame(width: 60)
            } else if downloaded {
                if selected {
                    Image(systemName: "checkmark").foregroundStyle(Theme.live)
                } else {
                    Button("Wählen", action: select).buttonStyle(.borderless)
                }
            } else {
                Button(action: download) { Image(systemName: "arrow.down.circle") }.buttonStyle(.borderless)
            }
        }
        .swipeActions {
            if downloaded { Button("Löschen", role: .destructive, action: delete) }
        }
    }
}
