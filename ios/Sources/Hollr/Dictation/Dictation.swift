import AVFoundation
import FluidAudio
import Foundation
import Observation
import Speech
import UIKit
import WhisperKit

/// What the open session contributes to recognition (repo, branch, tickets, files …).
struct DictationContext {
    var terms: [String] = []
}

/// On-device speech-to-text for the composer – independent of omp /live.
/// Engines: Parakeet (FluidAudio), Whisper (WhisperKit), Apple (DictationTranscriber, iOS 26).
///
/// Audio runs on the audio thread (AudioCollector); Parakeet/Whisper transcribe in chunks at
/// speech pauses while you talk, so only the last few seconds are left when you stop.
@MainActor
@Observable
final class Dictator {
    enum State: Equatable {
        case idle, preparing(String), recording, transcribing
        case failed(String)
    }

    private(set) var state: State = .idle
    /// Recognised text so far (Apple streams it, Parakeet/Whisper fill it chunk by chunk plus a live preview).
    private(set) var text = ""
    /// the end of `text` that is only a preview of what is being said now (Parakeet/Whisper) – it may still change
    private(set) var pending = ""
    private(set) var level: Float = 0
    /// the speech model being loaded into memory right now ("Whisper Large v3 Turbo"), nil when it's ready – the
    /// first load after an app update compiles it for the Neural Engine and can take a minute or two
    private(set) var loadingModel: String?
    /// short notice after a dictation ("Nichts verstanden", "Aufnahme unterbrochen" …)
    private(set) var notice: String?
    /// The chat (draft key) this dictation belongs to – one microphone, one dictation in the whole app.
    /// It is app-wide so zen mode or a new layout (another composer view) doesn't stop it.
    private(set) var owner: String?
    /// where the result goes (inserted into the draft, maybe sent) – set at start, not by a view
    private var deliver: ((String) -> Void)?

    /// Loads the engine's model in the background while you already speak (the audio is kept); while it isn't in
    /// memory yet, `loadingModel` says so – the overlay tells you why no text comes yet.
    private func trackLoad(label: String, loaded: @escaping () async -> Bool, load: @escaping () async throws -> Void) {
        let gen = generation
        Task { [weak self] in
            if await loaded() { return }
            guard let self, gen == self.generation else { return }
            self.loadingModel = label
            let started = Date()
            do {
                try await load()
                HollrLog.info("dictation: \(label) loaded in \(String(format: "%.1f", Date().timeIntervalSince(started)))s")
            } catch {
                HollrLog.error("dictation: loading \(label) failed: \(error)")
                if gen == self.generation, self.isBusy {
                    self.notice = String(localized: "\(label) ließ sich nicht laden: \(error.localizedDescription)")
                }
            }
            if self.loadingModel == label { self.loadingModel = nil }
        }
    }
    /// composers on screen per chat: when the last one goes away, the dictation ends and keeps its text
    private var visible: [String: Int] = [:]

    var isRecording: Bool { state == .recording }
    /// recording, but the microphone is paused (the overlay's big button); what was said so far is
    /// transcribed meanwhile
    private(set) var paused = false
    /// seconds of audio taken so far (pauses don't count) – the overlay's clock, read on its own timer
    var recordedSeconds: Double { Double(collector.count) / Double(AudioCollector.rate) }
    var isBusy: Bool {
        switch state {
        case .preparing, .recording, .transcribing: return true
        default: return false
        }
    }

    private let engine = AVAudioEngine()
    private let collector = AudioCollector()
    private var apple: AnyObject?
    private var legacy: LegacyAppleEngine?
    private var active: DictationSettings.Engine = .apple
    private var settings: DictationSettings?
    private var context = DictationContext()
    /// chunked transcription while recording
    private var committed = ""
    private var cut = 0
    private var chunks: Task<Void, Never>?
    private var chunkTimer: Task<Void, Never>?
    /// chunks waiting for or in transcription; the live preview waits while there are any
    private var pendingChunks = 0
    /// the live preview in flight, and when the last one started
    private var previewing: Task<Void, Never>?
    private var lastPreview = Date.distantPast
    private var observers: [NSObjectProtocol] = []
    /// bumped by every start and cancel: work of an older dictation (a slow start, a chunk) is dropped
    private var generation = 0
    /// stop was asked for while the microphone was still starting (released hold-to-talk early)
    private var stopWhenReady = false

    // MARK: Start / stop

