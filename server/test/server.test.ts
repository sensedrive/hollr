import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeFrame, encodeJson, FRAME_AUDIO, FRAME_JSON, FrameDecoder } from "../src/frames";
import { Herdr, toAgent } from "../src/herdr";
import {
  addBootstrap,
  buildPayload,
  ed25519PublicLine,
  enroll,
  listDevices,
  newBootstrapKey,
  parsePayloadUrl,
  payloadUrl,
  revokeDevice,
  upgradeDeviceKeys,
} from "../src/pairing";
import { PulseSession, type Run } from "../src/pulse";
import { parseEntry } from "../src/sessionlog";

describe("frames", () => {
  test("roundtrip across arbitrary chunk boundaries", () => {
    const audio = new Uint8Array([1, 2, 3, 4, 5]);
    const bytes = new Uint8Array([
      ...encodeFrame(FRAME_AUDIO, audio),
      ...encodeJson({ t: "mute", on: true }),
    ]);
    const d = new FrameDecoder();
    const frames = [
      ...d.push(bytes.slice(0, 3)),
      ...d.push(bytes.slice(3, 11)),
      ...d.push(bytes.slice(11)),
    ];
    expect(frames).toEqual([
      { type: FRAME_AUDIO, data: audio },
      { type: FRAME_JSON, data: { t: "mute", on: true } },
    ]);
  });
});

describe("pairing", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hollr-"));
    Bun.env.HOLLR_AUTHORIZED_KEYS = join(dir, "authorized_keys");
    Bun.env.HOLLR_HOST_KEY = join(dir, "host.pub");
    writeFileSync(
      Bun.env.HOLLR_HOST_KEY,
      `${ed25519PublicLine(new Uint8Array(32).fill(7))} root@test\n`,
    );
    writeFileSync(Bun.env.HOLLR_AUTHORIZED_KEYS, "ssh-ed25519 AAAAexisting user@laptop\n", {
      mode: 0o600,
    });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("bootstrap -> enroll -> list -> revoke keeps other keys intact", () => {
    const { seed, publicLine } = newBootstrapKey();
    expect(seed.length).toBe(32);
    const { id, exp } = addBootstrap(publicLine);
    let content = readFileSync(Bun.env.HOLLR_AUTHORIZED_KEYS ?? "", "utf8");
    expect(content).toContain(`enroll ${id}"`);
    expect(content).toContain("restrict,command=");

    const device = enroll(id, newBootstrapKey().publicLine, "Alex's iPhone; rm -rf /");
    expect(device.name).toBe("Alex's iPhone rm -rf");
    content = readFileSync(Bun.env.HOLLR_AUTHORIZED_KEYS ?? "", "utf8");
    expect(content).not.toContain("hollr-pairing");
    expect(content).toContain(' gate" ssh-ed25519');
    expect(content).toContain("user@laptop");
    expect(() => enroll(id, newBootstrapKey().publicLine, "x")).toThrow("unknown_pairing");

    expect(listDevices().map((d) => d.name)).toEqual(["Alex's iPhone rm -rf"]);
    expect(revokeDevice(device.id)).toHaveLength(1);
    expect(listDevices()).toHaveLength(0);
    expect(readFileSync(Bun.env.HOLLR_AUTHORIZED_KEYS ?? "", "utf8")).toContain("user@laptop");

    const payload = buildPayload({ seed, exp, addresses: ["1.2.3.4"], label: "my-server" });
    expect(parsePayloadUrl(payloadUrl(payload))).toEqual(payload);
    expect(payload.fp).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
  });

  test("device keys: forwarding only to loopback, old keys upgraded once", () => {
    const file = Bun.env.HOLLR_AUTHORIZED_KEYS ?? "";
    const key = newBootstrapKey().publicLine;
    writeFileSync(
      file,
      `ssh-ed25519 AAAAother user@laptop\nrestrict,command="/x/hollr gate" ${key} hollr-device:abcd Old Phone\n`,
    );
    expect(upgradeDeviceKeys()).toBe(1);
    const line = readFileSync(file, "utf8").split("\n")[1] ?? "";
    expect(line).toMatch(
      /^restrict,port-forwarding,permitopen="localhost:\*",permitopen="127\.0\.0\.1:\*",permitopen="\[::1\]:\*",command="[^"]+ gate" ssh-ed25519 /,
    );
    expect(line).toEndWith("hollr-device:abcd Old Phone");
    expect(readFileSync(file, "utf8")).toStartWith("ssh-ed25519 AAAAother user@laptop\n");
    expect(upgradeDeviceKeys()).toBe(0);
    expect(listDevices().map((d) => d.name)).toEqual(["Old Phone"]);
  });

  test("expired bootstrap is rejected", () => {
    const { id } = addBootstrap(newBootstrapKey().publicLine, -1);
    expect(() => enroll(id, newBootstrapKey().publicLine, "x")).toThrow();
  });

  test("rejects non-ed25519 device keys", () => {
    const { id } = addBootstrap(newBootstrapKey().publicLine);
    expect(() => enroll(id, 'ssh-rsa AAAA" command="evil', "x")).toThrow("invalid_key");
  });
});

