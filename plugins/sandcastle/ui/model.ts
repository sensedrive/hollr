/** Pure board logic: columns, per-machine lanes, ticket phases and branch labels. */
import type { Column, Issue, Phase, Project, Run, RunIssue, Status, TicketFlags } from "./types";

export function classify(issue: Pick<Issue, "state" | "labels">, labels: Project["labels"], hasGrill: boolean): Column | "story" {
  if (issue.labels.includes(labels.story)) return "story";
  if (issue.state === "closed") return "done";
  if (issue.labels.includes(labels.queue)) return "queue";
  if (hasGrill && labels.grill && issue.labels.includes(labels.grill)) return "grill";
  return "backlog";
}

/** The loop's rule: `order` filtered to queued issues, then the queued ones it lacks, ascending. */
export function effectiveOrder(order: number[], queued: number[]): number[] {
  const set = new Set(queued);
  const seen = new Set<number>();
  const out: number[] = [];
  for (const n of order)
    if (set.has(n) && !seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  for (const n of [...queued].sort((a, b) => a - b)) if (!seen.has(n)) out.push(n);
  return out;
}

export interface LaneOrder {
  server: string;
  order: number[];
}

/**
 * Splits the queued issues over the machines' lanes: a ticket goes to the first lane whose queue file names it;
 * one named nowhere goes to the first lane (the plugin's own machine comes first) – that loop would pick it up.
 */
export function assignLanes(queued: number[], lanes: LaneOrder[]): Map<string, number[]> {
  const out = new Map<string, number[]>(lanes.map((l) => [l.server, []]));
  const first = lanes[0];
  if (!first) return out;
  for (const n of queued) {
    const lane = lanes.find((l) => l.order.includes(n)) ?? first;
    out.get(lane.server)?.push(n);
  }
  for (const l of lanes) out.set(l.server, effectiveOrder(l.order, out.get(l.server) ?? []));
  return out;
}

/** Moves n before `before` (null = end); n need not be in the list yet. */
export function placeBefore(order: number[], n: number, before: number | null): number[] {
  const rest = order.filter((x) => x !== n);
  const i = before === null ? -1 : rest.indexOf(before);
  if (i < 0) rest.push(n);
  else rest.splice(i, 0, n);
  return rest;
}

export interface TicketRun {
  server: string;
  run: Run;
  issue: RunIssue;
}

/** n → its newest run on any machine for this repo; a live run beats an ended one. */
export function ticketRuns(statuses: Map<string, Status>, slug: string): Map<number, TicketRun> {
  const out = new Map<number, TicketRun>();
  const rank = (r: Run) => (r.status !== "ended" ? 1e15 : 0) + Date.parse(r.startedAt ?? r.endedAt ?? "0");
  for (const [server, status] of statuses)
    for (const run of status.runs) {
      if (run.slug !== slug) continue;
      for (const issue of run.issues) {
        const cur = out.get(issue.n);
        if (!cur || rank(run) > rank(cur.run)) out.set(issue.n, { server, run, issue });
      }
    }
  return out;
}

/** The newest run of this repo on a machine (live first). */
export function laneRun(status: Status | undefined, slug: string): Run | null {
  const runs = (status?.runs ?? []).filter((r) => r.slug === slug);
  runs.sort((a, b) => Number(b.status !== "ended") - Number(a.status !== "ended") || Date.parse(b.startedAt ?? "0") - Date.parse(a.startedAt ?? "0"));
  return runs[0] ?? null;
}

export const PHASE_TEXT: Record<Phase, string> = {
  queued: "wartet",
  planned: "geplant",
  building: "baut",
  reviewing: "Review",
  merged: "gemergt",
  failed: "fehlgeschlagen",
  "no-commits": "ohne Commits",
};

/** building/reviewing tickets must not be moved or reflagged – the loop has them. */
export const isBusy = (phase: Phase | undefined) => phase === "building" || phase === "reviewing";

/** Segments for the progress bar: finished first, then active, then waiting – reads left to right. */
export function segments(issues: RunIssue[]): Phase[] {
  const order: Phase[] = ["merged", "failed", "no-commits", "reviewing", "building", "planned", "queued"];
  return issues.map((i) => i.phase).sort((a, b) => order.indexOf(a) - order.indexOf(b));
}

/** `feature/queue-2026-11-23-1402` → `queue-11-23-1402`, `feature/TENDR-1069-x-y` → `TENDR-1069-…`. */
export function shortBranch(branch: string): string {
  const b = branch.replace(/^[^/]+\//, "").replace(/-20\d\d-(\d\d-\d\d)/, "-$1");
  const key = b.match(/^([A-Z][A-Z0-9]+-\d+)-./);
  if (key) return `${key[1]}-…`;
  return b.length > 22 ? `${b.slice(0, 20)}…` : b;
}

const BRANCH_COLOURS = ["--blue", "--orange", "--green", "--pink", "--cyan", "--yellow", "--purple", "--red"];

/** Stable colour per branch name, so tickets of one batch branch share it on every machine. */
export function branchColour(branch: string): string {
  let h = 0;
  for (const c of branch) h = (h * 31 + (c.codePointAt(0) ?? 0)) >>> 0;
  return `var(${BRANCH_COLOURS[h % BRANCH_COLOURS.length]})`;
}

/** `video` implies `testnote`, either implies `deploy` (as the gate stores it). */
export function normaliseFlags(f: TicketFlags, changed: keyof TicketFlags): TicketFlags {
  const next = { ...f };
  if (changed === "video" && next.video) next.testnote = true;
  if ((changed === "video" || changed === "testnote") && (next.video || next.testnote)) next.deploy = true;
  if (changed === "deploy" && !next.deploy) {
    next.testnote = false;
    next.video = false;
  }
  if (changed === "testnote" && !next.testnote) next.video = false;
  return next;
}

/** "vor 5 Min." style durations for start times. */
export function since(iso: string | null, now = Date.now()): string {
  if (!iso) return "";
  const min = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (min < 60) return `${min} Min.`;
  const h = Math.floor(min / 60);
  return h < 24 ? `${h} Std. ${min % 60} Min.` : `${Math.floor(h / 24)} T.`;
}