    func start(settings: DictationSettings, context: DictationContext = DictationContext(),
               owner: String? = nil, deliver: ((String) -> Void)? = nil) async {
        guard !isBusy else { return }
        generation += 1
        let gen = generation
        // busy right away: a second tap during the (slow) start must not start a second recording
        state = .preparing("")
        stopWhenReady = false
        self.owner = owner
        self.deliver = deliver
        self.settings = settings
        self.context = settings.sessionVocabulary ? context : DictationContext()
        text = ""
        pending = ""
        pendingChunks = 0
        lastPreview = .distantPast
        notice = nil
        committed = ""
        cut = 0
        collector.reset()
        active = settings.engine
        do {
            guard await AVAudioApplication.requestRecordPermission() else {
                throw DictationError.message(String(localized: "Mikrofon-Zugriff fehlt (Einstellungen › Hollr › Mikrofon)."))
            }
            guard gen == generation else { return }
            let terms = settings.allTerms(extra: self.context.terms)
            var madeApple: AnyObject?
            var madeLegacy: LegacyAppleEngine?
            switch active {
            case .parakeet:
                guard ParakeetCache.isDownloaded(settings.parakeetModel) else {
                    throw DictationError.message(String(localized: "\(settings.engineLabel) ist auf diesem Gerät nicht geladen – Einstellungen › Sprache."))
                }
                let model = settings.parakeetModel, boost = settings.useVocabulary && settings.parakeetBoost
                trackLoad(label: settings.engineLabel, loaded: { await ParakeetCache.shared.isLoaded(model) }) {
                    try await ParakeetCache.shared.prepare(model: model, boost: boost, terms: terms)
                }
            case .whisper:
                guard let folder = DictationSettings.whisperFolder(settings.whisperModel)?.path else {
                    throw DictationError.message(String(localized: "\(settings.engineLabel) ist auf diesem Gerät nicht geladen – Einstellungen › Sprache."))
                }
                let model = settings.whisperModel
                trackLoad(label: settings.engineLabel, loaded: { await WhisperCache.shared.isLoaded(model) }) {
                    _ = try await WhisperCache.shared.kit(model: model, folder: folder)
                }
            case .apple:
                let words = settings.useVocabulary ? terms.map(\.text) : []
                if #available(iOS 26, *), let a = try? await AppleDictationEngine.make(
                    locale: settings.locale, punctuation: settings.applePunctuation,
                    vocabulary: words,
                    onPrepare: { [weak self] in Task { @MainActor in
                        guard let self, gen == self.generation else { return }
                        self.state = .preparing(String(localized: "Sprachmodell wird geladen …"))
                    } },
                    onText: { [weak self] text in Task { @MainActor in
                        guard let self, gen == self.generation else { return }
                        self.text = text
                    } }
                ) {
                    madeApple = a
                } else {
                    madeLegacy = try await LegacyAppleEngine.make(locale: settings.locale) { [weak self] text in
                        Task { @MainActor in
                            guard let self, gen == self.generation else { return }
                            self.text = text
                        }
                    }
                }
            }
            // cancelled (or restarted) while the engine was being made
            guard gen == generation else {
                if #available(iOS 26, *) { (madeApple as? AppleDictationEngine)?.cancel() }
                madeLegacy?.cancel()
                return
            }
            apple = madeApple
            legacy = madeLegacy

            let session = AVAudioSession.sharedInstance()
            // iPhone mic preferred: no Bluetooth route (AirPods' headset mic is narrowband and noisier)
            var options: AVAudioSession.CategoryOptions = [.defaultToSpeaker]
            if !settings.preferBuiltInMic { options.insert(.allowBluetooth) }
            try session.setCategory(.playAndRecord, mode: settings.noiseSuppression ? .voiceChat : .measurement, options: options)
            try session.setActive(true)
            if settings.preferBuiltInMic,
               let builtIn = session.availableInputs?.first(where: { $0.portType == .builtInMic }) {
                try? session.setPreferredInput(builtIn)
            } else {
                try? session.setPreferredInput(nil)
            }
            let input = engine.inputNode
            // Apple's voice processing: noise suppression and level control for noisy places
            try? input.setVoiceProcessingEnabled(settings.noiseSuppression)
            let format = input.outputFormat(forBus: 0)
            // no microphone (in use by a call, route just vanished): installTap would crash on a 0 Hz format
            guard format.sampleRate > 0, format.channelCount > 0 else {
                throw DictationError.message(String(localized: "Kein Mikrofon verfügbar – läuft gerade ein Anruf?"))
            }

            collector.onLevel = { [weak self] rms in Task { @MainActor in self?.level = rms } }
            let collector = self.collector
            let appleEngine = apple
            let legacyEngine = legacy
            let usesSamples = active != .apple
            // audio thread: nothing here waits for the UI
            input.installTap(onBus: 0, bufferSize: 2048, format: format) { buffer, _ in
                if usesSamples {
                    collector.ingest(buffer)
                } else {
                    if #available(iOS 26, *), let a = appleEngine as? AppleDictationEngine { a.feed(buffer) } else { legacyEngine?.feed(buffer) }
                    collector.ingest(buffer) // level meter
                }
            }
            engine.prepare()
            try engine.start()
            observeInterruptions()
            state = .recording
            if usesSamples { startChunking() }
            HollrLog.info("dictation: recording with \(active.rawValue)")
            if stopWhenReady {
                stopWhenReady = false
                await finish()
            }
        } catch {
            guard gen == generation else { return }
            cleanupAudio()
            reset()
            self.deliver = nil
            self.owner = nil
            state = .failed(error.localizedDescription)
            HollrLog.error("dictation start: \(error)")
        }
    }

    /// Stops and hands the text to whoever started the dictation.
    func finish() async {
        if case .preparing = state { stopWhenReady = true; return }
        guard state == .recording, let settings else { return }
        let deliver = self.deliver
        self.deliver = nil
        let gen = generation
        let text = await stop(settings: settings)
        // thrown away (✕) while the text was still being made: nobody gets it
        guard gen == generation else { return }
        owner = nil
        deliver?(text)
    }

    func composerAppeared(_ key: String) { visible[key, default: 0] += 1 }

    /// The chat's last composer is gone (left the chat, closed it): end the dictation, keep the text.
    func composerDisappeared(_ key: String) {
        visible[key] = max((visible[key] ?? 1) - 1, 0)
        guard key == owner else { return }
        Task { @MainActor in
            // zen mode swaps the composer: the new one appears right after the old one went away
            try? await Task.sleep(for: .milliseconds(400))
            guard self.owner == key, (self.visible[key] ?? 0) == 0 else { return }
            HollrLog.info("dictation: chat left while recording – stopping")
            await self.finish()
        }
    }

    /// Stops recording and returns the final text (cleaned up, vocabulary applied).
    func stop(settings: DictationSettings) async -> String {
        guard state == .recording else { return "" }
        cleanupAudio()
        state = .transcribing
        let gen = generation
        let started = Date()
        let seconds = Double(collector.count) / Double(AudioCollector.rate)
        var result = ""
        do {
            switch active {
            case .parakeet, .whisper:
                // only the tail after the last chunk is left to do
                let tail = collector.slice(cut..<collector.count)
                await chunks?.value
                result = committed
                // a failing last piece must not throw away what is already recognised
                do {
                    if let piece = try await transcribeChunk(tail) { result = join(result, piece) }
                } catch {
                    HollrLog.error("dictation tail: \(error)")
                    if result.isEmpty { throw error }
                    notice = String(localized: "Der letzte Teil wurde nicht erkannt.")
                }
            case .apple:
                if #available(iOS 26, *), let a = apple as? AppleDictationEngine {
                    result = await a.finish()
                } else if let legacy {
                    result = await legacy.finish()
                }
            }
            HollrLog.info("dictation: \(active.rawValue) took \(String(format: "%.1f", Date().timeIntervalSince(started)))s after stop, \(Int(seconds))s audio")
        } catch {
            guard gen == generation else { return "" }
            state = .failed(error.localizedDescription)
            HollrLog.error("dictation stop: \(error)")
            reset()
            return ""
        }
        // cancelled meanwhile: cancel() already reset everything
        guard gen == generation else { return "" }
        reset()
        var cleaned = settings.finish(result, extraTerms: context.terms)
        if settings.polish, !cleaned.isEmpty {
            state = .transcribing
            cleaned = await LocalPolish.polish(cleaned, terms: settings.allTerms(extra: context.terms).map(\.text), language: settings.language)
            guard gen == generation else { return "" }
        }
        if cleaned.isEmpty {
            notice = seconds < 0.6 ? String(localized: "Zu kurz – etwas länger sprechen.") : String(localized: "Nichts verstanden.")
        }
        state = .idle
        text = cleaned
        return cleaned
    }

    /// Throws the recording away.
    func cancel() {
        generation += 1
        stopWhenReady = false
        if state == .recording { cleanupAudio() }
        reset()
        owner = nil
        deliver = nil
        text = ""
        state = .idle
    }

    // MARK: Pause / resume (the composer's big button)

    /// Stops listening without ending the dictation: the microphone goes off, what was said up to now is
    /// transcribed right away (Parakeet/Whisper), so the text is complete while paused.
    func pause() {
        guard state == .recording, !paused else { return }
        engine.pause()
        paused = true
        level = 0
        guard active != .apple else { return }
        let total = collector.count
        guard total > cut else { return }
        let piece = collector.slice(cut..<total)
        cut = total
        enqueueChunk(piece)
    }

    func resume() {
        guard state == .recording, paused else { return }
        do {
            try AVAudioSession.sharedInstance().setActive(true)
            try engine.start()
            paused = false
        } catch {
            HollrLog.error("dictation resume: \(error)")
            notice = String(localized: "Mikrofon ließ sich nicht wieder einschalten.")
        }
    }

    private func reset() {
        paused = false
        pending = ""
        chunkTimer?.cancel()
        chunkTimer = nil
        chunks?.cancel()
        chunks = nil
        previewing?.cancel()
        previewing = nil
        pendingChunks = 0
        // a dropped engine would keep its analyzer waiting for audio forever
        if #available(iOS 26, *) { (apple as? AppleDictationEngine)?.cancel() }
        legacy?.cancel()
        apple = nil
        legacy = nil
        collector.onLevel = nil
    }

    private func cleanupAudio() {
        for o in observers { NotificationCenter.default.removeObserver(o) }
        observers = []
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        level = 0
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    // MARK: Interruptions – a call, another app, the headset going away

    private func observeInterruptions() {
        let center = NotificationCenter.default
        let stopNow: (String) -> Void = { [weak self] why in
            Task { @MainActor in
                guard let self, self.state == .recording else { return }
                HollrLog.info("dictation: stopped by the system (\(why))")
                await self.finish()
                if case .failed = self.state {} else {
                    self.notice = String(localized: "Aufnahme unterbrochen – das Gesagte ist eingefügt.")
                }
            }
        }
        observers.append(center.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { note in
            let type = (note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt).flatMap(AVAudioSession.InterruptionType.init)
            if type == .began { stopNow("interruption") }
        })
        observers.append(center.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main) { note in
            let reason = (note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt).flatMap(AVAudioSession.RouteChangeReason.init)
            if reason == .oldDeviceUnavailable { stopNow("route") }
        })
        observers.append(center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { _ in
            stopNow("background")
        })
    }

    // MARK: Chunked transcription (Parakeet / Whisper)

    private func startChunking() {
        chunkTimer = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(500))
                guard let self, self.state == .recording else { return }
                if self.paused { continue }
                let total = self.collector.count
                if let point = Silence.cutPoint(energies: self.collector.energies(), from: self.cut, total: total),
                   point > self.cut {
                    let piece = self.collector.slice(self.cut..<point)
                    self.cut = point
                    self.enqueueChunk(piece)
                } else {
                    self.previewTail(total: total)
                }
            }
        }
    }

    /// Transcribes one piece after the ones before it and adds it to the text.
    private func enqueueChunk(_ piece: [Float]) {
        let previous = chunks
        let gen = generation
        pendingChunks += 1
        chunks = Task { [weak self] in
            await previous?.value
            guard let self else { return }
            // a chunk of an older dictation must not count against the new one
            defer { if gen == self.generation { self.pendingChunks = max(0, self.pendingChunks - 1) } }
            guard !Task.isCancelled, gen == self.generation else { return }
            do {
                guard let text = try await self.transcribeChunk(piece), gen == self.generation else { return }
                self.committed = self.join(self.committed, text)
                self.pending = ""
                if self.state == .recording { self.text = self.committed }
            } catch {
                HollrLog.error("dictation chunk: \(error)")
            }
        }
    }

    // MARK: Live preview – what is being said right now

    /// a chunk is only cut at a pause after ≥ 6 s of speech, so the text would stay empty that long: the audio
    /// since the last cut is transcribed on its own every ~1 s (Whisper ~2 s) and shown after the committed text;
    /// the chunk replaces it once it's cut. Never while a chunk is being transcribed (it wins the model).
    private func previewTail(total: Int) {
        guard previewing == nil, pendingChunks == 0 else { return }
        let rate = AudioCollector.rate
        let tail = total - cut
        let every = active == .whisper ? 2.0 : 1.0
        guard tail >= rate, Date().timeIntervalSince(lastPreview) >= every,
              active != .whisper || tail <= 25 * rate else { return }
        let from = cut
        let piece = collector.slice(from..<total)
        let gen = generation
        lastPreview = Date()
        previewing = Task { [weak self] in
            guard let self else { return }
            defer { self.previewing = nil }
            guard let text = try? await self.transcribeChunk(piece),
                  gen == self.generation, self.state == .recording, self.cut == from else { return }
            self.pending = text
            self.text = self.join(self.committed, text)
        }
    }

    /// One piece of audio → text (silence trimmed, invented subtitles dropped); nil = nothing said.
    private func transcribeChunk(_ samples: [Float]) async throws -> String? {
        guard let settings, let speech = Silence.trim(samples) else { return nil }
        let terms = settings.allTerms(extra: context.terms)
        var text: String
        switch active {
        case .parakeet:
            text = try await ParakeetCache.shared.transcribe(
                speech, model: settings.parakeetModel, boost: settings.useVocabulary && settings.parakeetBoost, terms: terms
            )
        case .whisper:
            guard let folder = DictationSettings.whisperFolder(settings.whisperModel)?.path else {
                throw DictationError.message(String(localized: "\(settings.engineLabel) ist auf diesem Gerät nicht geladen – Einstellungen › Sprache."))
            }
            text = try await WhisperCache.shared.transcribe(
                speech, model: settings.whisperModel, folder: folder, language: settings.language,
                vocabulary: settings.useVocabulary ? terms.map(\.text) : [], context: committed,
                fallbacks: settings.whisperFallbacks, vad: settings.whisperVAD
            )
        case .apple:
            return nil
        }
        text = DictationText.dropHallucinations(text.replacingOccurrences(of: #"\[[A-Z_]+\]"#, with: "", options: .regularExpression))
        return text.isEmpty ? nil : text
    }

    private func join(_ a: String, _ b: String) -> String {
        [a, b].map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }.joined(separator: " ")
    }

    #if DEBUG
    /// Test hook: a whole dictation with an audio file instead of the microphone.
    func testWithFile(_ url: URL, settings: DictationSettings, context: DictationContext = DictationContext()) async -> String {
        guard let file = try? AVAudioFile(forReading: url) else { return "no file" }
        self.settings = settings
        self.context = context
        active = settings.engine
        text = ""
        pending = ""
        pendingChunks = 0
        lastPreview = .distantPast
        generation += 1
        committed = ""
        cut = 0
        collector.reset()
        state = .recording
        if active != .apple { startChunking() }
        let format = file.processingFormat
        var seen = ""
        while let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 4096),
              (try? file.read(into: buffer, frameCount: 4096)) != nil, buffer.frameLength > 0 {
            collector.ingest(buffer)
            try? await Task.sleep(for: .milliseconds(Int(Double(buffer.frameLength) / format.sampleRate * 1000)))
            if !text.isEmpty, text != seen { seen = text; HollrLog.info("dictate-test: live \(String(format: "%.1f", recordedSeconds))s: \(text.prefix(80))") }
        }
        HollrLog.info("dictate-test: \(committed.isEmpty ? "no" : "had") text before stop: \(committed.prefix(80))")
        return await stop(settings: settings)
    }
    #endif

    // MARK: Warm-up and memory

    /// Loads the model before the first dictation (called when a chat opens).
    static func prewarm(_ settings: DictationSettings) {
        switch settings.engine {
        case .parakeet where ParakeetCache.isDownloaded(settings.parakeetModel):
            let model = settings.parakeetModel
            Task.detached(priority: .utility) {
                await WhisperCache.shared.unload()
                try? await ParakeetCache.shared.prepare(model: model, boost: false, terms: [])
            }
        case .whisper:
            if let folder = DictationSettings.whisperFolder(settings.whisperModel)?.path {
                let model = settings.whisperModel
                Task.detached(priority: .utility) {
                    await ParakeetCache.shared.unload()
                    _ = try? await WhisperCache.shared.kit(model: model, folder: folder)
                }
            }
        default:
            Task.detached(priority: .utility) {
                await ParakeetCache.shared.unload()
                await WhisperCache.shared.unload()
            }
        }
    }

    /// Frees the models (memory warning, app in the background) – the next chat warms them up again.
    static func releaseModels() {
        Task.detached {
            await ParakeetCache.shared.unload()
            await WhisperCache.shared.unload()
        }
    }
}

