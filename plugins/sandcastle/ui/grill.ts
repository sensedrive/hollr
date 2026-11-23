/**
 * Pure grill logic: which grill belongs to a ticket, how its 7 steps read, the deep link `open=` and the queue
 * behind „Alle auto-grillen“ (at most two running grills per machine).
 */
import type { Grill, GrillMode, GrillStatus, Status } from "./types";

export const GRILL_STEP_COUNT = 7;
/** step names as the server reports them; used when a grill has no steps (never seen) */
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

/** Current step, 1–7 (a finished grill stays on 7). */
export const currentStep = (g: Pick<Grill, "step">) => Math.min(Math.max(g.step, 1), GRILL_STEP_COUNT);

/** „Schritt 4/7 · Spec/ADR-PR“; finished: „Alle 7 Schritte erledigt“. */
export function stepText(g: Pick<Grill, "step" | "steps">): string {
  if (g.step > GRILL_STEP_COUNT) return `Alle ${GRILL_STEP_COUNT} Schritte erledigt`;
  const n = currentStep(g);
  const label = g.steps.find((s) => s.n === n)?.label ?? GRILL_STEP_LABELS[n - 1] ?? "";
  return `Schritt ${n}/${GRILL_STEP_COUNT} · ${label}`;
}

export type StepState = "done" | "active" | "waiting" | "todo";

/** Per step: done, the current one (active, or waiting for the human), or still open. */
export function stepStates(g: Pick<Grill, "step" | "steps" | "status">): StepState[] {
  const out: StepState[] = [];
  for (let n = 1; n <= GRILL_STEP_COUNT; n++) {
    const done = g.steps.find((s) => s.n === n)?.done ?? false;
    if (done) out.push("done");
    else if (n === g.step && isLiveGrill(g)) out.push(g.status === "waiting" ? "waiting" : "active");
    else out.push("todo");
  }
  return out;
}

/** Card badge: „wartet auf dich“ beats the progress; null = nothing worth a badge (ended). */
export function badgeText(g: Pick<Grill, "status" | "step">): string | null {
  if (g.status === "waiting") return "wartet auf dich";
  if (g.status === "ended") return null;
  return `gegrillt ${g.status === "done" ? GRILL_STEP_COUNT : currentStep(g)}/${GRILL_STEP_COUNT}`;
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
}

/** `TENDR-1:3551`, `:3551` or `TENDR-1:` (key only); anything else → null. */
export function parseOpen(value: string | null | undefined): OpenTarget | null {
  const m = (value ?? "").trim().match(/^([A-Z][A-Z0-9]+-\d+)?:(\d+)?$/);
  if (!m) return null;
  const key = m[1] ?? null;
  const n = m[2] ? Number(m[2]) : null;
  if (n !== null && n < 1) return null;
  if (!key && n === null) return null;
  return { key, n };
}

/** `open=` from a URL fragment like `#token=…&f=…&open=TENDR-1%3A3551`. */
export function readOpen(hash: string): OpenTarget | null {
  return parseOpen(new URLSearchParams(hash.replace(/^#/, "")).get("open"));
}

/** The fragment without `open=` (the link is handled once, a reload must not reopen it). */
export function dropOpen(hash: string): string {
  const rest = hash.replace(/^#/, "").split("&").filter((p) => p && !p.startsWith("open=")).join("&");
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
