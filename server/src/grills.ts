/**
 * Grills on this machine for the Sandcastle board: `lul-workr-grill-jira-ticket` / `-auto-grill-` sessions.
 * A grill is a normal omp session in herdr; the board finds it three ways – a herdr pane labelled
 * `Grill <KEY> · #<n>`, a recent `.scratch/<KEY>/STATUS.md` in a project folder, or `<state>/grills.json`
 * (grills started from the board) – and merges them into one entry per ticket.
 *
 * Pure apart from reading STATUS.md files and grills.json; the caller passes folders, panes and labels.
 */
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  type Stats,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { Agent } from "./herdr";

export type GrillMode = "interactive" | "auto";
export type GrillStatus = "running" | "waiting" | "idle" | "done" | "ended";

export interface GrillStep {
  n: number;
  label: string;
  done: boolean;
}

export interface Grill {
  /** `${slug}#${n}`, or `${cwd}|${key}` when slug or n is unknown */
  id: string;
  slug: string | null;
  project: string | null;
  n: number | null;
  key: string | null;
  mode: GrillMode | null;
  source: "hollr" | "manual";
  pane: string | null;
  status: GrillStatus;
  steps: GrillStep[];
  /** first open step, 8 when all are done */
  step: number;
  notes: string[];
  cwd: string | null;
  startedAt: string | null;
  updatedAt: string | null;
}

/** `<state>/sandcastle/grills.json`: one entry per `grill-start`. */
export interface GrillRecord {
  slug: string;
  n: number;
  key: string | null;
  mode: GrillMode;
  advisor: string | null;
  pane: string;
  startedAt: string;
}

export const STEP_LABELS = [
  "Ticket gelesen",
  "Grill",
  "JIRA-Kommentar",
  "Spec/ADR-PR",
  "Entwürfe",
  "Story & Kinder",
  "Bericht",
];

const DAY = 24 * 3600_000;
const STATUS_WINDOW = 7 * DAY;
const RECORD_WINDOW = 2 * DAY;
const RECORD_KEEP = 14 * DAY;
const RECORD_MAX = 200;
const NOTES_MAX = 30;
const NOTE_LEN = 300;

export const KEY_RE = /^[A-Z][A-Z0-9]+-\d+$/;
const ADVISOR_RE = /^[\w.:/-]{1,60}$/;
/** the session label – the link between Hollr's views and the board */
export const GRILL_LABEL_RE = /^(Auto-)?Grill (?:([A-Z][A-Z0-9]+-\d+) · )?#(\d+)$/;
const GRILL_LABEL_KEY_ONLY_RE = /^(Auto-)?Grill ([A-Z][A-Z0-9]+-\d+)$/;

// ── labels and prompts ─────────────────────────────────────────────────────────────────────────────

export function parseGrillLabel(
  label: string,
): { mode: GrillMode; key: string | null; n: number | null } | null {
  const s = label.trim();
  const m = s.match(GRILL_LABEL_RE);
  if (m) return { mode: m[1] ? "auto" : "interactive", key: m[2] ?? null, n: Number(m[3]) };
  const k = s.match(GRILL_LABEL_KEY_ONLY_RE);
  if (k) return { mode: k[1] ? "auto" : "interactive", key: k[2] ?? null, n: null };
  return null;
}

export function grillLabel(g: { mode: GrillMode; key: string | null; n: number }): string {
  return `${g.mode === "auto" ? "Auto-" : ""}Grill ${g.key ? `${g.key} · ` : ""}#${g.n}`;
}

export function grillPrompt(g: {
  mode: GrillMode;
  key: string | null;
  n: number;
  advisor: string | null;
}): string {
  const arg = g.key ?? `#${g.n}`;
  return g.mode === "auto"
    ? `/skill:lul-workr-auto-grill-jira-ticket ${arg}${g.advisor ? ` --advisor=${g.advisor}` : ""}`
    : `/skill:lul-workr-grill-jira-ticket ${arg}`;
}

