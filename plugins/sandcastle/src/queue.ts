/**
 * The Sandcastle queue: `<git-common-dir>/hollr-sandcastle/queue.json` – written only here, read by the loop
 * (templates/sandcastle/queue.mts in lul-workr-init) with the same order rule.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const queueDir = (gitCommonDir: string) => join(gitCommonDir, "hollr-sandcastle");

export function readOrder(gitCommonDir: string): number[] {
  try {
    const data = JSON.parse(readFileSync(join(queueDir(gitCommonDir), "queue.json"), "utf8")) as { order?: unknown };
    return Array.isArray(data.order) ? data.order.filter((n): n is number => Number.isInteger(n) && n > 0) : [];
  } catch {
    return [];
  }
}

export function writeOrder(gitCommonDir: string, order: number[]): void {
  const dir = queueDir(gitCommonDir);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "queue.json");
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ version: 1, order })}\n`);
  renameSync(tmp, file);
}

/**
 * `order` kept to the queued issues (open, not a story, queue label), then queued issues it lacks in
 * ascending number order.
 */
export function effectiveOrder(order: number[], queued: number[]): number[] {
  const set = new Set(queued);
  const kept = [...new Set(order)].filter((n) => set.has(n));
  const known = new Set(kept);
  return [...kept, ...[...set].filter((n) => !known.has(n)).sort((a, b) => a - b)];
}

/** `n` moved before `before` (null or unknown: to the end); before itself: unchanged. */
export function moveBefore(order: number[], n: number, before: number | null): number[] {
  if (before === n) return [...order];
  const rest = order.filter((x) => x !== n);
  const at = before === null ? -1 : rest.indexOf(before);
  if (at < 0) rest.push(n);
  else rest.splice(at, 0, n);
  return rest;
}

/** To the end – also when already queued. */
export const append = (order: number[], n: number) => [...order.filter((x) => x !== n), n];

export const remove = (order: number[], n: number) => order.filter((x) => x !== n);
