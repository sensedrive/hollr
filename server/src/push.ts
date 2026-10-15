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
  /** Live Activity on the lock screen while an agent works */
  activity: boolean;
}

export interface PushDevice {
  token: string;
  env: "sandbox" | "production";
  name: string;
  prefs: PushPrefs;
  /** app language: "de" | "en" */
  lang?: string;
  /** ActivityKit push-to-start token (iOS 17.2+): starts a Live Activity while the app is closed */
  liveStart?: string;
  /** pane → update token of the running Live Activity */
  activities?: Record<string, string>;
  updated: number;
}

export const DEFAULT_PREFS: PushPrefs = { waiting: true, done: true, error: true, activity: true };

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
  const prev = pushDevices().find((d) => d.token === token.toLowerCase());
  const liveStart = String(input.liveStart ?? prev?.liveStart ?? "");
  const device: PushDevice = {
    token: token.toLowerCase(),
    env: input.env === "sandbox" ? "sandbox" : "production",
    name: String(input.name ?? "iPhone").slice(0, 40),
    lang: input.lang === "en" ? "en" : "de",
    prefs: { ...DEFAULT_PREFS, ...(input.prefs ?? {}) },
    ...(/^[0-9a-f]{64,400}$/i.test(liveStart) ? { liveStart: liveStart.toLowerCase() } : {}),
    // the app re-registers often: running activities must not be forgotten
    ...(prev?.activities ? { activities: prev.activities } : {}),
    updated: Date.now(),
  };
  writeJson(DEVICES(), [...pushDevices().filter((d) => d.token !== device.token), device]);
  return device;
}

/** The app reports the update token of a Live Activity (or null when it ended). */
export function setActivityToken(deviceToken: string, pane: string, token: string | null) {
  if (!/^[\w:.-]{1,64}$/.test(pane)) throw new Error("invalid_pane");
  if (token !== null && !/^[0-9a-f]{64,400}$/i.test(token)) throw new Error("invalid_token");
  const devices = pushDevices();
  const device = devices.find((d) => d.token === deviceToken.toLowerCase());
  if (!device) throw new Error("unknown_device");
  const activities = { ...(device.activities ?? {}) };
  if (token) activities[pane] = token.toLowerCase();
  else delete activities[pane];
  device.activities = activities;
  writeJson(DEVICES(), devices);
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
  kind: "waiting" | "done" | "error";
  data: Record<string, string>;
  /** notification category: the app shows answer buttons / a reply field */
  category?: string;
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
        ...(notice.category ? { category: notice.category } : {}),
        // the content extension builds the answer buttons from the payload
        ...(notice.category ? { "mutable-content": 1 } : {}),
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

// ---------- Live Activities ----------

/** What the lock screen shows (mirrors AgentActivityAttributes.ContentState in the app). */
export interface ActivityState {
  /** working | waiting | done | error */
  status: string;
  /** current step / question */
  step: string;
  todoDone: number;
  todoTotal: number;
  /** unix seconds the turn started */
  since: number;
}

export interface ActivityInfo {
  pane: string;
  host: string;
  fp: string;
  title: string;
  agent: string;
}

/**
 * Starts, updates or ends the Live Activity of one agent on every phone that wants it.
 * Start uses the push-to-start token; updates and end use the activity's own token, which the app
 * reports once the activity runs. Returns how many phones got it.
 */
export async function sendActivity(
  event: "start" | "update" | "end",
  info: ActivityInfo,
  state: ActivityState,
  alert?: { title: string; body: string },
): Promise<number> {
  const config = pushConfig();
  if (!config) return 0;
  const key = readFileSync(KEY(), "utf8");
  const now = Math.floor(Date.now() / 1000);
  let sent = 0;
  for (const device of pushDevices()) {
    if (device.prefs.activity === false) continue;
    const running = device.activities?.[info.pane];
    let token: string | undefined;
    let ev: string = event;
    if (running) token = running;
    else if (event === "start" && device.liveStart) token = device.liveStart;
    else continue; // nothing running and nothing to start
    if (running && event === "start") ev = "update";
    const aps: Record<string, unknown> = {
      timestamp: now,
      event: ev,
      "content-state": state,
      "stale-date": now + 15 * 60,
    };
    if (ev === "start") {
      aps["attributes-type"] = "AgentActivityAttributes";
      aps.attributes = info;
      aps.alert = alert ?? { title: info.title, body: state.step || info.agent };
    } else if (alert) {
      aps.alert = { ...alert, sound: "default" };
    }
    if (ev === "end") aps["dismissal-date"] = now + (state.status === "error" ? 30 * 60 : 10 * 60);
    const host = device.env === "sandbox" ? "api.sandbox.push.apple.com" : "api.push.apple.com";
    const res = await apnsRequest(
      host,
      `/3/device/${token}`,
      {
        authorization: `bearer ${providerToken(config, key)}`,
        "apns-topic": `${config.bundleId}.push-type.liveactivity`,
        "apns-push-type": "liveactivity",
        // routine progress at low priority (Apple budgets high-priority activity pushes)
        "apns-priority": ev === "update" && !alert ? "5" : "10",
      },
      JSON.stringify({ aps }),
    );
    if (res.status === 200) sent++;
    else {
      log("push", `activity ${ev} ${info.pane} → ${device.name}: ${res.status} ${res.reason ?? ""}`);
      if (res.status === 410 || res.reason === "BadDeviceToken" || res.reason === "Unregistered") {
        if (running) setActivityToken(device.token, info.pane, null);
        else {
          const devices = pushDevices();
          const d = devices.find((x) => x.token === device.token);
          if (d) {
            delete d.liveStart;
            writeJson(DEVICES(), devices);
          }
        }
      }
    }
    if (ev === "end" && running) setActivityToken(device.token, info.pane, null);
  }
  return sent;
}
