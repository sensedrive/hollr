import { describe, expect, test } from "bun:test";
import type { TimelineItem, TodoPhase, ToolCall } from "./api";
import {
  cardKind, chatView, diffRows, diffSlice, markHits, outTail, parseRange, phaseFolded, todoChanges, toolTip, underRoot,
} from "./chatTools";

const call = (id: string, name: string, extra: Partial<ToolCall> = {}): ToolCall => ({ id, name, label: "", status: "ok", ...extra });
const todo = (...statuses: string[]): TodoPhase[] => [
  { name: "Analyse", tasks: statuses.map((status, i) => ({ content: `T${i}`, status })) },
];

describe("chatView", () => {
  test("reads merge, todo calls without a state stay hidden, an item of only those disappears", () => {
    const items: TimelineItem[] = [
      { k: "tools", id: "g1", calls: [call("a", "read"), call("b", "read"), call("c", "bash"), call("d", "read")] },
      { k: "tools", id: "g2", calls: [call("e", "todo")] },
    ];
    const v = chatView(items);
    expect(v.items.map((i) => i.id)).toEqual(["g1"]);
    expect(v.pieces.get("g1")?.map((p) => [p.kind, p.id])).toEqual([["reads", "r-a"], ["call", "c"], ["reads", "r-d"]]);
  });

  test("todo states: unchanged repeats drop, a run in one item is one card, only the newest is latest", () => {
    const items: TimelineItem[] = [
      { k: "tools", id: "g1", calls: [call("t1", "todo", { todo: todo("pending", "pending") })] },
      { k: "tools", id: "g2", calls: [call("t2", "todo", { todo: todo("pending", "pending") }), call("x", "bash")] },
      { k: "tools", id: "g3", calls: [call("t3", "todo", { todo: todo("completed", "pending") }), call("t4", "todo", { todo: todo("completed", "in_progress") })] },
    ];
    const v = chatView(items);
    expect(v.pieces.get("g2")?.map((p) => p.id)).toEqual(["x"]);
    const run = v.pieces.get("g3")?.[0];
    expect(run?.kind === "todo" && run.calls.map((c) => c.id)).toEqual(["t3", "t4"]);
    expect(v.todo.get("t-t1")).toEqual({ prev: undefined, latest: false });
    expect(v.todo.get("t-t3")?.latest).toBe(true);
    expect(v.todo.get("t-t3")?.prev).toEqual(todo("pending", "pending"));
  });

  test("a failed todo call without a state still shows", () => {
    const v = chatView([{ k: "tools", id: "g", calls: [call("t", "todo", { status: "error", result: "no such task" })] }]);
    expect(v.pieces.get("g")?.[0]?.kind).toBe("call");
  });
});

test("cardKind maps canonical names (Claude's mapped ones too)", () => {
  expect(["bash", "eval", "edit", "write", "grep", "ls", "task", "fetch", "wait", "mcp__x__y", "skill"].map((n) => cardKind(call("i", n))))
    .toEqual(["bash", "bash", "edit", "edit", "search", "search", "task", "links", "compact", "compact", "generic"]);
  expect(cardKind(call("i", "notebook", { diff: [] }))).toBe("edit");
});

test("toolTip names the original tool only when it differs", () => {
  const ms = (n: number) => `${n}ms`;
  expect(toolTip(call("i", "edit", { tool: "MultiEdit", label: "Fix", ms: 5 }), ms)).toBe("MultiEdit · Fix · 5ms");
  expect(toolTip(call("i", "edit", { tool: "Edit", label: "Fix" }), ms)).toBe("Fix");
});

test("underRoot: relative inside the space, /private/tmp = /tmp, undefined outside", () => {
  expect(underRoot("/tmp/lab/inventory.py", "/private/tmp/lab")).toBe("inventory.py");
  expect(underRoot("/private/tmp/lab", "/tmp/lab/")).toBe(".");
  expect(underRoot("/tmp/labx/a", "/tmp/lab")).toBeUndefined();
  expect(underRoot("inventory.py", "/tmp/lab")).toBeUndefined();
});

describe("diff", () => {
  test("gap rows only between hunks that don't touch", () => {
    const rows = diffRows([
      { lines: [{ t: " ", o: 1, n: 1, text: "a" }, { t: "-", o: 2, text: "b" }] },
      { lines: [{ t: " ", o: 3, n: 2, text: "c" }] },
      { lines: [{ t: "+", n: 20, text: "z" }] },
    ]);
    expect(rows.map((r) => ("t" in r ? r.text : "…"))).toEqual(["a", "b", "c", "…", "z"]);
  });

  test("small diffs open, big ones show the head and count hidden lines (not gaps)", () => {
    const rows = diffRows([{ lines: Array.from({ length: 40 }, (_, i) => ({ t: "+" as const, n: i + 1, text: `${i}` })) }]);
    expect(diffSlice(rows.slice(0, 30), undefined).isOpen).toBe(true);
    const closed = diffSlice(rows, undefined);
    expect([closed.isOpen, closed.shown.length, closed.hidden]).toEqual([false, 12, 28]);
    expect(diffSlice(rows, true).shown.length).toBe(40);
  });

  test("multi-file edits: a file row where the file changes, line numbers restart (no gap)", () => {
    const rows = diffRows([
      { file: "a.ts", lines: [{ t: "+", n: 50, text: "x" }] },
      { file: "b.py", lines: [{ t: "+", n: 1, text: "y" }] },
      { file: "b.py", lines: [{ t: "+", n: 9, text: "z" }] },
    ]);
    expect(rows.map((r) => ("gap" in r ? "…" : "file" in r ? `[${r.file}]` : r.text))).toEqual(["[a.ts]", "x", "[b.py]", "y", "…", "z"]);
  });
});

test("parseRange: whole file vs part, total optional", () => {
  expect(parseRange("1-30/30")).toEqual({ from: 1, to: 30, total: 30, whole: true });
  expect(parseRange("10-40/120")?.whole).toBe(false);
  expect(parseRange("1-80")).toEqual({ from: 1, to: 80, total: undefined, whole: false });
  expect(parseRange("x")).toBeUndefined();
});

test("todoChanges: new or changed tasks; folded phases keep what just changed visible", () => {
  const prev = todo("pending", "pending");
  const next = todo("completed", "completed");
  const changed = todoChanges(prev, next);
  expect(changed.map((x) => x.content)).toEqual(["T0", "T1"]);
  expect(todoChanges(undefined, next)).toEqual([]);
  expect(phaseFolded(next[0]!, changed)).toBe(false);
  expect(phaseFolded(next[0]!, [])).toBe(true);
  expect(phaseFolded(todo("completed", "pending")[0]!, [])).toBe(false);
});

test("markHits: regex, case-insensitive, invalid patterns literal", () => {
  expect(markHits("# TODO: x todo", "todo")).toEqual([{ s: "# " }, { s: "TODO", hit: true }, { s: ": x " }, { s: "todo", hit: true }]);
  expect(markHits("a(b", "(")).toEqual([{ s: "a" }, { s: "(", hit: true }, { s: "b" }]);
  expect(markHits("abc", "^")).toEqual([{ s: "abc" }]);
});

test("outTail: last 8 collapsed, everything sent when open", () => {
  const out = Array.from({ length: 12 }, (_, i) => `${i}`);
  expect(outTail({ out, outTotal: 30 }, false)).toEqual({ lines: out.slice(-8), earlier: 22, more: 4, total: 30 });
  expect(outTail({ out, outTotal: 30 }, true)).toEqual({ lines: out, earlier: 18, more: 0, total: 30 });
});
