/**
 * Pure grill logic: which grill belongs to a ticket, how its 7 steps read, the deep link `open=` and the queue
 * behind „Alle auto-grillen“ (at most two running grills per machine).
 *
 * What a grill shows comes from three sources in a fixed order (`grillView`): the GitHub artifacts of the JIRA
 * ticket's family first (story with ≥ 1 child = finished, whatever log or pane say), then the steps of the grill's
 * Ablauf-Log flow, else „Stand unbekannt“ – never a guessed step.
 */
import type { Family, Grill, GrillMode, GrillStatus, JiraTicket, Status } from "./types";

export const GRILL_STEP_COUNT = 7;
/** step names as the server reports them; used when a grill has no steps (no flow) */
export const GRILL_STEP_LABELS = ["Ticket gelesen", "Grill", "JIRA-Kommentar", "Spec/ADR-PR", "Entwürfe", "Story & Kinder", "Bericht"];

/** A grill that still has a session working, waiting or paused on it – the board must not start another one. */
export const isLiveGrill = (g: Pick<Grill, "status">) => g.status === "running" || g.status === "waiting" || g.status === "idle";
/** What counts against the two-per-machine limit of the auto-grill queue. */
export const isBusyGrill = (g: Pick<Grill, "status">) => g.status === "running" || g.status === "waiting";

export const GRILL_STATUS_TEXT: Record<GrillStatus, string> = {
  running: "wird gegrillt",
  waiting: "wartet auf dich",
  idle: "pausiert",
  done: "fertig gegrillt",
  ended: "beendet",
};

export function modeText(mode: GrillMode | null): string {
  return mode === "auto" ? "Auto-Grillen" : mode === "interactive" ? "Grillen" : "Grill";
}

/** n of the grill issue → the family of its JIRA ticket (grill ticket, story, children). */
export function grillFamilies(tickets: readonly Pick<JiraTicket, "family">[]): Map<number, Family> {
  const out = new Map<number, Family>();
  for (const t of tickets) if (t.family.grill) out.set(t.family.grill.n, t.family);
  return out;
}

/** Finished by its artifacts: the story exists with at least one child. */
export const grilledByArtifacts = (f: Family | undefined): f is Family & { story: NonNullable<Family["story"]> } => !!f?.story && f.children.length > 0;

export type StepState = "done" | "skipped" | "active" | "waiting" | "todo" | "unknown";

export interface GrillView {
  /** where the state comes from: GitHub artifacts, the Ablauf-Log, or nothing */
  source: "artifacts" | "log" | "unknown";
  /** the pill: `done` when the artifacts say finished, else the session's status */
  status: GrillStatus;
  /** card badge; null = nothing worth a badge (ended) */
  badge: string | null;
  tone: "done" | "waiting" | "running" | "unknown";
  /** „Fertig gegrillt · Story #254 mit 3 Kindern“, „Schritt 4/7 · Spec/ADR-PR“, „Stand unbekannt“ */
  text: string;
  /** the grill part of a ticket's build line while the grill lives („Grill 4/7“); null when finished or ended */
  progress: string | null;
  /** why the flow waits (`flow.paused` reason) */
  reason: string | null;
  /** per step 1–7 */
  steps: StepState[];
}

const kids = (n: number) => (n === 1 ? "1 Kind" : `${n} Kindern`);

/**
 * The state to show for a grill (null = none known) and/or the family of its ticket. Artifacts beat the log, the
 * log beats „Stand unbekannt“. The artifacts also mark single steps, with or without a log: 2 when the grill
 * ticket is closed; 6 (story and children) already means finished.
 */
export function grillView(g: Grill | null, family?: Family): GrillView | null {
  if (grilledByArtifacts(family))
    return {
      source: "artifacts",
      status: "done",
      badge: "gegrillt ✓",
      tone: "done",
      text: `Fertig gegrillt · Story #${family.story.n} mit ${kids(family.children.length)}`,
      progress: null,
      reason: null,
      steps: GRILL_STEP_LABELS.map(() => "done"),
    };
  if (!g) return null;
  const live = isLiveGrill(g);
  const waiting = g.status === "waiting";
  const reason = g.paused;
  // step 6 (story and children) is the finished rule above; what is left of the artifacts is step 2
  const factDone = (n: number) => n === 2 && family?.grill?.state === "closed";
  if (g.steps && g.step !== null) {
    const step = g.step;
    const steps = GRILL_STEP_LABELS.map((_, i): StepState => {
      const n = i + 1;
      const s = g.steps?.find((x) => x.n === n);
      if (s?.state === "skipped") return "skipped";
      if (s?.done || factDone(n)) return "done";
      if (n === step && live) return waiting ? "waiting" : "active";
      return "todo";
    });
    const n = Math.min(Math.max(step, 1), GRILL_STEP_COUNT);
    const finished = step > GRILL_STEP_COUNT || g.status === "done";
    const label = g.steps.find((s) => s.n === n)?.label ?? GRILL_STEP_LABELS[n - 1] ?? "";
    return {
      source: "log",
      status: g.status,
      badge: waiting ? "wartet auf dich" : g.status === "ended" ? null : `gegrillt ${finished ? GRILL_STEP_COUNT : n}/${GRILL_STEP_COUNT}`,
      tone: waiting ? "waiting" : finished ? "done" : "running",
      text: step > GRILL_STEP_COUNT ? `Alle ${GRILL_STEP_COUNT} Schritte erledigt` : `Schritt ${n}/${GRILL_STEP_COUNT} · ${label}`,
      progress: live && !finished ? `Grill ${n}/${GRILL_STEP_COUNT}` : null,
      reason,
      steps,
    };
  }
  return {
    source: "unknown",
    status: g.status,
    badge: waiting ? "wartet auf dich" : g.status === "ended" ? null : "Stand unbekannt",
    tone: waiting ? "waiting" : "unknown",
    text: "Stand unbekannt",
    progress: live ? "Grill: Stand unbekannt" : null,
    reason,
    steps: GRILL_STEP_LABELS.map((_, i) => (factDone(i + 1) ? "done" : "unknown")),
  };
}

