/**
 * The user's last board settings (project, view, filter, column, start form), kept on disk. Browser storage does not
 * survive: Hollr reaches the plugin through a tunnel whose local port – and so the page origin – changes every time.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HttpError } from "./env";

const MAX_BYTES = 64 * 1024;

export class Prefs {
  private readonly file: string;
  private data: Record<string, unknown>;

  constructor(private readonly dir: string) {
    this.file = join(dir, "prefs.json");
    this.data = load(this.file);
  }

  get(): Record<string, unknown> {
    return this.data;
  }

  /** Merges `patch` (null removes a key) and writes the file when something changed. */
  patch(patch: Record<string, unknown>): Record<string, unknown> {
    const next = { ...this.data };
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) delete next[k];
      else next[k] = v;
    }
    const text = JSON.stringify(next);
    if (text.length > MAX_BYTES) throw new HttpError(400, "Einstellungen sind zu groß.");
    if (text === JSON.stringify(this.data)) return this.data;
    mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, text);
    renameSync(tmp, this.file);
    this.data = next;
    return next;
  }
}

function load(file: string): Record<string, unknown> {
  try {
    const data: unknown = JSON.parse(readFileSync(file, "utf8"));
    return data && typeof data === "object" && !Array.isArray(data) ? Object.fromEntries(Object.entries(data)) : {};
  } catch {
    return {};
  }
}
