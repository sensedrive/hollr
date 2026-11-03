import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTimeline, RICH_CAPS, readTimeline, type TimelineOptions, type ToolCall } from "../src/timeline";

// Fixtures are trimmed lines of real omp session logs (the chat lab session and older ones).
const call = (id: string, name: string, args: Record<string, unknown>) =>
  JSON.stringify({
    type: "message",
    timestamp: "2026-11-03T21:00:00.000Z",
    message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id, name, arguments: args }] },
  });
const result = (id: string, toolName: string, details: Record<string, unknown>, text = "", isError = false) =>
  JSON.stringify({
    type: "message",
    timestamp: "2026-11-03T21:00:01.000Z",
    message: { role: "toolResult", toolCallId: id, toolName, details, content: [{ type: "text", text }], isError },
  });
/** the calls of the timeline, in order */
const calls = (lines: string[], opts?: TimelineOptions): ToolCall[] =>
  buildTimeline(lines.join("\n"), 150, opts).items.flatMap((i) => (i.k === "tools" ? i.calls : []));
const only = (lines: string[], opts?: TimelineOptions) => {
  const c = calls(lines, opts)[0];
  if (!c) throw new Error("no call");
  return c;
};

const LAB_DIFF = [
  " 8|class Inventory:",
  " 9|    def __init__(self):",
  "",
  " 22|    def total_value(self):",
  "-24|        return total / 10  # bug: cents -> euros",
  "+24|        return total / 100",
  " 25|",
  "-28|        for name, qty in lines:",
  "+28|        snapshot = dict(self.items)",
  "+29|        try:",
  " 30|        return sum(self.items[n][1] * q for n, q in lines)",
].join("\n");