enum DictationError: LocalizedError {
    case message(String)
    var errorDescription: String? {
        switch self { case .message(let m): return m }
    }
}

// MARK: - Parakeet (FluidAudio)

actor ParakeetCache {
    static let shared = ParakeetCache()
    private var loaded: (model: String, models: AsrModels, asr: AsrManager)?
    private var ctc: CtcModels?
    private var boosting: (key: Int, session: VocabularyBoostingSession)?

    nonisolated static func version(_ model: String) -> AsrModelVersion { model == "v3" ? .v3 : .ultra }

    nonisolated static func isDownloaded(_ model: String) -> Bool {
        let v = version(model)
        return AsrModels.modelsExist(at: AsrModels.defaultCacheDirectory(for: v), version: v)
    }

    nonisolated static var ctcDownloaded: Bool {
        CtcModels.modelsExist(at: CtcModels.defaultCacheDirectory(for: .ctc110m))
    }

    func download(model: String, boost: Bool, progress: @escaping @Sendable (Double) -> Void) async throws {
        _ = try await AsrModels.download(version: Self.version(model)) { p in progress(p.fractionCompleted * (boost ? 0.85 : 1)) }
        if boost { _ = try await CtcModels.downloadAndLoad(variant: .ctc110m); progress(1) }
    }

    /// the load in flight – warm-up, start and the first chunk all ask; the model is loaded once
    private var loading: (model: String, task: Task<(AsrModels, AsrManager), Error>)?

    func prepare(model: String, boost: Bool, terms: [DictationSettings.Term]) async throws {
        if loaded?.model != model {
            let task: Task<(AsrModels, AsrManager), Error>
            if let loading, loading.model == model {
                task = loading.task
            } else {
                task = Task {
                    let models = try await AsrModels.downloadAndLoad(version: Self.version(model))
                    let asr = AsrManager(config: .default)
                    try await asr.loadModels(models)
                    return (models, asr)
                }
                loading = (model, task)
            }
            defer { if loading?.model == model { loading = nil } }
            let (models, asr) = try await task.value
            if loaded?.model != model { loaded = (model, models, asr) }
        }
        if boost { _ = try await boostingSession(terms) }
    }

    private func boostingSession(_ terms: [DictationSettings.Term]) async throws -> VocabularyBoostingSession? {
        let usable = terms.filter { $0.text.count >= 3 }
        guard !usable.isEmpty else { return nil }
        let key = usable.hashValue
        if let boosting, boosting.key == key { return boosting.session }
        if ctc == nil { ctc = try await CtcModels.downloadAndLoad(variant: .ctc110m) }
        guard let ctc else { return nil }
        let vocab = CustomVocabularyContext(terms: usable.map { CustomVocabularyTerm(text: $0.text, aliases: $0.aliases) })
        let session = try await VocabularyBoostingSession(vocabulary: vocab, ctcModels: ctc)
        boosting = (key, session)
        return session
    }

    func transcribe(_ samples: [Float], model: String, boost: Bool, terms: [DictationSettings.Term]) async throws -> String {
        guard samples.count > 8_000 else { return "" }
        try await prepare(model: model, boost: false, terms: [])
        guard let loaded else { return "" }
        var state = try TdtDecoderState(decoderLayers: loaded.models.version.decoderLayers)
        let result = try await loaded.asr.transcribe(samples, decoderState: &state, language: nil)
        if boost, let session = try? await boostingSession(terms),
           let rescored = await session.rescore(text: result.text, tokenTimings: result.tokenTimings ?? [], audioSamples: samples) {
            return rescored.text
        }
        return result.text
    }

    func isLoaded(_ model: String) -> Bool { loaded?.model == model }

    func unload() {
        loaded = nil
        loading = nil
        boosting = nil
    }
}

