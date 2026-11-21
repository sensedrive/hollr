import Foundation

/// Older Hollr servers could send a string cut inside an emoji: a lone "\ud83d" escape. JavaScript reads that,
/// Swift's JSON decoders reject the whole answer – the chat then never loaded. Lone surrogate escapes become
/// "\ufffd" (�); everything else stays byte for byte. Run before decoding, not after a failed strict decode: the
/// lenient timeline decoding would turn such an item into a placeholder instead of failing, and the repair never ran.
enum JSONRepair {
    static func wellFormed(_ data: Data) -> Data {
        // the usual case: no surrogate escape at all – one scan, no copy
        guard hasSurrogateEscape(data) else { return data }
        let b = [UInt8](data)
        var out = [UInt8]()
        out.reserveCapacity(b.count)
        var i = 0
        var inString = false
        func hex4(_ at: Int) -> UInt16? {
            guard at + 4 <= b.count, let s = String(bytes: b[at..<at + 4], encoding: .ascii) else { return nil }
            return UInt16(s, radix: 16)
        }
        func surrogate(_ at: Int) -> UInt16? {
            guard at + 6 <= b.count, b[at] == 0x5C, b[at + 1] == 0x75 else { return nil } // \u
            return hex4(at + 2)
        }
        let replacement = Array("\\ufffd".utf8)
        while i < b.count {
            let c = b[i]
            if !inString {
                if c == 0x22 { inString = true }
                out.append(c)
                i += 1
                continue
            }
            if c == 0x22 { inString = false; out.append(c); i += 1; continue }
            guard c == 0x5C, i + 1 < b.count else { out.append(c); i += 1; continue }
            // an escape: only \uXXXX can be a surrogate, the others are copied as they are
            guard b[i + 1] == 0x75, let unit = hex4(i + 2) else {
                out.append(contentsOf: b[i...i + 1])
                i += 2
                continue
            }
            if (0xD800...0xDBFF).contains(unit) {
                if let low = surrogate(i + 6), (0xDC00...0xDFFF).contains(low) {
                    out.append(contentsOf: b[i..<i + 12])
                    i += 12
                } else {
                    out.append(contentsOf: replacement)
                    i += 6
                }
            } else if (0xDC00...0xDFFF).contains(unit) {
                out.append(contentsOf: replacement)
                i += 6
            } else {
                out.append(contentsOf: b[i..<i + 6])
                i += 6
            }
        }
        return Data(out)
    }

    /// `\uD800`…`\uDFFF` anywhere (an escaped backslash before "ud83d" counts too – the repair sorts that out).
    private static func hasSurrogateEscape(_ data: Data) -> Bool {
        data.withUnsafeBytes { (b: UnsafeRawBufferPointer) -> Bool in
            guard b.count >= 6 else { return false }
            for i in 0..<(b.count - 5) where b[i] == 0x5C && b[i + 1] == 0x75 && (b[i + 2] | 0x20) == 0x64 {
                let c = b[i + 3] | 0x20
                if c == 0x38 || c == 0x39 || (0x61...0x66).contains(c) { return true }
            }
            return false
        }
    }

    /// Decodes with lone surrogates repaired.
    static func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        try JSONDecoder().decode(type, from: wellFormed(data))
    }
}
