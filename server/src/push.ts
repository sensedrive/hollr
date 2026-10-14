/**
 * Push notifications straight from this server to Apple (APNs) – no relay in between.
 * Needs the team's APNs auth key (.p8), set up once with `hollr push setup`.
 */
import { createPrivateKey, sign } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { connect } from "node:http2";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "./log";

/** read on every call, so tests (HOLLR_PUSH_DIR) never touch the real config */
export const pushDir = () => Bun.env.HOLLR_PUSH_DIR ?? join(homedir(), ".config", "hollr");
const CONFIG = () => join(pushDir(), "push.json");
const KEY = () => join(pushDir(), "apns.p8");
const DEVICES = () => join(pushDir(), "push-devices.json");

export interface PushConfig {
  keyId: string;
  teamId: string;
  bundleId: string;
}

export interface PushPrefs {
  /** agent waits for you (question, confirmation) */
  waiting: boolean;
  /** agent finished its turn */
  done: boolean;
  /** agent stopped with an error */
  error: boolean;
}

export interface PushDevice {
  token: string;
  env: "sandbox" | "production";
  name: string;
  prefs: PushPrefs;
  /** app language: "de" | "en" */
  lang?: string;
  updated: number;
}

export const DEFAULT_PREFS: PushPrefs = { waiting: true, done: true, error: true };

export function pushConfig(): PushConfig | undefined {
  try {
    const c = JSON.parse(readFileSync(CONFIG(), "utf8")) as PushConfig;
    return c.keyId && c.teamId && existsSync(KEY()) ? c : undefined;
  } catch {
    return undefined;
  }
}

/** Stores the APNs key (mode 600) and its ids. */
export function setupPush(
  keyFile: string,
  keyId: string,
  teamId: string,
  bundleId = "app.hollr.ios",
) {
  setupPushKey(readFileSync(keyFile, "utf8"), keyId, teamId, bundleId);
}

/** Same, with the key text (sent by the app over the paired SSH connection). */
export function setupPushKey(
  pem: string,
  keyId: string,
  teamId: string,
  bundleId = "app.hollr.ios",
) {
  if (!/^[A-Z0-9]{10}$/.test(keyId)) throw new Error("Key-ID: 10 Zeichen, z. B. ABC123DEFG");
  if (!/^[A-Z0-9]{10}$/.test(teamId)) throw new Error("Team-ID: 10 Zeichen, z. B. ABCDE12345");
  if (!/^[\w.-]+$/.test(bundleId)) throw new Error("ungültige Bundle-ID");
  createPrivateKey(pem); // fails early on a broken key
  mkdirSync(pushDir(), { recursive: true, mode: 0o700 });
  writeFileSync(KEY(), pem, { mode: 0o600 });
  chmodSync(KEY(), 0o600);
  writeJson(CONFIG(), { keyId, teamId, bundleId });
  jwtCache = undefined;
}

// ---------- devices ----------

