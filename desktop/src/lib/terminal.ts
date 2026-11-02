// A live terminal on a pane (see src-tauri/src/term.rs): `hollr gate attach` (the pane's own TUI in
// a PTY sized to the view) or `hollr gate shell` (an own shell in its folder). Keeps the connection
// like iOS (TerminalSession): a dropped one comes back by itself, only a server answer ends it.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/** pane: the session's own terminal · shell: an own shell in the pane's folder */
export type TermMode = "pane" | "shell";

/** What a `hollr-term` event carries (TermEvent in term.rs). */
export type TermEvent =
  | { kind: "out"; data: string }
  | { kind: "exit"; code?: number | null }
  | { kind: "error"; error: string }
  | { kind: "closed" }
  | { kind: "unsupported" }
  | { kind: "failed"; error: string }
  | { kind: "end"; error?: string };

/** Why a terminal is over (an answer from the server, or a connection that can't work). */
export type TermEnd =
  | { why: "exit" }
  | { why: "gone" }
  | { why: "closed" }
  | { why: "unsupported" }
  | { why: "error"; error: string };

/**
 * connecting: the first connection · open: output arrives · reconnecting: dropped, comes back by
 * itself (the last screen stays) · closed: an answer – only "Neu verbinden" starts again
 */
export type TermPhase =
  | { kind: "connecting" }
  | { kind: "open" }
  | { kind: "reconnecting" }
  | { kind: "closed"; end: TermEnd };

export interface TermBackend {
  start(a: { server: string; pane: string; mode: TermMode; cols: number; rows: number }): Promise<number>;
  write(id: number, data: string): Promise<void>;
  resize(id: number, cols: number, rows: number): Promise<void>;
  stop(id: number): Promise<void>;
  listen(fn: (e: TermEvent & { id: number }) => void): Promise<() => void>;
}

export const tauriBackend: TermBackend = {
  start: (a) => invoke<number>("term_start", a),
  write: (id, data) => invoke("term_write", { id, data }),
  resize: (id, cols, rows) => invoke("term_resize", { id, cols, rows }),
  stop: (id) => invoke("term_stop", { id }),
  listen: (fn) => listen<TermEvent & { id: number }>("hollr-term", (e) => fn(e.payload)),
};

/** Pause before reconnect number `failures` (iOS: 0.5 s, 1, 2, 4, 8, then every 10 s). */
export const reconnectDelay = (failures: number) => Math.min(0.5 * 2 ** Math.max(failures - 1, 0), 10) * 1000;

/** A connection that held this long starts the pauses over. */
const HELD = 30_000;

/** The server's answer as the end of the terminal; undefined: not an answer. */
export function answerOf(e: TermEvent): TermEnd | undefined {
  switch (e.kind) {
    case "exit":
      return { why: "exit" };
    case "error":
      return e.error === "not_found" ? { why: "gone" } : { why: "error", error: e.error };
    case "closed":
      return { why: "closed" };
    case "unsupported":
      return { why: "unsupported" };
    case "failed":
      return { why: "error", error: e.error };
    default:
      return undefined;
  }
}

export class TermSession {
  private id: number | null = null;
  /** a start is under way (its id not known yet) */
  private starting = false;
  /** events that arrived before term_start returned their id */
  private early: (TermEvent & { id: number })[] = [];
  /** typed, not sent yet: one write at a time (concurrent invokes may arrive out of order) */
  private outbox = "";
  private sending = false;
  private size: { cols: number; rows: number } | null = null;
  private failures = 0;
  private startedAt = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private unlisten: (() => void) | undefined;
  private disposed = false;
  phase: TermPhase = { kind: "connecting" };

  constructor(
    private readonly opts: {
      server: string;
      pane: string;
      mode: TermMode;
      onOutput: (data: string) => void;
      onPhase: (phase: TermPhase) => void;
      backend?: TermBackend;
      now?: () => number;
    },
  ) {
    this.backend.listen((e) => this.onEvent(e)).then((u) => {
      if (this.disposed) u();
      else this.unlisten = u;
    });
  }

  private get backend() {
    return this.opts.backend ?? tauriBackend;
  }
  private now() {
    return this.opts.now?.() ?? Date.now();
  }

  private setPhase(phase: TermPhase) {
    this.phase = phase;
    this.opts.onPhase(phase);
  }

  /** The terminal's size: the first one starts the connection, later ones resize the PTY. */
  resize(cols: number, rows: number) {
    if (this.disposed || cols < 1 || rows < 1) return;
    const first = this.size === null;
    if (!first && this.size!.cols === cols && this.size!.rows === rows) return;
    this.size = { cols, rows };
    if (first) this.connect();
    else if (this.id !== null) this.backend.resize(this.id, cols, rows).catch(() => {});
  }

  /** Typed text / keys as terminal input. */
  type(data: string) {
    if (!data || this.disposed || (this.id === null && !this.starting)) return;
    this.outbox += data;
    this.pump();
  }

  private async pump() {
    if (this.sending) return;
    this.sending = true;
    while (this.outbox && this.id !== null) {
      const data = this.outbox;
      this.outbox = "";
      await this.backend.write(this.id, data).catch(() => {});
    }
    this.sending = false;
  }

  /** "Neu verbinden": starts over (also after an answer). */
  restart() {
    if (this.disposed || !this.size) return;
    this.drop();
    this.failures = 0;
    this.setPhase({ kind: "connecting" });
    this.connect();
  }

