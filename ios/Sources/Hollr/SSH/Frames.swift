import Foundation

/// Hollr wire protocol on the SSH exec channel – must match server/src/frames.ts.
/// Every frame: [type: u8][length: u24 big-endian][payload]
enum Frame: Equatable {
    /// PCM s16le, 24 kHz, mono
    case audio(Data)
    case json(Data)

    static let audioType: UInt8 = 0x01
    static let jsonType: UInt8 = 0x02
    static let sampleRate: Double = 24_000

    var encoded: Data {
        let (type, payload): (UInt8, Data) = switch self {
        case .audio(let d): (Frame.audioType, d)
        case .json(let d): (Frame.jsonType, d)
        }
        var out = Data(capacity: payload.count + 4)
        out.append(type)
        out.append(UInt8((payload.count >> 16) & 0xff))
        out.append(UInt8((payload.count >> 8) & 0xff))
        out.append(UInt8(payload.count & 0xff))
        out.append(payload)
        return out
    }

    static func control(_ object: [String: Any]) -> Frame {
        .json((try? JSONSerialization.data(withJSONObject: object)) ?? Data("{}".utf8))
    }
}

/// Incremental decoder for arbitrary chunk boundaries.
struct FrameDecoder {
    private var buffer = Data()

    mutating func push(_ chunk: Data) -> [Frame] {
        buffer.append(chunk)
        var frames: [Frame] = []
        var offset = buffer.startIndex
        while buffer.endIndex - offset >= 4 {
            let type = buffer[offset]
            let len = Int(buffer[offset + 1]) << 16 | Int(buffer[offset + 2]) << 8 | Int(buffer[offset + 3])
            guard buffer.endIndex - offset - 4 >= len else { break }
            let payload = buffer.subdata(in: (offset + 4)..<(offset + 4 + len))
            offset += 4 + len
            switch type {
            case Frame.audioType: frames.append(.audio(payload))
            case Frame.jsonType: frames.append(.json(payload))
            default: break
            }
        }
        buffer = buffer.subdata(in: offset..<buffer.endIndex)
        return frames
    }
}

/// Events sent by the server during a live session.
enum LiveEvent: Equatable {
    case phase(String, reason: String?)
    case status(String)
    case delegation(String)
    case user(String)
    case omp(String)
    case tool(name: String, intent: String?)
    case answer(String, final: Bool)
    case error(code: String, message: String)
    case other

    init(json: Data) {
        guard let obj = (try? JSONSerialization.jsonObject(with: json)) as? [String: Any],
              let t = obj["t"] as? String
        else { self = .other; return }
        switch t {
        case "phase": self = .phase(obj["phase"] as? String ?? "", reason: obj["reason"] as? String)
        case "status": self = .status(obj["status"] as? String ?? "")
        case "delegation": self = .delegation(obj["text"] as? String ?? "")
        case "user": self = .user(obj["text"] as? String ?? "")
        case "omp": self = .omp(obj["state"] as? String ?? "")
        case "tool": self = .tool(name: obj["name"] as? String ?? "", intent: obj["intent"] as? String)
        case "answer": self = .answer(obj["text"] as? String ?? "", final: obj["final"] as? Bool ?? true)
        case "error": self = .error(code: obj["code"] as? String ?? "", message: obj["message"] as? String ?? "")
        default: self = .other
        }
    }
}
