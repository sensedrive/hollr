/**
 * Hollr wire protocol over an SSH exec channel (stdin/stdout).
 *
 * Every frame: [type: u8][length: u24 big-endian][payload]
 *   type 0x01  audio  – PCM s16le, 24 kHz, mono (both directions)
 *   type 0x02  json   – UTF-8 JSON control message / event
 */
export const FRAME_AUDIO = 0x01;
export const FRAME_JSON = 0x02;
export const MAX_PAYLOAD = 0xffffff;

export const AUDIO_RATE = 24_000;

export type Frame =
  | { type: typeof FRAME_AUDIO; data: Uint8Array }
  | { type: typeof FRAME_JSON; data: unknown };

export function encodeFrame(type: number, payload: Uint8Array): Uint8Array {
  if (payload.length > MAX_PAYLOAD) throw new Error("frame too large");
  const out = new Uint8Array(4 + payload.length);
  out[0] = type;
  out[1] = (payload.length >> 16) & 0xff;
  out[2] = (payload.length >> 8) & 0xff;
  out[3] = payload.length & 0xff;
  out.set(payload, 4);
  return out;
}

export function encodeJson(message: unknown): Uint8Array {
  return encodeFrame(FRAME_JSON, new TextEncoder().encode(JSON.stringify(message)));
}

/** Incremental decoder: feed arbitrary chunks, get complete frames back. */
export class FrameDecoder {
  private buffer = new Uint8Array(0);

  push(chunk: Uint8Array): Frame[] {
    const merged = new Uint8Array(this.buffer.length + chunk.length);
    merged.set(this.buffer);
    merged.set(chunk, this.buffer.length);
    const frames: Frame[] = [];
    let offset = 0;
    while (merged.length - offset >= 4) {
      const type = merged[offset] ?? 0;
      const len =
        ((merged[offset + 1] ?? 0) << 16) |
        ((merged[offset + 2] ?? 0) << 8) |
        (merged[offset + 3] ?? 0);
      if (merged.length - offset - 4 < len) break;
      const payload = merged.slice(offset + 4, offset + 4 + len);
      offset += 4 + len;
      if (type === FRAME_AUDIO) frames.push({ type: FRAME_AUDIO, data: payload });
      else if (type === FRAME_JSON) {
        try {
          frames.push({ type: FRAME_JSON, data: JSON.parse(new TextDecoder().decode(payload)) });
        } catch {
          // ignore malformed control frames
        }
      }
    }
    this.buffer = merged.slice(offset);
    return frames;
  }
}
