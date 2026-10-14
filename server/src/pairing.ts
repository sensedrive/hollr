/**
 * Pairing a phone without passwords or extra services:
 *
 * 1. `hollr pair` creates a short-lived *bootstrap* key and shows it as a QR code
 *    (hollr://pair?c=...). Its authorized_keys entry may only run `hollr enroll`.
 * 2. The app connects with that key, sends its own device public key (generated
 *    on the phone, never leaves it) and a device name.
 * 3. `hollr enroll` stores the device key restricted to `hollr gate` and deletes
 *    the bootstrap key. Host key pinning via the fingerprint inside the QR.
 */
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, hostname, userInfo } from "node:os";
import { dirname, join } from "node:path";

export const PAIRING_TTL_SEC = 10 * 60;

export interface PairingPayload {
  v: 1;
  a: string[]; // addresses to try, in order
  p: number; // ssh port
  u: string; // unix user
  fp: string; // SHA256 host key fingerprint
  s: string; // bootstrap ed25519 seed, base64url
  e: number; // expiry (unix seconds)
  l: string; // server label
}

export interface Device {
  id: string;
  name: string;
  fingerprint: string;
  line: number;
}

export function authorizedKeysPath(): string {
  return Bun.env.HOLLR_AUTHORIZED_KEYS ?? join(homedir(), ".ssh", "authorized_keys");
}

/** Absolute command sshd should run for this binary (compiled) or dev script. */
export function selfCommand(): string {
  const main = Bun.main;
  const q = (s: string) => `'${s.replace(/'/g, "")}'`;
  return main.endsWith(".ts") ? `${q(process.execPath)} ${q(main)}` : q(process.execPath);
}

function sshString(data: Uint8Array): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  return Buffer.concat([len, Buffer.from(data)]);
}

/** OpenSSH public key line ("ssh-ed25519 AAAA…") for a raw 32-byte Ed25519 public key. */
export function ed25519PublicLine(pub: Uint8Array): string {
  const blob = Buffer.concat([sshString(Buffer.from("ssh-ed25519")), sshString(pub)]);
  return `ssh-ed25519 ${blob.toString("base64")}`;
}

export function fingerprintOfLine(line: string): string {
  const b64 = line.trim().split(/\s+/)[1] ?? "";
  const digest = createHash("sha256").update(Buffer.from(b64, "base64")).digest("base64");
  return `SHA256:${digest.replace(/=+$/, "")}`;
}

export function hostKeyFingerprint(): string {
  for (const type of ["ed25519", "ecdsa", "rsa"]) {
    const file = Bun.env.HOLLR_HOST_KEY ?? `/etc/ssh/ssh_host_${type}_key.pub`;
    if (existsSync(file)) return fingerprintOfLine(readFileSync(file, "utf8"));
  }
  throw new Error("Kein SSH-Host-Key unter /etc/ssh gefunden.");
}

export function newBootstrapKey(): { seed: Buffer; publicLine: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pub = Buffer.from(publicKey.export({ format: "jwk" }).x as string, "base64url");
  const seed = Buffer.from(privateKey.export({ format: "jwk" }).d as string, "base64url");
  return { seed, publicLine: ed25519PublicLine(pub) };
}

// ---------- authorized_keys editing (locked + atomic) ----------