// MARK: - Whisper (WhisperKit)

actor WhisperCache {
    static let shared = WhisperCache()
    private var current: (model: String, kit: WhisperKit)?
    private var loading: (model: String, task: Task<WhisperKit, Error>)?

    func kit(model: String, folder: String) async throws -> WhisperKit {
        if let current, current.model == model { return current.kit }
        let task: Task<WhisperKit, Error>
        if let loading, loading.model == model {
            task = loading.task
        } else {
            let config = WhisperKitConfig(model: model, modelFolder: folder, verbose: false, prewarm: true, load: true, download: false)
            task = Task { try await WhisperKit(config) }
            loading = (model, task)
        }
        defer { if loading?.model == model { loading = nil } }
        let kit = try await task.value
        current = (model, kit)
        return kit
    }

    func transcribe(_ samples: [Float], model: String, folder: String, language: String, vocabulary: [String],
                    context: String = "", fallbacks: Int, vad: Bool) async throws -> String {
        guard samples.count > 8_000 else { return "" }
        let kit = try await kit(model: model, folder: folder)
        var prompt: [Int]?
        if (!vocabulary.isEmpty || !context.isEmpty), let tok = kit.tokenizer {
            // Whisper keeps the last 111 prompt tokens: vocabulary as a sentence, then what was just said
            // (so a chunk continues the previous one in style and spelling)
            var text = vocabulary.isEmpty ? "" : " " + vocabulary.prefix(40).joined(separator: ", ") + "."
            if !context.isEmpty { text += " " + String(context.suffix(200)) }
            prompt = Array(tok.encode(text: text).filter { $0 < tok.specialTokens.specialTokenBegin }.suffix(110))
        }
        let auto = language == "auto"
        if samples.count > 30 * 16_000 { prompt = nil } // long audio: VAD chunks without prompt
        let options = DecodingOptions(
            task: .transcribe, language: auto ? nil : language,
            temperatureFallbackCount: fallbacks, usePrefillPrompt: !auto, detectLanguage: auto,
            promptTokens: prompt, compressionRatioThreshold: 2.4,
            // VAD chunking together with a prompt can stall WhisperKit – only split long recordings
            chunkingStrategy: vad && (prompt == nil || samples.count > 30 * 16_000) ? .vad : ChunkingStrategy.none
        )
        let results: [TranscriptionResult] = try await kit.transcribe(audioArray: samples, decodeOptions: options)
        return results.map(\.text).joined(separator: " ")
    }

    func isLoaded(_ model: String) -> Bool { current?.model == model }

    func unload() {
        current = nil
        loading = nil
    }
}