/** The fields of a `grill-start` request, checked; German errors. */
export function validateGrillRequest(raw: {
  n?: unknown;
  key?: unknown;
  mode?: unknown;
  advisor?: unknown;
}): { n: number; key: string | null; mode: GrillMode; advisor: string | null } {
  const n = Number(raw.n);
  if (!Number.isInteger(n) || n < 1)
    throw new Error("Die Issue-Nummer muss eine ganze Zahl ab 1 sein.");
  const key = raw.key === null || raw.key === undefined || raw.key === "" ? null : String(raw.key);
  if (key !== null && !KEY_RE.test(key)) throw new Error(`„${key}“ ist kein JIRA-Schlüssel.`);
  if (raw.mode !== "interactive" && raw.mode !== "auto")
    throw new Error(`Unbekannter Modus „${String(raw.mode ?? "")}“ (interactive, auto).`);
  const advisor =
    raw.advisor === null || raw.advisor === undefined || raw.advisor === ""
      ? null
      : String(raw.advisor);
  if (advisor !== null) {
    if (raw.mode !== "auto") throw new Error("Einen Advisor gibt es nur beim Auto-Grillen.");
    if (!ADVISOR_RE.test(advisor))
      throw new Error("Advisor: nur Buchstaben, Ziffern und . : / - _ (höchstens 60 Zeichen).");
  }
  return { n, key, mode: raw.mode, advisor };
}

// ── STATUS.md ──────────────────────────────────────────────────────────────────────────────────────

/** A top-level bullet naming a step: `- [x] 5 …`, `- 4. …`, `- Schritt 3: …`, `- Schritt 1/2: …` (not `5a.`). */
const STEP_LINE =
  /^[-*]\s+(?:\[([ xX])\]\s+)?(?:Schritte?\s+)?([1-7])(?:\/([1-7]))?(?:\.|:|\)|(?=\s)|$)\s*(.*)$/;
/** a plain bullet saying the step has only begun */
const UNDERWAY = /\b(läuft|gestartet|beginnt|begonnen|offen)\b/i;
/** a section heading (`## Offen`) or a bare `Offen:` line */
const SECTION = /^(?:#{2,}\s*(.+?)|([\p{L} ]+):)\s*$/u;
const ISSUE_REF = /(?:#|\/issues\/)(\d+)/;

/**
 * Steps, ticket and notes of a grill's STATUS.md. Checkbox lines say done or not; plain step bullets count
 * as done, except under an „Offen“ section or when they say the step only started. A later line for the
 * same step wins.
 */
export function parseStatusMd(text: string): {
  steps: GrillStep[];
  step: number;
  n: number | null;
  notes: string[];
} {
  // step → done as the file says; a step the file never mentions has no entry
  const done: (boolean | undefined)[] = new Array(8).fill(undefined);
  const notes: string[] = [];
  let n: number | null = null;
  let open = false;
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^#\s/.test(trimmed)) continue;
    const ticket = trimmed.match(/^Grill-Ticket:\s*(.*)$/i);
    if (ticket) {
      const ref = ticket[1]?.match(ISSUE_REF);
      if (ref && n === null) n = Number(ref[1]);
    }
    const section = line.match(SECTION);
    if (section) {
      open = /\boffen\b/i.test(section[1] ?? section[2] ?? "");
      if (line.startsWith("#")) continue;
    }
    const step = line.match(STEP_LINE);
    if (step) {
      const box = step[1];
      const isDone =
        box !== undefined ? box.toLowerCase() === "x" : !open && !UNDERWAY.test(step[4] ?? "");
      for (const s of [step[2], step[3]]) if (s) done[Number(s)] = isDone;
      continue;
    }
    notes.push(trimmed.length > NOTE_LEN ? `${trimmed.slice(0, NOTE_LEN - 1)}…` : trimmed);
  }
  // the grill runs its steps in order: an earlier step the file never mentions is done when a later one is
  // (older STATUS.md files skip „Ticket gelesen“/„Grill“ and would read as „Schritt 1/7“); a step it lists as
  // open or started stays open
  const lastDone = Math.max(0, ...Object.entries(done).filter(([, v]) => v).map(([k]) => Number(k)));
  const steps = STEP_LABELS.map((label, i) => ({ n: i + 1, label, done: done[i + 1] ?? i + 1 <= lastDone }));
  const first = steps.find((s) => !s.done);
  return { steps, step: first ? first.n : 8, n, notes: notes.slice(-NOTES_MAX) };
}

// ── grills.json ────────────────────────────────────────────────────────────────────────────────────

export function readGrillRecords(file: string): GrillRecord[] {
  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(data) ? (data as GrillRecord[]) : [];
  } catch {
    return [];
  }
}

