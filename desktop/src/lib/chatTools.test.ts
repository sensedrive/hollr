import { describe, expect, test } from "bun:test";
import type { TimelineItem, TodoPhase, ToolCall } from "./api";
import {
  cardKind, chatView, cwdShown, diffRows, diffSlice, finishedJobs, jobCalls, jobOutcome, jobView, jobViews, markHits, outTail,
  parseRange, phaseFolded, searchScopes, shortCommand, todoChanges, toolTip, underRoot,
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
    .toEqual(["bash", "bash", "edit", "edit", "search", "search", "task", "links", "wait", "compact", "generic"]);
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

test("searchScopes: omp's ';'-separated paths one by one, brace globs intact", () => {
  expect(searchScopes("apps/superadmin-app/src;packages/api-contracts/src;tests/browser")).toEqual([
    "apps/superadmin-app/src", "packages/api-contracts/src", "tests/browser",
  ]);
  expect(searchScopes("src/{a,b}/*.ts")).toEqual(["src/{a,b}/*.ts"]);
  expect(searchScopes(undefined)).toEqual([]);
});

test("cwdShown: hidden for the space folder, relative under it, relative arguments resolved, short outside", () => {
  const short = (p: string) => p.replace(/^\/home\/[^/]+/, "~");
  const root = "/home/u/projects/tendr";
  expect(cwdShown(undefined, root, short)).toBeUndefined();
  expect(cwdShown("/home/u/projects/tendr/", root, short)).toBeUndefined();
  expect(cwdShown(".", root, short)).toBeUndefined();
  expect(cwdShown("/home/u/projects/tendr/apps/web", root, short)).toBe("apps/web");
  expect(cwdShown("../tendr-release/services/render", root, short)).toBe("~/projects/tendr-release/services/render");
  expect(cwdShown("./apps/web", root, short)).toBe("apps/web");
  expect(cwdShown("../x", undefined, short)).toBe("../x");
  expect(cwdShown("/home/u/projects/tendr-release", root, short)).toBe("~/projects/tendr-release");
});

test("shortCommand: unwraps sh -c, drops cd and env, cuts at the first chain/pipe/redirect", () => {
  expect(shortCommand("sh -c 'yarn test:e2e:stack:up && yarn test:e2e:stack:wait && CI=1 yarn turbo run build'")).toBe("yarn test:e2e:stack:up …");
  expect(shortCommand("SANDCASTLE_AGENT=opus-5.5 SANDCASTLE_MAX_PARALLEL=3 yarn sandcastle > /tmp/s.log 2>&1; tail -5 /tmp/s.log")).toBe("yarn sandcastle …");
  expect(shortCommand("cd ~/projects/x && git status")).toBe("git status");
  expect(shortCommand("du -sh /a 2>/dev/null | sort -h")).toBe("du -sh /a …");
  expect(shortCommand("ls -la")).toBe("ls -la");
  expect(shortCommand("echo one\necho two")).toBe("echo one …");
  expect(shortCommand("x".repeat(100), 20)).toBe(`${"x".repeat(19)}…`);
});

describe("jobs", () => {
  const bash = call("c1", "bash", { label: "Reproducing t21", detail: "sh -c 'yarn test:e2e && yarn x'", bg: "bg_2" });
  const task = call("c2", "task", { label: "Investigating blocker", bg: "T21ReleaseBlocker" });
  const items: TimelineItem[] = [{ k: "tools", id: "g", calls: [bash, task, call("c3", "read")] }];

  test("jobCalls / jobViews: the intent as title, the command short beside it, full in the tooltip", () => {
    const calls = jobCalls(items);
    expect([...calls.keys()]).toEqual(["bg_2", "T21ReleaseBlocker"]);
    const views = jobViews({
      items,
      jobs: [
        { id: "bg_2", type: "bash", label: "sh -c 'yarn test:e2e && yarn x'", startedAt: 1 },
        { id: "T21ReleaseBlocker", type: "task", label: "T21ReleaseBlocker", startedAt: 2 },
        { id: "bg_9", type: "bash", label: "make build", startedAt: 3 },
      ],
    }, calls);
    expect(views).toEqual([
      { id: "bg_2", title: "Reproducing t21", command: "yarn test:e2e …", full: "sh -c 'yarn test:e2e && yarn x'", startedAt: 1 },
      { id: "T21ReleaseBlocker", title: "Investigating blocker", command: undefined, full: undefined, startedAt: 2 },
      // no starting call in view (older than the timeline): the server's label
      { id: "bg_9", title: "make build", command: undefined, full: "make build", startedAt: 3 },
    ]);
    expect(jobView({ id: "bg_3" }).title).toBe("bg_3");
  });

  test("jobOutcome: done / failed / still running", () => {
    expect(["completed", "failed", "running", "cancelled"].map(jobOutcome)).toEqual(["done", "failed", "running", "failed"]);
  });

  test("finishedJobs: the server's info names jobs by command – their intents instead", () => {
    const calls = jobCalls(items);
    expect(finishedJobs("Hintergrund-Job fertig: sh -c 'yarn test:e2e && yarn x'", calls)).toEqual(["Reproducing t21"]);
    expect(finishedJobs("Hintergrund-Job fertig: something else", calls)).toBeUndefined();
    expect(finishedJobs("Kontext wurde zusammengefasst", calls)).toBeUndefined();
  });
});
