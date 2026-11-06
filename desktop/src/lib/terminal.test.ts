import { describe, expect, test, vi } from "bun:test";
import { findLinks, keySequence, linksAt, reconnectDelay, TermSession, type TermBackend, type TermEvent, type TermLine, type TermPhase } from "./terminal";

/** A backend whose starts answer when the test says so. */
function fakeBackend() {
  let emit: (e: TermEvent & { id: number }) => void = () => {};
  const starts: { cols: number; rows: number; mode: string }[] = [];
  const writes: [number, string][] = [];
  const resizes: [number, number, number][] = [];
  const stops: number[] = [];
  let next = 0;
  /** events sent from inside start, before it returns (the race the session has to handle) */
  let duringStart: ((id: number) => TermEvent | undefined) | undefined;
  const backend: TermBackend = {
    async start(a) {
      starts.push({ cols: a.cols, rows: a.rows, mode: a.mode });
      const id = ++next;
      const e = duringStart?.(id);
      if (e) emit({ ...e, id });
      return id;
    },
    async write(id, data) {
      writes.push([id, data]);
    },
    async resize(id, cols, rows) {
      resizes.push([id, cols, rows]);
    },
    async stop(id) {
      stops.push(id);
    },
    async listen(fn) {
      emit = fn;
      return () => (emit = () => {});
    },
  };
  return {
    backend, starts, writes, resizes, stops,
    send: (id: number, e: TermEvent) => emit({ ...e, id }),
    set duringStart(f: typeof duringStart) { duringStart = f; },
  };
}

/** lets pending promise continuations run (the fake backend answers right away) */
const tick = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

function session(b: ReturnType<typeof fakeBackend>, mode: "pane" | "shell" = "pane") {
  const out: string[] = [];
  const phases: TermPhase["kind"][] = [];
  const s = new TermSession({
    server: "srv", pane: "w1:p1", mode, backend: b.backend,
    onOutput: (d) => out.push(d), onPhase: (p) => phases.push(p.kind),
  });
  return { s, out, phases };
}

describe("TermSession", () => {
  test("starts with the first size, resizes later, output opens it", async () => {
    const b = fakeBackend();
    const { s, out, phases } = session(b);
    await tick();
    expect(b.starts).toEqual([]);
    s.resize(100, 30);
    s.type("x"); // while connecting: sent once the id is known
    await tick();
    expect(b.starts).toEqual([{ cols: 100, rows: 30, mode: "pane" }]);
    expect(b.writes).toEqual([[1, "x"]]);
    b.send(1, { kind: "out", data: "hi" });
    b.send(2, { kind: "out", data: "other stream" });
    expect(out).toEqual(["hi"]);
    expect(phases).toEqual(["open"]);
    s.resize(100, 30);
    s.resize(90, 20);
    expect(b.resizes).toEqual([[1, 90, 20]]);
    s.dispose();
    expect(b.stops).toEqual([1]);
  });

  test("typing goes out one write at a time, in order", async () => {
    const b = fakeBackend();
    const sent: string[] = [];
    let release: () => void = () => {};
    b.backend.write = async (_id, data) => {
      sent.push(data);
      const { promise, resolve } = Promise.withResolvers<void>();
      release = resolve;
      await promise;
    };
    const { s } = session(b);
    await tick();
    s.resize(80, 24);
    await tick();
    s.type("a");
    s.type("b");
    s.type("c");
    expect(sent).toEqual(["a"]);
    release();
    await tick();
    expect(sent).toEqual(["a", "bc"]);
    release();
    s.dispose();
  });

  test("events before start returned are replayed", async () => {
    const b = fakeBackend();
    b.duringStart = () => ({ kind: "out", data: "early" });
    const { s, out } = session(b);
    await tick();
    s.resize(80, 24);
    await tick();
    expect(out).toEqual(["early"]);
    s.dispose();
  });

  test("a dropped stream reconnects with the latest size, an answer closes", async () => {
    vi.useFakeTimers();
    const b = fakeBackend();
    const { s, phases } = session(b);
    await tick();
    s.resize(80, 24);
    await tick();
    b.send(1, { kind: "out", data: "screen" });
    b.send(1, { kind: "end" });
    expect(s.phase.kind).toBe("reconnecting");
    s.resize(120, 40); // while away: the next connection uses it
    s.type("lost"); // nothing to send it to
    vi.advanceTimersByTime(reconnectDelay(1) - 1);
    await tick();
    expect(b.starts.length).toBe(1);
    vi.advanceTimersByTime(1);
    await tick();
    expect(b.starts.at(-1)).toEqual({ cols: 120, rows: 40, mode: "pane" });
    expect(b.writes).toEqual([]);
    b.send(2, { kind: "error", error: "not_found" });
    expect(s.phase).toEqual({ kind: "closed", end: { why: "gone" } });
    expect(phases).toEqual(["open", "reconnecting", "closed"]);
    s.restart();
    await tick();
    expect(b.starts.length).toBe(3);
    expect(s.phase.kind).toBe("connecting");
    s.dispose();
    vi.useRealTimers();
  });

  test("reconnectNow skips the pause; old servers and exits are answers", async () => {
    const b = fakeBackend();
    const { s } = session(b, "shell");
    await tick();
    s.resize(80, 24);
    await tick();
    b.send(1, { kind: "end", error: "timeout" });
    s.reconnectNow();
    await tick();
    expect(b.starts.length).toBe(2);
    b.send(2, { kind: "unsupported" });
    expect(s.phase).toEqual({ kind: "closed", end: { why: "unsupported" } });
    s.reconnectNow(); // closed stays closed
    await tick();
    expect(b.starts.length).toBe(2);
    s.restart();
    await tick();
    b.send(3, { kind: "exit", code: 0 });
    expect(s.phase).toEqual({ kind: "closed", end: { why: "exit" } });
    s.dispose();
  });

  test("backoff like iOS", () => {
    expect([1, 2, 3, 4, 5, 6, 9].map(reconnectDelay)).toEqual([500, 1000, 2000, 4000, 8000, 10000, 10000]);
  });
});