describe("pulse", () => {
  test("moves only the streams of the omp pid, once", async () => {
    const calls: string[][] = [];
    const run: Run = async (args) => {
      calls.push(args);
      if (args.includes("source-outputs")) {
        return {
          code: 0,
          err: "",
          out: JSON.stringify([
            { index: 5, properties: { "application.process.id": "42" } },
            { index: 6, properties: { "application.process.id": "99" } },
          ]),
        };
      }
      if (args.includes("sink-inputs")) return { code: 0, err: "", out: "[]" };
      return { code: 0, err: "", out: "17" };
    };
    const s = new PulseSession("1234", run);
    expect(await s.attach(42)).toEqual({ capturing: true, playing: false });
    await s.attach(42);
    const moves = calls.filter((c) => c[1] === "move-source-output");
    expect(moves).toEqual([["pactl", "move-source-output", "5", "hollr_mic_1234"]]);
  });
});

describe("session log", () => {
  test("delegations, tools and answers", () => {
    expect(
      parseEntry(
        JSON.stringify({
          type: "custom_message",
          customType: "live-delegation",
          content: "Lies notiz.txt",
          message: { role: "custom", customType: "live-delegation", content: "Lies notiz.txt" },
        }),
      ),
    ).toEqual([{ t: "delegation", text: "Lies notiz.txt" }]);
    expect(
      parseEntry(
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            stopReason: "toolUse",
            content: [
              { type: "thinking" },
              { type: "toolCall", name: "read", intent: "Datei lesen" },
            ],
          },
        }),
      ),
    ).toEqual([{ t: "tool", name: "read", intent: "Datei lesen" }]);
    expect(
      parseEntry(
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            stopReason: "stop",
            content: [{ type: "text", text: "4711" }],
          },
        }),
      ),
    ).toEqual([{ t: "answer", text: "4711", final: true }]);
  });
});

test("agent title strips omp prefix and icon glyphs", () => {
  expect(
    toAgent({
      pane_id: "wH:p6",
      agent: "omp",
      terminal_title_stripped: "π > \u{F014E} TICKET: Structure the backlog",
    }).title,
  ).toBe("TICKET: Structure the backlog");
});

test("session tail only reports entries since the call started", async () => {
  const { SessionTail } = await import("../src/sessionlog");
  const file = join(tmpdir(), `hollr-tail-${Date.now()}.jsonl`);
  const old = {
    type: "custom_message",
    customType: "live-delegation",
    content: "alt",
    timestamp: "2020-01-01T00:00:00Z",
  };
  writeFileSync(file, `${JSON.stringify(old)}\n`);
  const events: unknown[] = [];
  const tail = new SessionTail(file, (e) => events.push(e), Date.now() - 1000);
  const fresh = { ...old, content: "neu", timestamp: new Date().toISOString() };
  writeFileSync(file, `${JSON.stringify(old)}\n${JSON.stringify(fresh)}\n`);
  await tail.poll();
  expect(events).toEqual([{ t: "delegation", text: "neu" }]);
  rmSync(file);
});

test("omp live footer state", async () => {
  const { parseLiveState } = await import("../src/herdr");
  expect(parseLiveState("╰─ × muted · 󱁐 mute · 󱊷 end ───")).toBe("muted");
  expect(parseLiveState("╰─ ● listening · 󱁐 mute · 󱊷 end ─")).toBe("listening");
  expect(parseLiveState("normal prompt ❯")).toBeUndefined();
});

describe("timeline", () => {
  const line = (o: unknown) => JSON.stringify(o);
  const t0 = Date.parse("2026-10-13T10:00:00Z");
  const iso = (s: number) => new Date(t0 + s * 1000).toISOString();

  test("turn, grouped tools with duration, todo snapshot, running job, end", async () => {
    const { buildTimeline } = await import("../src/timeline");
    const now = Date.now();
    const jsonl = [
      line({ type: "title", title: "📝 Test" }),
      line({
        type: "message",
        timestamp: iso(0),
        message: { role: "user", content: [{ type: "text", text: "Mach was" }], timestamp: t0 },
      }),
      line({
        type: "message",
        timestamp: iso(1),
        message: {
          role: "assistant",
          stopReason: "toolUse",
          content: [
            { type: "thinking", thinking: "erst lesen" },
            {
              type: "toolCall",
              id: "c1",
              name: "read",
              intent: "Datei lesen",
              arguments: { path: "a.ts" },
            },
            {
              type: "toolCall",
              id: "c2",
              name: "edit",
              intent: "Fix",
              arguments: { input: "[src/b.ts#AB12]\nPUT" },
            },
          ],
        },
      }),
      line({
        type: "custom",
        customType: "tool_execution_start",
        timestamp: iso(1),
        data: { toolCallId: "c1", toolName: "read", startedAt: iso(1) },
      }),
      line({
        type: "message",
        timestamp: iso(3),
        message: {
          role: "toolResult",
          toolCallId: "c1",
          toolName: "read",
          content: [{ type: "text", text: "x" }],
          timestamp: t0 + 3000,
        },
      }),
      line({
        type: "message",
        timestamp: iso(4),
        message: {
          role: "toolResult",
          toolCallId: "c2",
          toolName: "edit",
          details: { diff: "+a\n+b\n-c" },
          content: [],
          timestamp: t0 + 4000,
        },
      }),
      line({
        type: "message",
        timestamp: iso(5),
        message: {
          role: "assistant",
          stopReason: "toolUse",
          content: [
            { type: "toolCall", id: "c3", name: "todo", arguments: { op: "done", task: "A" } },
            {
              type: "toolCall",
              id: "c4",
              name: "bash",
              intent: "Deploy",
              arguments: { command: "yarn deploy", async: true },
            },
          ],
        },
      }),
      line({
        type: "message",
        timestamp: iso(6),
        message: {
          role: "toolResult",
          toolCallId: "c3",
          toolName: "todo",
          details: {
            phases: [
              {
                name: "Welle 2",
                tasks: [
                  { content: "A", status: "completed" },
                  { content: "B", status: "in_progress" },
                ],
              },
            ],
          },
          content: [],
        },
      }),
      line({
        type: "message",
        timestamp: iso(6),
        message: {
          role: "toolResult",
          toolCallId: "c4",
          toolName: "bash",
          details: { async: { state: "running", jobId: "bg_1", type: "bash" } },
          content: [],
          timestamp: now,
        },
      }),
      line({
        type: "message",
        timestamp: iso(8),
        message: {
          role: "assistant",
          stopReason: "stop",
          completedAt: t0 + 134_000,
          content: [{ type: "text", text: "Fertig." }],
        },
      }),
    ].join("\n");
    const t = buildTimeline(jsonl);
    expect(t.title).toBe("📝 Test");
    // consecutive tool calls without text in between form one group (like omp's TUI)
    expect(t.items.map((i) => i.k)).toEqual(["user", "thinking", "tools", "text", "end"]);
    const g = t.items[2] as {
      calls: Array<{ name: string; ms?: number; detail?: string; add?: number; del?: number }>;
    };
    expect(g.calls.map((c) => c.name)).toEqual(["read", "edit", "todo", "bash"]);
    expect(g.calls[0]?.ms).toBe(2000);
    expect(g.calls[1]?.detail).toBe("src/b.ts");
    expect([g.calls[1]?.add, g.calls[1]?.del]).toEqual([2, 1]);
    expect(t.todo?.[0]?.name).toBe("Welle 2");
    expect(t.jobs.map((j) => j.id)).toEqual(["bg_1"]);
    expect((t.items.at(-1) as { ms: number }).ms).toBe(134_000);
    expect(t.running).toBe(false);
  });

  test("redacts tokens", async () => {
    const { redact } = await import("../src/timeline");
    expect(redact("token ghp_abcdefghijklmnopqrstuvwxyz123456 ok")).toBe("token ••• ok");
  });
});

