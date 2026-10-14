import Foundation
import Observation

/// Local speech-to-text settings (Einstellungen › Sprache). Everything is on-device.
@MainActor
@Observable
final class DictationSettings {
    enum Engine: String, CaseIterable, Identifiable {
        case parakeet, whisper, apple
        var id: String { rawValue }
        var title: String {
            switch self {
            case .parakeet: return "Parakeet"
            case .whisper: return "Whisper"
            case .apple: return "Apple"
            }
        }
    }

    struct Model: Identifiable, Hashable {
        let id: String
        let name: String
        let size: String
        let note: String
    }

    static let parakeetModels: [Model] = [
        .init(id: "ultra", name: "Parakeet Ultra", size: "≈ 600 MB",
              note: String(localized: "Beste Genauigkeit, 25 Sprachen, Deutsch + Englisch gemischt")),
        .init(id: "v3", name: "Parakeet v3", size: "≈ 480 MB", note: String(localized: "NVIDIA-Original, 25 Sprachen")),
    ]

    static let whisperModels: [Model] = [
        .init(id: "openai_whisper-large-v3_947MB", name: "Large v3", size: "948 MB", note: String(localized: "Maximale Genauigkeit")),
        .init(id: "openai_whisper-large-v3-v20240930_626MB", name: "Large v3 Turbo", size: "627 MB", note: String(localized: "Fast so genau, deutlich schneller")),
        .init(id: "openai_whisper-small_216MB", name: "Small", size: "216 MB", note: String(localized: "Kompakt, gute Genauigkeit")),
        .init(id: "openai_whisper-base", name: "Base", size: "142 MB", note: String(localized: "Schnell, für kurze Notizen")),
    ]

    static let languages: [(code: String, name: String)] = [
        ("de", String(localized: "Deutsch")), ("en", String(localized: "Englisch")), ("auto", String(localized: "Automatisch erkennen")),
        ("fr", String(localized: "Französisch")), ("es", "Spanisch"), ("it", "Italienisch"), ("nl", String(localized: "Niederländisch")),
        ("pl", String(localized: "Polnisch")), ("pt", String(localized: "Portugiesisch")),
    ]

    struct Replacement: Codable, Hashable, Identifiable {
        var id = UUID()
        var from: String
        var to: String
    }

    /// One vocabulary line: "Kubernetes" or "TypeScript = Type Script, Type Skript, Typescript, Typescript"
    struct Term: Hashable {
        let text: String
        let aliases: [String]
    }

    static let defaultVocabulary = """
    omp = OMP, Oh My Pi
    herdr = Herder, Hörder
    Hollr = Holler
    Claude Code
    Codex
    GitHub
    Pull Request
    JIRA = Jira, Dschira, Vira
    deployen = deploien
    deploye = deploie
    Sandcastle
    TypeScript = Type Script, Type Skript, Typescript
    JavaScript
    SwiftUI = Swift UI
    pnpm = PNPM
    Kubernetes
    Docker
    Dokku
    Postgres = Postgres-Datenbank
    Redis
    Refactoring
    Endpoint
    Frontend
    Backend
    Deployment
    Staging
    Commit
    Rebase
    Merge Request
    """

    private let defaults = UserDefaults.standard

    var engine: Engine { didSet { defaults.set(engine.rawValue, forKey: "dictation.engine") } }
    var parakeetModel: String { didSet { defaults.set(parakeetModel, forKey: "dictation.parakeetModel") } }
    var whisperModel: String { didSet { defaults.set(whisperModel, forKey: "dictation.whisperModel") } }
    var language: String { didSet { defaults.set(language, forKey: "dictation.language") } }
    var autoSend: Bool { didSet { defaults.set(autoSend, forKey: "dictation.autoSend") } }
    /// Raw vocabulary text, one term per line (aliases after "=").
    var vocabularyText: String { didSet { defaults.set(vocabularyText, forKey: "dictation.vocabularyText") } }
    /// Feed the vocabulary into the engines (Apple context, Whisper prompt, Parakeet CTC boosting).
    var useVocabulary: Bool { didSet { defaults.set(useVocabulary, forKey: "dictation.useVocabulary") } }
    /// Parakeet: CTC keyword spotting + rescoring (extra ≈ 100 MB model).
    var parakeetBoost: Bool { didSet { defaults.set(parakeetBoost, forKey: "dictation.parakeetBoost") } }
    /// Whisper: retries with higher temperature when the result looks wrong (0 = off).
    var whisperFallbacks: Int { didSet { defaults.set(whisperFallbacks, forKey: "dictation.whisperFallbacks") } }
    /// Whisper: split long recordings at pauses (voice activity detection).
    var whisperVAD: Bool { didSet { defaults.set(whisperVAD, forKey: "dictation.whisperVAD") } }
    /// Apple: punctuation and capitalisation.
    var applePunctuation: Bool { didSet { defaults.set(applePunctuation, forKey: "dictation.applePunctuation") } }
    /// Drop "ähm", "äh" … from the result.
    var removeFillers: Bool { didSet { defaults.set(removeFillers, forKey: "dictation.removeFillers") } }
    /// Apple Intelligence on the device polishes punctuation and spelling (iOS 26, beta).
    var polish: Bool { didSet { defaults.set(polish, forKey: "dictation.polish") } }
    /// Voice processing: noise suppression and level control (for noisy places).
    var noiseSuppression: Bool { didSet { defaults.set(noiseSuppression, forKey: "dictation.noiseSuppression") } }
    /// Record with the iPhone microphone even when AirPods are connected.
    var preferBuiltInMic: Bool { didSet { defaults.set(preferBuiltInMic, forKey: "dictation.preferBuiltInMic") } }
    /// Words from the open session (repo, branch, tickets, files) help recognition.
    var sessionVocabulary: Bool { didSet { defaults.set(sessionVocabulary, forKey: "dictation.sessionVocabulary") } }
    /// "… senden" at the end sends the message.
    var voiceSend: Bool { didSet { defaults.set(voiceSend, forKey: "dictation.voiceSend") } }
    var replacements: [Replacement] {
        didSet { defaults.set(try? JSONEncoder().encode(replacements), forKey: "dictation.replacements") }
    }
    /// Whisper variant → local folder
    var downloaded: [String: String] { didSet { defaults.set(downloaded, forKey: "dictation.downloaded") } }