// MARK: - Apple DictationTranscriber (iOS 26+)

@available(iOS 26, *)
final class AppleDictationEngine: @unchecked Sendable {
    private let analyzer: SpeechAnalyzer
    private let format: AVAudioFormat?
    private let input: AsyncStream<AnalyzerInput>.Continuation
    private var converter: AVAudioConverter?
    private var resultsTask: Task<Void, Never>?
    private var finalized = ""
    private var volatile = ""

    private init(analyzer: SpeechAnalyzer, format: AVAudioFormat?, input: AsyncStream<AnalyzerInput>.Continuation) {
        self.analyzer = analyzer
        self.format = format
        self.input = input
    }

    static func make(locale wanted: Locale, punctuation: Bool, vocabulary: [String],
                     onPrepare: @escaping @Sendable () -> Void,
                     onText: @escaping @Sendable (String) -> Void) async throws -> AppleDictationEngine {
        var locale = await DictationTranscriber.supportedLocale(equivalentTo: wanted)
        if locale == nil { locale = await DictationTranscriber.supportedLocale(equivalentTo: Locale(identifier: "de-DE")) }
        guard let locale else { throw DictationError.message(String(localized: "Sprache wird von Apple nicht unterstützt.")) }
        var preset = DictationTranscriber.Preset.progressiveLongDictation
        if !punctuation { preset.transcriptionOptions.remove(.punctuation) }
        let transcriber = DictationTranscriber(
            locale: locale, contentHints: preset.contentHints, transcriptionOptions: preset.transcriptionOptions,
            reportingOptions: preset.reportingOptions, attributeOptions: preset.attributeOptions
        )
        if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
            onPrepare()
            try await request.downloadAndInstall()
        }
        let analyzer = SpeechAnalyzer(modules: [transcriber])
        if !vocabulary.isEmpty {
            // Apple recommends ≤ 100 short phrases
            let context = AnalysisContext()
            context.contextualStrings[.general] = Array(vocabulary.prefix(100))
            try? await analyzer.setContext(context)
        }
        let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber])
        let (stream, continuation) = AsyncStream<AnalyzerInput>.makeStream()
        let engine = AppleDictationEngine(analyzer: analyzer, format: format, input: continuation)
        try await analyzer.start(inputSequence: stream)
        engine.resultsTask = Task {
            do {
                for try await result in transcriber.results {
                    let piece = String(result.text.characters)
                    if result.isFinal {
                        engine.finalized += piece
                        engine.volatile = ""
                    } else {
                        engine.volatile = piece
                    }
                    onText(engine.finalized + engine.volatile)
                }
            } catch {
                HollrLog.error("apple dictation results: \(error)")
            }
        }
        return engine
    }

    func feed(_ buffer: AVAudioPCMBuffer) {
        guard let format, buffer.format != format else {
            input.yield(AnalyzerInput(buffer: buffer))
            return
        }
        if converter == nil || converter?.inputFormat != buffer.format {
            converter = AVAudioConverter(from: buffer.format, to: format)
        }
        guard let converter else { return }
        let ratio = format.sampleRate / buffer.format.sampleRate
        guard let out = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 32)
        else { return }
        var consumed = false
        converter.convert(to: out, error: nil) { _, status in
            if consumed { status.pointee = .noDataNow; return nil }
            consumed = true
            status.pointee = .haveData
            return buffer
        }
        if out.frameLength > 0 { input.yield(AnalyzerInput(buffer: out)) }
    }

    /// Drops everything (dictation thrown away or never started).
    func cancel() {
        input.finish()
        resultsTask?.cancel()
        let analyzer = analyzer
        Task { await analyzer.cancelAndFinishNow() }
    }

    func finish() async -> String {
        input.finish()
        try? await analyzer.finalizeAndFinishThroughEndOfInput()
        await resultsTask?.value
        return finalized + volatile
    }
}

