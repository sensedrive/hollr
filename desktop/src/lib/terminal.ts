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

/** Links in terminal text: http(s)://, www., localhost:PORT, 127.0.0.1:PORT (like iOS). A link ends at
 *  whitespace, quotes, angle brackets and at what frames or cuts it in TUIs: box drawing and block elements
 *  (`│https://x│`), "…" (a shortened link), CJK punctuation, fullwidth forms and Nerd Font glyphs. */
const URL_CHAR = "[^\\s<>\"'`\\u2026\\u2500-\\u259f\\u3000-\\u303f\\ue000-\\uf8ff\\uff00-\\uffef]";
const URL_RE = new RegExp(
  `\\b(?:https?:\\/\\/|www\\.)${URL_CHAR}+|\\b(?:localhost|127\\.0\\.0\\.1):\\d{2,5}(?:\\/${URL_CHAR}*)?`,
  "g",
);
const LINK_CHAR = new RegExp(`^${URL_CHAR}$`);
const count = (s: string, c: string) => s.split(c).length - 1;

/** Sentence punctuation after a link, a closing bracket the link didn't open. */
function trimUrl(url: string): string {
  while (/[.,;:!?'"\]}>]$/.test(url) || (url.endsWith(")") && count(url, "(") < count(url, ")"))) url = url.slice(0, -1);
  return url;
}

/** A string range [start, end) of a (logical) line and what opening it opens. */
export interface FoundLink {
  start: number;
  end: number;
  url: string;
}

/** The links in a (logical) line: string range [start, end) and the URL to open. */
export function findLinks(text: string): FoundLink[] {
  const out: FoundLink[] = [];
  for (const m of text.matchAll(URL_RE)) {
    const raw = trimUrl(m[0]);
    if (!raw) continue;
    const url = /^https?:/i.test(raw) ? raw : (raw.startsWith("www.") ? "https://" : "http://") + raw;
    out.push({ start: m.index, end: m.index + raw.length, url });
  }
  return out;
}

/** The part of an xterm.js buffer line (IBufferLine) the link mapping reads. */
export interface TermLine {
  readonly isWrapped: boolean;
  readonly length: number;
  getCell(x: number): { getChars(): string; getWidth(): number } | undefined;
}

/** A link on the screen: first and last cell (1-based, inclusive – xterm.js' IBufferRange), the text
 *  shown there and the URL to open. */
export interface CellLink {
  start: { x: number; y: number };
  end: { x: number; y: number };
  text: string;
  url: string;
}

/** The character in the row's last column (the left half of a wide character standing there). */
function lastChars(line: TermLine): string {
  const last = line.getCell(line.length - 1);
  if (last && last.getWidth() === 0) return line.getCell(line.length - 2)?.getChars() ?? "";
  return last?.getChars() ?? "";
}

/** Row `row` goes on with the line of row `row - 1`: wrapped by the terminal, or – programs that draw
 *  their rows themselves (herdr, tmux, full-screen TUIs) break long lines without marking the next row
 *  as wrapped – the previous row is filled up to its last column and both meet inside a link-like word. */
function continues(getLine: (row: number) => TermLine | undefined, row: number): boolean {
  const line = getLine(row);
  if (!line) return false;
  if (line.isWrapped) return true;
  const prev = getLine(row - 1);
  return !!prev && LINK_CHAR.test(lastChars(prev)) && LINK_CHAR.test(line.getCell(0)?.getChars() ?? "");
}

/**
 * The links touching buffer row `y` (1-based): its logical line – the rows wrapped into one – read as text,
 * `find` run on it and each string range mapped back to the cells it is drawn in. Wide characters (emoji,
 * CJK) take two cells but one or two UTF-16 units, combining marks share their base's cell.
 */
export function linksAt(
  getLine: (row: number) => TermLine | undefined,
  rows: number,
  y: number,
  find: (text: string) => FoundLink[],
): CellLink[] {
  let first = y - 1;
  while (first > 0 && continues(getLine, first)) first--;
  let text = "";
  /** per UTF-16 unit of `text`: the cell it is drawn in (1-based) and the last column of that cell */
  const cells: { x: number; y: number; last: number }[] = [];
  for (let row = first; row < rows; row++) {
    const line = getLine(row);
    if (!line || (row > first && !continues(getLine, row))) break;
    // the empty cell a wide character left at the end of a row when it wrapped is no gap in the line
    let end = line.length;
    if (continues(getLine, row + 1)) while (end > 0 && !line.getCell(end - 1)?.getChars()) end--;
    for (let x = 0; x < end; x++) {
      const cell = line.getCell(x);
      const width = cell?.getWidth() ?? 1;
      if (width === 0) continue; // the second half of a wide character
      const chars = cell?.getChars() || " ";
      text += chars;
      for (let i = 0; i < chars.length; i++) cells.push({ x: x + 1, y: row + 1, last: x + width });
    }
  }
  const out: CellLink[] = [];
  for (const l of find(text)) {
    const start = cells[l.start];
    const end = cells[l.end - 1];
    if (!start || !end || start.y > y || end.y < y) continue;
    out.push({ start: { x: start.x, y: start.y }, end: { x: end.last, y: end.y }, text: text.slice(l.start, l.end), url: l.url });
  }
  return out;
}