function withAuthorizedKeys<T>(edit: (lines: string[]) => { lines: string[]; result: T }): T {
  const file = authorizedKeysPath();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const lock = `${file}.hollr.lock`;
  for (let i = 0; ; i++) {
    try {
      mkdirSync(lock);
      break;
    } catch {
      if (i > 50) rmSync(lock, { recursive: true, force: true });
      Bun.sleepSync(20);
    }
  }
  try {
    const existed = existsSync(file);
    const mode = existed ? statSync(file).mode & 0o777 : 0o600;
    const lines = existed ? readFileSync(file, "utf8").split("\n") : [];
    if (lines.at(-1) === "") lines.pop();
    const { lines: next, result } = edit(lines);
    const tmp = `${file}.hollr.tmp`;
    writeFileSync(tmp, next.length ? `${next.join("\n")}\n` : "", { mode });
    renameSync(tmp, file);
    return result;
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

const BOOT_RE = /hollr-pairing:([\w-]+):exp:(\d+)/;
const DEVICE_RE = /hollr-device:([\w-]+)(?: (.*))?$/;

function dropExpired(lines: string[], now = Date.now() / 1000): string[] {
  return lines.filter((l) => {
    const m = l.match(BOOT_RE);
    return !m || Number(m[2]) > now;
  });
}

export function addBootstrap(
  publicLine: string,
  ttlSec = PAIRING_TTL_SEC,
): { id: string; exp: number } {
  const id = randomBytes(6).toString("hex");
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const line = `restrict,command="${selfCommand()} enroll ${id}" ${publicLine} hollr-pairing:${id}:exp:${exp}`;
  withAuthorizedKeys((lines) => ({ lines: [...dropExpired(lines), line], result: null }));
  return { id, exp };
}

export function sanitizeName(name: string): string {
  return (
    name
      .replace(/[^\p{L}\p{N} ._'-]/gu, "")
      .trim()
      .slice(0, 40) || "iPhone"
  );
}

/** Called via the bootstrap key: swaps it for the phone's permanent device key. */
export function enroll(pairingId: string, devicePublicLine: string, name: string): Device {
  if (!/^ssh-ed25519 [A-Za-z0-9+/=]+$/.test(devicePublicLine.trim())) {
    throw new Error("invalid_key");
  }
  const id = randomBytes(4).toString("hex");
  const clean = sanitizeName(name);
  return withAuthorizedKeys((lines) => {
    const now = Date.now() / 1000;
    const idx = lines.findIndex((l) => l.match(BOOT_RE)?.[1] === pairingId);
    if (idx === -1) throw new Error("unknown_pairing");
    if (Number(lines[idx]?.match(BOOT_RE)?.[2]) <= now) throw new Error("expired");
    const kept = dropExpired(
      lines.filter((_, i) => i !== idx),
      now,
    );
    const deviceLine = `${deviceOptions()} ${devicePublicLine.trim()} hollr-device:${id} ${clean}`;
    kept.push(deviceLine);
    return {
      lines: kept,
      result: {
        id,
        name: clean,
        fingerprint: fingerprintOfLine(devicePublicLine),
        line: kept.length,
      },
    };
  });
}

/**
 * Device keys run only `hollr gate`; TCP forwarding is allowed to this server's own
 * loopback (the in-app browser shows local dev servers). No shell, no agent/X11 forwarding.
 */
export function deviceOptions(): string {
  const permits = ["localhost", "127.0.0.1", "[::1]"].map((h) => `permitopen="${h}:*"`);
  return ["restrict", "port-forwarding", ...permits, `command="${selfCommand()} gate"`].join(",");
}

/** Brings device keys paired with older versions to the current options (idempotent). */
export function upgradeDeviceKeys(): number {
  const wanted = `${deviceOptions()} `;
  const file = authorizedKeysPath();
  if (!existsSync(file)) return 0;
  const stale = readFileSync(file, "utf8")
    .split("\n")
    .some((l) => DEVICE_RE.test(l) && !l.startsWith(wanted));
  if (!stale) return 0;
  return withAuthorizedKeys((lines) => {
    let changed = 0;
    const next = lines.map((line) => {
      const key = line.indexOf("ssh-ed25519 ");
      if (!DEVICE_RE.test(line) || line.startsWith(wanted) || key === -1) return line;
      changed++;
      return wanted + line.slice(key);
    });
    return { lines: next, result: changed };
  });
}

export function listDevices(): Device[] {
  const file = authorizedKeysPath();
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .flatMap((line, i) => {
      const m = line.match(DEVICE_RE);
      if (!m) return [];
      const keyPart = line.slice(line.indexOf("ssh-ed25519"));
      return [
        { id: m[1] ?? "", name: m[2] ?? "", fingerprint: fingerprintOfLine(keyPart), line: i + 1 },
      ];
    });
}

export function revokeDevice(idOrName: string): Device[] {
  return withAuthorizedKeys((lines) => {
    const removed: Device[] = [];
    const kept = lines.filter((line, i) => {
      const m = line.match(DEVICE_RE);
      if (m && (m[1] === idOrName || m[2] === idOrName)) {
        removed.push({ id: m[1] ?? "", name: m[2] ?? "", fingerprint: "", line: i + 1 });
        return false;
      }
      return true;
    });
    return { lines: kept, result: removed };
  });
}

// ---------- payload ----------

export function detectAddresses(): string[] {
  const out = Bun.spawnSync(["hostname", "-I"]).stdout.toString().trim();
  const addrs = out.split(/\s+/).filter((a) => a && !a.startsWith("172.17.") && !a.includes(":"));
  const isPrivate = (a: string) =>
    /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(a);
  return [...addrs.filter((a) => !isPrivate(a)), ...addrs.filter(isPrivate)];
}

export function buildPayload(opts: {
  seed: Buffer;
  exp: number;
  addresses?: string[];
  port?: number;
  label?: string;
}): PairingPayload {
  const addresses = opts.addresses?.length ? opts.addresses : detectAddresses();
  if (addresses.length === 0)
    throw new Error("Keine Server-Adresse gefunden – bitte --host angeben.");
  return {
    v: 1,
    a: addresses,
    p: opts.port ?? 22,
    u: userInfo().username,
    fp: hostKeyFingerprint(),
    s: opts.seed.toString("base64url"),
    e: opts.exp,
    l: opts.label ?? hostname(),
  };
}

export function payloadUrl(payload: PairingPayload): string {
  return `hollr://pair?c=${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
}

export function parsePayloadUrl(url: string): PairingPayload {
  const c = new URL(url).searchParams.get("c");
  if (!c) throw new Error("kein Pairing-Code");
  return JSON.parse(Buffer.from(c, "base64url").toString("utf8")) as PairingPayload;
}
