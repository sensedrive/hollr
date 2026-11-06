// The start of a fresh session (SessionStart.svelte, MagicFink hollr-desktop v12 „SessionStart“): what to show
// before the first prompt.
import type { StatusLine } from "./api";

/** omp's footer value "3.3%/1M" → share in percent and the window ("1M"). */
export function contextShare(value?: string): { pct: number; window: string } | undefined {
  const m = value?.match(/([\d.]+)%\/(\S+)/);
  if (!m) return undefined;
  const pct = Number(m[1]);
  return Number.isFinite(pct) ? { pct, window: m[2] ?? "" } : undefined;
}

/** A German source string for t() and its placeholders. */
export interface Step {
  text: string;
  vars?: Record<string, string | number>;
}

/** First steps for the composer, from what's known about the folder (a repo: its open changes and history). */
export function firstSteps(line?: StatusLine): Step[] {
  if (!line?.branch) return [{ text: "Worum geht es in diesem Ordner?" }];
  const steps: Step[] = [{ text: "Worum geht es in diesem Projekt?" }];
  if (line.dirty === 1) steps.push({ text: "Prüf die offene Änderung auf {branch}", vars: { branch: line.branch } });
  else if (line.dirty) steps.push({ text: "Prüf die {n} offenen Änderungen auf {branch}", vars: { n: line.dirty, branch: line.branch } });
  steps.push({ text: "Was wurde zuletzt committet?" });
  return steps;
}
