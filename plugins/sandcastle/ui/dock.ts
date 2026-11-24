/**
 * Pure logic of the Sandcastle dock below the Tickets board: a machine's lane (GitHub issues in run/queue order)
 * folded to JIRA tickets („chips“), their aggregated phase and stage, the run's progress and reordering whole
 * tickets inside the waiting part of a lane. No DOM, no state – tested in dock.test.ts.
 */
import type { Flow, Phase, StageState } from "./types";

/** The four steps a ticket goes through in a run (chips in the details panel). */
export const STAGES = ["Planer", "Implementer", "Code-Review", "Merge"] as const;

export interface DockChip {
  /** JIRA key, `#<n>` for an issue without ticket */
  key: string;
  /** the ticket's issues in this lane, in lane order */
  children: number[];
  phase: Phase;
  /** index of the current step (STAGES): -1 = not started, 4 = everything done */
  stage: number;
}

/** What one ticket is doing, from its issues' phases: the busiest child wins, merged only when all are. */
export function ticketPhase(phases: Phase[]): Phase {
  const rank: Phase[] = ["reviewing", "building", "planned", "failed", "no-commits", "queued"];
  return rank.find((p) => phases.includes(p)) ?? "merged";
}

/** Index of the current stage (STAGES) from a phase alone; before it all are done. -1 = not started, 4 = everything done. */
export function stageOf(phase: Phase): number {
  return ({ queued: -1, planned: 0, building: 1, reviewing: 2, merged: 4, failed: -1, "no-commits": -1 } as const)[phase];
}

/**
 * The step of one issue in a batch flow, from `role.started`/`role.ended` and the assignment's result: the role
 * working on it, else the next one due. A queued issue is at the planner while it plans; undefined = the flow
 * says nothing (not planned, or it failed – its phase tells).
 */
export function flowStage(flow: Flow, n: number): number | undefined {
  const a = flow.assignments.find((x) => x.id === n);
  if (!a) return flow.active.some((r) => r.role === "planner") ? 0 : undefined;
  if (a.result === "merged") return 4;
  if (a.result !== "running") return undefined;
  if (a.role) return { planner: 0, implementer: 1, reviewer: 2, merger: 3 }[a.role];
  return a.reviewed ? 3 : a.commits > 0 ? 2 : 1;
}

export const CHIP_TEXT: Readonly<Record<Phase, string>> = {
  queued: "⏱ wartet",
  planned: "geplant",
  building: "🔒 Implementer läuft",
  reviewing: "🔒 Code-Review läuft",
  merged: "✓ gemergt",
  failed: "✗ fehlgeschlagen",
  "no-commits": "ohne Commits",
};

/** What a chip says: the phase, or the planner/merger step a flow reports (and what a built issue waits for). */
export function chipText(c: DockChip): string {
  if (c.stage === 0 && (c.phase === "queued" || c.phase === "planned")) return "🔒 Planer läuft";
  if (c.stage === 2 && c.phase === "planned") return "wartet auf Code-Review";
  if (c.stage === 3 && c.phase === "reviewing") return "🔒 Merge läuft";
  return CHIP_TEXT[c.phase];
}

/**
 * Lane order (issue numbers) → one chip per ticket at the place of its first issue. `stepOf` (a run's flow) gives an
 * issue's step; without it the step follows the phase. A ticket stands at its busiest unfinished issue's step.
 */
export function laneChips(
  order: readonly number[],
  ticketOf: (n: number) => string | undefined,
  phaseOf: (n: number) => Phase | undefined,
  stepOf: (n: number) => number | undefined = () => undefined,
): DockChip[] {
  const byKey = new Map<string, { key: string; children: number[]; phases: Phase[]; steps: number[] }>();
  for (const n of order) {
    const key = ticketOf(n) ?? `#${n}`;
    let c = byKey.get(key);
    if (!c) {
      c = { key, children: [], phases: [], steps: [] };
      byKey.set(key, c);
    }
    const phase = phaseOf(n) ?? "queued";
    c.children.push(n);
    c.phases.push(phase);
    c.steps.push(stepOf(n) ?? stageOf(phase));
  }
  return [...byKey.values()].map((c) => {
    const phase = ticketPhase(c.phases);
    const busy = c.steps.filter((s) => s >= 0 && s < 4);
    const stage = busy.length ? Math.max(...busy) : c.steps.every((s) => s === 4) ? 4 : stageOf(phase);
    return { key: c.key, children: c.children, phase, stage };
  });
}

const STAGE_LABEL: Record<string, string> = {
  worktree: "Worktree",
  sandcastle: "Sandcastle",
  checks: "Prüfungen",
  pr: "PR",
  deploy: "Testserver",
  testplan: "Testanweisung",
  teardown: "Abbau",
};
const STAGE_MARK: Record<StageState, string> = { pending: "", running: "●", ok: "✓", failed: "✗", skipped: "–" };

/** The flow's stages for the compact line „Worktree ✓ · Sandcastle ● · Prüfungen …“. */
export function stageLine(flow: Flow): { stage: string; text: string; state: StageState; current: boolean; reason: string | null }[] {
  return flow.stages.map((s) => {
    const label = STAGE_LABEL[s.stage] ?? s.stage;
    const mark = STAGE_MARK[s.state];
    return { stage: s.stage, text: mark ? `${label} ${mark}` : label, state: s.state, current: s.stage === flow.current, reason: s.reason };
  });
}

/** „2 von 4“: the place of the furthest ticket the run has reached (nothing started yet: 1). */
export function runProgress(chips: readonly DockChip[]): { at: number; total: number } {
  const i = chips.findLastIndex((c) => c.phase !== "queued");
  return { at: Math.min(chips.length, Math.max(1, i + 1)), total: chips.length };
}

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
