/**
 * Pure logic of the Sandcastle dock below the Tickets board and its run panel (magicfink sandcastle-board v24): a
 * machine's lane (GitHub issues in run/queue order) folded to JIRA tickets („chips“), the state of each child issue,
 * a story's „3/9 gemergt“ with its most active status, the loop's round (Planer wählt · Kinder bauen · Merge) and
 * reordering whole tickets inside the waiting part of a lane. The Sandcastle loop works per child issue: a round's
 * planner picks free children, each gets an implementer then a reviewer, one merger merges the round's finished
 * ones – planner and merge belong to the round, not to a story. No DOM, no state – tested in dock.test.ts.
 */
import type { Flow, Phase } from "./types";

export interface DockChip {
  /** JIRA key, `#<n>` for an issue without ticket */
  key: string;
  /** the ticket's issues in this lane, in lane order */
  children: number[];
  phase: Phase;
}

/** What one ticket is doing, from its issues' phases: the busiest child wins, merged only when all are. */
export function ticketPhase(phases: Phase[]): Phase {
  const rank: Phase[] = ["reviewing", "building", "planned", "failed", "no-commits", "queued"];
  return rank.find((p) => phases.includes(p)) ?? "merged";
}

/** Lane order (issue numbers) → one chip per ticket at the place of its first issue. */
export function laneChips(order: readonly number[], ticketOf: (n: number) => string | undefined, phaseOf: (n: number) => Phase | undefined): DockChip[] {
  const byKey = new Map<string, { key: string; children: number[]; phases: Phase[] }>();
  for (const n of order) {
    const key = ticketOf(n) ?? `#${n}`;
    let c = byKey.get(key);
    if (!c) {
      c = { key, children: [], phases: [] };
      byKey.set(key, c);
    }
    c.children.push(n);
    c.phases.push(phaseOf(n) ?? "queued");
  }
  return [...byKey.values()].map((c) => ({ key: c.key, children: c.children, phase: ticketPhase(c.phases) }));
}

// ---- children

/** Where one child issue stands in the run; unknown = the run writes no flow log, its state would be a guess. */
export type ChildStatus = "waiting" | "blocked" | "implementer" | "review" | "ready" | "merged" | "failed" | "empty" | "unknown";

export interface ChildInfo {
  n: number;
  status: ChildStatus;
  /** blocked: the open issue it waits for */
  blockedBy: number | null;
  /** failed: why */
  reason: string | null;
  /** implementer/review: when that role started on it (flow), for „seit 12 Min.“ */
  since: string | null;
}

const CHILD_LABEL: Readonly<Record<Exclude<ChildStatus, "blocked">, string>> = {
  waiting: "wartet",
  implementer: "Implementer",
  review: "Code-Review",
  ready: "wartet auf Merge",
  merged: "gemergt",
  failed: "fehlgeschlagen",
  empty: "ohne Commits",
  unknown: "ohne Angabe",
};

/** The child's pill: „Implementer“, „wartet auf #3605“, „ohne Angabe“ … */
export const childLabel = (c: ChildInfo): string => (c.status === "blocked" ? `wartet auf #${c.blockedBy ?? "?"}` : CHILD_LABEL[c.status]);

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A child's title under its story without the story's key – „… (TENDR-1091)“, „… [TENDR-1091]“ or
 * „TENDR-1091: …“ is noise there. Other text stays; a title that is only the key stays as it is.
 */
