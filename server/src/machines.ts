// The user's machines, so every app pairs the same ones. Each app writes its list of servers to every server it
// reaches (`machines` merge) and reads the union back; a server only one app knows gets paired by the others
// through an invite:
//
// 1. app B lacks machine X → `request` on a server it shares with app A (any server both reach)
// 2. app A, paired with X, sees the request → asks X for a fresh one-time pairing link (`gate pairlink` on X,
//    the same bootstrap key `hollr pair` makes, 10 minutes, one use) → `invite` on that shared server
// 3. app B `take`s it and pairs as if the link had been scanned.
//
// Entries are keyed by host-key fingerprint; the newest `updatedAt` wins, so a removal (`removed`) spreads like an
// addition and a later pairing brings the machine back. Invites hold a pairing secret: the file is 0600, only paired
// devices can read it through `hollr gate`, and an invite goes away once taken or expired.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stateDir } from "./hiddenspaces";

export const MACHINES_FILE = "machines.json";
const INVITE_TTL_MS = 10 * 60_000;
const REQUEST_TTL_MS = 24 * 3_600_000;

export interface Machine {
  /** SHA256 host key fingerprint – the machine's identity */
  fp: string;
  label: string;
  addresses: string[];
  port: number;
  user: string;
  /** ms; the newest version of an entry wins */
  updatedAt: number;
  /** removed on some device: every app drops it (a newer pairing brings it back) */
  removed?: boolean;
}

export interface PairRequest {
  /** the machine wanted */
  fp: string;
  /** the asking app installation */
  install: string;
  name: string;
  at: number;
}

export interface Invite {
  fp: string;
  install: string;
  url: string;
  expires: number;
}

/** One of the user's own settings every app should have the same (newest `updatedAt` wins). */
export interface Pref<T> {
  value: T;
  updatedAt: number;
}

/** Settings that belong to the user, not to a device: the composer's prompt snippets, the dictation vocabulary. */
export interface Prefs {
  snippets?: Pref<string[]>;
  vocabulary?: Pref<string>;
}

export interface MachinesDoc {
  machines: Machine[];
  requests: PairRequest[];
  invites: Invite[];
  prefs: Prefs;
}

const file = () => join(stateDir(), MACHINES_FILE);

const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length < 4096;

function validMachine(m: unknown): m is Machine {
  const x = m as Machine;
  return (
    !!x &&
    isStr(x.fp) &&
    typeof x.label === "string" &&
    Array.isArray(x.addresses) &&
    x.addresses.every(isStr) &&
    Number.isInteger(x.port) &&
    typeof x.user === "string" &&
    typeof x.updatedAt === "number" &&
    Number.isFinite(x.updatedAt)
  );
}

function validPrefs(raw: unknown): Prefs {
  const p = (raw ?? {}) as Record<string, Pref<unknown> | undefined>;
  const stamped = (x: Pref<unknown> | undefined) =>
    !!x && typeof x.updatedAt === "number" && Number.isFinite(x.updatedAt);
  const out: Prefs = {};
  const s = p.snippets;
  if (stamped(s) && Array.isArray(s?.value) && s.value.every((v) => typeof v === "string"))
    out.snippets = {
      value: (s.value as string[]).slice(0, 100).map((v) => v.slice(0, 4000)),
      updatedAt: s.updatedAt,
    };
  const v = p.vocabulary;
  if (stamped(v) && typeof v?.value === "string")
    out.vocabulary = { value: v.value.slice(0, 20_000), updatedAt: v.updatedAt };
  return out;
}

/** Newest wins per setting. */
export function mergePrefs(have: Prefs, incoming: Prefs): Prefs {
  const next = { ...have };
  const add = validPrefs(incoming);
  if (add.snippets && (!next.snippets || add.snippets.updatedAt > next.snippets.updatedAt))
    next.snippets = add.snippets;
  if (add.vocabulary && (!next.vocabulary || add.vocabulary.updatedAt > next.vocabulary.updatedAt))
    next.vocabulary = add.vocabulary;
  return next;
}