  /** Back in front (window focus / visible): a dropped connection retries right away. */
  reconnectNow() {
    if (this.disposed || this.phase.kind !== "reconnecting" || this.starting || this.id !== null) return;
    clearTimeout(this.timer);
    this.connect();
  }

  dispose() {
    this.disposed = true;
    this.drop();
    this.unlisten?.();
  }

  /** Ends the current connection (no events for it any more). */
  private drop() {
    clearTimeout(this.timer);
    if (this.id !== null) this.backend.stop(this.id).catch(() => {});
    this.id = null;
    this.starting = false;
    this.early = [];
    this.outbox = "";
  }

  private async connect() {
    if (this.disposed || !this.size) return;
    this.starting = true;
    this.early = [];
    this.startedAt = this.now();
    const { server, pane, mode } = this.opts;
    let id: number;
    try {
      id = await this.backend.start({ server, pane, mode, ...this.size });
    } catch {
      if (!this.starting) return;
      this.starting = false;
      return this.dropped();
    }
    // stopped / restarted meanwhile: this start is stale
    if (!this.starting || this.disposed) return void this.backend.stop(id).catch(() => {});
    this.starting = false;
    this.id = id;
    this.pump();
    for (const e of this.early.splice(0)) if (e.id === id) this.handle(e);
  }

  private onEvent(e: TermEvent & { id: number }) {
    if (this.disposed) return;
    if (this.id === null) {
      if (this.starting) this.early.push(e);
    } else if (e.id === this.id) this.handle(e);
  }

  private handle(e: TermEvent) {
    if (e.kind === "out") {
      if (this.phase.kind !== "open") this.setPhase({ kind: "open" });
      this.opts.onOutput(e.data);
      return;
    }
    if (e.kind === "end") {
      this.id = null;
      this.outbox = "";
      return this.dropped();
    }
    const end = answerOf(e);
    if (!end) return;
    this.id = null;
    this.outbox = "";
    this.setPhase({ kind: "closed", end });
  }

  /** The connection is gone without an answer: try again after a pause. */
  private dropped() {
    if (this.disposed) return;
    this.failures = this.now() - this.startedAt > HELD ? 0 : this.failures + 1;
    this.setPhase({ kind: "reconnecting" });
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.connect(), reconnectDelay(this.failures));
  }
}

// ------------------------------------------------------------ keys

const NAMED: Record<string, string> = {
  enter: "\r", esc: "\x1b", tab: "\t", space: " ", backspace: "\x7f", delete: "\x1b[3~", insert: "\x1b[2~",
  home: "\x1b[H", end: "\x1b[F", pageup: "\x1b[5~", pagedown: "\x1b[6~",
  f1: "\x1bOP", f2: "\x1bOQ", f3: "\x1bOR", f4: "\x1bOS", f5: "\x1b[15~", f6: "\x1b[17~", f7: "\x1b[18~",
  f8: "\x1b[19~", f9: "\x1b[20~", f10: "\x1b[21~", f11: "\x1b[23~", f12: "\x1b[24~",
};
const ARROWS: Record<string, string> = { up: "A", down: "B", right: "C", left: "D" };

/**
 * A herdr key name (the composer's key menu: "esc", "up", "ctrl+c", "shift+tab", "y" …) as the bytes
 * a terminal sends for it. `appCursor`: the app switched the arrows to application mode (ESC O A).
 */
export function keySequence(name: string, appCursor = false): string | undefined {
  const parts = name.split("+");
  const key = parts.pop() ?? "";
  const mods = new Set(parts);
  let seq: string | undefined;
  if (ARROWS[key]) seq = (appCursor && !mods.size ? "\x1bO" : "\x1b[") + ARROWS[key];
  else if (key === "tab" && mods.has("shift")) return "\x1b[Z";
  else if (NAMED[key]) seq = NAMED[key];
  else if ([...key].length === 1) seq = key;
  if (seq === undefined) return undefined;
  if (mods.has("ctrl") && seq.length === 1) {
    const code = seq.toUpperCase().charCodeAt(0);
    if (code >= 64 && code <= 95) seq = String.fromCharCode(code - 64);
    else if (seq === " ") seq = "\0";
  }
  if (mods.has("alt")) seq = "\x1b" + seq;
  return seq;
}

// ------------------------------------------------------------ links

/** Links in terminal text: http(s)://, www., localhost:PORT, 127.0.0.1:PORT (like iOS). */
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"'`]+|\b(?:localhost|127\.0\.0\.1):\d{2,5}(?:\/[^\s<>"'`]*)?/g;
const count = (s: string, c: string) => s.split(c).length - 1;

/** Sentence punctuation after a link, a closing bracket the link didn't open. */
function trimUrl(url: string): string {
  while (/[.,;:!?'"\]}>]$/.test(url) || (url.endsWith(")") && count(url, "(") < count(url, ")"))) url = url.slice(0, -1);
  return url;
}

/** The links in a (logical) line: string range [start, end) and the URL to open. */
export function findLinks(text: string): { start: number; end: number; url: string }[] {
  const out: { start: number; end: number; url: string }[] = [];
  for (const m of text.matchAll(URL_RE)) {
    const raw = trimUrl(m[0]);
    if (!raw) continue;
    const url = /^https?:/i.test(raw) ? raw : (raw.startsWith("www.") ? "https://" : "http://") + raw;
    out.push({ start: m.index, end: m.index + raw.length, url });
  }
  return out;
}