test("omp footer parsing", async () => {
  const { parseFooter } = await import("../src/spaces");
  const f = parseFooter("─────\n 󰵗 · 󰪣 Opus 5.5 ·  hollr-test ·  1.6%/1M 󰁨 · 󰙺 0.10");
  expect(f.model).toBe("Opus 5.5");
  expect(f.context).toBe("1.6%/1M");
  expect(f.cost).toBe("0.10");
});

describe("ports", () => {
  test("keeps loopback/wildcard listeners with their process", async () => {
    const { parseListeners } = await import("../src/ports");
    const ss = [
      'LISTEN 0 511 127.0.0.1:5173 0.0.0.0:* users:(("node",pid=42,fd=20))',
      "LISTEN 0 4096 0.0.0.0:8082 0.0.0.0:*",
      "LISTEN 0 5 10.0.0.2:15432 0.0.0.0:*",
      "LISTEN 0 4096 0.0.0.0:22 0.0.0.0:*",
      "LISTEN 0 4096 127.0.0.53%lo:53 0.0.0.0:*",
      'LISTEN 0 511 [::1]:3000 [::]:* users:(("bun",pid=7,fd=3))',
    ].join("\n");
    expect(parseListeners(ss)).toEqual([
      { port: 3000, process: "bun", pid: 7 },
      { port: 5173, process: "node", pid: 42 },
      { port: 8082, process: undefined, pid: undefined },
    ]);
  });
});

describe("watch", () => {
  test("waiting at once, done only after idle holds and real work", async () => {
    const { diffStates } = await import("../src/watch");
    const seen = new Map();
    expect(diffStates(seen, [{ pane: "w1:p1", status: "idle" }], 0)).toEqual([]);
    diffStates(seen, [{ pane: "w1:p1", status: "working" }], 1000);
    // short pause between steps: no notification
    expect(diffStates(seen, [{ pane: "w1:p1", status: "idle" }], 9000)).toEqual([]);
    diffStates(seen, [{ pane: "w1:p1", status: "working" }], 10000);
    expect(diffStates(seen, [{ pane: "w1:p1", status: "idle" }], 20000)).toEqual([]);
    expect(diffStates(seen, [{ pane: "w1:p1", status: "idle" }], 24000)).toEqual([
      { pane: "w1:p1", kind: "done", workedMs: 19000 },
    ]);
    expect(diffStates(seen, [{ pane: "w1:p1", status: "idle" }], 30000)).toEqual([]);
    diffStates(seen, [{ pane: "w1:p1", status: "working" }], 31000);
    expect(diffStates(seen, [{ pane: "w1:p1", status: "blocked" }], 33000)).toEqual([
      { pane: "w1:p1", kind: "waiting", workedMs: 2000 },
    ]);
    // a turn under 5s is not worth a push
    diffStates(seen, [{ pane: "w2:p1", status: "working" }], 40000);
    diffStates(seen, [{ pane: "w2:p1", status: "working" }], 40000);
    diffStates(seen, [{ pane: "w2:p1", status: "idle" }], 42000);
    expect(diffStates(seen, [{ pane: "w2:p1", status: "idle" }], 47000)).toEqual([]);
  });
});