/** Appends a start; keeps the last 200 of the last 14 days. */
export function recordGrill(file: string, rec: GrillRecord, now = Date.now()): void {
  const kept = readGrillRecords(file).filter((r) => now - Date.parse(r.startedAt) <= RECORD_KEEP);
  const all = [...kept, rec].slice(-RECORD_MAX);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(all)}\n`);
  renameSync(tmp, file);
}

// ── discovery ──────────────────────────────────────────────────────────────────────────────────────

export interface CollectInput {
  /** candidate working folders (project roots, worktrees) */
  dirs: Iterable<string>;
  /** herdr's agents; null = herdr unreachable */
  agents: Agent[] | null;
  /** pane → its tab and workspace labels */
  labels: Map<string, string[]>;
  records: GrillRecord[];
  /** slug and project name of a working folder */
  projectOf: (cwd: string) => { slug: string; name: string } | null;
  /** project name of a slug */
  nameOf: (slug: string) => string | null;
  now: number;
  /** done grills last updated longer ago drop out (default 24 h) */
  doneTtl?: number;
}

interface Entry extends Grill {
  /** STATUS.md was found */
  hasStatus: boolean;
}

const iso = (ms: number) => new Date(ms).toISOString();
const listDir = (dir: string) => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};

function blank(over: Partial<Entry>): Entry {
  const steps = STEP_LABELS.map((label, i) => ({ n: i + 1, label, done: false }));
  return {
    id: "",
    slug: null,
    project: null,
    n: null,
    key: null,
    mode: null,
    source: "manual",
    pane: null,
    status: "ended",
    steps,
    step: 1,
    notes: [],
    cwd: null,
    startedAt: null,
    updatedAt: null,
    hasStatus: false,
    ...over,
  };
}

/** `.scratch/<KEY>/STATUS.md` written in the last 7 days that are about a grill. */
function statusEntries(a: CollectInput): Entry[] {
  const found = new Map<string, Entry>();
  for (const cwd of a.dirs) {
    const scratch = join(cwd, ".scratch");
    for (const key of listDir(scratch)) {
      if (!KEY_RE.test(key)) continue;
      const file = join(scratch, key, "STATUS.md");
      let st: Stats;
      try {
        st = statSync(file);
      } catch {
        continue;
      }
      if (a.now - st.mtimeMs > STATUS_WINDOW) continue;
      let text: string;
      try {
        text = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      if (!/grill/i.test(text)) continue;
      const parsed = parseStatusMd(text);
      const proj = a.projectOf(cwd);
      const entry = blank({
        slug: proj?.slug ?? null,
        project: proj?.name ?? null,
        n: parsed.n,
        key,
        steps: parsed.steps,
        step: parsed.step,
        notes: parsed.notes,
        cwd,
        startedAt: iso(st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs),
        updatedAt: iso(st.mtimeMs),
        hasStatus: true,
      });
      // the same ticket's file in two checkouts: the one written last counts
      const id = `${entry.slug ?? ""}|${key}`;
      const seen = found.get(id);
      if (!seen || (seen.updatedAt ?? "") < (entry.updatedAt ?? "")) found.set(id, entry);
    }
  }
  return [...found.values()];
}

function matches(e: Entry, g: { slug: string | null; n: number | null; key: string | null }) {
  if (e.slug && g.slug && e.slug !== g.slug) return false;
  if (e.n !== null && g.n !== null) return e.n === g.n;
  return !!e.key && e.key === g.key;
}

/** Everything known about grills on this machine, one entry per ticket, live ones first. */
export function collectGrills(a: CollectInput): Grill[] {
  const entries = statusEntries(a);
  const agents = a.agents ?? [];
  const alive = new Map(agents.map((x) => [x.pane, x]));
  const find = (g: { slug: string | null; n: number | null; key: string | null }) =>
    entries.find((e) => matches(e, g));
  const fill = (e: Entry, g: { slug: string | null; n: number | null; key: string | null }) => {
    e.slug ??= g.slug;
    e.n ??= g.n;
    e.key ??= g.key;
    if (e.slug) e.project ??= a.nameOf(e.slug);
  };

  // started from the board
  for (const r of a.records) {
    if (a.now - Date.parse(r.startedAt) > RECORD_WINDOW) continue;
    const g = { slug: r.slug, n: r.n, key: r.key };
    let e = find(g);
    if (!e) {
      e = blank({ project: a.nameOf(r.slug) });
      entries.push(e);
    }
    fill(e, g);
    // records are in start order: a ticket grilled twice shows its newer start
    e.source = "hollr";
    e.mode = r.mode;
    e.startedAt = r.startedAt;
    if (alive.has(r.pane)) e.pane = r.pane;
  }

  // herdr panes labelled as a grill
  for (const agent of agents) {
    const label = (a.labels.get(agent.pane) ?? []).map(parseGrillLabel).find((x) => x !== null);
    if (!label) continue;
    const proj = agent.cwd ? a.projectOf(agent.cwd) : null;
    const g = { slug: proj?.slug ?? null, n: label.n, key: label.key };
    let e =
      find(g) ??
      // a label without the other half: the STATUS.md in the pane's folder
      entries.find(
        (x) =>
          x.cwd === agent.cwd &&
          (label.key === null || x.key === label.key) &&
          (label.n === null || x.n === null || x.n === label.n),
      );
    if (!e) {
      e = blank({});
      entries.push(e);
    }
    fill(e, g);
    e.mode ??= label.mode;
    e.pane = agent.pane;
  }

  // hand-started without a grill label: an agent in the STATUS folder whose label names the ticket
  for (const e of entries) {
    if (e.pane || !e.cwd || !e.key) continue;
    const key = e.key.toLowerCase();
    const agent = agents.find(
      (x) =>
        x.cwd === e.cwd &&
        x.kind !== "unknown" &&
        (a.labels.get(x.pane) ?? []).some((l) => l.toLowerCase().includes(key)),
    );
    if (agent) e.pane = agent.pane;
  }

  const ttl = a.doneTtl ?? DAY;
  const out: Grill[] = [];
  for (const e of entries) {
    const agent = e.pane ? alive.get(e.pane) : undefined;
    const allDone = e.step === 8;
    e.status =
      agent?.status === "working"
        ? "running"
        : agent?.status === "blocked"
          ? "waiting"
          : allDone
            ? "done"
            : agent
              ? "idle"
              : "ended";
    if (!agent) e.pane = null;
    if (agent?.sessionFile) {
      try {
        const session = iso(statSync(agent.sessionFile).mtimeMs);
        if (!e.updatedAt || session > e.updatedAt) e.updatedAt = session;
      } catch {}
    }
    if (e.status === "done" && a.now - Date.parse(e.updatedAt ?? e.startedAt ?? "") > ttl) continue;
    e.id =
      e.slug && e.n !== null ? `${e.slug}#${e.n}` : `${e.cwd ?? ""}|${e.key ?? `#${e.n ?? ""}`}`;
    const { hasStatus: _, ...grill } = e;
    out.push(grill);
  }
  const live = (g: Grill) => (g.status === "running" || g.status === "waiting" ? 0 : 1);
  return out.sort(
    (x, y) => live(x) - live(y) || (y.updatedAt ?? "").localeCompare(x.updatedAt ?? ""),
  );
}
