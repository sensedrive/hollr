import AVFoundation
import FluidAudio
import Foundation
import Observation
import Speech
import WhisperKit

/// On-device speech-to-text for the composer – independent of omp /live.
/// Engines: Parakeet (FluidAudio), Whisper (WhisperKit), Apple (DictationTranscriber, iOS 26).
@MainActor
@Observable
final class Dictator {
    enum State: Equatable {
        case idle, preparing(String), recording, transcribing
        case failed(String)
    }

    private(set) var state: State = .idle
    /// Recognised text (Apple streams it live, Parakeet/Whisper deliver it after you stop).
    private(set) var text = ""
    private(set) var level: Float = 0

    var isRecording: Bool { state == .recording }
    var isBusy: Bool {
        switch state {
        case .preparing, .recording, .transcribing: return true
        default: return false
        }
    }

    private let engine = AVAudioEngine()
    private var apple: AnyObject?
    private var legacy: LegacyAppleEngine?
    private var samples: [Float] = []
    private var resampler: AVAudioConverter?
    private let target16k = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16_000, channels: 1, interleaved: false)!
    private var active: DictationSettings.Engine = .apple

    // MARK: Start / stop

    func start(settings: DictationSettings) async {
        guard !isBusy else { return }
        text = ""
        samples.removeAll()
        active = settings.engine
        do {
            guard await AVAudioApplication.requestRecordPermission() else {
                throw DictationError.message(String(localized: "Mikrofon-Zugriff fehlt (Einstellungen › Hollr › Mikrofon)."))
            }
            switch active {
            case .parakeet:
                guard ParakeetCache.isDownloaded(settings.parakeetModel) else {
                    throw DictationError.message(String(localized: "Parakeet-Modell noch nicht geladen (Einstellungen › Sprache)."))
                }
                let model = settings.parakeetModel, boost = settings.useVocabulary && settings.parakeetBoost
                let terms = settings.terms
                Task.detached { try? await ParakeetCache.shared.prepare(model: model, boost: boost, terms: terms) }
            case .whisper:
                guard let folder = settings.downloaded[settings.whisperModel] else {
                    throw DictationError.message(String(localized: "Whisper-Modell noch nicht geladen (Einstellungen › Sprache)."))
                }
                let model = settings.whisperModel
                Task.detached { _ = try? await WhisperCache.shared.kit(model: model, folder: folder) }
            case .apple:
                if #available(iOS 26, *), let a = try? await AppleDictationEngine.make(
                    locale: settings.locale, punctuation: settings.applePunctuation,
                    vocabulary: settings.vocabularyWords,
                    onPrepare: { [weak self] in Task { @MainActor in self?.state = .preparing(String(localized: "Sprachmodell wird geladen …")) } },
                    onText: { [weak self] text in Task { @MainActor in self?.text = text } }
                ) {
                    apple = a
                } else {
                    legacy = try await LegacyAppleEngine.make(locale: settings.locale) { [weak self] text in
                        Task { @MainActor in self?.text = text }
                    }
                }
            }

            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playAndRecord, mode: .measurement, options: [.defaultToSpeaker, .allowBluetooth])
            try session.setActive(true)
            let input = engine.inputNode
            let format = input.outputFormat(forBus: 0)
            input.installTap(onBus: 0, bufferSize: 2048, format: format) { [weak self] buffer, _ in
                self?.handle(buffer)
            }
            engine.prepare()
            try engine.start()
            state = .recording
            HollrLog.info("dictation: recording with \(active.rawValue)")
        } catch {
            cleanupAudio()
            state = .failed(error.localizedDescription)
            HollrLog.error("dictation start: \(error)")
        }
    }

    /// Stops recording and returns the final text (vocabulary + replacements applied).
    func stop(settings: DictationSettings) async -> String {
        guard state == .recording else { return "" }
        cleanupAudio()
        state = .transcribing
        var result = text
        let started = Date()
        do {
            switch active {
            case .parakeet:
                result = try await ParakeetCache.shared.transcribe(
                    samples, model: settings.parakeetModel,
                    boost: settings.useVocabulary && settings.parakeetBoost, terms: settings.terms
                )
            case .whisper:
                guard let folder = settings.downloaded[settings.whisperModel] else { throw DictationError.message(String(localized: "Kein Whisper-Modell")) }
                result = try await WhisperCache.shared.transcribe(
                    samples, model: settings.whisperModel, folder: folder, language: settings.language,
                    vocabulary: settings.vocabularyWords, fallbacks: settings.whisperFallbacks, vad: settings.whisperVAD
                )
            case .apple:
                if #available(iOS 26, *), let a = apple as? AppleDictationEngine {
                    result = await a.finish()
                } else if let legacy {
                    result = await legacy.finish()
                }
            }
            state = .idle
            HollrLog.info("dictation: \(active.rawValue) took \(String(format: "%.1f", Date().timeIntervalSince(started)))s for \(samples.count / 16000)s audio")
        } catch {
            state = .failed(error.localizedDescription)
            HollrLog.error("dictation stop: \(error)")
        }
        apple = nil
        legacy = nil
        let cleaned = settings.apply(result.replacingOccurrences(of: #"\[[A-Z_]+\]"#, with: "", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines))
        text = cleaned
        return cleaned
    }

    func cancel() {
        cleanupAudio()
        apple = nil
        legacy = nil
        text = ""
        state = .idle
    }

    private func cleanupAudio() {
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        level = 0
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    // MARK: Audio

    nonisolated private func handle(_ buffer: AVAudioPCMBuffer) {
        if let ch = buffer.floatChannelData?[0] {
            var sum: Float = 0
            for i in 0..<Int(buffer.frameLength) { sum += ch[i] * ch[i] }
            let rms = sqrt(sum / Float(max(buffer.frameLength, 1)))
            Task { @MainActor in self.level = rms }
        }
        Task { @MainActor in self.route(buffer) }
    }

    #if DEBUG
    private var injecting = false

    /// Test hook: a whole dictation with an audio file instead of the microphone.
    func testWithFile(_ url: URL, settings: DictationSettings) async -> String {
        await start(settings: settings)
        guard state == .recording, let file = try? AVAudioFile(forReading: url) else { return "start failed: \(state)" }
        injecting = true
        let format = file.processingFormat
        while let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 4096),
              (try? file.read(into: buffer, frameCount: 4096)) != nil, buffer.frameLength > 0 {
            route(buffer, injected: true)
            try? await Task.sleep(for: .milliseconds(Int(Double(buffer.frameLength) / format.sampleRate * 1000)))
        }
        try? await Task.sleep(for: .seconds(1))
        injecting = false
        return await stop(settings: settings)
    }
    #endif

    private func route(_ buffer: AVAudioPCMBuffer, injected: Bool = false) {
        guard state == .recording else { return }
        #if DEBUG
        if injecting && !injected { return }
        #endif
        switch active {
        case .parakeet, .whisper:
            appendResampled(buffer)
        case .apple:
            if #available(iOS 26, *), let a = apple as? AppleDictationEngine {
                a.feed(buffer)
            } else {
                legacy?.feed(buffer)
            }
        }
    }

    private func appendResampled(_ buffer: AVAudioPCMBuffer) {
        if resampler?.inputFormat != buffer.format { resampler = AVAudioConverter(from: buffer.format, to: target16k) }
        guard let resampler else { return }
        let ratio = 16_000 / buffer.format.sampleRate
        guard let out = AVAudioPCMBuffer(pcmFormat: target16k, frameCapacity: AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 32)
        else { return }
        var consumed = false
        resampler.convert(to: out, error: nil) { _, status in
            if consumed { status.pointee = .noDataNow; return nil }
            consumed = true
            status.pointee = .haveData
            return buffer
        }
        if let ch = out.floatChannelData?[0] {
            samples.append(contentsOf: UnsafeBufferPointer(start: ch, count: Int(out.frameLength)))
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

    func prepare(model: String, boost: Bool, terms: [DictationSettings.Term]) async throws {
        if loaded?.model != model {
            let models = try await AsrModels.downloadAndLoad(version: Self.version(model))
            let asr = AsrManager(config: .default)
            try await asr.loadModels(models)
            loaded = (model, models, asr)
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

    func unload() {
        loaded = nil
        boosting = nil
    }
}

// MARK: - Whisper (WhisperKit)

actor WhisperCache {
    static let shared = WhisperCache()
    private var current: (model: String, kit: WhisperKit)?

    func kit(model: String, folder: String) async throws -> WhisperKit {
        if let current, current.model == model { return current.kit }
        let config = WhisperKitConfig(model: model, modelFolder: folder, verbose: false, prewarm: true, load: true, download: false)
        let kit = try await WhisperKit(config)
        current = (model, kit)
        return kit
    }

    func transcribe(_ samples: [Float], model: String, folder: String, language: String, vocabulary: [String],
                    fallbacks: Int, vad: Bool) async throws -> String {
        guard samples.count > 8_000 else { return "" }
        let kit = try await kit(model: model, folder: folder)
        var prompt: [Int]?
        if !vocabulary.isEmpty, let tok = kit.tokenizer {
            // Whisper keeps the last 111 prompt tokens – the vocabulary as a natural sentence.
            let text = " " + vocabulary.prefix(60).joined(separator: ", ") + "."
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

    func unload() { current = nil }
}

// MARK: - Apple DictationTranscriber (iOS 26+)

@available(iOS 26, *)
final class AppleDictationEngine {
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

    func finish() async -> String {
        input.finish()
        try? await analyzer.finalizeAndFinishThroughEndOfInput()
        await resultsTask?.value
        return finalized + volatile
    }
}

// MARK: - Apple on-device fallback (older iOS / simulator)

final class LegacyAppleEngine {
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

@MainActor
@Observable
final class ModelManager {
    private(set) var progress: [String: Double] = [:]
    private(set) var errors: [String: String] = [:]
    /// bumps when something was downloaded/deleted so views re-check `isDownloaded`
    private(set) var revision = 0

    static var whisperBase: URL {
        let url = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("whisper", isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    func downloadWhisper(_ variant: String, settings: DictationSettings) {
        run(variant) { report in
            let folder = try await WhisperKit.download(variant: variant, downloadBase: Self.whisperBase) { p in
                report(p.fractionCompleted)
            }
            await MainActor.run { settings.downloaded[variant] = folder.path }
        }
    }

    func downloadParakeet(_ model: String, boost: Bool) {
        run("parakeet-\(model)") { report in
            try await ParakeetCache.shared.download(model: model, boost: boost, progress: report)
        }
    }

    func deleteWhisper(_ variant: String, settings: DictationSettings) {
        if let path = settings.downloaded[variant] { try? FileManager.default.removeItem(atPath: path) }
        settings.downloaded[variant] = nil
        Task { await WhisperCache.shared.unload() }
        revision += 1
    }

    func deleteParakeet(_ model: String) {
        try? FileManager.default.removeItem(at: AsrModels.defaultCacheDirectory(for: ParakeetCache.version(model)))
        Task { await ParakeetCache.shared.unload() }
        revision += 1
    }

    private func run(_ key: String, _ work: @escaping (@escaping @Sendable (Double) -> Void) async throws -> Void) {
        guard progress[key] == nil else { return }
        progress[key] = 0
        errors[key] = nil
        Task {
            do {
                try await work { value in Task { @MainActor in self.progress[key] = value } }
            } catch {
                errors[key] = error.localizedDescription
                HollrLog.error("download \(key): \(error)")
            }
            progress[key] = nil
            revision += 1
        }
    }
}
