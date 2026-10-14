import AVFoundation
import Foundation

/// Microphone in / speaker out with Apple's voice processing (echo cancellation),
/// converted to/from the wire format: PCM s16le, 24 kHz, mono.
///
/// Switching the audio session into voice-chat mode often reconfigures the hardware a moment
/// after the engine started; AVAudioEngine then stops itself silently. We rebuild and restart on
/// configuration changes, interruptions and via a watchdog, so the first call works too.
final class VoiceIO {
    var onCapture: ((Data) -> Void)?
    var onLevels: ((_ input: Float, _ output: Float) -> Void)?

    /// Speaker off: incoming speech is dropped (the call and the mic keep running).
    var outputMuted = false {
        didSet { if outputMuted { flushPlayback() } }
    }

    private var engine = AVAudioEngine()
    private var player = AVAudioPlayerNode()
    private let wireFormat = AVAudioFormat(
        commonFormat: .pcmFormatInt16, sampleRate: Frame.sampleRate, channels: 1, interleaved: true
    )!
    private let playFormat = AVAudioFormat(standardFormatWithSampleRate: Frame.sampleRate, channels: 1)!
    private var converter: AVAudioConverter?
    private let lock = NSLock()
    private var pendingFrames: AVAudioFrameCount = 0
    private var outputLevel: Float = 0
    /// Above this much queued speech we drop audio to stay in real time.
    private let maxQueued = AVAudioFrameCount(Frame.sampleRate * 0.8)

    private var active = false
    private var observers: [NSObjectProtocol] = []
    private var watchdog: Timer?
    private var restarting = false
    private(set) var capturedFrames = 0
    private(set) var playedFrames = 0