describe("push", () => {
  test("devices and ES256 provider token", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hollr-push-"));
    Bun.env.HOLLR_PUSH_DIR = dir;
    const push = await import("../src/push");
    expect(() => push.registerDevice({ token: "nothex" })).toThrow("invalid_token");
    push.registerDevice({ token: "AB".repeat(32), env: "sandbox", name: "Test" });
    push.registerDevice({
      token: "ab".repeat(32),
      env: "production",
      prefs: { done: false } as never,
    });
    expect(push.pushDevices()).toHaveLength(1);
    expect(push.pushDevices()[0]?.prefs).toEqual({ waiting: true, done: false, error: true, activity: true });
    // Live Activity tokens: kept across re-registration, removed when the activity ends
    push.setActivityToken("ab".repeat(32), "w1:p1", "cd".repeat(40));
    push.registerDevice({ token: "ab".repeat(32), env: "production", liveStart: "ef".repeat(40) } as never);
    expect(push.pushDevices()[0]?.activities).toEqual({ "w1:p1": "cd".repeat(40) });
    expect(push.pushDevices()[0]?.liveStart).toBe("ef".repeat(40));
    expect(() => push.setActivityToken("ab".repeat(32), "w1 p1; rm", "cd".repeat(40))).toThrow("invalid_pane");
    push.setActivityToken("ab".repeat(32), "w1:p1", null);
    expect(push.pushDevices()[0]?.activities).toEqual({});
    const { generateKeyPairSync, verify } = await import("node:crypto");
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const jwt = push.providerToken(
      { keyId: "ABC123DEFG", teamId: "TEAM123456", bundleId: "x" },
      pem,
      1_000_000,
    );
    const [h, c, sig] = jwt.split(".");
    expect(JSON.parse(Buffer.from(h ?? "", "base64url").toString())).toEqual({
      alg: "ES256",
      kid: "ABC123DEFG",
    });
    expect(JSON.parse(Buffer.from(c ?? "", "base64url").toString())).toEqual({
      iss: "TEAM123456",
      iat: 1000,
    });
    expect(
      verify(
        "sha256",
        Buffer.from(`${h}.${c}`),
        { key: publicKey, dsaEncoding: "ieee-p1363" },
        Buffer.from(sig ?? "", "base64url"),
      ),
    ).toBe(true);
    expect(push.unregisterDevice("AB".repeat(32))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("git views", () => {
  test("graph, changes, stage, commit details, branches on a real repo", async () => {
    const git = await import("../src/git");
    const repo = mkdtempSync(join(tmpdir(), "hollr-git-"));
    const sh = (...cmd: string[]) => {
      const r = Bun.spawnSync(cmd, {
        cwd: repo,
        env: {
          ...Bun.env,
          GIT_AUTHOR_NAME: "T",
          GIT_AUTHOR_EMAIL: "t@x",
          GIT_COMMITTER_NAME: "T",
          GIT_COMMITTER_EMAIL: "t@x",
        },
      });
      if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")}: ${r.stderr}`);
    };
    sh("git", "init", "-q", "-b", "main");
    writeFileSync(join(repo, "a.txt"), "one\ntwo\n");
    sh("git", "add", ".");
    sh("git", "commit", "-qm", "first");
    sh("git", "checkout", "-qb", "feature");
    writeFileSync(join(repo, "b.txt"), "x\n");
    sh("git", "add", ".");
    sh("git", "commit", "-qm", "feat: b");
    sh("git", "checkout", "-q", "main");
    writeFileSync(join(repo, "a.txt"), "one\nTWO\n");
    sh("git", "commit", "-qam", "change a");
    sh("git", "merge", "-q", "--no-ff", "-m", "Merge feature", "feature");

    const g = git.graph(repo);
    expect(g.commits.map((c) => c.subject)).toEqual([
      "Merge feature",
      "feat: b",
      "change a",
      "first",
    ]);
    expect(g.commits[0]?.parents).toHaveLength(2);

    const merge = git.commitDetails(repo, g.commits[0]?.hash ?? "");
    expect(merge.merge).toBe(true);
    expect(merge.files).toEqual([{ path: "b.txt", status: "A", add: 1, del: 0 }]);

    writeFileSync(join(repo, "a.txt"), "one\nTWO\nthree\n");
    writeFileSync(join(repo, "new.md"), "hi\nthere\n");
    let c = git.changes(repo);
    expect(c.branch).toBe("main");
    expect(c.staged).toEqual([]);
    expect(c.unstaged).toEqual([
      { path: "a.txt", status: "M", add: 1, del: 0 },
      { path: "new.md", status: "A", add: 3, del: 0 },
    ]);
    expect(git.fileDiff(repo, "a.txt", false).text).toContain("+three");
    git.stage(repo, "a.txt", true);
    c = git.changes(repo);
    expect(c.staged).toEqual([{ path: "a.txt", status: "M", add: 1, del: 0 }]);
    expect(git.fileDiff(repo, "a.txt", true).text).toContain(" one");
    git.stage(repo, "a.txt", false);
    expect(git.changes(repo).staged).toEqual([]);

    const b = git.branches(repo);
    expect(
      (b.local as Array<{ name: string; current: boolean }>).map((x) => [x.name, x.current]).sort(),
    ).toEqual([
      ["feature", false],
      ["main", true],
    ]);
    rmSync(repo, { recursive: true, force: true });
  });
});

describe("space deletion safety", () => {
  test("only folders inside home or /tmp, never home itself or system paths", async () => {
    const { safeToDelete } = await import("../src/spaces");
    const home = Bun.env.HOME ?? "";
    const inside = mkdtempSync(join(home, ".hollr-test-"));
    const tmp = mkdtempSync(join("/tmp", "hollr-del-"));
    expect(safeToDelete(inside)).toBe(true);
    expect(safeToDelete(tmp)).toBe(true);
    expect(safeToDelete(home)).toBe(false);
    expect(safeToDelete("/")).toBe(false);
    expect(safeToDelete("/usr")).toBe(false);
    expect(safeToDelete("/tmp")).toBe(false);
    expect(safeToDelete(`${inside}/../..`)).toBe(false);
    expect(safeToDelete("/does/not/exist")).toBe(false);
    expect(safeToDelete("")).toBe(false);
    rmSync(inside, { recursive: true, force: true });
    rmSync(tmp, { recursive: true, force: true });
  });
});

describe("tools", () => {
  test("version comparison", async () => {
    const { newer } = await import("../src/tools");
    expect(newer("0.9.2", "0.9.1")).toBe(true);
    expect(newer("1.10.0", "1.9.9")).toBe(true);
    expect(newer("rust-v0.162.1", "0.162.1")).toBe(false);
    expect(newer("18.10.1", "18.10.4")).toBe(false);
    expect(newer("2.1.280", "2.1.280")).toBe(false);
  });
});

describe("models", () => {
  test("start args and session switch per agent", async () => {
    const { startArgs, switchCommand } = await import("../src/models");
    expect(startArgs("omp", "anthropic/claude-opus-5-5", "high")).toEqual([
      "--model=anthropic/claude-opus-5-5",
      "--thinking=high",
    ]);
    expect(startArgs("claude", "sonnet", "max")).toEqual(["--model", "sonnet", "--effort", "max"]);
    expect(startArgs("codex", "gpt-5.5", "low")).toEqual([
      "-m",
      "gpt-5.5",
      "-c",
      'model_reasoning_effort="low"',
    ]);
    expect(startArgs("omp")).toEqual([]);
    expect(() => startArgs("omp", "x; rm -rf /")).toThrow();
    expect(switchCommand("omp", "anthropic/claude-haiku-5-5", "low")).toBe(
      "/switch anthropic/claude-haiku-5-5:low",
    );
    expect(switchCommand("claude", "opus")).toBe("/model opus");
    expect(() => switchCommand("codex", "gpt-5.5")).toThrow();
  });
});

describe("keys", () => {
  test("keys herdr doesn't know go out as escape sequences, in order", async () => {
    const calls: string[][] = [];
    const herdr = new Herdr(async (args) => {
      calls.push(args);
      return args[1] === "list" ? { agents: [] } : "";
    });
    await herdr.sendKeys("w1:p1", ["a", "b", "home", "x", "delete", "enter"]);
    expect(calls.filter((c) => c[1] !== "list")).toEqual([
      ["pane", "send-keys", "w1:p1", "a", "b"],
      ["pane", "send-text", "w1:p1", "\x1bOH"],
      ["pane", "send-keys", "w1:p1", "x"],
      ["pane", "send-text", "w1:p1", "\x1b[3~"],
      ["pane", "send-keys", "w1:p1", "enter"],
    ]);
  });
});

describe("events", () => {
  test("structure changes always, pane updates only when status/cwd/title change", async () => {
    const { classify } = await import("../src/events");
    const panes = new Map<string, string>();
    const upd = (status: string, rev: number) => ({
      event: "pane_updated",
      data: { pane: { pane_id: "w1:p1", agent_status: status, cwd: "/tmp", revision: rev } },
    });
    expect(classify({ event: "workspace_created" }, panes)).toBe("spaces");
    expect(classify({ event: "pane_created" }, panes)).toBe("tree");
    expect(classify(upd("idle", 1), panes)).toBe("none"); // first sighting: just remembered
    expect(classify(upd("idle", 2), panes)).toBe("none"); // output only
    expect(classify(upd("working", 3), panes)).toBe("tree");
  });
});

describe("usage history", () => {
  test("dedupe, record only when moved or hourly, activity per hour", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hollr-usage-"));
    Bun.env.HOLLR_STATE_DIR = dir;
    const { dedupeLimits, UsageRecorder, usageHistory } = await import("../src/usagehistory");
    const row = (used: number) => ({ provider: "claude", account: "a", label: "5 Hour", window: "5h", used });
    expect(dedupeLimits([row(0.3), row(0.32), { ...row(0.1), label: "7 Day" }])).toHaveLength(2);
    const r = new UsageRecorder();
    const t0 = 1_800_000_000_000;
    r.recordLimits([row(0.3), row(0.3)], t0);
    r.recordLimits([row(0.3)], t0 + 600_000); // unchanged → skipped
    r.recordLimits([row(0.35)], t0 + 1_200_000); // moved → stored
    r.recordLimits([row(0.35)], t0 + 1_200_000 + 3_600_000); // hourly anchor
    r.tick(["omp"], t0);
    r.tick(["omp", "claude"], t0 + 2000);
    r.tick([], t0 + 4000);
    r.flush();
    const h = usageHistory(30, t0 + 5_000_000);
    expect(h.samples.map((s) => s.limits[0]?.u)).toEqual([0.3, 0.35, 0.35]);
    expect(h.activity[0]?.work).toEqual({ omp: 4, claude: 2 });
    rmSync(dir, { recursive: true, force: true });
    delete Bun.env.HOLLR_STATE_DIR;
  });
});

describe("live footer", () => {
  test("recognised in every omp state", async () => {
    const { hasLiveFooter } = await import("../src/herdr");
    expect(hasLiveFooter("╰─ × muted · ␣ mute · ⎋ end ───╯")).toBe(true);
    expect(hasLiveFooter("╰─ ● hearing you · ␣ mute · ⎋ end ─")).toBe(true);
    expect(hasLiveFooter(" π · ◒ Opus 5.5 · 📁 …/my-app · ⑂ main")).toBe(false);
  });
});

describe("network modes", () => {
  test("tailscale first with LAN fallback, lan without tailscale addresses", async () => {
    const { addressesFor, isTailscaleIp } = await import("../src/network");
    const ts = { installed: true, state: "Running", dnsName: "box.tail1.ts.net", ips: ["100.101.1.2"] };
    const t = addressesFor("tailscale", ts);
    expect(t.slice(0, 2)).toEqual(["box.tail1.ts.net", "100.101.1.2"]);
    expect(addressesFor("lan", ts).some(isTailscaleIp)).toBe(false);
    expect(addressesFor("lan", ts)).not.toContain("box.tail1.ts.net");
    expect(addressesFor("tailscale", { ...ts, state: "Stopped" })).not.toContain("box.tail1.ts.net");
    expect(isTailscaleIp("100.64.0.1")).toBe(true);
    expect(isTailscaleIp("100.128.0.1")).toBe(false);
  });
});

describe("gate", () => {
  test("timeline of a closed pane answers not_found instead of nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hollr-gate-"));
    try {
      const herdr = join(dir, "herdr");
      writeFileSync(
        herdr,
        `#!/bin/sh\necho '{"error":{"code":"pane_not_found","message":"no such pane"}}'\nexit 1\n`,
        { mode: 0o755 },
      );
      const proc = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli.ts"), "gate"], {
        env: {
          PATH: Bun.env.PATH ?? "/usr/bin:/bin",
          HOME: dir,
          HOLLR_GATE_PATH: "1",
          HERDR_BIN_PATH: herdr,
          HOLLR_AUTHORIZED_KEYS: join(dir, "authorized_keys"),
          HOLLR_STATE_DIR: dir,
          XDG_STATE_HOME: dir,
          XDG_CONFIG_HOME: dir,
          SSH_ORIGINAL_COMMAND: "timeline w1:p9 150",
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const out = await new Response(proc.stdout).text();
      expect(await proc.exited).toBe(0);
      expect(JSON.parse(out)).toEqual({ error: "not_found" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("addresses", () => {
  test("public, then .local, then private; no link-local, no bridges", async () => {
    const { orderAddresses } = await import("../src/pairing");
    const v4 = (address: string, internal = false) => ({ family: "IPv4", internal, address });
    const order = orderAddresses(
      {
        lo0: [v4("127.0.0.1", true)],
        en0: [v4("192.168.1.20"), { family: "IPv6", internal: false, address: "fe80::1" }],
        en1: [v4("169.254.10.3")],
        en5: [v4("203.0.113.7")],
        utun4: [v4("100.101.1.2")],
        docker0: [v4("172.17.0.1")],
        "br-1a2b": [v4("172.18.0.1")],
        virbr0: [v4("192.168.122.1")],
        lxdbr0: [v4("10.10.10.1")],
        cni0: [v4("10.88.0.1")],
        "flannel.1": [v4("10.244.0.0")],
      },
      ["mac.local"],
    );
    expect(order).toEqual(["203.0.113.7", "mac.local", "192.168.1.20", "100.101.1.2"]);
  });
});

describe("pairing confirmation", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hollr-confirm-"));
    Bun.env.HOLLR_STATE_DIR = dir;
    // a denied code drops its bootstrap key: never touch the real ~/.ssh
    Bun.env.HOLLR_AUTHORIZED_KEYS = join(dir, "authorized_keys");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete Bun.env.HOLLR_STATE_DIR;
    delete Bun.env.HOLLR_AUTHORIZED_KEYS;
  });

  test("waits for yes, rejects no, skips when not asked", async () => {
    const p = await import("../src/pairing");
    await p.awaitConfirmation("nobody", "iPhone", 200); // no confirmation requested → returns at once
    p.requireConfirmation("abc");
    const waiting = p.awaitConfirmation("abc", "Alex iPhone", 5000);
    await Bun.sleep(100);
    expect(p.pendingRequest("abc")).toEqual({ name: "Alex iPhone" });
    p.answerRequest("abc", true);
    await waiting;
    p.requireConfirmation("def");
    const denied = p.awaitConfirmation("def", "x", 5000);
    await Bun.sleep(100);
    p.answerRequest("def", false);
    expect(denied).rejects.toThrow("denied");
    p.requireConfirmation("ghi");
    expect(p.awaitConfirmation("ghi", "x", 300)).rejects.toThrow("not_confirmed");
    await Bun.sleep(400);
  });

  for (const outcome of ["denied", "not_confirmed"] as const)
    test(`${outcome}: a second scan of the same code cannot enroll`, async () => {
      const p = await import("../src/pairing");
      const { id } = p.addBootstrap(p.newBootstrapKey().publicLine);
      p.requireConfirmation(id);
      const first = p.awaitConfirmation(id, "Phone", outcome === "denied" ? 5000 : 300);
      if (outcome === "denied") {
        await Bun.sleep(100);
        p.answerRequest(id, false);
      }
      await expect(first).rejects.toThrow(outcome);
      expect(readFileSync(Bun.env.HOLLR_AUTHORIZED_KEYS ?? "", "utf8")).not.toContain(id);
      // second scan: no marker any more, but the key is gone too
      expect(await p.awaitConfirmation(id, "Thief", 300)).toBe(false);
      expect(() => p.enroll(id, p.newBootstrapKey().publicLine, "Thief")).toThrow(
        "unknown_pairing",
      );
    });

  test("yes: marker stays until enrolled, a parallel scan is busy", async () => {
    const p = await import("../src/pairing");
    const { id } = p.addBootstrap(p.newBootstrapKey().publicLine);
    p.requireConfirmation(id);
    const first = p.awaitConfirmation(id, "Phone", 5000);
    await Bun.sleep(100);
    await expect(p.awaitConfirmation(id, "Thief", 300)).rejects.toThrow("busy");
    p.answerRequest(id, true);
    expect(await first).toBe(true);
    expect(p.pendingRequest(id)).toBeUndefined();
    // confirmed but not enrolled yet: another scan still has to ask
    const again = p.awaitConfirmation(id, "Thief", 300);
    await expect(again).rejects.toThrow("not_confirmed");
    expect(() => p.enroll(id, p.newBootstrapKey().publicLine, "x")).toThrow("unknown_pairing");
  });
});

describe("one-time code", () => {
  test("format round-trip, tolerant input", async () => {
    const { decodeCode, encodeCode } = await import("../src/otp");
    const secret = Buffer.from("a1b2c3d4e5f6", "hex");
    const code = encodeCode("100.101.127.82", secret);
    expect(code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    const back = decodeCode(code.toLowerCase().replaceAll("-", " "));
    expect(back?.ip).toBe("100.101.127.82");
    expect(back?.secret.toString("hex")).toBe("a1b2c3d4e5f6");
    expect(decodeCode("ABCD-EFGH")).toBeUndefined();
  });

  test("phone proves the code, gets the payload once; wrong codes lock it", async () => {
    const { createDecipheriv } = await import("node:crypto");
    const otp = await import("../src/otp");
    const payload = JSON.stringify({ v: 1, a: ["127.0.0.1"], l: "test" });
    const server = otp.serveCode("127.0.0.1", payload, Date.now() / 1000 + 60);
    const url = `http://127.0.0.1:${otp.OTP_PORT}/hollr/pair`;
    const post = (proof: Buffer) =>
      fetch(url, { method: "POST", body: JSON.stringify({ proof: proof.toString("base64") }) });
    // wrong code → 403
    expect((await post(Buffer.alloc(32))).status).toBe(403);
    // right code → sealed payload
    const decoded = otp.decodeCode(server.code);
    if (!decoded) throw new Error("code did not decode");
    const { ip, secret } = decoded;
    const keys = otp.deriveKeys(ip, secret);
    const res = await post(otp.proofFor(keys.auth));
    expect(res.status).toBe(200);
    const box = Buffer.from(((await res.json()) as { box: string }).box, "base64");
    const d = createDecipheriv("aes-256-gcm", keys.enc, box.subarray(0, 12));
    d.setAuthTag(box.subarray(box.length - 16));
    expect(Buffer.concat([d.update(box.subarray(12, box.length - 16)), d.final()]).toString()).toBe(payload);
    expect(await server.done).toBe("served");
    // used → 410 (or closed)
    const again = await post(otp.proofFor(keys.auth)).catch(() => undefined);
    expect(again === undefined || again.status === 410).toBe(true);
    server.stop();
    await Bun.sleep(300);

    const locked = otp.serveCode("127.0.0.1", payload, Date.now() / 1000 + 60);
    for (let i = 0; i < 5; i++) await post(Buffer.alloc(32));
    expect(await locked.done).toBe("failed");
    locked.stop();
    await Bun.sleep(300);
  }, 20_000);
});

describe("live activity", () => {
  test("starts after a while, updates on new steps, alerts when waiting, ends with the turn", async () => {
    const { planActivity, START_AFTER_MS, UPDATE_EVERY_MS } = await import("../src/activity");
    const t0 = 1_000_000;
    const track = { active: false, since: t0, lastAt: 0 };
    const p = { step: "Tests laufen", todoDone: 1, todoTotal: 4 };
    expect(planActivity(track, "working", p, t0 + 5_000)).toBeUndefined(); // short turns stay quiet
    const start = planActivity(track, "working", p, t0 + START_AFTER_MS);
    expect(start?.event).toBe("start");
    expect(start?.state).toEqual({ ...p, status: "working", since: t0 / 1000 });
    const active = { ...track, active: true, lastStatus: "working", lastStep: p.step, lastAt: t0 + START_AFTER_MS };
    expect(planActivity(active, "working", p, t0 + 60_000)).toBeUndefined(); // nothing new
    const next = { ...p, step: "Build" };
    expect(planActivity(active, "working", next, t0 + START_AFTER_MS + 1000)).toBeUndefined(); // too soon
    expect(planActivity(active, "working", next, t0 + START_AFTER_MS + UPDATE_EVERY_MS)?.event).toBe("update");
    const waiting = planActivity(active, "blocked", { ...p, step: "Darf ich pushen?" }, t0 + 70_000);
    expect(waiting).toMatchObject({ event: "update", alert: true, state: { status: "waiting" } });
    expect(planActivity({ ...active, lastStatus: "waiting" }, "blocked", p, t0 + 72_000)).toBeUndefined();
    expect(planActivity(active, "idle", p, t0 + 90_000)).toMatchObject({ event: "end", state: { status: "done" } });
    expect(planActivity(active, "idle", p, t0 + 90_000, true)?.state.status).toBe("error");
    expect(planActivity(track, "idle", p, t0 + 90_000)).toBeUndefined(); // never started
  });

  test("progress from todo, running tool or question", async () => {
    const { describeProgress } = await import("../src/activity");
    const tl = {
      items: [
        { k: "text", id: "1", text: "Ich **schaue** mir das an" },
        { k: "tools", id: "2", calls: [{ id: "a", name: "bash", label: "bun test", status: "running" }] },
      ],
      jobs: [],
      running: true,
      waiting: false,
      todo: [{ name: "P1", tasks: [{ content: "Fix", status: "completed" }, { content: "Deploy", status: "in_progress" }] }],
    } as never;
    expect(describeProgress(tl, "x")).toEqual({ step: "Deploy", todoDone: 1, todoTotal: 2 });
    const noTodo = { ...(tl as object), todo: undefined } as never;
    expect(describeProgress(noTodo, "x").step).toBe("bun test");
    expect(describeProgress(undefined, "omp arbeitet")).toEqual({ step: "omp arbeitet", todoDone: 0, todoTotal: 0 });
  });
});

describe("@ file completion", () => {
  test("name prefix before contains before path before fuzzy, shorter first", async () => {
    const { matchFiles } = await import("../src/spaces");
    const files = [
      "src/live/AgentSession.swift",
      "src/views/Agent.swift",
      "docs/agents.md",
      "src/model/session.ts",
      "README.md",
      "test/agent-session.test.ts",
    ];
    expect(matchFiles(files, "agent")).toEqual([
      "docs/agents.md",
      "src/views/Agent.swift",
      "test/agent-session.test.ts",
      "src/live/AgentSession.swift",
    ]);
    expect(matchFiles(files, "sess")[0]).toBe("src/model/session.ts");
    expect(matchFiles(files, "agsw")).toEqual(["src/views/Agent.swift", "src/live/AgentSession.swift"]);
    expect(matchFiles(files, "")).toEqual(["README.md"]);
    expect(matchFiles(files, "agent", 2)).toHaveLength(2);
  });
});

describe("uploads", () => {
  test("saved outside the repo under a safe name, size limited", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hollr-up-"));
    Bun.env.HOLLR_UPLOAD_DIR = dir;
    try {
      const { saveUpload, safeName } = await import("../src/uploads");
      expect(safeName("../../etc/passwd")).toBe("passwd");
      expect(safeName(".hidden")).toBe("hidden");
      expect(safeName("Bildschirmfoto 2026.png")).toBe("Bildschirmfoto 2026.png");
      expect(safeName("a;rm -rf.png")).toBe("a_rm -rf.png");
      const path = saveUpload("shot.png", Buffer.from("png-bytes").toString("base64"), new Date("2026-10-15T08:30:05Z"));
      expect(path).toBe(join(dir, "2026-10-15", "083005-shot.png"));
      expect(readFileSync(path, "utf8")).toBe("png-bytes");
      expect(() => saveUpload("x", "")).toThrow("empty");
    } finally {
      delete Bun.env.HOLLR_UPLOAD_DIR;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("review actions", () => {
  test("discard, commit (staged or all), nothing to commit", async () => {
    const { commit, discard } = await import("../src/git");
    const repo = mkdtempSync(join(tmpdir(), "hollr-git-"));
    const sh = (...cmd: string[]) => Bun.spawnSync(cmd, { cwd: repo, stdout: "pipe", stderr: "pipe" });
    try {
      sh("git", "init", "-q");
      sh("git", "config", "user.email", "t@example.com");
      sh("git", "config", "user.name", "T");
      writeFileSync(join(repo, "a.txt"), "eins\n");
      sh("git", "add", ".");
      sh("git", "commit", "-qm", "init");
      writeFileSync(join(repo, "a.txt"), "zwei\n");
      writeFileSync(join(repo, "neu.txt"), "neu\n");
      discard(repo, "a.txt");
      expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("eins\n");
      discard(repo, "neu.txt");
      expect(Bun.file(join(repo, "neu.txt")).size).toBe(0);
      expect(() => commit(repo, "x", false)).toThrow("Nichts gestaged");
      expect(() => commit(repo, "  ", true)).toThrow("Commit-Nachricht fehlt");
      writeFileSync(join(repo, "b.txt"), "b\n");
      const c = commit(repo, "füge b hinzu", true);
      expect(c.hash).toMatch(/^[0-9a-f]{7,}$/);
      expect(sh("git", "log", "-1", "--format=%s").stdout.toString().trim()).toBe("füge b hinzu");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("terminal", () => {
  test("screen size ignores colors and escape sequences", async () => {
    const { screenSize } = await import("../src/term");
    expect(screenSize("\x1b[38;2;1;2;3mhallo\x1b[0m welt\nab\n\x1b]0;title\x07x")).toEqual({ rows: 3, cols: 10 });
    expect(screenSize("äöü")).toEqual({ rows: 1, cols: 3 });
  });
});

describe("phone shell", () => {
  test("size is clamped to something a terminal can show", async () => {
    const { clampSize } = await import("../src/shell");
    expect(clampSize(72, 30)).toEqual({ cols: 72, rows: 30 });
    expect(clampSize(5, 1)).toEqual({ cols: 20, rows: 5 });
    expect(clampSize(9999, 9999)).toEqual({ cols: 300, rows: 200 });
    expect(clampSize(Number.NaN, Number.NaN)).toEqual({ cols: 80, rows: 24 });
  });
});