export interface TicketGrill {
  server: string;
  grill: Grill;
}

const RANK: Record<GrillStatus, number> = { waiting: 4, running: 3, idle: 2, done: 1, ended: 0 };

/**
 * n → the grill to show for a ticket of this repo, across every machine. Matched by slug + n, or by JIRA key for
 * grills that only know the key (`keyToN` from the board). Live beats done beats ended, then the newest.
 */
export function ticketGrills(statuses: Map<string, Pick<Status, "grills">>, slug: string, keyToN: Map<string, number>): Map<number, TicketGrill> {
  const out = new Map<number, TicketGrill>();
  const time = (g: Grill) => Date.parse(g.updatedAt ?? g.startedAt ?? "") || 0;
  for (const [server, status] of statuses)
    for (const grill of status.grills ?? []) {
      let n: number | null = null;
      if (grill.slug === slug && grill.n !== null) n = grill.n;
      else if (grill.n === null && grill.key && (grill.slug === slug || grill.slug === null)) n = keyToN.get(grill.key) ?? null;
      if (n === null) continue;
      const cur = out.get(n);
      if (!cur || RANK[grill.status] > RANK[cur.grill.status] || (RANK[grill.status] === RANK[cur.grill.status] && time(grill) > time(cur.grill)))
        out.set(n, { server, grill });
    }
  return out;
}

// ---- deep link

export interface OpenTarget {
  key: string | null;
  n: number | null;
  /** `owner/name` from `repo=`: selects the project with that slug */
  repo?: string;
}

/** GitHub `owner/name`: the owner is letters, digits and dashes, the name never starts with a dot */
const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9-]*\/(?!\.)[\w.-]+$/;

/** `TENDR-1:3551`, `:3551` or `TENDR-1:` (key only); anything else → null. A valid `repo` slug is kept, a bad one dropped. */
export function parseOpen(value: string | null | undefined, repo?: string | null): OpenTarget | null {
  const m = (value ?? "").trim().match(/^([A-Z][A-Z0-9]+-\d+)?:(\d+)?$/);
  if (!m) return null;
  const key = m[1] ?? null;
  const n = m[2] ? Number(m[2]) : null;
  if (n !== null && n < 1) return null;
  if (!key && n === null) return null;
  const slug = (repo ?? "").trim();
  return REPO_RE.test(slug) ? { key, n, repo: slug } : { key, n };
}

/** `open=` (and `repo=`) from a URL fragment like `#token=…&f=…&open=%3A3551&repo=owner%2Fname`. */
export function readOpen(hash: string): OpenTarget | null {
  const q = new URLSearchParams(hash.replace(/^#/, ""));
  return parseOpen(q.get("open"), q.get("repo"));
}

/** The JIRA ticket whose GitHub family (grill ticket, story, children) contains issue `n`; null if none. */
export function ticketOfIssue(tickets: readonly Pick<JiraTicket, "key" | "family">[], n: number): string | null {
  for (const t of tickets) {
    const f = t.family;
    if (f.grill?.n === n || f.story?.n === n || f.children.some((c) => c.n === n)) return t.key;
  }
  return null;
}

/** The fragment without `open=` and `repo=` (the link is handled once, a reload must not reopen it). */
export function dropOpen(hash: string): string {
  const rest = hash
    .replace(/^#/, "")
    .split("&")
    .filter((p) => p && !p.startsWith("open=") && !p.startsWith("repo="))
    .join("&");
  return rest ? `#${rest}` : "";
}

/** JIRA project of a key: `TENDR-1071` → `TENDR`. */
export const keyProject = (key: string) => key.replace(/-\d+$/, "");

// ---- auto-grill queue

export interface QueuedGrill {
  server: string;
  slug: string;
  n: number;
  key: string | null;
  advisor: string | null;
}

export const MAX_GRILLS_PER_MACHINE = 2;

/**
 * Which queued grills may start now: per machine, as many as the limit leaves next to its busy grills and the
 * starts already in flight; queue order is kept per machine.
 */
export function nextGrills(queue: QueuedGrill[], busy: Map<string, number>, max = MAX_GRILLS_PER_MACHINE): QueuedGrill[] {
  const used = new Map(busy);
  const out: QueuedGrill[] = [];
  for (const q of queue) {
    const n = used.get(q.server) ?? 0;
    if (n >= max) continue;
    used.set(q.server, n + 1);
    out.push(q);
  }
  return out;
}

/** Advisor choices: the project's agent models first, then recently used ones; no duplicates, valid ids only. */
export function advisorOptions(agents: { label: string; model: string }[], recent: string[]): { value: string; label: string }[] {
  const out = new Map<string, string>();
  for (const a of agents) if (ADVISOR_RE.test(a.model) && !out.has(a.model)) out.set(a.model, a.label && a.label !== a.model ? `${a.label} (${a.model})` : a.model);
  for (const m of recent) if (ADVISOR_RE.test(m) && !out.has(m)) out.set(m, m);
  return [...out].map(([value, label]) => ({ value, label }));
}

export const ADVISOR_RE = /^[\w.:/-]{1,60}$/;

/** Remembers an advisor at the front of the recent list (max 8). */
export const rememberAdvisor = (recent: string[], m: string) => [m, ...recent.filter((x) => x !== m)].slice(0, 8);
