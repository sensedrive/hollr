import AVFoundation
import Foundation
#if canImport(FoundationModels)
import FoundationModels
#endif

// Building blocks of local dictation, kept apart from the UI-facing `Dictator`:
// audio collection off the main thread, silence detection, text cleanup and the optional
// on-device polish.

// MARK: - Audio collection (runs on the audio thread)

/// Collects 16 kHz mono samples from the microphone tap. Called on the audio thread, read from
/// the main actor – everything behind one lock, so nothing about recording touches the UI thread.
final class AudioCollector: @unchecked Sendable {
    static let rate = 16_000
    /// 20 ms analysis frames
    static let frame = 320

    private let lock = NSLock()
    private var samples: [Float] = []
    private var frameRMS: [Float] = []
    private var partial: [Float] = []
    private var converter: AVAudioConverter?
    private let target = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: Double(rate), channels: 1, interleaved: false)!
    private var lastLevelAt = 0.0
    /// throttled (~15 Hz) microphone level for the UI
    var onLevel: (@Sendable (Float) -> Void)?

    func reset() {
        lock.lock()
        samples.removeAll(keepingCapacity: true)
        frameRMS.removeAll(keepingCapacity: true)
        partial.removeAll()
        converter = nil
        lock.unlock()
    }

    /// Audio thread: resample to 16 kHz mono and append, keep per-frame energy.
    func ingest(_ buffer: AVAudioPCMBuffer) {
        if converter?.inputFormat != buffer.format { converter = AVAudioConverter(from: buffer.format, to: target) }
        guard let converter, buffer.frameLength > 0 else { return }
        let ratio = target.sampleRate / buffer.format.sampleRate
        guard let out = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 32)
        else { return }
        var consumed = false
        converter.convert(to: out, error: nil) { _, status in
            if consumed { status.pointee = .noDataNow; return nil }
            consumed = true
            status.pointee = .haveData
            return buffer
        }
        guard let ch = out.floatChannelData?[0], out.frameLength > 0 else { return }
        let chunk = Array(UnsafeBufferPointer(start: ch, count: Int(out.frameLength)))

        lock.lock()
        samples.append(contentsOf: chunk)
        partial.append(contentsOf: chunk)
        var newest: Float = 0
        while partial.count >= Self.frame {
            var sum: Float = 0
            for i in 0..<Self.frame { sum += partial[i] * partial[i] }
            newest = sqrt(sum / Float(Self.frame))
            frameRMS.append(newest)
            partial.removeFirst(Self.frame)
        }
        lock.unlock()

        let now = CACurrentMediaTime()
        if now - lastLevelAt > 0.066 {
            lastLevelAt = now
            onLevel?(newest)
        }
    }

    var count: Int {
        lock.lock(); defer { lock.unlock() }
        return samples.count
    }

    func slice(_ range: Range<Int>) -> [Float] {
        lock.lock(); defer { lock.unlock() }
        let r = range.clamped(to: 0..<samples.count)
        return Array(samples[r])
    }

    func energies() -> [Float] {
        lock.lock(); defer { lock.unlock() }
        return frameRMS
    }
}

// MARK: - Silence

enum Silence {
    /// Speech threshold relative to the recording's own noise floor (quiet room vs. train).
    static func threshold(_ rms: [Float]) -> Float {
        guard !rms.isEmpty else { return 0.01 }
        let sorted = rms.sorted()
        let floor = sorted[min(sorted.count - 1, sorted.count / 10)]
        return max(0.008, floor * 3.5)
    }

    /// Cuts leading/trailing silence (keeps 250 ms around speech); nil = nothing was said.
    static func trim(_ samples: [Float]) -> [Float]? {
        let f = AudioCollector.frame
        guard samples.count >= f * 5 else { return nil }
        var rms: [Float] = []
        rms.reserveCapacity(samples.count / f)
        var i = 0
        while i + f <= samples.count {
            var sum: Float = 0
            for j in i..<(i + f) { sum += samples[j] * samples[j] }
            rms.append(sqrt(sum / Float(f)))
            i += f
        }
        let t = threshold(rms)
        guard let first = rms.firstIndex(where: { $0 > t }), let last = rms.lastIndex(where: { $0 > t }) else { return nil }
        // a single click is not speech: at least ~120 ms above the threshold
        guard rms.filter({ $0 > t }).count >= 6 else { return nil }
        let pad = AudioCollector.rate / 4
        let start = max(0, first * f - pad)
        let end = min(samples.count, (last + 1) * f + pad)
        return Array(samples[start..<end])
    }

