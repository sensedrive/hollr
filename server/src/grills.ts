/**
 * Grills on this machine for the Sandcastle board: `lul-workr-grill-jira-ticket` / `-auto-grill-` sessions.
 * A grill is a normal omp session in herdr; the board finds it three ways – a herdr pane labelled
 * `Grill <KEY> · #<n>`, a skill flow `skill: grill|auto-grill` in the Ablauf-Log, or `<state>/grills.json`
 * (grills started from the board) – and merges them into one entry per ticket.
 *
 * Progress comes from the Ablauf-Log only: its stages are the 7 steps. Without a flow the steps are unknown
 * (`steps: null`) – never guessed. STATUS.md is the agent's own re-entry note and is not read.
 *
 * Pure apart from reading grills.json; the caller passes flows, panes and labels.
 */
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type Flow, GRILL_STAGES, type StageState } from "./flows";
import type { Agent } from "./herdr";

export type GrillMode = "interactive" | "auto";
export type GrillStatus = "running" | "waiting" | "idle" | "done" | "ended";

export interface GrillStep {
  n: number;
  /** the flow stage (read, grill, jira-comment, spec, design, story, report) */
  stage: string;
  label: string;
  state: StageState;
  /** ok or skipped */
  done: boolean;
  /** `stage.ended` reason (a skipped design: why) */
  reason: string | null;
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
  /** the 7 steps from the Ablauf-Log; null = no flow for this grill (progress unknown) */
  steps: GrillStep[] | null;
  /** the first step not done, 1–7; 8 when all are done; null without a flow */
  step: number | null;
  /** `flow.paused` reason while the flow waits (e.g. „wartet auf Antworten an #247“) */
  paused: string | null;
  /** id of the grill's flow in the Ablauf-Log */
  flow: string | null;
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
const FLOW_WINDOW = 7 * DAY;
const RECORD_WINDOW = 2 * DAY;
const RECORD_KEEP = 14 * DAY;
const RECORD_MAX = 200;

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

// ── flow steps ─────────────────────────────────────────────────────────────────────────────────────

/** The 7 steps of a grill flow and the first one not done (8 when all are). */
export function flowSteps(f: Flow): { steps: GrillStep[]; step: number } {
  const steps = GRILL_STAGES.map((stage, i) => {
    const s = f.stages.find((x) => x.stage === stage);
    const state = s?.state ?? "pending";
    return {
      n: i + 1,
      stage,
      label: STEP_LABELS[i] ?? stage,
      state,
      done: state === "ok" || state === "skipped",
      reason: s?.reason ?? null,
    };
  });
  return { steps, step: steps.find((s) => !s.done)?.n ?? 8 };
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

export interface GrillFlow {
  /** slug and project name of the flow's repo */
  slug: string;
  name: string;
  /** the repo's main checkout */
  root: string;
  flow: Flow;
}

export interface CollectInput {
  /** skill flows of the projects' repos (non-grill skills are skipped) */
  flows: GrillFlow[];
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
  /** the grill's flow (the newest when it has several) */
  f: Flow | null;
}

const iso = (ms: number) => new Date(ms).toISOString();

function blank(over: Partial<Entry>): Entry {
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
    steps: null,
    step: null,
    paused: null,
    flow: null,
    cwd: null,
    startedAt: null,
    updatedAt: null,
    f: null,
    ...over,
  };
}

const isGrillFlow = (f: Flow) =>
  f.kind === "skill" && (f.skill === "grill" || f.skill === "auto-grill");

function matches(e: Entry, g: { slug: string | null; n: number | null; key: string | null }) {
  if (e.slug && g.slug && e.slug !== g.slug) return false;
  if (e.n !== null && g.n !== null) return e.n === g.n;
  return !!e.key && e.key === g.key;
}

/** Everything known about grills on this machine, one entry per ticket, live ones first. */
export function collectGrills(a: CollectInput): Grill[] {
  const entries: Entry[] = [];
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

  // grill flows of the last 7 days, oldest first: a ticket grilled twice shows its newer flow
  const flows = a.flows
    .filter((x) => isGrillFlow(x.flow) && a.now - Date.parse(x.flow.updatedAt) <= FLOW_WINDOW)
    .sort((x, y) => x.flow.startedAt.localeCompare(y.flow.startedAt));
  for (const { slug, name, root, flow } of flows) {
    const g = {
      slug,
      n: flow.issue,
      key: flow.ticket && KEY_RE.test(flow.ticket) ? flow.ticket : null,
    };
    if (g.n === null && g.key === null) continue;
    let e = find(g);
    if (!e) {
      e = blank({ project: name, cwd: root });
      entries.push(e);
    }
    fill(e, g);
    e.f = flow;
    e.mode = flow.skill === "auto-grill" ? "auto" : "interactive";
    e.cwd ??= root;
  }

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
      // a label without the other half: the flow of the pane's repo
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

  // hand-started without a grill label: an agent in the flow's main checkout whose label names the ticket
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
    const f = e.f;
    if (f) {
      const { steps, step } = flowSteps(f);
      e.steps = steps;
      e.step = step;
      e.flow = f.id || null;
      e.paused = f.closed ? null : f.paused;
      e.startedAt ??= f.startedAt || null;
      if (f.updatedAt && (!e.updatedAt || f.updatedAt > e.updatedAt)) e.updatedAt = f.updatedAt;
    }
    e.status =
      agent?.status === "working"
        ? "running"
        : agent?.status === "blocked" || e.paused
          ? "waiting"
          : f?.outcome === "ok"
            ? "done"
            : f?.outcome === "aborted"
              ? "ended"
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
    const { f: _, ...grill } = e;
    out.push(grill);
  }
  const live = (g: Grill) => (g.status === "running" || g.status === "waiting" ? 0 : 1);
  return out.sort(
    (x, y) => live(x) - live(y) || (y.updatedAt ?? "").localeCompare(x.updatedAt ?? ""),
  );
}