describe("keySequence", () => {
  test("herdr key names as terminal bytes", () => {
    expect(keySequence("enter")).toBe("\r");
    expect(keySequence("esc")).toBe("\x1b");
    expect(keySequence("space")).toBe(" ");
    expect(keySequence("up")).toBe("\x1b[A");
    expect(keySequence("up", true)).toBe("\x1bOA");
    expect(keySequence("ctrl+c")).toBe("\x03");
    expect(keySequence("ctrl+d")).toBe("\x04");
    expect(keySequence("ctrl+l")).toBe("\x0c");
    expect(keySequence("shift+tab")).toBe("\x1b[Z");
    expect(keySequence("alt+b")).toBe("\x1bb");
    expect(keySequence("y")).toBe("y");
    expect(keySequence("nonsense")).toBeUndefined();
  });
});

describe("findLinks", () => {
  test("urls, www., localhost ports – trailing punctuation dropped", () => {
    const text = "see https://example.com/a_(b). or www.hollr.app, dev at localhost:5173/x and (127.0.0.1:8080)";
    expect(findLinks(text).map((l) => l.url)).toEqual([
      "https://example.com/a_(b)",
      "https://www.hollr.app",
      "http://localhost:5173/x",
      "http://127.0.0.1:8080",
    ]);
    const [first] = findLinks(text);
    expect(text.slice(first.start, first.end)).toBe("https://example.com/a_(b)");
  });

  test("a link ends at TUI frames, a shortening ellipsis, CJK punctuation and Nerd Font glyphs", () => {
    const urls = (text: string) => findLinks(text).map((l) => l.url);
    expect(urls("│https://example.com/a│")).toEqual(["https://example.com/a"]);
    expect(urls("browser open https://idmsa.apple.com/signin?appIdKey=2bd7197b69c4…")).toEqual(["https://idmsa.apple.com/signin?appIdKey=2bd7197b69c4"]);
    expect(urls("見て https://example.com/x。次")).toEqual(["https://example.com/x"]);
    expect(urls("https://example.com/y\ue0b0 main")).toEqual(["https://example.com/y"]);
    expect(urls("PR https://gourmetta.pr-2850.128-140-61-8.nip.io/ und https://github.com/leicht-luftig/tendr/pull/2850.")).toEqual([
      "https://gourmetta.pr-2850.128-140-61-8.nip.io/",
      "https://github.com/leicht-luftig/tendr/pull/2850",
    ]);
  });
});

/** Terminal rows as xterm.js lays them out with the Unicode 11 width table (TerminalView): wide characters
 *  (emoji incl. ⚡ and skin tone modifiers, CJK) in two cells, the second one empty with width 0; combining
 *  marks and VS16 in their base's cell; padded to `cols`. Checked against a real xterm.js 6 + addon-unicode11:
 *  "F ✔ ⚡ 👍🏽" → F:1 ␠:1 ✔:1 ␠:1 ⚡:2 "":0 ␠:1 👍:2 "":0 🏽:2 "":0. */
function screen(cols: number, rows: { text: string; wrapped?: boolean }[]): (row: number) => TermLine | undefined {
  const wide = (c: number) =>
    c >= 0x1f000 || c === 0x26a1 || (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3);
  const joins = (c: number) => (c >= 0x300 && c <= 0x36f) || c === 0xfe0f;
  const lines = rows.map(({ text, wrapped = false }) => {
    const cells: { chars: string; width: number }[] = [];
    for (const ch of text) {
      const c = ch.codePointAt(0)!;
      if (joins(c) && cells.length) {
        const base = cells.findLast((cell) => cell.width > 0)!;
        base.chars += ch;
      } else if (wide(c)) cells.push({ chars: ch, width: 2 }, { chars: "", width: 0 });
      else cells.push({ chars: ch, width: 1 });
    }
    if (cells.length > cols) throw new Error(`row longer than ${cols}: ${text}`);
    while (cells.length < cols) cells.push({ chars: "", width: 1 });
    return {
      isWrapped: wrapped,
      length: cols,
      getCell: (x: number) => cells[x] && { getChars: () => cells[x].chars, getWidth: () => cells[x].width },
    };
  });
  return (row) => lines[row];
}