// MARK: - Apple on-device fallback (older iOS / simulator)

final class LegacyAppleEngine: @unchecked Sendable {
    private let request = SFSpeechAudioBufferRecognitionRequest()
    private var task: SFSpeechRecognitionTask?
    private var latest = ""
    private var done: CheckedContinuation<Void, Never>?
    private var finished = false

    static func make(locale: Locale, onText: @escaping @Sendable (String) -> Void) async throws -> LegacyAppleEngine {
        let status = await withCheckedContinuation { c in SFSpeechRecognizer.requestAuthorization { c.resume(returning: $0) } }
        guard status == .authorized else { throw DictationError.message(String(localized: "Spracherkennung nicht erlaubt (Einstellungen › Hollr).")) }
        guard let recognizer = SFSpeechRecognizer(locale: locale) ?? SFSpeechRecognizer(locale: Locale(identifier: "de-DE")),
              recognizer.isAvailable
        else { throw DictationError.message(String(localized: "Spracherkennung nicht verfügbar.")) }
        let engine = LegacyAppleEngine()
        engine.request.shouldReportPartialResults = true
        engine.request.requiresOnDeviceRecognition = recognizer.supportsOnDeviceRecognition
        engine.task = recognizer.recognitionTask(with: engine.request) { result, error in
            if let result {
                engine.latest = result.bestTranscription.formattedString
                onText(engine.latest)
            }
            if error != nil || result?.isFinal == true { engine.markDone() }
        }
        return engine
    }