    /// Puts the session into voice-chat mode early (before the server is ready), so the
    /// hardware reconfiguration happens before the engine starts.
    static func prepareSession() {
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playAndRecord, mode: .voiceChat, options: [.defaultToSpeaker, .allowBluetoothHFP])
            try session.setPreferredIOBufferDuration(0.02)
            try session.setActive(true)
        } catch {
            HollrLog.error("audio: session prepare failed \(error)")
        }
    }

    func start() throws {
        Self.prepareSession()
        active = true
        try buildAndStart()
        observe()
        // watchdog: the engine can stop without notification on some route changes
        watchdog?.invalidate()
        watchdog = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            guard let self, self.active, !self.restarting else { return }
            if !self.engine.isRunning {
                HollrLog.error("audio: engine stopped – restarting (watchdog)")
                self.restart()
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in
            guard let self, self.active else { return }
            HollrLog.info("audio: after 3s running=\(self.engine.isRunning) captured=\(self.capturedFrames) played=\(self.playedFrames)")
        }
    }

    private func buildAndStart() throws {
        // fresh engine every time: reused engines keep stale voice-processing state
        engine = AVAudioEngine()
        player = AVAudioPlayerNode()
        let input = engine.inputNode
        try input.setVoiceProcessingEnabled(true)
        let inputFormat = input.outputFormat(forBus: 0)
        let session = AVAudioSession.sharedInstance()
        HollrLog.info("audio: input \(inputFormat), route \(session.currentRoute.outputs.map(\.portName))")
        guard inputFormat.sampleRate > 0, inputFormat.channelCount > 0 else {
            throw NSError(domain: "VoiceIO", code: 1, userInfo: [NSLocalizedDescriptionKey: String(localized: "Mikrofon nicht verfügbar")])
        }
        converter = AVAudioConverter(from: inputFormat, to: wireFormat)
        if converter == nil { HollrLog.error("audio: no converter for \(inputFormat)") }

        engine.attach(player)
        engine.connect(player, to: engine.mainMixerNode, format: playFormat)
        input.installTap(onBus: 0, bufferSize: 1024, format: inputFormat) { [weak self] buffer, _ in
            self?.handleCapture(buffer)
        }
        engine.prepare()
        try engine.start()
        player.play()
        lock.lock()
        pendingFrames = 0
        lock.unlock()
        HollrLog.info("audio: engine running")
    }

    private func observe() {
        let center = NotificationCenter.default
        for o in observers { center.removeObserver(o) }
        observers = [
            center.addObserver(forName: .AVAudioEngineConfigurationChange, object: nil, queue: .main) { [weak self] note in
                guard let self, self.active, (note.object as? AVAudioEngine) === self.engine else { return }
                // our own rebuild also triggers this: only restart if the engine really stopped
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in
                    guard let self, self.active, !self.engine.isRunning else { return }
                    HollrLog.info("audio: configuration changed, engine stopped – restarting")
                    self.restart()
                }
            },
            center.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] note in
                guard let self, self.active,
                      let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                      AVAudioSession.InterruptionType(rawValue: raw) == .ended else { return }
                HollrLog.info("audio: interruption ended – restarting")
                self.restart()
            },
            center.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: nil, queue: .main) { [weak self] _ in
                guard let self, self.active else { return }
                HollrLog.info("audio: media services reset – restarting")
                self.restart()
            },
        ]
    }

    private var lastRestart = Date.distantPast

    private func restart() {
        guard active, !restarting, Date().timeIntervalSince(lastRestart) > 1 else { return }
        restarting = true
        lastRestart = Date()
        defer { restarting = false }
        try? AVAudioSession.sharedInstance().setActive(true)
        // same engine: voice processing stays configured (rebuilding re-triggers the change)
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        if format.sampleRate > 0 {
            input.removeTap(onBus: 0)
            converter = AVAudioConverter(from: format, to: wireFormat)
            input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
                self?.handleCapture(buffer)
            }
        }
        do {
            engine.prepare()
            try engine.start()
            player.play()
            HollrLog.info("audio: engine restarted (\(format.sampleRate) Hz)")
        } catch {
            HollrLog.error("audio: restart failed \(error) – rebuilding")
            teardownEngine()
            try? buildAndStart()
        }
    }

    private func teardownEngine() {
        engine.inputNode.removeTap(onBus: 0)
        player.stop()
        engine.stop()
    }

    #if DEBUG
    private var injecting = false

    /// Test hook: feeds an audio file through the capture path (incl. resampling) in real time.
    func injectFile(_ url: URL) {
        Thread.detachNewThread { [weak self] in
            guard let file = try? AVAudioFile(forReading: url) else { return }
            let format = file.processingFormat
            let chunk: AVAudioFrameCount = 1024
            let tmp = AVAudioConverter(from: format, to: self?.wireFormat ?? format)
            self?.injecting = true
            defer { self?.injecting = false }
            while let self, let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: chunk) {
                guard (try? file.read(into: buffer, frameCount: chunk)) != nil, buffer.frameLength > 0 else { break }
                self.handleCapture(buffer, using: tmp)
                Thread.sleep(forTimeInterval: Double(buffer.frameLength) / format.sampleRate)
            }
        }
    }
    #endif

    func stop() {
        active = false
        watchdog?.invalidate()
        watchdog = nil
        for o in observers { NotificationCenter.default.removeObserver(o) }
        observers = []
        teardownEngine()
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func flushPlayback() {
        player.stop()
        lock.lock()
        pendingFrames = 0
        lock.unlock()
        if engine.isRunning { player.play() }
        outputLevel = 0
    }

    /// Queue PCM s16le 24 kHz mono for playback.
    func play(_ pcm: Data) {
        guard !outputMuted else { return }
        // audio may arrive before the engine runs (or while it restarts) – drop it
        guard engine.isRunning, player.isPlaying else { return }
        let frames = AVAudioFrameCount(pcm.count / 2)
        guard frames > 0, let buffer = AVAudioPCMBuffer(pcmFormat: playFormat, frameCapacity: frames) else { return }
        lock.lock()
        let tooMuch = pendingFrames > maxQueued
        if !tooMuch { pendingFrames += frames }
        lock.unlock()
        if tooMuch { return }

        buffer.frameLength = frames
        let out = buffer.floatChannelData![0]
        var sum: Float = 0
        pcm.withUnsafeBytes { raw in
            let samples = raw.bindMemory(to: Int16.self)
            for i in 0..<Int(frames) {
                let v = Float(Int16(littleEndian: samples[i])) / 32768
                out[i] = v
                sum += v * v
            }
        }
        outputLevel = sqrt(sum / Float(frames))
        playedFrames += Int(frames)
        player.scheduleBuffer(buffer) { [weak self] in
            guard let self else { return }
            self.lock.lock()
            self.pendingFrames -= min(self.pendingFrames, frames)
            self.lock.unlock()
        }
    }

    private func handleCapture(_ buffer: AVAudioPCMBuffer, using override: AVAudioConverter? = nil) {
        #if DEBUG
        if override == nil, injecting { return } // test clip replaces the mic
        #endif
        guard let converter = override ?? converter else { return }
        let ratio = wireFormat.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 32
        guard let out = AVAudioPCMBuffer(pcmFormat: wireFormat, frameCapacity: capacity) else { return }
        var consumed = false
        var error: NSError?
        converter.convert(to: out, error: &error) { _, status in
            if consumed {
                status.pointee = .noDataNow
                return nil
            }
            consumed = true
            status.pointee = .haveData
            return buffer
        }
        guard error == nil, out.frameLength > 0, let samples = out.int16ChannelData?[0] else { return }
        let count = Int(out.frameLength)
        capturedFrames += count
        var sum: Float = 0
        for i in 0..<count {
            let v = Float(samples[i]) / 32768
            sum += v * v
        }
        onLevels?(sqrt(sum / Float(count)), outputLevel)
        outputLevel *= 0.85
        onCapture?(Data(bytes: samples, count: count * 2))
    }
}