describe("linksAt", () => {
  const at = (cols: number, rows: { text: string; wrapped?: boolean }[], y: number) => linksAt(screen(cols, rows), rows.length, y, findLinks);

  test("wide characters, combining marks and glyphs before a link don't shift its cells", () => {
    const cases: [string, number][] = [
      ["A 🚀 deploy: https://gourmetta.pr-2850.128-140-61-8.nip.io/", 14],
      ["B │ 日本語 https://github.com/finksmart/hollr/pull/123", 12],
      ["C \uf113 \ue0a0 main https://example.com/nerd?q=1", 12],
      ["D e\u0301e\u0301 https://example.com/combining", 6],
      ["F ✔ ⚡ 👍🏽 https://example.com/emoji", 13],
      ["🚀h deploy ⚡ ok https://example.com/x", 18],
    ];
    for (const [text, x] of cases) {
      const [link, ...rest] = at(80, [{ text }], 1);
      expect(rest).toEqual([]);
      expect(link.start).toEqual({ x, y: 1 });
      expect(link.end).toEqual({ x: x + link.text.length - 1, y: 1 });
      expect(link.url).toBe(link.text);
      expect(text.endsWith(link.text)).toBe(true);
    }
  });

  test("several links in a row, each with its own cells", () => {
    const text = "🔗 https://github.com/a/b/pull/1 and http://localhost:5173/x";
    expect(at(80, [{ text }], 1)).toEqual([
      { start: { x: 4, y: 1 }, end: { x: 32, y: 1 }, text: "https://github.com/a/b/pull/1", url: "https://github.com/a/b/pull/1" },
      { start: { x: 38, y: 1 }, end: { x: 60, y: 1 }, text: "http://localhost:5173/x", url: "http://localhost:5173/x" },
    ]);
  });

  test("a link ending in a wide character ends on its second cell", () => {
    const [link] = at(40, [{ text: "see https://example.com/日本" }], 1);
    expect(link.url).toBe("https://example.com/日本");
    expect(link.end).toEqual({ x: 28, y: 1 });
  });

  const url = `https://example.com/long/${"a".repeat(60)}/end`;

  test("a link the terminal wrapped is one link on all its rows", () => {
    const rows = [{ text: "G " + url.slice(0, 38) }, { text: url.slice(38, 78), wrapped: true }, { text: url.slice(78), wrapped: true }];
    for (const y of [1, 2, 3]) {
      const [link, ...rest] = at(40, rows, y);
      expect(rest).toEqual([]);
      expect(link).toEqual({ start: { x: 3, y: 1 }, end: { x: url.length - 78, y: 3 }, text: url, url });
    }
  });

  test("a link a multiplexer or TUI broke into rows itself (not marked wrapped) is still one link", () => {
    const rows = [
      { text: "G " + url.slice(0, 38) },
      { text: url.slice(38, 78) },
      { text: url.slice(78) },
      { text: "next line" },
    ];
    for (const y of [1, 2, 3]) expect(at(40, rows, y).map((l) => l.url)).toEqual([url]);
    expect(at(40, rows, 4)).toEqual([]);
  });

  test("a row ending with a wide character that didn't fit keeps the link whole", () => {
    // xterm leaves the last cell empty when a wide character wraps to the next row
    const rows = [{ text: "x https://example.com/日本" }, { text: "語/end", wrapped: true }];
    for (const y of [1, 2]) expect(at(27, rows, y).map((l) => l.url)).toEqual(["https://example.com/日本語/end"]);
  });

  test("rows that only touch don't join: a link before a space, frames, a short row", () => {
    const boxed = [
      { text: "│ see https://example.com/boxed".padEnd(41) + "│" },
      { text: "│ more".padEnd(41) + "│" },
    ];
    expect(at(42, boxed, 1).map((l) => l.url)).toEqual(["https://example.com/boxed"]);
    expect(at(42, boxed, 2)).toEqual([]);
    const full = [{ text: "https://example.com/" + "b".repeat(20) }, { text: " not part of it" }];
    expect(at(40, full, 1).map((l) => l.url)).toEqual(["https://example.com/" + "b".repeat(20)]);
    const short = [{ text: "https://example.com/short" }, { text: "word" }];
    expect(at(40, short, 1).map((l) => l.url)).toEqual(["https://example.com/short"]);
  });
});
