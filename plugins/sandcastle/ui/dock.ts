/**
 * Pure logic of the Sandcastle dock below the Tickets board: a machine's lane (GitHub issues in run/queue order)
 * folded to JIRA tickets („chips“), their aggregated phase and stage, the run's progress and reordering whole
 * tickets inside the waiting part of a lane. No DOM, no state – tested in dock.test.ts.
 */
import type { Phase } from "./types";

/** The four steps a ticket goes through in a run (chips in the details panel). */
export const STAGES = ["Planer", "Implementer", "Code-Review", "Merge"] as const;

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

/** Index of the current stage (STAGES); before it all are done. -1 = not started, 4 = everything done. */
export function stageOf(phase: Phase): number {
  return ({ queued: -1, planned: 0, building: 1, reviewing: 2, merged: 4, failed: -1, "no-commits": -1 } as const)[phase];
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

/** Tickets of the lane this one waits for: one of its issues is blocked by an issue of theirs. */
export function dependsOn(chips: readonly DockChip[], chip: DockChip, blockedBy: (n: number) => readonly number[]): string[] {
  const blockers = new Set(chip.children.flatMap((n) => blockedBy(n)));
  return chips.filter((c) => c !== chip && c.children.some((n) => blockers.has(n))).map((c) => c.key);
}