    /// Where to cut the running recording into a chunk (sample index), or nil = keep collecting.
    /// At a pause after ≥ 6 s of audio, forced at 25 s (at the quietest spot of the last 2 s).
    static func cutPoint(energies rms: [Float], from start: Int, total: Int) -> Int? {
        let f = AudioCollector.frame
        let startFrame = start / f
        guard rms.count > startFrame else { return nil }
        let seconds = Double(total - start) / Double(AudioCollector.rate)
        guard seconds >= 6 else { return nil }
        let t = threshold(rms)
        let tail = rms.suffix(20) // 400 ms
        if tail.count == 20, tail.allSatisfy({ $0 < t }) {
            return (rms.count - 10) * f // middle of the pause
        }
        if seconds >= 25 {
            let window = rms[max(startFrame, rms.count - 100)..<rms.count]
            if let quiet = window.indices.min(by: { rms[$0] < rms[$1] }) { return quiet * f }
            return total
        }
        return nil
    }
}

// MARK: - Text cleanup

enum DictationText {
    /// Phrases Whisper invents on silence or noise (it learned them from subtitles).
    static let hallucinations = [
        "Untertitel im Auftrag des ZDF", "Untertitelung im Auftrag des ZDF", "Untertitel der Amara.org-Community",
        "Untertitelung des ZDF", "Untertitel von Stephanie Geiges", "Copyright WDR", "Vielen Dank fürs Zuschauen",
        "Vielen Dank für's Zuschauen", "Danke fürs Zuschauen", "Bis zum nächsten Mal", "Thanks for watching",
        "Thank you for watching", "Subtitles by the Amara.org community", "Amara.org",
    ]

