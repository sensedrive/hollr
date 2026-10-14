/**
 * Pairing by one-time code – for when you can't scan the screen (e.g. on the go, Mac at home).
 * The code is just another way to hand over the same pairing payload as the QR code:
 *
 *   code = Crockford-base32( IPv4 (4 bytes) ‖ secret (6 bytes) )  →  "K7Q2-M9XA-3PLD-W8RT"
 *
 * The phone takes the address from the code and asks this machine on PORT (only while
 * `hollr pair` runs, bound to that one address – the Tailscale IP when remote). It proves it
 * knows the code (HMAC) and gets the payload AES-256-GCM encrypted with a key from the code
 * (PBKDF2-SHA256, 600 000 rounds, salt = the address). 5 wrong tries end the code; it serves once.
 */
import { createCipheriv, createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";

export const OTP_PORT = 47820;
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford: no I, L, O, U
const ROUNDS = 600_000;
const MAX_FAILURES = 5;

export function encodeCode(ip: string, secret: Buffer): string {
  const bytes = Buffer.concat([Buffer.from(ip.split(".").map(Number)), secret]);
  let bits = "";
  for (const b of bytes) bits += b.toString(2).padStart(8, "0");
  let out = "";
  for (let i = 0; i < bits.length; i += 5)
    out += ALPHABET[Number.parseInt(bits.slice(i, i + 5).padEnd(5, "0"), 2)];
  return out.match(/.{1,4}/g)?.join("-") ?? out;
}

export function decodeCode(code: string): { ip: string; secret: Buffer } | undefined {
  const clean = code
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/[OI L]/g, (c) => (c === "O" ? "0" : "1"));
  if (clean.length !== 16 || [...clean].some((c) => !ALPHABET.includes(c))) return undefined;
  let bits = "";
  for (const c of clean) bits += ALPHABET.indexOf(c).toString(2).padStart(5, "0");
  const bytes = Buffer.from(
    Array.from({ length: 10 }, (_, i) => Number.parseInt(bits.slice(i * 8, i * 8 + 8), 2)),
  );
  return { ip: [...bytes.subarray(0, 4)].join("."), secret: bytes.subarray(4) };
}

/** Same derivation as the app: 64 bytes → auth key ‖ encryption key. */
export function deriveKeys(ip: string, secret: Buffer) {
  const k = pbkdf2Sync(secret, `hollr-pair:${ip}`, ROUNDS, 64, "sha256");
  return { auth: k.subarray(0, 32), enc: k.subarray(32) };
}

export const proofFor = (auth: Buffer) =>
  createHmac("sha256", auth).update("hollr-pair-v1").digest();

/** nonce ‖ ciphertext ‖ tag – CryptoKit's AES.GCM "combined" format. */
export function seal(enc: Buffer, plaintext: string): Buffer {
  const nonce = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", enc, nonce);
  const body = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  return Buffer.concat([nonce, body, c.getAuthTag()]);
}

export interface OtpServer {
  code: string;
  /** resolves when the payload was handed out (or the code died) */
  done: Promise<"served" | "failed">;
  stop(): void;
}

/** Serves `payload` once to whoever proves the code, on `ip:OTP_PORT`. */
export function serveCode(ip: string, payload: string, expiresAt: number): OtpServer {
  const secret = randomBytes(6);
  const code = encodeCode(ip, secret);
  const keys = deriveKeys(ip, secret);
  const expected = proofFor(keys.auth);
  let failures = 0;
  let finished = false;
  const { promise: done, resolve } = Promise.withResolvers<"served" | "failed">();
  const finish = (how: "served" | "failed") => {
    if (finished) return;
    finished = true;
    resolve(how);
    setTimeout(() => server.stop(true), 200);
  };
  const server = Bun.serve({
    hostname: ip,
    port: OTP_PORT,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== "/hollr/pair" || req.method !== "POST")
        return new Response("not found", { status: 404 });
      if (finished) return Response.json({ error: "used" }, { status: 410 });
      if (Date.now() / 1000 > expiresAt) {
        finish("failed");
        return Response.json({ error: "expired" }, { status: 410 });
      }
      const body = (await req.json().catch(() => ({}))) as { proof?: string };
      const proof = Buffer.from(body.proof ?? "", "base64");
      if (proof.length !== expected.length || !timingSafeEqual(proof, expected)) {
        failures++;
        if (failures >= MAX_FAILURES) finish("failed");
        return Response.json(
          { error: failures >= MAX_FAILURES ? "locked" : "wrong_code" },
          { status: 403 },
        );
      }
      const sealed = seal(keys.enc, payload);
      finish("served");
      return Response.json({ box: sealed.toString("base64") });
    },
  });
  return {
    code,
    done,
    stop: () => {
      if (!finished) {
        finished = true;
        resolve("failed");
      }
      server.stop(true);
    },
  };
}
