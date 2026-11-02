import { describe, expect, mock, test } from "bun:test";
import type { Timeline } from "../src/lib/api";

// dashboard.ts uses agent.ts's timeline helpers; agent.ts's gate wrappers pull in the Tauri/i18n runtime – cut that off
mock.module("../src/lib/api", () => ({ gate: () => Promise.reject(new Error("no gate in tests")) }));
const {
  byUrgency, contextFromHistory, contextFromTimeline, isLong, LONG_MS, mainCaps, pooled, portsIn, projectOf, todoProgress,
  windowHours,
} = await import("../src/lib/dashboard");
const NOW = 1_800_000_000_000;
const tl = (over: Partial<Timeline>): Timeline => ({ items: [], jobs: [], running: false, waiting: false, ...over });

describe("limits", () => {
  test("window order: hours before days before weeks", () => {
    expect(["7d", "5h", "1w", "30d"].sort((a, b) => windowHours(a) - windowHours(b))).toEqual(["5h", "7d", "1w", "30d"]);
  });

  test("pooled: one per provider and window, the fullest wins, stable order", () => {
    const caps = [
      { provider: "openai-codex", window: "7d", used: 0.12 },
      { provider: "anthropic", window: "7d", used: 0.56 },
      { provider: "anthropic", window: "5h", used: 0.28 },
      { provider: "anthropic", window: "5h", used: 0.35 },
      { provider: "anthropic", window: "7d", used: 0.51 },
      { provider: "openai-codex", window: "5h", used: 0 },
    ];
    expect(pooled(caps).map((c) => `${c.provider} ${c.window} ${c.used}`)).toEqual([
      "anthropic 5h 0.35", "anthropic 7d 0.56", "openai-codex 5h 0", "openai-codex 7d 0.12",
    ]);
  });

  test("main caps: only Claude and ChatGPT's chat meter", () => {
    const caps = [
      { provider: "anthropic", window: "5h", used: 0.1 },
      { provider: "anthropic", window: "7d", meter: "opus", used: 0.1 },
      { provider: "cursor", window: "30d", used: 0.1 },
      { provider: "openai-codex", window: "5h", meter: "chat", used: 0.1 },
    ];
    expect(mainCaps(caps).map((c) => c.provider + (c.meter ?? ""))).toEqual(["anthropic", "openai-codexchat"]);
  });
});

describe("session context", () => {
  test("todo progress: done/total and the task in progress; nothing when all closed", () => {
    const todo = [
      { name: "A", tasks: [{ content: "one", status: "completed" }, { content: "two", status: "in_progress" }] },
      { name: "B", tasks: [{ content: "three", status: "pending" }] },
    ];
    expect(todoProgress(todo)).toEqual({ done: 1, total: 3, current: "two" });
    expect(todoProgress([{ name: "A", tasks: [{ content: "x", status: "completed" }, { content: "y", status: "abandoned" }] }])).toBeUndefined();
    expect(todoProgress([])).toBeUndefined();
  });

  test("timeline: running tool is the step, last text, pending ask, branch", () => {
    const ctx = contextFromTimeline(tl({
      title: "✻ Fix login",
      running: true,
      turnStartedAt: NOW - 5000,
      line: { branch: "feature/x", dirty: 3, model: "opus" },
      items: [
        { k: "text", id: "1", text: "**Looking** at the `auth` module" },
        { k: "tools", id: "2", calls: [{ id: "c", name: "bash", label: "Run the tests", status: "running" }] },
      ],
    }));
    expect(ctx).toMatchObject({
      title: "Fix login", branch: "feature/x", dirty: 3, model: "opus", step: "Run the tests",
      last: "Looking at the auth module", running: true, turnStartedAt: NOW - 5000,
    });
    expect(ctx.ask).toBeUndefined();
  });

  test("timeline: not running → no step, no turn start; a pending ask is kept", () => {
    const ctx = contextFromTimeline(tl({
      turnStartedAt: NOW,
      items: [{ k: "ask", id: "a", question: "Which?", options: ["x", "y"], pending: true }],
    }));
    expect(ctx.step).toBeUndefined();
    expect(ctx.turnStartedAt).toBeUndefined();
    expect(ctx.ask?.id).toBe("a");
  });

  test("history: last answer, the latest tool only while working", () => {
    const events = [
      { t: "answer" as const, text: "Done with step 1", final: true },
      { t: "tool" as const, name: "edit", intent: "Patch config" },
    ];
    expect(contextFromHistory(events, true)).toMatchObject({ last: "Done with step 1", step: "Patch config", running: true });
    expect(contextFromHistory(events, false).step).toBeUndefined();
  });

  test("long-running only after LONG_MS of a running turn", () => {
    const ctx = { running: true, turnStartedAt: NOW - LONG_MS, jobs: 0 };
    expect(isLong(ctx, NOW)).toBe(true);
    expect(isLong(ctx, NOW - 1)).toBe(false);
    expect(isLong({ ...ctx, running: false }, NOW)).toBe(false);
    expect(isLong(undefined, NOW)).toBe(false);
  });
});

describe("projects", () => {
  const spaces = [
    { id: "w1", label: "hollr", root: "/src/hollr", repo: "hollr", isWorktree: false, git: { branch: "main", ahead: 0, behind: 0, dirty: 2 } },
    { id: "w2", label: "hollr-x", root: "/src/hollr-x", repo: "hollr", isWorktree: true, git: { branch: "feat/x", ahead: 0, behind: 0, dirty: 0 } },
  ];

  test("worktrees of one repo share the project, keep their branch", () => {
    const a = projectOf("s", { id: "w1", label: "hollr" }, "/src/hollr", spaces);
    const b = projectOf("s", { id: "w2", label: "hollr-x" }, "/src/hollr-x/sub", spaces);
    expect(a.key).toBe(b.key);
    expect([a.branch, b.branch, b.worktree, a.dirty]).toEqual(["main", "feat/x", true, 2]);
  });

  test("without a space: the folder, branch from the session", () => {
    const p = projectOf("s", { id: "w9", label: "Workspace 9" }, "/home/me/app/", undefined, { running: false, jobs: 0, branch: "dev" });
    expect(p).toMatchObject({ key: "s|app", name: "app", branch: "dev", worktree: false });
  });

  test("ports inside the project root only", () => {
    const ports = [{ port: 5173, cwd: "/src/hollr/desktop" }, { port: 3000, cwd: "/src/hollr-x" }, { port: 8080 }];
    expect(portsIn("/src/hollr", ports).map((p) => p.port)).toEqual([5173]);
    expect(portsIn(undefined, ports)).toEqual([]);
  });
});

describe("urgency", () => {
  test("questions > finished (newest first) > errors > long-running (longest first)", () => {
    const items = [
      { kind: "long" as const, since: 50, id: "long-new" },
      { kind: "error" as const, since: 10, id: "error" },
      { kind: "done" as const, since: 10, id: "done-old" },
      { kind: "waiting" as const, since: 30, id: "waiting-new" },
      { kind: "long" as const, since: 20, id: "long-old" },
      { kind: "done" as const, since: 40, id: "done-new" },
      { kind: "ask" as const, since: 20, id: "ask-old" },
    ];
    expect(items.sort(byUrgency).map((i) => i.id)).toEqual([
      "ask-old", "waiting-new", "done-new", "done-old", "error", "long-old", "long-new",
    ]);
  });
});
