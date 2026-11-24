// Spaces Hollr opened itself for a Sandcastle run or a grill: the apps list them apart from the user's own spaces.
// Recorded when the session's workspace is created (herdr.ts newChat), kept on the server like hidden spaces.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stateDir } from "./hiddenspaces";

export type SpaceOrigin = "sandcastle" | "grill";

const ORIGINS: readonly SpaceOrigin[] = ["sandcastle", "grill"];
const originsFile = () => join(stateDir(), "space-origins.json");

export function loadOrigins(): Map<string, SpaceOrigin> {
  try {
    const data = JSON.parse(readFileSync(originsFile(), "utf8")) as {
      origins?: Record<string, unknown>;
    };
    return new Map(
      Object.entries(data.origins ?? {}).filter((e): e is [string, SpaceOrigin] =>
        ORIGINS.includes(e[1] as SpaceOrigin),
      ),
    );
  } catch {
    return new Map();
  }
}

/** Written whole and renamed into place: gate calls run in parallel and must never read half a file. */
function saveOrigins(origins: Map<string, SpaceOrigin>): void {
  const file = originsFile();
  mkdirSync(stateDir(), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ origins: Object.fromEntries([...origins].sort()) })}\n`);
  renameSync(tmp, file);
}

export function recordOrigin(ws: string, origin: SpaceOrigin): void {
  const origins = loadOrigins();
  if (origins.get(ws) === origin) return;
  origins.set(ws, origin);
  saveOrigins(origins);
}

/** Forgets spaces herdr no longer has: herdr reuses workspace ids, and a new space must not inherit a mark.
 *  An empty list (herdr restarting) forgets nothing. */
export function pruneOrigins(existing: string[]): Map<string, SpaceOrigin> {
  const origins = loadOrigins();
  if (!existing.length || !origins.size) return origins;
  const keep = new Set(existing);
  const next = new Map([...origins].filter(([id]) => keep.has(id)));
  if (next.size !== origins.size) saveOrigins(next);
  return next;
}