export function childTitle(title: string, storyKey: string): string {
  if (storyKey.startsWith("#")) return title;
  const key = escapeRe(storyKey);
  const cleaned = title
    .replace(new RegExp(`\\s*[([]${key}[)\\]]`, "g"), "")
    .replace(new RegExp(`^${key}\\s*[:–-]\\s*`), "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return cleaned || title;
}

/** An implementer or reviewer works on it now (row highlighted, „Log“ link). */
export const isWorking = (c: ChildInfo): boolean => c.status === "implementer" || c.status === "review";

/** A role working on children now; the hammer (implementer) or magnifier (review) in the views. */
export interface RoleGroup {
  role: "implementer" | "review";
  numbers: number[];
}

export const ROLE_LABEL: Readonly<Record<RoleGroup["role"], string>> = { implementer: "Implementer", review: "Code-Review" };

const nums = (list: readonly number[]) => list.map((n) => `#${n}`).join(", ");

/** The roles at work on these children: implementer before code review, numbers ascending. */
export function workGroups(children: readonly ChildInfo[]): RoleGroup[] {
  return (["implementer", "review"] as const)
    .map((role) => ({ role, numbers: children.filter((c) => c.status === role).map((c) => c.n).sort((a, b) => a - b) }))
    .filter((g) => g.numbers.length > 0);
}

/** „Implementer #3605 · Code-Review #3604“; the round line joins with „ an “. */
export const rolesText = (groups: readonly RoleGroup[], joiner = " "): string => groups.map((g) => `${ROLE_LABEL[g.role]}${joiner}${nums(g.numbers)}`).join(" · ");

const SEGMENT: Readonly<Record<ChildStatus, string>> = {
  waiting: "queued",
  blocked: "queued",
  unknown: "queued",
  implementer: "building",
  review: "reviewing",
  ready: "ready",
  merged: "merged",
  failed: "failed",
  empty: "empty",
};

/** Segment class (`.seg.<x>`) of a child in the progress bars. */
export const childSegment = (c: ChildInfo): string => SEGMENT[c.status];

/**
 * A child's state: from its assignment in the run's flow (role at work, merged, failed or rejected; built and
 * reviewed without a role = waiting for the round's merge), else from its phase. `blocker` = an open issue it waits
 * for (only matters while it waits); `blind` = nothing reports the run's state.
 */
export function childStatus(
  n: number,
  a: { phase: Phase | undefined; flow: Flow | null | undefined; blind: boolean; blocker?: number | null; reason?: string | null },
): ChildInfo {
  const out = (status: ChildStatus, reason: string | null = null): ChildInfo => {
    const role = status === "implementer" ? "implementer" : status === "review" ? "reviewer" : null;
    const since = role ? (a.flow?.active.find((r) => r.role === role && r.assignment === n)?.since ?? null) : null;
    return { n, status, blockedBy: status === "blocked" ? (a.blocker ?? null) : null, reason, since };
  };
  if (a.blind) return out("unknown");
  if (a.phase === "merged") return out("merged");
  const as = a.flow?.assignments.find((x) => x.id === n);
  if (as?.result === "merged") return out("merged");
  if (as && as.result !== "running") return out("failed", as.reason ?? a.reason ?? null);
  if (as) {
    if (as.role === "implementer") return out("implementer");
    if (as.role === "reviewer") return out("review");
    if (as.role === "merger" || as.reviewed) return out("ready");
    return out(as.commits > 0 ? "review" : "implementer");
  }
  switch (a.phase) {
    case "failed":
      return out("failed", a.reason ?? null);
    case "no-commits":
      return out("empty");
    case "building":
    case "planned":
      return out("implementer");
    case "reviewing":
      return out("review");
    default:
      return out(a.blocker ? "blocked" : "waiting");
  }
}

// ---- stories

export type StoryActivity = "working" | "merging" | "ready" | "waiting" | "failed" | "done" | "unknown";

export interface StorySummary {
  merged: number;
  total: number;
  /** „3/9“, blind „9 Kinder“ */
  count: string;
  activity: StoryActivity;
  /** „Implementer #3605 · Code-Review #3604“, „im Merge“, „wartet“, „fertig“, „ohne Angabe“ … */
  label: string;
  /** working: which role works on which child */
  roles: RoleGroup[];
}

const kids = (n: number) => `${n} ${n === 1 ? "Kind" : "Kinder"}`;

/** A story's merged count and its most active status: in work before merge before waiting before done. */
export function storySummary(children: readonly ChildInfo[], step: RoundStep | null): StorySummary {
  const total = children.length;
  const count = (s: ChildStatus) => children.filter((c) => c.status === s).length;
  const merged = count("merged");
  const base = { merged, total, count: `${merged}/${total}`, roles: [] };
  if (total && children.every((c) => c.status === "unknown")) return { ...base, count: kids(total), activity: "unknown", label: "ohne Angabe" };
  const roles = workGroups(children);
  if (roles.length) return { ...base, activity: "working", label: rolesText(roles), roles };
  if (count("ready")) return step === "merge" ? { ...base, activity: "merging", label: "im Merge" } : { ...base, activity: "ready", label: "wartet auf Merge" };
  if (count("waiting") || count("blocked")) return { ...base, activity: "waiting", label: "wartet" };
  const failed = count("failed");
  if (failed) return { ...base, activity: "failed", label: `fertig, ${failed} fehlgeschl.` };
  return { ...base, activity: "done", label: "fertig" };
}

/** „6 von 18 Kindern gemergt“ / „6/18 gemergt“ – the run's progress in children, not stories. */
export function childProgress(children: readonly ChildInfo[], blind: boolean): { text: string; short: string } {
  const total = children.length;
  if (blind) return { text: `${kids(total)}, Stand unbekannt`, short: `${kids(total)} · ?` };
  const merged = children.filter((c) => c.status === "merged").length;
  return { text: `${merged} von ${total} ${total === 1 ? "Kind" : "Kindern"} gemergt`, short: `${merged}/${total} gemergt` };
}

// ---- round

export type RoundStep = "planner" | "building" | "merge";

export const ROUND_STEPS: readonly { id: RoundStep; label: string }[] = [
  { id: "planner", label: "Planer wählt" },
  { id: "building", label: "Kinder bauen" },
  { id: "merge", label: "Merge" },
];

const STAGE_LABEL: Readonly<Record<string, string>> = {
  worktree: "Worktree",
  checks: "Prüfungen",
  pr: "PR",
  deploy: "Testserver",
  testplan: "Testanweisung",
  teardown: "Abbau",
};

/** What the round does now, from the flow's active roles (children at work count as building). */
export function roundStep(flow: Flow | null | undefined, working: number): RoundStep | null {
  const roles = new Set((flow?.active ?? []).map((r) => r.role));
  if (roles.has("merger")) return "merge";
  if (roles.has("implementer") || roles.has("reviewer") || working > 0) return "building";
  if (roles.has("planner")) return "planner";
  return null;
}

/**
 * „Runde 3 von max. 60 · jetzt: Implementer an #3605 · Code-Review an #3604“ (or „jetzt: Planer wählt“ /
 * „jetzt: Merge (#3604, #3605)“); after the loop the stage the run is at; blind: „Stand unbekannt – …“.
 * `children` = every child of the lane. `steps`: the round strip (Planer wählt · Kinder bauen · Merge) applies – a
 * flow reports a loop still running.
 */
export function roundLine(flow: Flow | null | undefined, blind: boolean, children: readonly ChildInfo[]): { text: string; step: RoundStep | null; steps: boolean } {
  if (blind) return { text: "Stand unbekannt – dieser Lauf schreibt kein Ablauf-Log", step: null, steps: false };
  const loop = flow?.stages.find((s) => s.stage === "sandcastle")?.state;
  if (flow && (loop === "ok" || loop === "failed" || loop === "skipped")) {
    const at = flow.current && flow.current !== "sandcastle" ? STAGE_LABEL[flow.current] : undefined;
    return { text: at ? `Schleife fertig · jetzt: ${at}` : "Schleife fertig", step: null, steps: false };
  }
  const roles = workGroups(children);
  const step = roundStep(flow, roles.length);
  const ready = children.filter((c) => c.status === "ready").map((c) => c.n).sort((a, b) => a - b);
  const what =
    step === "planner"
      ? "Planer wählt"
      : step === "merge"
        ? ready.length
          ? `Merge (${nums(ready)})`
          : "Merge"
        : step === "building"
          ? roles.length
            ? rolesText(roles, " an ")
            : "Kinder warten"
          : null;
  const it = flow?.iteration;
  if (!it) return { text: what ? `jetzt: ${what}` : flow ? "noch keine Runde – startet mit der Schleife" : "Runde unbekannt", step, steps: !!flow };
  const round = `Runde ${it.n}${it.max ? ` von max. ${it.max}` : ""}`;
  return { text: what ? `${round} · jetzt: ${what}` : round, step, steps: true };
}

// ---- lane order

/**
 * Moves a waiting ticket one place up (-1) or down (1) among the waiting tickets; the new lane order (issue
 * numbers), null when it can't move (not waiting, or the neighbour is no waiting ticket).
 */
export function moveChip(chips: readonly DockChip[], key: string, dir: -1 | 1): number[] | null {
  const i = chips.findIndex((c) => c.key === key);
  const j = i + dir;
  const a = chips[i];
  const b = chips[j];
  if (!a || !b || a.phase !== "queued" || b.phase !== "queued") return null;
  const next = [...chips];
  next[i] = b;
  next[j] = a;
  return next.flatMap((c) => c.children);
}

/**
 * „↑ nach vorne“: a waiting ticket moves before the first waiting ticket (what a run works on stays ahead); the new
 * lane order, null when it is not waiting or already first among the waiting ones.
 */
export function toFront(chips: readonly DockChip[], key: string): number[] | null {
  const i = chips.findIndex((c) => c.key === key);
  const first = chips.findIndex((c) => c.phase === "queued");
  const a = chips[i];
  if (!a || a.phase !== "queued" || i <= first) return null;
  const next = chips.filter((c) => c !== a);
  next.splice(first, 0, a);
  return next.flatMap((c) => c.children);
}

/** Tickets of the lane this one waits for: one of its issues is blocked by an issue of theirs. */
export function dependsOn(chips: readonly DockChip[], chip: DockChip, blockedBy: (n: number) => readonly number[]): string[] {
  const blockers = new Set(chip.children.flatMap((n) => blockedBy(n)));
  return chips.filter((c) => c !== chip && c.children.some((n) => blockers.has(n))).map((c) => c.key);
}
