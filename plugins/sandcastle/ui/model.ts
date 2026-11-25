/** Pure board logic: columns, per-machine lanes, ticket phases and branch labels. */
import type { Column, Issue, Phase, Project, Run, RunIssue, RunTest, Status, TicketFlags } from "./types";

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
  /** absent = online (tests, callers that don't know) */
  online?: boolean;
}

/** Where a queued ticket named in no queue file belongs: the first online lane (the plugin's own machine comes first). */
export const homeLane = <L extends { online?: boolean }>(lanes: L[]): L | undefined => lanes.find((l) => l.online !== false);

/**
 * Splits the queued issues over the machines' lanes. A ticket a live run is working on belongs to that run's
 * machine (pinned, listed first in run order); otherwise the first lane whose queue file names it; one named
 * nowhere shows in the home lane – the board writes it there (`adoption`).
 */
export function assignLanes(queued: number[], lanes: LaneOrder[], pinned = new Map<number, string>()): Map<string, number[]> {
  const out = new Map<string, number[]>(lanes.map((l) => [l.server, []]));
  const home = homeLane(lanes) ?? lanes[0];
  if (!home) return out;
  const top = new Map<string, number[]>(lanes.map((l) => [l.server, []]));
  for (const [n, server] of pinned) top.get(server)?.push(n);
  for (const n of queued) {
    const server = pinned.get(n);
    if (server && top.has(server)) continue;
    const lane = lanes.find((l) => l.order.includes(n)) ?? home;
    out.get(lane.server)?.push(n);
  }
  for (const l of lanes) out.set(l.server, [...(top.get(l.server) ?? []), ...effectiveOrder(l.order, out.get(l.server) ?? [])]);
  return out;
}

/** What the board knows about one paired machine, for `adoption`. */
export interface MachineFacts {
  server: string;
  online: boolean;
  /** its project list and run status answered in this page's life – else whether it has the checkout or runs the
   *  repo is a guess (cache, or [] after a failed project scan) */
  projectsFresh: boolean;
  /** the repo is checked out there (its project list, possibly cached) */
  checkout: boolean;
  /** a live run of this repo there (run status) */
  runsRepo: boolean;
  /** the machine's queue file; null = never read */
  order: number[] | null;
  /** queue file and run status read from the machine in this page's life */
  fresh: boolean;
}

/**
 * Every queued ticket must sit in exactly one machine's queue file – the loops run only their own file. Which
 * queued tickets (ascending) the board has to append to which lane: those named in no lane's file and not pinned to
 * a live run, into the first online lane (`machines` in lane order, own machine first). Every machine that may hold
 * a file counts: one with the checkout, and an online one running the repo. Null while that can't be told safely –
 * an online machine whose project list didn't answer, a lane whose file is unknown, an online lane not read yet:
 * each might already name the ticket (it would end up in two lanes). An offline machine never seen with the repo
 * doesn't block (its loop can't run; the board can't learn more).
 */
export function adoption(queued: number[], machines: MachineFacts[], pinned: Map<number, string>): { server: string; add: number[] } | null {
  if (machines.some((m) => m.online && !m.projectsFresh)) return null;
  const lanes = machines.filter((m) => m.checkout || (m.online && m.runsRepo));
  if (lanes.some((l) => l.order === null || (l.online && !l.fresh))) return null;
  const home = lanes.find((l) => l.online && l.checkout);
  if (!home) return null;
  const add = queued.filter((n) => !pinned.has(n) && !lanes.some((l) => l.order?.includes(n))).sort((a, b) => a - b);
  return add.length ? { server: home.server, add: [...new Set(add)] } : null;
}

/** What `queue-add` stores: the file's order, then the added numbers it lacks – a union, nothing dropped. */
export const unionOrder = (order: number[], add: number[]): number[] => [...new Set([...order, ...add])];

export interface LaneFile {
  server: string;
  /** the machine's host name (gate `status`) – the same on every board, unlike the order of the lanes */
  host: string;
  order: number[];
}

/**
 * After the board appended `added` to a lane: those now named in more than one lane's file → server → the numbers
 * to take out there. Two boards on different plugin hosts (each with its own machine as first lane) may adopt the
 * same ticket at once; the later one sees both files and keeps the lane whose host name sorts first, so every
 * board settles on the same lane.
 */
export function doubles(added: number[], lanes: LaneFile[]): Map<string, number[]> {
  const out = new Map<string, number[]>();
  const rank = [...lanes].sort((a, b) => (a.host < b.host ? -1 : a.host > b.host ? 1 : a.server < b.server ? -1 : a.server > b.server ? 1 : 0));
  for (const n of new Set(added)) {
    const [, ...extra] = rank.filter((l) => l.order.includes(n));
    for (const l of extra) out.set(l.server, [...(out.get(l.server) ?? []), n]);
  }
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

/** The runs of this repo a machine's lane shows: every live one (board-started first, then by start), else the newest ended one. */
export function laneRuns(status: Status | undefined, slug: string): Run[] {
  const runs = (status?.runs ?? []).filter((r) => r.slug === slug);
  const started = (r: Run) => Date.parse(r.startedAt ?? r.endedAt ?? "0");
  const live = runs.filter((r) => r.status !== "ended").sort((a, b) => Number(a.source === "manual") - Number(b.source === "manual") || started(a) - started(b));
  if (live.length) return live;
  const ended = runs.sort((a, b) => started(b) - started(a))[0];
  return ended ? [ended] : [];
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

export interface LaneSummary {
  /** tickets in the lane (running + queued) */
  total: number;
  /** waiting in the queue, not picked by a run yet */
  queued: number;
  /** of the queued ones: waiting for an open blocker */
  blocked: number;
  /** phase counts of tickets in a live run */
  phases: Partial<Record<Phase, number>>;
}

/** What a collapsed lane says about its tickets; `phaseOf`/`blocked` come from the derived board. */
export function laneSummary(order: number[], phaseOf: (n: number) => Phase | undefined, blocked: (n: number) => boolean): LaneSummary {
  const out: LaneSummary = { total: order.length, queued: 0, blocked: 0, phases: {} };
  for (const n of order) {
    const phase = phaseOf(n);
    if (!phase || phase === "queued") {
      out.queued++;
      if (blocked(n)) out.blocked++;
    } else out.phases[phase] = (out.phases[phase] ?? 0) + 1;
  }
  return out;
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

const RUN_TESTS: readonly RunTest[] = ["none", "note", "instructions", "video"];

/**
 * The test-server choice „Neuer Lauf“ opens with: the remembered one, but „none“ when the project can't put up a
 * test server there – a remembered choice never re-enables it. Without the fact (older hollr) the choice stands.
 */
export function runTestChoice(remembered: unknown, testServer: Project["testServer"]): RunTest {
  if (testServer && !testServer.ok) return "none";
  return RUN_TESTS.find((t) => t === remembered) ?? "none";
}

/** "vor 5 Min." style durations for start times. */
export function since(iso: string | null, now = Date.now()): string {
  if (!iso) return "";
  const min = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (min < 60) return `${min} Min.`;
  const h = Math.floor(min / 60);
  return h < 24 ? `${h} Std. ${min % 60} Min.` : `${Math.floor(h / 24)} T.`;
}