    func feed(_ buffer: AVAudioPCMBuffer) { request.append(buffer) }

    func cancel() {
        task?.cancel()
        request.endAudio()
    }

    private func markDone() {
        guard !finished else { return }
        finished = true
        done?.resume()
        done = nil
    }

    func finish() async -> String {
        request.endAudio()
        if !finished {
            await withCheckedContinuation { c in
                done = c
                DispatchQueue.main.asyncAfter(deadline: .now() + 3) { self.markDone() }
            }
        }
        return latest
    }
}

// MARK: - Model downloads

/// Downloads and deletes the speech models. One for the whole app: a download keeps running (and showing its
/// progress) when you leave the settings and come back – before, every visit started from zero and a second tap
/// started a second download into the same folder.
@MainActor
@Observable
final class ModelManager {
    static let shared = ModelManager()

    private(set) var progress: [String: Double] = [:]
    private(set) var errors: [String: String] = [:]
    /// bumps when something was downloaded/deleted so views re-check what's on disk
    private(set) var revision = 0
    /// bytes on disk per model key (`parakeet-<id>`, Whisper variant), measured off the main thread
    private(set) var sizes: [String: Int64] = [:]

    private init() {}

    func isDownloaded(_ key: String) -> Bool { folder(key) != nil }

    /// the model's folder when it is completely on the device
    nonisolated func folder(_ key: String) -> URL? {
        if key.hasPrefix("parakeet-") {
            let model = String(key.dropFirst("parakeet-".count))
            guard ParakeetCache.isDownloaded(model) else { return nil }
            return AsrModels.defaultCacheDirectory(for: ParakeetCache.version(model))
        }
        return DictationSettings.whisperFolder(key)
    }

