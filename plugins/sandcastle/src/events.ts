/** Progress of a run from `<git-common-dir>/hollr-sandcastle/events.jsonl` (loop and skill append to it). */

export interface Progress {
  loop?: { cwd: string; branch: string };
  picked: Set<number>;
  merged: Set<number>;
  failed: Map<number, string>;
  noCommits: Set<number>;
  /** titles from `picked` – for issues the board no longer lists */
  titles: Map<number, string>;
  loopEnded?: string;
  runEnd?: { result: string; pr: number | null };
}

/** A field of a parsed JSON value, if it is an object with that key. */
function field(v: unknown, key: string): unknown {
  if (typeof v !== "object" || v === null || !(key in v)) return undefined;
  return Object.entries(v).find(([k]) => k === key)?.[1];
}

/** Issue numbers of a list of numbers or of {id} objects. */
const nums = (v: unknown): number[] =>
  Array.isArray(v) ? v.map((x) => Number(typeof x === "object" ? field(x, "id") : x)).filter((n) => n > 0) : [];

/** Lines at or after `sinceIso`; broken lines are skipped; a later event about an issue wins. */
export function parseProgress(text: string, sinceIso: string): Progress {
  const since = Date.parse(sinceIso);
  const p: Progress = { picked: new Set(), merged: new Set(), failed: new Map(), noCommits: new Set(), titles: new Map() };
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let e: unknown;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const at = Date.parse(String(field(e, "at") ?? ""));
    if (!(at >= since)) continue;
    switch (field(e, "t")) {
      case "loop-start":
        p.loop = { cwd: String(field(e, "cwd") ?? ""), branch: String(field(e, "branch") ?? "") };
        break;
      case "picked": {
        const issues = field(e, "issues");
        for (const issue of Array.isArray(issues) ? issues : []) {
          const n = Number(field(issue, "id"));
          if (!(n > 0)) continue;
          p.picked.add(n);
          p.merged.delete(n);
          p.failed.delete(n);
          p.noCommits.delete(n);
          const title = field(issue, "title");
          if (typeof title === "string") p.titles.set(n, title);
        }
        break;
      }
      case "failed": {
        const n = Number(field(e, "issue"));
        if (n > 0) {
          p.failed.set(n, String(field(e, "reason") ?? ""));
          p.merged.delete(n);
          p.noCommits.delete(n);
        }
        break;
      }
      case "no-commits":
        for (const n of nums(field(e, "issues"))) {
          p.noCommits.add(n);
          p.failed.delete(n);
          p.merged.delete(n);
        }
        break;
      case "merged":
        for (const n of nums(field(e, "issues"))) {
          p.merged.add(n);
          p.failed.delete(n);
          p.noCommits.delete(n);
        }
        break;
      case "loop-end":
        p.loopEnded = String(field(e, "reason") ?? "");
        break;
      case "run-end": {
        const pr = field(e, "pr");
        p.runEnd = { result: String(field(e, "result") ?? ""), pr: typeof pr === "number" ? pr : null };
        break;
      }
    }
  }
  return p;
}

/** Picked and not yet merged, failed or without commits. */
export const inProgress = (p: Progress) =>
  [...p.picked].filter((n) => !p.merged.has(n) && !p.failed.has(n) && !p.noCommits.has(n));