    static func dropHallucinations(_ text: String) -> String {
        var out = text
        for phrase in hallucinations {
            let pattern = NSRegularExpression.escapedPattern(for: phrase) + "[^.!?\\n]*[.!?]?"
            out = out.replacingOccurrences(of: pattern, with: "", options: [.regularExpression, .caseInsensitive])
        }
        return out.replacingOccurrences(of: "\\s{2,}", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// "ähm", "äh", "öhm" … (English "um"/"uh" only when dictating English – "um" is a German word).
    static func dropFillers(_ text: String, language: String) -> String {
        var words = "ähm+|äh+|öhm+|ehm+|hmm+|mhm"
        if language == "en" { words += "|um+|uh+|erm" }
        let pattern = "(?<![\\p{L}\\p{N}])(?:\(words))(?![\\p{L}\\p{N}])[,.…]*\\s*"
        var out = text.replacingOccurrences(of: pattern, with: "", options: [.regularExpression, .caseInsensitive])
        out = out.replacingOccurrences(of: "\\s+([,.!?])", with: "$1", options: .regularExpression)
        out = out.replacingOccurrences(of: "\\s{2,}", with: " ", options: .regularExpression)
        // a sentence that started with a filler: capitalise again
        if let first = out.first, first.isLowercase, text.first?.isUppercase == true {
            out = first.uppercased() + out.dropFirst()
        }
        return out.trimmingCharacters(in: .whitespaces)
    }

    /// "tendr 725", "Tendr minus 725" → "TENDR-725" for ticket prefixes known from the session/vocabulary.
    static func formatTickets(_ text: String, prefixes: Set<String>) -> String {
        var out = text
        for prefix in prefixes where prefix.count >= 2 {
            let p = NSRegularExpression.escapedPattern(for: prefix)
            let pattern = "(?<![\\p{L}\\p{N}])\(p)[\\s-]*(?:minus\\s*|bindestrich\\s*|strich\\s*|dash\\s*)?(\\d{1,6})(?![\\p{N}])"
            out = out.replacingOccurrences(of: pattern, with: "\(prefix)-$1", options: [.regularExpression, .caseInsensitive])
        }
        return out
    }

    /// Ticket prefixes in known terms ("TENDR-725" → "TENDR").
    static func ticketPrefixes(in terms: [String]) -> Set<String> {
        Set(terms.compactMap { term in
            guard let m = term.range(of: "^[A-Z][A-Z0-9]{1,9}(?=-\\d+$)", options: .regularExpression) else { return nil }
            return String(term[m])
        })
    }

    /// "… senden" / "… abschicken" at the very end: strip it and send.
    static func voiceSend(_ text: String) -> (text: String, send: Bool) {
        let pattern = "[\\s,.;:]*(?:und\\s+)?(?:senden|abschicken|schick(?:e)?\\s+(?:es\\s+)?ab|send it)[\\s.!]*$"
        guard let range = text.range(of: pattern, options: [.regularExpression, .caseInsensitive]) else { return (text, false) }
        let rest = String(text[..<range.lowerBound]).trimmingCharacters(in: .whitespaces)
        return (rest, !rest.isEmpty)
    }
}

// MARK: - Optional polish with the on-device model (Apple Intelligence, iOS 26)

enum LocalPolish {
    static var isAvailable: Bool {
        #if canImport(FoundationModels)
        if #available(iOS 26, *) { return SystemLanguageModel.default.availability == .available }
        #endif
        return false
    }

    /// Why polish can't run here (shown in settings), nil when it can.
    static var unavailableReason: String? {
        #if canImport(FoundationModels)
        if #available(iOS 26, *) {
            switch SystemLanguageModel.default.availability {
            case .available: return nil
            case .unavailable(.deviceNotEligible): return String(localized: "Dieses iPhone unterstützt Apple Intelligence nicht.")
            case .unavailable(.appleIntelligenceNotEnabled): return String(localized: "Apple Intelligence ist in den iOS-Einstellungen aus.")
            case .unavailable(.modelNotReady): return String(localized: "Das Apple-Modell wird noch geladen.")
            case .unavailable: return String(localized: "Apple Intelligence ist gerade nicht verfügbar.")
            }
        }
        #endif
        return String(localized: "Braucht iOS 26 mit Apple Intelligence.")
    }

    /// Minimal corrections only; falls back to the input on any doubt (timeout, big changes).
    static func polish(_ text: String, terms: [String], language: String) async -> String {
        #if canImport(FoundationModels)
        if #available(iOS 26, *), isAvailable, text.count >= 12 {
            let vocabulary = terms.prefix(60).joined(separator: ", ")
            let instructions = """
            Du korrigierst diktierten Text minimal. Korrigiere nur Rechtschreibung, Groß-/Kleinschreibung, \
            Zeichensetzung und offensichtlich falsch erkannte Fachbegriffe. Entferne Füllwörter und Versprecher. \
            Behalte Sprache, Wortwahl, Reihenfolge und Inhalt bei – nichts ergänzen, nichts kürzen, nichts übersetzen, \
            nicht antworten. Gib ausschließlich den korrigierten Text aus.
            Fachbegriffe in genau dieser Schreibweise: \(vocabulary)
            """
            do {
                let result = try await withThrowingTaskGroup(of: String?.self) { group in
                    group.addTask {
                        let session = LanguageModelSession(instructions: instructions)
                        return try await session.respond(to: text).content
                    }
                    group.addTask {
                        try await Task.sleep(for: .seconds(6))
                        return nil
                    }
                    let first = try await group.next() ?? nil
                    group.cancelAll()
                    return first
                }
                if let polished = result?.trimmingCharacters(in: .whitespacesAndNewlines) {
                    let ratio = Double(polished.count) / Double(max(text.count, 1))
                    // guard against the model answering or rewriting instead of correcting
                    if !polished.isEmpty, (0.6...1.25).contains(ratio) { return polished }
                    HollrLog.info("polish: rejected (ratio \(String(format: "%.2f", ratio)))")
                }
            } catch {
                HollrLog.error("polish: \(error)")
            }
        }
        #endif
        return text
    }
}
