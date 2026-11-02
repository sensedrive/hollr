import { describe, expect, test, vi } from "bun:test";
import { findLinks, keySequence, reconnectDelay, TermSession, type TermBackend, type TermEvent, type TermPhase } from "./terminal";

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
});
