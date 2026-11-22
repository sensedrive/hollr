// Spaces hidden from the apps' lists ("Verstecken"): kept on the server so the desktop app and the phone always
// agree. herdr keeps them running; only the lists leave them out (a space waiting for you still shows).
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const HIDDEN_FILE = "hidden-spaces.json";

export const stateDir = () =>
  Bun.env.HOLLR_STATE_DIR ?? join(homedir(), ".local", "state", "hollr");
const hiddenFile = () => join(stateDir(), HIDDEN_FILE);

export function loadHidden(): Set<string> {
  try {
    const data = JSON.parse(readFileSync(hiddenFile(), "utf8")) as { hidden?: unknown };
    return new Set(
      Array.isArray(data.hidden)
        ? data.hidden.filter((id): id is string => typeof id === "string")
        : [],
    );
  } catch {
    return new Set();
  }
}

/** Written whole and renamed into place: gate calls run in parallel and must never read half a file. */
function saveHidden(ids: Set<string>): void {
  const file = hiddenFile();
  mkdirSync(stateDir(), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ hidden: [...ids].sort() })}\n`);
  renameSync(tmp, file);
}

/** Hides or shows spaces again; returns the hidden ones after the change. */
export function setHidden(ws: string[], hidden: boolean): string[] {
  const ids = loadHidden();
  let changed = false;
  for (const id of ws) {
    if (ids.has(id) === hidden) continue;
    if (hidden) ids.add(id);
    else ids.delete(id);
    changed = true;
  }
  if (changed) saveHidden(ids);
  return [...ids].sort();
}

/** Forgets spaces herdr no longer has: herdr reuses workspace ids, and a new space must not come up hidden.
 *  An empty list (herdr restarting) forgets nothing. */
export function pruneHidden(existing: string[]): Set<string> {
  const ids = loadHidden();
  if (!existing.length || !ids.size) return ids;
  const keep = new Set(existing);
  const next = new Set([...ids].filter((id) => keep.has(id)));
  if (next.size !== ids.size) saveHidden(next);
  return next;
}