export function loadMachines(now = Date.now()): MachinesDoc {
  let raw: Partial<MachinesDoc> = {};
  try {
    raw = JSON.parse(readFileSync(file(), "utf8"));
  } catch {}
  return {
    machines: Array.isArray(raw.machines) ? raw.machines.filter(validMachine) : [],
    requests: Array.isArray(raw.requests)
      ? raw.requests.filter((r) => isStr(r?.fp) && isStr(r?.install) && now - r.at < REQUEST_TTL_MS)
      : [],
    invites: Array.isArray(raw.invites)
      ? raw.invites.filter(
          (i) => isStr(i?.fp) && isStr(i?.install) && isStr(i?.url) && i.expires > now,
        )
      : [],
    prefs: validPrefs(raw.prefs),
  };
}

function save(doc: MachinesDoc) {
  mkdirSync(stateDir(), { recursive: true });
  const tmp = `${file()}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(doc)}\n`, { mode: 0o600 });
  renameSync(tmp, file());
}

/** Newest entry per machine wins; equal times keep what is there. */
export function mergeMachines(have: Machine[], incoming: Machine[]): Machine[] {
  const byFp = new Map(have.map((m) => [m.fp, m]));
  for (const m of incoming) {
    if (!validMachine(m)) continue;
    const old = byFp.get(m.fp);
    if (!old || m.updatedAt > old.updatedAt)
      byFp.set(m.fp, {
        fp: m.fp,
        label: m.label.slice(0, 80),
        addresses: m.addresses.slice(0, 12),
        port: m.port,
        user: m.user.slice(0, 64),
        updatedAt: m.updatedAt,
        ...(m.removed ? { removed: true } : {}),
      });
  }
  return [...byFp.values()].sort((a, b) => a.label.localeCompare(b.label));
}

export type MachinesRequest =
  | { op: "get" }
  | { op: "merge"; machines?: Machine[]; prefs?: Prefs }
  | { op: "request"; fp: string; install: string; name?: string }
  | { op: "invite"; fp: string; install: string; url: string }
  | { op: "take"; install: string };

/** One `gate machines` call: the doc after it (invites only for `take`, and only the caller's). */
export function machines(
  req: MachinesRequest,
  now = Date.now(),
): Partial<MachinesDoc> & { taken?: Invite[] } {
  const doc = loadMachines(now);
  const view = () => ({ machines: doc.machines, requests: doc.requests, prefs: doc.prefs });
  switch (req.op) {
    case "merge": {
      if (req.machines !== undefined && !Array.isArray(req.machines))
        throw new Error("machines muss eine Liste sein");
      const before = JSON.stringify([doc.machines, doc.prefs]);
      doc.machines = mergeMachines(doc.machines, req.machines ?? []);
      doc.prefs = mergePrefs(doc.prefs, req.prefs ?? {});
      // every write wakes every app's feed: an app that sent nothing new must not start another round
      if (JSON.stringify([doc.machines, doc.prefs]) !== before) save(doc);
      return view();
    }
    case "request": {
      if (!isStr(req.fp) || !isStr(req.install)) throw new Error("fp/install fehlt");
      const old = doc.requests.find((r) => r.fp === req.fp && r.install === req.install);
      // asked again within a minute: already waiting for an answer, no new write (and no feed round)
      if (old && now - old.at < 60_000) return view();
      doc.requests = [
        ...doc.requests.filter((r) => r !== old),
        { fp: req.fp, install: req.install, name: (req.name ?? "").slice(0, 60), at: now },
      ];
      save(doc);
      return view();
    }
    case "invite": {
      if (!isStr(req.fp) || !isStr(req.install) || !req.url?.startsWith("hollr://pair?c="))
        throw new Error("Einladung unvollständig");
      doc.invites = [
        ...doc.invites.filter((i) => !(i.fp === req.fp && i.install === req.install)),
        { fp: req.fp, install: req.install, url: req.url, expires: now + INVITE_TTL_MS },
      ];
      // answered
      doc.requests = doc.requests.filter((r) => !(r.fp === req.fp && r.install === req.install));
      save(doc);
      return view();
    }
    case "take": {
      if (!isStr(req.install)) throw new Error("install fehlt");
      const taken = doc.invites.filter((i) => i.install === req.install);
      if (taken.length) {
        doc.invites = doc.invites.filter((i) => i.install !== req.install);
        save(doc);
      }
      return { ...view(), taken };
    }
    default:
      return view();
  }
}