    init() {
        engine = Engine(rawValue: defaults.string(forKey: "dictation.engine") ?? "") ?? .apple
        parakeetModel = defaults.string(forKey: "dictation.parakeetModel") ?? "ultra"
        whisperModel = defaults.string(forKey: "dictation.whisperModel") ?? "openai_whisper-large-v3-v20240930_626MB"
        let preferred = Locale.preferredLanguages.first.map { String($0.prefix(2)) } ?? "de"
        language = defaults.string(forKey: "dictation.language")
            ?? (Self.languages.contains { $0.code == preferred } ? preferred : "de")
        autoSend = defaults.bool(forKey: "dictation.autoSend")
        vocabularyText = defaults.string(forKey: "dictation.vocabularyText") ?? Self.defaultVocabulary
        useVocabulary = Self.flag("dictation.useVocabulary", default: true)
        parakeetBoost = Self.flag("dictation.parakeetBoost", default: false)
        whisperFallbacks = defaults.object(forKey: "dictation.whisperFallbacks") != nil ? defaults.integer(forKey: "dictation.whisperFallbacks") : 3
        whisperVAD = Self.flag("dictation.whisperVAD", default: true)
        applePunctuation = Self.flag("dictation.applePunctuation", default: true)
        removeFillers = Self.flag("dictation.removeFillers", default: true)
        polish = Self.flag("dictation.polish", default: false)
        noiseSuppression = Self.flag("dictation.noiseSuppression", default: false)
        preferBuiltInMic = Self.flag("dictation.preferBuiltInMic", default: false)
        sessionVocabulary = Self.flag("dictation.sessionVocabulary", default: true)
        voiceSend = Self.flag("dictation.voiceSend", default: true)
        replacements = defaults.data(forKey: "dictation.replacements")
            .flatMap { try? JSONDecoder().decode([Replacement].self, from: $0) } ?? []
        downloaded = (defaults.dictionary(forKey: "dictation.downloaded") as? [String: String] ?? [:])
            .filter { FileManager.default.fileExists(atPath: $0.value) }
    }

    private static func flag(_ key: String, default value: Bool) -> Bool {
        UserDefaults.standard.object(forKey: key) != nil ? UserDefaults.standard.bool(forKey: key) : value
    }

    var whisperReady: Bool { downloaded[whisperModel] != nil }

    var locale: Locale {
        language == "auto" ? Locale.current : Locale(identifier: language)
    }

    var terms: [Term] {
        vocabularyText.split(separator: "\n").compactMap { line in
            let parts = line.split(separator: "=", maxSplits: 1).map { $0.trimmingCharacters(in: .whitespaces) }
            guard let text = parts.first, !text.isEmpty, !text.hasPrefix("#") else { return nil }
            let aliases = parts.count > 1
                ? parts[1].split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
                : []
            return Term(text: text, aliases: aliases)
        }
    }

    /// Whole-word pattern where spaces and hyphens inside the phrase are interchangeable.
    static func loosePattern(_ phrase: String) -> String {
        let parts = phrase.split(whereSeparator: { $0 == " " || $0 == "-" }).map { NSRegularExpression.escapedPattern(for: String($0)) }
        return "(?<![\\p{L}\\p{N}])" + parts.joined(separator: "[\\s-]*") + "(?![\\p{L}\\p{N}])"
    }

    /// Plain terms for engines without alias support.
    var vocabularyWords: [String] { useVocabulary ? terms.map(\.text) : [] }

    /// Own vocabulary plus words from the open session (deduplicated, own terms first).
    func allTerms(extra: [String]) -> [Term] {
        var seen = Set<String>()
        return (terms + extra.map { Term(text: $0, aliases: []) }).filter { seen.insert($0.text.lowercased()).inserted }
    }

    /// Everything after recognition: invented subtitles, fillers, replacements, vocabulary, ticket keys.
    func finish(_ raw: String, extraTerms: [String] = []) -> String {
        var out = DictationText.dropHallucinations(raw)
        if removeFillers { out = DictationText.dropFillers(out, language: language) }
        out = apply(out, extra: extraTerms)
        let all = allTerms(extra: extraTerms).map(\.text)
        out = DictationText.formatTickets(out, prefixes: DictationText.ticketPrefixes(in: all))
        return out.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Replacements + vocabulary aliases (alias → canonical spelling), case-insensitive whole words.
    func apply(_ text: String, extra: [String] = []) -> String {
        var out = text
        let terms = allTerms(extra: extra)
        var rules = replacements.map { ($0.from, $0.to) }
        if useVocabulary { rules += terms.flatMap { term in term.aliases.map { ($0, term.text) } } }
        for (from, to) in rules where !from.isEmpty {
            out = out.replacingOccurrences(of: Self.loosePattern(from), with: to, options: [.regularExpression, .caseInsensitive])
        }
        if useVocabulary {
            // fix casing/spacing of known terms ("typescript", "Type-Script" → "TypeScript")
            for term in terms where term.text.count >= 3 {
                out = out.replacingOccurrences(of: Self.loosePattern(term.text), with: term.text, options: [.regularExpression, .caseInsensitive])
            }
        }
        return out
    }
}