describe("rich tool data (omp)", () => {
  test("edit: omp's diff as hunks with old/new line numbers, the file, add/del as before", () => {
    const c = only([
      call("e1", "edit", { input: "[inventory.py#C5A2]\nPUT 24.=24:\n+…" }),
      result("e1", "edit", { diff: LAB_DIFF, firstChangedLine: 24, op: "update", path: "/tmp/lab/inventory.py" }),
    ]);
    expect(c.file).toBe("/tmp/lab/inventory.py");
    expect(c.detail).toBe("inventory.py");
    expect([c.add, c.del]).toEqual([3, 2]);
    expect(c.diffMore).toBeUndefined();
    expect(c.diff).toEqual([
      {
        lines: [
          { t: " ", o: 8, n: 8, text: "class Inventory:" },
          { t: " ", o: 9, n: 9, text: "    def __init__(self):" },
        ],
      },
      {
        lines: [
          { t: " ", o: 22, n: 22, text: "    def total_value(self):" },
          { t: "-", o: 24, text: "        return total / 10  # bug: cents -> euros" },
          { t: "+", n: 24, text: "        return total / 100" },
          { t: " ", o: 25, n: 25, text: "" },
          { t: "-", o: 28, text: "        for name, qty in lines:" },
          { t: "+", n: 28, text: "        snapshot = dict(self.items)" },
          { t: "+", n: 29, text: "        try:" },
          // context lines carry omp's old number – the new one follows from the lines added above
          { t: " ", o: 30, n: 31, text: "        return sum(self.items[n][1] * q for n, q in lines)" },
        ],
      },
    ]);
  });

  test("edit over several files: one hunk group per file, tagged with the file", () => {
    const a = " 70|  afterAll(async () => {\n-72|  });\n+72|  }, 60_000);";
    const b = " 183|  afterAll(async () => {\n-185|  });\n+185|  }, 60_000);";
    const c = only([
      call("e2", "edit", { input: "…" }),
      result("e2", "edit", {
        diff: `${a}\n${b}`,
        firstChangedLine: 72,
        perFileResults: [
          { path: "/r/a.spec.ts", diff: a, op: "update" },
          { path: "/r/b.spec.ts", diff: b, op: "update" },
        ],
      }),
    ]);
    expect(c.diff?.map((h) => [h.file, h.lines.length])).toEqual([
      ["/r/a.spec.ts", 3],
      ["/r/b.spec.ts", 3],
    ]);
    expect(c.file).toBeUndefined();
  });

  test("diff cap: at most 400 lines over all hunks, `diffMore` counts the rest; lines redacted and clipped", () => {
    const hunk = (from: number) =>
      Array.from({ length: 150 }, (_, i) => `+${from + i}|line ${from + i}`).join("\n");
    const diff = [hunk(1), hunk(200), hunk(400)].join("\n\n");
    const c = only([
      call("e3", "edit", { path: "big.ts" }),
      result("e3", "edit", {
        diff: `+1|key sk-abcdefghijklmnopqrstuv ${"x".repeat(1000)}\n\n${diff}`,
        path: "/r/big.ts",
      }),
    ]);
    const lines = c.diff?.flatMap((h) => h.lines) ?? [];
    expect(lines.length).toBe(RICH_CAPS.diffLines);
    expect(c.diffMore).toBe(451 - RICH_CAPS.diffLines);
    // 1 + 150 + 150 lines fit, the fourth hunk is cut after 99
    expect(c.diff?.map((h) => h.lines.length)).toEqual([1, 150, 150, 99]);
    expect(lines[0]?.text.startsWith("key ••• x")).toBe(true);
    expect(lines[0]?.text.length).toBe(400);
  });

  test("write: the written file as one added hunk; large files only their head; no diff for device writes", () => {
    const small = only([
      call("w1", "write", { path: "notes/plan.md", content: "# Plan\n\n- a\n" }),
      result("w1", "write", { resolvedPath: "/r/notes/plan.md" }, "[/r/notes/plan.md#AB12]"),
    ]);
    expect(small.file).toBe("/r/notes/plan.md");
    expect(small.diff).toEqual([
      {
        lines: [
          { t: "+", n: 1, text: "# Plan" },
          { t: "+", n: 2, text: "" },
          { t: "+", n: 3, text: "- a" },
        ],
      },
    ]);
    const big = only([
      call("w2", "write", { path: "gen.json", content: Array.from({ length: 500 }, (_, i) => `${i}`).join("\n") }),
      result("w2", "write", { resolvedPath: "/r/gen.json" }),
    ]);
    expect(big.diff?.[0]?.lines.length).toBe(RICH_CAPS.writeLines);
    expect(big.diffMore).toBe(500 - RICH_CAPS.writeLines);
    const device = only([
      call("w3", "write", { path: "agent://Peer", content: "hello" }),
      result("w3", "write", {}),
    ]);
    expect([device.file, device.diff]).toEqual([undefined, undefined]);
    const failed = only([
      call("w4", "write", { path: "x.ts", content: "a" }),
      result("w4", "write", {}, "EACCES", true),
    ]);
    expect(failed.diff).toBeUndefined();
  });

  test("grep: matching lines per file from omp's display (hash tags, nested dirs, single file)", () => {
    const lab = only([
      call("g1", "grep", { pattern: "TODO", path: "." }),
      result("g1", "grep", {
        scopePath: ".",
        matchCount: 2,
        fileCount: 2,
        files: ["README.md", "inventory.py"],
        displayContent:
          "# README.md#558A\n 4│\n*5│<!-- TODO: CLI ergänzen -->\n\n# inventory.py#706F\n 22│    def total_value(self):\n*23│        # TODO: round to whole euros for the report\n 24│        return 1",
      }),
    ]);
    expect(lab.result).toBe("2 Treffer in 2 Dateien");
    expect(lab.matches).toEqual([
      { file: "README.md", lines: [{ n: 5, text: "<!-- TODO: CLI ergänzen -->" }] },
      { file: "inventory.py", lines: [{ n: 23, text: "        # TODO: round to whole euros for the report" }] },
    ]);
    const nested = only([
      call("g2", "grep", { pattern: "image" }),
      result("g2", "grep", {
        matchCount: 3,
        fileCount: 2,
        files: [".do/app.production.yaml", ".do/app.stage.yaml"],
        displayContent:
          "# .do/\n## app.production.yaml\n  61│- name: backoffice\n *62│  image:\n    │...\n*147│  image:\n## app.stage.yaml\n *9│  image:",
      }),
    ]);
    expect(nested.matches).toEqual([
      {
        file: ".do/app.production.yaml",
        lines: [
          { n: 62, text: "  image:" },
          { n: 147, text: "  image:" },
        ],
      },
      { file: ".do/app.stage.yaml", lines: [{ n: 9, text: "  image:" }] },
    ]);
    const single = only([
      call("g3", "grep", { pattern: "name", path: ".do/app.stage.yaml" }),
      result("g3", "grep", {
        matchCount: 2,
        fileCount: 1,
        files: [".do/app.stage.yaml"],
        displayContent: "  *1│name: tendr-stage\n  *2│region: fra\n   3│domains:",
      }),
    ]);
    expect(single.matches).toEqual([
      {
        file: ".do/app.stage.yaml",
        lines: [
          { n: 1, text: "name: tendr-stage" },
          { n: 2, text: "region: fra" },
        ],
      },
    ]);
  });

  test("grep caps: 20 files × 8 lines, text 300 chars; no matches → no field", () => {
    const display = Array.from(
      { length: 25 },
      (_, f) => `# f${f}.ts\n${Array.from({ length: 12 }, (_, l) => `*${l + 1}│${"y".repeat(500)}`).join("\n")}`,
    ).join("\n\n");
    const c = only([
      call("g4", "grep", { pattern: "y" }),
      result("g4", "grep", { matchCount: 300, fileCount: 25, files: [], displayContent: display }),
    ]);
    expect(c.matches?.length).toBe(RICH_CAPS.matchFiles);
    expect(c.matches?.every((f) => f.lines.length === RICH_CAPS.matchLines)).toBe(true);
    expect(c.matches?.[0]?.lines[0]?.text.length).toBe(RICH_CAPS.matchText);
    const none = only([
      call("g5", "grep", { pattern: "zzz" }),
      result("g5", "grep", { matchCount: 0, fileCount: 0, files: [] }, "No matches found"),
    ]);
    expect(none.matches).toBeUndefined();
  });

  test("glob: found paths, at most 50", () => {
    const files = Array.from({ length: 70 }, (_, i) => `src/f${i}.ts`);
    const c = only([call("f1", "glob", { pattern: "src/**" }), result("f1", "glob", { fileCount: 70, files })]);
    expect(c.files).toEqual(files.slice(0, RICH_CAPS.files));
    expect(c.result).toBe("70 Dateien");
  });

  test("read: file and line range with total; paged reads; no file for directories and URLs", () => {
    const whole = only([
      call("r1", "read", { path: "inventory.py" }),
      result("r1", "read", {
        totalLines: 30,
        displayContent: { text: "…", startLine: 1, lineNumbers: [1, 2, 30] },
        meta: { source: { type: "path", value: "/tmp/lab/inventory.py" }, pagedSource: true },
      }),
    ]);
    expect([whole.file, whole.range]).toEqual(["/tmp/lab/inventory.py", "1-30/30"]);
    const paged = only([
      call("r2", "read", { path: ".do/app.stage.yaml" }),
      result("r2", "read", {
        totalLines: 513,
        meta: {
          source: { type: "path", value: "/r/.do/app.stage.yaml" },
          truncation: { shownRange: { start: 1, end: 63 }, nextOffset: 64 },
        },
      }),
    ]);
    expect(paged.range).toBe("1-63/513");
    const dir = only([
      call("r3", "read", { path: "." }),
      result("r3", "read", { isDirectory: true, resolvedPath: "/tmp/lab" }),
    ]);
    expect([dir.file, dir.range]).toEqual([undefined, undefined]);
    const url = only([
      call("r4", "read", { path: "https://bun.com/docs/x.md" }),
      result("r4", "read", { kind: "url", url: "https://bun.com/docs/x.md", meta: { source: { type: "url" } } }),
    ]);
    expect([url.file, url.range]).toEqual([undefined, undefined]);
  });

  test("todo: every todo call carries the state right after it", () => {
    const phases = (done: number) => [
      {
        name: "Analyse",
        tasks: [
          { content: "Alle Dateien lesen", status: done > 0 ? "completed" : "in_progress" },
          { content: "Bugs finden", status: done > 1 ? "completed" : "pending" },
        ],
      },
    ];
    const t = buildTimeline(
      [
        call("t1", "todo", { op: "init" }),
        result("t1", "todo", { op: "init", phases: phases(0), storage: "session" }),
        call("t2", "todo", { op: "done", task: "Alle Dateien lesen" }),
        result("t2", "todo", { op: "done", phases: phases(1), storage: "session" }),
      ].join("\n"),
    );
    const [a, b] = t.items.flatMap((i) => (i.k === "tools" ? i.calls : []));
    expect(a?.todo?.[0]?.tasks.map((x) => x.status)).toEqual(["in_progress", "pending"]);
    expect(b?.todo?.[0]?.tasks.map((x) => x.status)).toEqual(["completed", "pending"]);
    expect(t.todo).toEqual(b?.todo);
  });

  test("web_search: result links, at most 10", () => {
    const sources = Array.from({ length: 14 }, (_, i) => ({ title: `T${i}`, url: `https://x.dev/${i}`, snippet: "…" }));
    const c = only([
      call("s1", "web_search", { query: "bun lifecycle" }),
      result("s1", "web_search", { response: { provider: "parallel", sources, answer: "" } }),
    ]);
    expect(c.links?.length).toBe(RICH_CAPS.links);
    expect(c.links?.[0]).toEqual({ title: "T0", url: "https://x.dev/0" });
  });

  test("task: subagent type at spawn, answer from wait and async delivery, tool calls via the lookup", () => {
    const spawn = [
      call("k1", "task", { tasks: [{ name: "ReviewFixes" }, { name: "VerifyGuide" }] }),
      result(
        "k1",
        "task",
        {
          results: [],
          progress: [
            { index: 0, id: "ReviewFixes", agent: "reviewer", status: "pending", toolCount: 0 },
            { index: 1, id: "VerifyGuide", agent: "scout", status: "pending", toolCount: 0 },
          ],
          async: { state: "running", jobId: "ReviewFixes", type: "task" },
        },
        "Spawned 2 background agents using task.",
      ),
    ];
    const running = only(spawn, { subCalls: (id) => (id === "ReviewFixes" ? 3 : undefined) });
    expect(running.sub).toEqual({ calls: 3 });
    const report = (id: string, agent: string, answer: string) =>
      `<task-result id="${id}" agent="${agent}" status="completed" duration="2m41s">\n<meta lines="3" size="1KB" />\n<preview full-output="agent://${id}">\n${answer}\n</preview>\n</task-result>\n\n${id} is now idle`;
    const done = only(
      [
        ...spawn,
        call("k2", "wait", { jobs: ["ReviewFixes"] }),
        result("k2", "wait", {
          op: "wait",
          jobs: [{ id: "ReviewFixes", type: "task", status: "completed", resultText: report("ReviewFixes", "reviewer", "Beide Fixes halten.") }],
        }),
        JSON.stringify({
          type: "custom_message",
          customType: "async-result",
          display: false,
          content: `<system-notice>\nBackground job VerifyGuide has completed.\n${report("VerifyGuide", "scout", "Fast alles stimmt.")}\n</system-notice>`,
          details: { jobs: [{ jobId: "VerifyGuide", type: "task", status: "completed" }] },
        }),
      ],
      { subCalls: () => 5 },
    );
    expect(done.sub).toEqual({
      answer: "**ReviewFixes**\n\nBeide Fixes halten.\n\n**VerifyGuide**\n\nFast alles stimmt.",
      calls: 10,
    });
  });

  test("task: one subagent's answer as is, clipped to 4000 chars", () => {
    const long = "a".repeat(5000);
    const c = only([
      call("k3", "task", { tasks: [{ name: "Scout" }] }),
      result("k3", "task", { progress: [{ id: "Scout", agent: "scout" }], async: { state: "running", jobId: "Scout" } }),
      JSON.stringify({
        type: "custom_message",
        customType: "async-result",
        display: true,
        content: `<task-result id="Scout" agent="scout" status="completed"><preview>${long}</preview></task-result>`,
      }),
    ]);
    expect(c.sub?.agent).toBe("scout");
    expect(c.sub?.answer?.length).toBe(RICH_CAPS.subAnswer);
  });

  test("readTimeline counts a subagent's tool calls from its log next to the session (nested ids too)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hollr-sub-"));
    try {
      const session = join(dir, "2026-11-03T20-57-04_x.jsonl");
      const root = session.replace(/\.jsonl$/, "");
      mkdirSync(join(root, "Batch"), { recursive: true });
      const tc = (n: number) =>
        Array.from({ length: n }, (_, i) =>
          JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: `c${i}`, name: "read" }] } }),
        ).join("\n");
      writeFileSync(join(root, "Batch.jsonl"), tc(2));
      writeFileSync(join(root, "Batch", "Batch.Child.jsonl"), tc(4));
      writeFileSync(
        session,
        [
          call("k4", "task", { tasks: [{ name: "Batch" }] }),
          result("k4", "task", { progress: [{ id: "Batch", agent: "task" }, { id: "Batch.Child", agent: "task" }] }),
        ].join("\n"),
      );
      const t = await readTimeline(session);
      const c = t.items.flatMap((i) => (i.k === "tools" ? i.calls : []))[0];
      expect(c?.sub).toEqual({ calls: 6, agent: "task" });
      expect(t.agent).toBe("omp");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("bash: the last 60 output lines, the full count in outTotal", () => {
    const text = `${Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n")}\n\nWall time: 0.12 seconds`;
    const c = only([call("b1", "bash", { command: "seq 100" }), result("b1", "bash", { wallTimeMs: 120 }, text)]);
    expect(c.out?.length).toBe(RICH_CAPS.outLines);
    expect(c.out?.[0]).toBe("line 41");
    expect(c.out?.at(-1)).toBe("line 100");
    expect(c.outTotal).toBe(100);
  });

  test("timeline says it comes from omp; calls without rich data stay as before", () => {
    const t = buildTimeline([call("x1", "lsp", { action: "hover" }), result("x1", "lsp", {}, "type")].join("\n"));
    expect(t.agent).toBe("omp");
    const c = t.items[0]?.k === "tools" ? t.items[0].calls[0] : undefined;
    expect(c).toEqual({ id: "x1", name: "lsp", label: "lsp", detail: "hover", status: "ok", ms: undefined, result: undefined, path: undefined });
  });
});