function writeJson(file: string, data: unknown) {
  mkdirSync(pushDir(), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
}

export function pushDevices(): PushDevice[] {
  try {
    return JSON.parse(readFileSync(DEVICES(), "utf8")) as PushDevice[];
  } catch {
    return [];
  }
}

export function registerDevice(input: Partial<PushDevice>): PushDevice {
  const token = String(input.token ?? "");
  if (!/^[0-9a-f]{64,200}$/i.test(token)) throw new Error("invalid_token");
  const device: PushDevice = {
    token: token.toLowerCase(),
    env: input.env === "sandbox" ? "sandbox" : "production",
    name: String(input.name ?? "iPhone").slice(0, 40),
    lang: input.lang === "en" ? "en" : "de",
    prefs: { ...DEFAULT_PREFS, ...(input.prefs ?? {}) },
    updated: Date.now(),
  };
  writeJson(DEVICES(), [...pushDevices().filter((d) => d.token !== device.token), device]);
  return device;
}

export function unregisterDevice(token: string): boolean {
  const before = pushDevices();
  const after = before.filter((d) => d.token !== token.toLowerCase());
  writeJson(DEVICES(), after);
  return after.length !== before.length;
}

// ---------- APNs ----------

let jwtCache: { token: string; at: number } | undefined;

function b64url(data: string | Buffer): string {
  return Buffer.from(data).toString("base64url");
}

/** ES256 provider token, reused for 50 minutes (Apple allows 20–60). */
export function providerToken(config: PushConfig, keyPem: string, now = Date.now()): string {
  if (jwtCache && now - jwtCache.at < 50 * 60 * 1000) return jwtCache.token;
  const header = b64url(JSON.stringify({ alg: "ES256", kid: config.keyId }));
  const claims = b64url(JSON.stringify({ iss: config.teamId, iat: Math.floor(now / 1000) }));
  const signature = sign("sha256", Buffer.from(`${header}.${claims}`), {
    key: createPrivateKey(keyPem),
    dsaEncoding: "ieee-p1363",
  });
  const token = `${header}.${claims}.${b64url(signature)}`;
  jwtCache = { token, at: now };
  return token;
}

export interface Notice {
  title: string;
  subtitle?: string;
  body: string;
  /** groups notifications per agent */
  thread: string;
  /** replaces an older notification of the same agent */
  collapse?: string;
  kind: keyof PushPrefs;
  data: Record<string, string>;
  /** English texts for phones that run Hollr in English */
  en?: { subtitle?: string; body?: string };
}

function apnsRequest(host: string, path: string, headers: Record<string, string>, body: string) {
  return new Promise<{ status: number; reason?: string }>((resolve) => {
    const client = connect(`https://${host}`);
    client.on("error", (err) => resolve({ status: 0, reason: String(err) }));
    const req = client.request({ ":method": "POST", ":path": path, ...headers });
    let status = 0;
    let text = "";
    req.on("response", (h) => {
      status = Number(h[":status"]);
    });
    req.on("data", (chunk) => {
      text += chunk;
    });
    req.on("end", () => {
      client.close();
      let reason: string | undefined;
      try {
        reason = text ? (JSON.parse(text) as { reason?: string }).reason : undefined;
      } catch {}
      resolve({ status, reason });
    });
    req.on("error", (err) => {
      client.close();
      resolve({ status: 0, reason: String(err) });
    });
    req.setTimeout(10_000, () => req.close());
    req.end(body);
  });
}

/** Sends a notice to every registered phone that wants this kind. Returns how many got it. */
export async function sendNotice(notice: Notice): Promise<number> {
  const config = pushConfig();
  if (!config) return 0;
  const key = readFileSync(KEY(), "utf8");
  const payloadFor = (lang?: string) => {
    const en = lang === "en" ? notice.en : undefined;
    return JSON.stringify({
      aps: {
        alert: {
          title: notice.title,
          subtitle: en?.subtitle ?? notice.subtitle,
          body: en?.body ?? notice.body,
        },
        sound: "default",
        "thread-id": notice.thread,
        "interruption-level": notice.kind === "waiting" ? "time-sensitive" : "active",
      },
      ...notice.data,
    });
  };
  let sent = 0;
  for (const device of pushDevices()) {
    if (!device.prefs[notice.kind]) continue;
    const host = device.env === "sandbox" ? "api.sandbox.push.apple.com" : "api.push.apple.com";
    const headers: Record<string, string> = {
      authorization: `bearer ${providerToken(config, key)}`,
      "apns-topic": config.bundleId,
      "apns-push-type": "alert",
      "apns-priority": "10",
    };
    if (notice.collapse) headers["apns-collapse-id"] = notice.collapse.slice(0, 64);
    const res = await apnsRequest(
      host,
      `/3/device/${device.token}`,
      headers,
      payloadFor(device.lang),
    );
    if (res.status === 200) sent++;
    else {
      log("push", `${device.name}: ${res.status} ${res.reason ?? ""}`);
      if (res.status === 410 || res.reason === "BadDeviceToken" || res.reason === "Unregistered") {
        unregisterDevice(device.token);
      }
    }
  }
  return sent;
}
