import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const dir = join(Bun.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "hollr");
export const LOG_FILE = join(dir, "hollr.log");

/** Append-only log for debugging phone sessions (`hollr logs`). Never throws. */
export function log(...parts: unknown[]) {
  try {
    mkdirSync(dir, { recursive: true });
    try {
      if (statSync(LOG_FILE).size > 2_000_000) renameSync(LOG_FILE, `${LOG_FILE}.1`);
    } catch {}
    const text = parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" ");
    appendFileSync(LOG_FILE, `${new Date().toISOString()} [${process.pid}] ${text}\n`);
  } catch {}
}