    func downloadWhisper(_ variant: String, settings: DictationSettings) {
        run(variant) { report in
            _ = try await WhisperKit.download(variant: variant, downloadBase: DictationSettings.whisperBase) { p in
                report(p.fractionCompleted)
            }
            guard DictationSettings.whisperFolder(variant) != nil else {
                throw DictationError.message(String(localized: "Download unvollständig – bitte noch einmal laden."))
            }
        } done: {
            // the first model you load is the one you want: no extra „Wählen“
            if !settings.whisperReady { settings.whisperModel = variant }
        }
    }

    func downloadParakeet(_ model: String, settings: DictationSettings) {
        let boost = settings.parakeetBoost
        run("parakeet-\(model)") { report in
            try await ParakeetCache.shared.download(model: model, boost: boost, progress: report)
            guard ParakeetCache.isDownloaded(model) else {
                throw DictationError.message(String(localized: "Download unvollständig – bitte noch einmal laden."))
            }
        } done: {
            if !ParakeetCache.isDownloaded(settings.parakeetModel) { settings.parakeetModel = model }
        }
    }

    func delete(_ key: String) {
        if let url = folder(key) { try? FileManager.default.removeItem(at: url) }
        Task {
            await WhisperCache.shared.unload()
            await ParakeetCache.shared.unload()
        }
        sizes[key] = nil
        revision += 1
    }

    /// Measures the downloaded models' sizes (folder walk, off the main thread).
    func measure(_ keys: [String]) {
        Task.detached(priority: .utility) {
            var found: [String: Int64] = [:]
            for key in keys {
                guard let url = self.folder(key) else { continue }
                found[key] = Self.bytes(in: url)
            }
            await MainActor.run { self.sizes.merge(found) { _, new in new } }
        }
    }

    nonisolated private static func bytes(in url: URL) -> Int64 {
        let keys: [URLResourceKey] = [.totalFileAllocatedSizeKey, .fileAllocatedSizeKey]
        guard let walk = FileManager.default.enumerator(at: url, includingPropertiesForKeys: keys) else { return 0 }
        var total: Int64 = 0
        for case let file as URL in walk {
            let v = try? file.resourceValues(forKeys: Set(keys))
            total += Int64(v?.totalFileAllocatedSize ?? v?.fileAllocatedSize ?? 0)
        }
        return total
    }

    private func run(_ key: String, _ work: @escaping (@escaping @Sendable (Double) -> Void) async throws -> Void,
                     done: @escaping () -> Void) {
        guard progress[key] == nil else { return }
        progress[key] = 0
        errors[key] = nil
        // auto-lock would suspend the app and break the download: the screen stays on while one runs
        UIApplication.shared.isIdleTimerDisabled = true
        Task {
            do {
                try await work { value in
                    Task { @MainActor in
                        // a late update after the end must not bring the bar back
                        if let now = self.progress[key] { self.progress[key] = max(now, value) }
                    }
                }
                done()
                measure([key])
            } catch {
                errors[key] = error.localizedDescription
                HollrLog.error("download \(key): \(error)")
            }
            progress[key] = nil
            if progress.isEmpty { UIApplication.shared.isIdleTimerDisabled = false }
            revision += 1
        }
    }
}
