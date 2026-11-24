import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Grill } from "../src/grills";
import type { Agent } from "../src/herdr";
import {
  type Deps,
  effectiveOrder,
  type LoopProc,
  lastErrorLine,
  mergedIssues,
  parseProgress,
  parsePs,
  plannedIssues,
  progressOf,
  type Run,
  type RunIssue,
  readLogText,
  sandcastle,
  sandcastleEnv,
  sectionsSince,
  skillPrompt,
  fixedScope,
  parentOf,
  validateConfig,
  type Project,
} from "../src/sandcastle";

const root = realpathSync(mkdtempSync(join(tmpdir(), "hollr-sandcastle-")));
const saved = { HOME: Bun.env.HOME, HOLLR_STATE_DIR: Bun.env.HOLLR_STATE_DIR };
const shop = join(root, "code", "shop");
const wt = join(root, ".herdr", "worktrees", "shop", "run1");
const now = Date.now();
const at = (minAgo: number) => new Date(now - minAgo * 60_000).toISOString();
const SLUG = "acme/shop";

function git(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
}

// excerpts of the real formats (tendr worktree logs)
const planner = (minAgo: number, issues: { id: string; title: string }[]) =>
  `\n--- Run started: ${at(minAgo)} ---\nSandcastle Run\n  Agent: planner\n  Branch: feature/x\nAgent started\n<plan>\n${JSON.stringify({ issues: issues.map((i) => ({ ...i, branch: `sandcastle/issue-${i.id}` })) })}\n</plan>\nAgent stopped\nRun complete: reached 1 iteration(s) without completion signal.\n`;
const merger = `--- Run started: ${at(20)} ---\nSandcastle Run\n  Agent: merger\nAgent started\nBash(git rev-parse HEAD && git log --oneline HEAD..sandcastle/issue-11 && git merge --squash sandcastle/issue-11 2>&1 | tail -5)\nBash(git commit -q -m "🐛 fix: twelve" -m "Closes #12")\n<promise>COMPLETE</promise>\nAgent stopped\n`;
const impl = (minAgo: number, commits: boolean, tail = "") =>
  `\n--- Run started: ${at(minAgo)} ---\nIteration 1/100\nAgent started\nBash(gh issue view 1 --comments)\n${tail}Agent stopped\nCollecting commits\n${commits ? "Syncing 1 commit to host\n" : ""}Collecting commits done (0.0s)\nRun complete: agent finished after 1 iteration(s).\n`;

function logs(dir: string, files: Record<string, string>) {
  const d = join(dir, ".sandcastle", "logs");
  mkdirSync(d, { recursive: true });
  // written ten minutes ago: not "active", the loop is not running unless a test says so
  const then = new Date(now - 10 * 60_000);
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(join(d, name), text);
    utimesSync(join(d, name), then, then);
  }
  return d;
}

const agent = (pane: string, cwd: string, status = "working"): Agent => ({
  pane,
  kind: "omp",
  status,
  title: "t",
  cwd,
  workspace: "w",
});

// labels: herdr's tab/workspace labels – never ask the real herdr
const base: Deps = { prLookup: false, procs: [], agents: [], labels: new Map() };
const status = async (deps: Deps = {}) =>
  (await sandcastle({ op: "status" }, { ...base, ...deps })) as {
    runs: Run[];
    lock: { slug: string; pane: string; cwd: string | null } | null;
    grills: Grill[];
  };

beforeAll(async () => {
  Bun.env.HOME = root;
  Bun.env.HOLLR_STATE_DIR = join(root, "state");
  // project with the flat `github.*` label shape and a loop that knows the queue
  mkdirSync(join(shop, ".sandcastle"), { recursive: true });
  writeFileSync(
    join(shop, ".lul-workr.json"),
    JSON.stringify({
      project: "shop",
      repo: { slug: SLUG },
      jira: {
        baseUrl: "https://j.example/",
        projectKey: "SHOP",
        boardId: 7,
        cloudId: "c-1",
        states: {
          selected: "Selected",
          inProgress: "In Arbeit",
          testing: "Testing",
          done: "Fertig",
        },
      },
      github: { queue: "Warteschlange", story: "epic", grillTicket: "grill", nogo: "nogo" },
      engine: {
        kind: "sandcastle",
        sandcastle: {
          defaults: { agent: "opus-5", parallel: 2 },
          agents: [
            {
              key: "opus-5",
              harness: "claudeCode",
              model: "claude-opus-5",
              label: "Claude · Opus 5",
            },
          ],
        },
      },
    }),
  );
  writeFileSync(join(shop, ".sandcastle", "queue.mts"), "// hollr-sandcastle\n");
  git(shop, "init", "-q", "-b", "main");
  git(shop, "add", "-A");
  git(shop, "commit", "-q", "-m", "init");
  git(shop, "update-ref", "refs/remotes/origin/main", "HEAD");
  // second project with `github.labels.*`, a third with broken JSON
  const other = join(root, "code", "other");
  mkdirSync(other, { recursive: true });
  writeFileSync(
    join(other, ".lul-workr.json"),
    JSON.stringify({
      repo: { slug: "acme/other" },
      github: {
        labels: {
          queue: "Q",
          grillTicket: "to-grill",
          ready: "ready-for-agent",
          ciFailed: "ci-failed",
          workflow: ["release", 7, ""],
        },
      },
    }),
  );
  git(other, "init", "-q");
  const broken = join(root, "code", "broken");
  mkdirSync(broken, { recursive: true });
  writeFileSync(join(broken, ".lul-workr.json"), "{nope");
  git(broken, "init", "-q");

  git(shop, "worktree", "add", "-q", "-b", "feature/x", wt);
  logs(wt, {
    "feature-x-planner.log":
      planner(60 * 30, [{ id: "99", title: "yesterday" }]) +
      planner(50, [
        { id: "11", title: "Elf" },
        { id: "12", title: "Zwölf" },
      ]) +
      planner(30, [
        { id: "13", title: "Dreizehn" },
        { id: "14", title: "Vierzehn" },
      ]),
    "feature-x-merger.log": merger,
    "sandcastle-issue-11-implementer.log": impl(45, true),
    "sandcastle-issue-12-implementer.log": impl(45, true),
    "sandcastle-issue-13-implementer.log": impl(28, true),
    "sandcastle-issue-13-reviewer.log": impl(25, true, "Error: vitest failed (3 tests)\n"),
    "sandcastle-issue-14-implementer.log": impl(26, false),
  });
});

afterAll(() => {
  Bun.env.HOME = saved.HOME;
  if (saved.HOLLR_STATE_DIR === undefined) delete Bun.env.HOLLR_STATE_DIR;
  else Bun.env.HOLLR_STATE_DIR = saved.HOLLR_STATE_DIR;
  rmSync(root, { recursive: true, force: true });
});

describe("projects", () => {
  test("main checkouts with both label shapes, jira and agents; broken JSON names the error", async () => {
    const { projects } = (await sandcastle({ op: "projects" }, base)) as { projects: Project[] };
    const p = projects.find((x) => x.slug === SLUG);
    expect(p).toMatchObject({
      name: "shop",
      root: shop,
      engine: "sandcastle",
      labels: {
        queue: "Warteschlange",
        story: "epic",
        grill: "grill",
        ready: null,
        ciFailed: null,
        nogo: "nogo",
        workflow: [],
      },
      jira: {
        baseUrl: "https://j.example",
        projectKey: "SHOP",
        boardId: "7",
        cloudId: "c-1",
        states: {
          selected: "Selected",
          inProgress: "In Arbeit",
          testing: "Testing",
          done: "Fertig",
        },
      },
      agents: [
        { key: "opus-5", label: "Claude · Opus 5", harness: "claudeCode", model: "claude-opus-5" },
      ],
      defaults: { agent: "opus-5", parallel: 2 },
      queueSupported: true,
    });
    expect(projects.find((x) => x.slug === "acme/other")).toMatchObject({
      labels: {
        queue: "Q",
        story: "story",
        grill: "to-grill",
        ready: "ready-for-agent",
        ciFailed: "ci-failed",
        nogo: null,
        workflow: ["release"],
      },
      jira: {
        cloudId: null,
        states: { selected: null, inProgress: null, testing: null, done: null },
      },
    });
    expect(projects.find((x) => x.root.endsWith("broken"))?.error).toContain("kein gültiges JSON");
    // the worktree is no project of its own
    expect(projects.filter((x) => x.slug === SLUG)).toHaveLength(1);
  });
});

describe("status from logs", () => {
  test("an ended manual run: plan, merges, a failure with its reason, one without commits", async () => {
    const { runs, lock } = await status();
    expect(lock).toBeNull();
    const run = runs.find((r) => r.cwd === wt) as Run;
    expect(run).toMatchObject({
      slug: SLUG,
      project: "shop",
      branch: "feature/x",
      alive: false,
      status: "ended",
      source: "manual",
      pid: null,
    });
    const phase = Object.fromEntries(run.issues.map((i) => [i.n, i.phase]));
    // #99 was planned yesterday: outside the day window
    expect(phase).toEqual({ 11: "merged", 12: "merged", 13: "failed", 14: "no-commits" });
    expect(run.issues.find((i) => i.n === 13)?.reason).toBe("Error: vitest failed (3 tests)");
    expect(run.issues.find((i) => i.n === 11)?.title).toBe("Elf");
    expect(run.issues.find((i) => i.n === 13)?.logs.map((l) => l.role)).toEqual([
      "implementer",
      "reviewer",
    ]);
    expect(run.logs.map((l) => l.role).sort()).toEqual(["merger", "planner"]);
    expect(run.progress).toEqual({
      total: 4,
      merged: 2,
      failed: 2,
      active: 0,
      queued: 0,
      percent: 100,
    });
    expect(run.startedAt).toBe(at(50));
  });

  test("a running loop: process env gives the config, unmerged issues build or review", async () => {
    const proc: LoopProc = {
      pid: 4242,
      start: now - 55 * 60_000,
      args: "node tsx .sandcastle/main.mts",
      cwd: wt,
      env: { SANDCASTLE_AGENT: "opus-5", SANDCASTLE_MAX_PARALLEL: "2", SANDCASTLE_STORY_IDS: "7" },
    };
    const { runs } = await status({ procs: [proc], agents: [agent("w3:p1", wt, "blocked")] });
    const run = runs[0] as Run;
    expect(run).toMatchObject({
      cwd: wt,
      alive: true,
      pid: 4242,
      status: "waiting",
      pane: "w3:p1",
    });
    expect(run.config).toEqual({
      agent: "opus-5",
      agentLabel: "Claude · Opus 5",
      model: "claude-opus-5",
      parallel: 2,
      scope: "7",
      screencast: null,
    });
    const phase = Object.fromEntries(run.issues.map((i) => [i.n, i.phase]));
    expect(phase).toEqual({ 11: "merged", 12: "merged", 13: "reviewing", 14: "building" });
    expect(run.progress.percent).toBe(50);
  });

  test("a session still working in the folder after the loop: loop-ended", async () => {
    const { runs } = await status({ agents: [agent("w3:p1", wt)] });
    expect(runs.find((r) => r.cwd === wt)?.status).toBe("loop-ended");
  });
});

describe("log", () => {
  test("only logs the status lists", async () => {
    const path = join(wt, ".sandcastle", "logs", "sandcastle-issue-13-reviewer.log");
    const r = (await sandcastle({ op: "log", path }, base)) as { text: string; size: number };
    expect(r.text).toContain("vitest failed");
    const stray = join(
      logs(join(root, "elsewhere"), { "x-planner.log": "secret\n" }),
      "x-planner.log",
    );
    for (const p of [stray, "/etc/hosts", `${wt}/.sandcastle/logs/../../.git`])
      await expect(sandcastle({ op: "log", path: p }, base)).rejects.toThrow("keinem Lauf");
  });

  test("tail from a line start, follow from an offset, ANSI stripped, unfinished line held back", () => {
    const f = join(root, "t.log");
    writeFileSync(f, `${"a".repeat(1500)}\nzwei\n\u001b[31mdrei\u001b[0m\nvie`);
    const tail = readLogText(f, undefined, 1024);
    expect(tail.text).toBe("zwei\ndrei\n");
    expect(tail.offset).toBe(1501 + 5 + 14);
    appendFileSync(f, "r\nfünf\n");
    const more = readLogText(f, tail.offset);
    expect(more.text).toBe("vier\nfünf\n");
    expect(more.offset).toBe(more.size);
    expect(readLogText(f, more.offset).text).toBe("");
    // the file was rewritten: offset beyond its size reads the tail again
    writeFileSync(f, "neu\n");
    expect(readLogText(f, 9999)).toEqual({ text: "neu\n", offset: 4, size: 4 });
  });
});

describe("queue", () => {
  test("order and ticket flags round-trip; video implies test note and deploy; other fields stay", async () => {
    const q = join(shop, ".git", "hollr-sandcastle", "queue.json");
    mkdirSync(join(shop, ".git", "hollr-sandcastle"), { recursive: true });
    writeFileSync(q, JSON.stringify({ version: 1, order: [3], future: "bleibt" }));
    const set = await sandcastle(
      {
        op: "queue-set",
        slug: SLUG,
        order: [5, 3, 5, -1, 2.5],
        tickets: { "5": { video: true }, "3": { deploy: true } },
      },
      base,
    );
    expect(set).toEqual({
      order: [5, 3],
      tickets: {
        "5": { deploy: true, testnote: true, video: true },
        "3": { deploy: true, testnote: false, video: false },
      },
    });
    await sandcastle({ op: "queue-set", slug: SLUG, tickets: { "3": null } }, base);
    expect(await sandcastle({ op: "queue", slug: SLUG }, base)).toEqual({
      order: [5, 3],
      tickets: { "5": { deploy: true, testnote: true, video: true } },
    });
    expect(JSON.parse(readFileSync(q, "utf8")).future).toBe("bleibt");
    await expect(sandcastle({ op: "queue", slug: "acme/nope" }, base)).rejects.toThrow(
      "nicht ausgecheckt",
    );
    await expect(sandcastle({ op: "queue-set", slug: SLUG, order: "5" }, base)).rejects.toThrow(
      "order",
    );
  });

  test("effective order: stored order of queued issues, then new ones ascending", () => {
    expect(effectiveOrder([5, 9, 1], [8, 1, 3, 5])).toEqual([5, 1, 3, 8]);
    expect(effectiveOrder([5, 3], [3, 5, 7])).toEqual([5, 3, 7]);
  });
});

describe("start / release (queue mode via events)", () => {
  const pane = "w9:p1";
  const events = join(shop, ".git", "hollr-sandcastle", "events.jsonl");
  const deps: Deps = {
    ...base,
    agents: [agent(pane, shop)],
    queuedIssues: async () => [3, 5, 8],
    startSession: async () => pane,
  };

  test("starts once per machine, then tracks the loop through events.jsonl, release frees the lock", async () => {
    await expect(
      sandcastle({ op: "start", slug: SLUG, config: { agent: "opus-5.5", parallel: 1 } }, deps),
    ).rejects.toThrow("Unbekannter Agent");
    let prompt = "";
    const started = (await sandcastle(
      { op: "start", slug: SLUG, config: { agent: "opus-5", parallel: 2, deploy: false } },
      {
        ...deps,
        startSession: async (cwd, label, text) => {
          expect([cwd, label]).toEqual([shop, "Sandcastle shop"]);
          prompt = text;
          return pane;
        },
      },
    )) as { lock: { slug: string; config: { deploy: boolean } }; pane: string };
    expect(started.pane).toBe(pane);
    expect(started.lock.config.deploy).toBe(false);
    // ticket 5 asks for the test stack: no --kein-testserver
    expect(prompt).toBe("/skill:lul-workr-run-sandcastle shop opus-5 2 warteschlange");
    await expect(
      sandcastle({ op: "start", slug: SLUG, config: { agent: "opus-5", parallel: 1 } }, deps),
    ).rejects.toThrow("läuft schon ein Lauf (shop)");

    // before the loop starts: the run sits in the project root, the board's queue waiting
    let st = await status({ agents: deps.agents });
    expect(st.lock?.pane).toBe(pane);
    let run = st.runs.find((r) => r.source === "hollr") as Run;
    expect(run).toMatchObject({ cwd: shop, status: "running", pane });
    expect(run.issues.map((i) => [i.n, i.phase])).toEqual([
      [5, "queued"],
      [3, "queued"],
    ]);

    const t = new Date(Date.now() + 1000).toISOString();
    const ev = (e: Record<string, unknown>) =>
      appendFileSync(events, `${JSON.stringify({ at: t, ...e })}\n`);
    ev({ t: "loop-start", cwd: wt, branch: "feature/x", agent: "x", parallel: 2 });
    ev({ t: "picked", iteration: 1, issues: [{ id: 5, title: "Fünf" }] });
    ev({ t: "merged", issues: [5] });
    ev({ t: "loop-end", reason: "empty" });
    st = await status({ agents: deps.agents });
    expect(st.lock?.cwd).toBe(wt);
    run = st.runs.find((r) => r.source === "hollr") as Run;
    expect(run).toMatchObject({ cwd: wt, status: "loop-ended", pane });
    expect(run.issues.map((i) => [i.n, i.phase, i.title])).toEqual([
      [3, "queued", null],
      [5, "merged", "Fünf"],
    ]);
    expect(run.issues.find((i) => i.n === 5)?.flags).toEqual({
      deploy: true,
      testnote: true,
      video: true,
    });

    expect(await sandcastle({ op: "release" }, deps)).toEqual({ lock: null });
    expect((await status({ agents: deps.agents })).lock).toBeNull();
  });

  test("a closed session ends the lock", async () => {
    await sandcastle({ op: "start", slug: SLUG, config: { agent: "opus-5", parallel: 1 } }, deps);
    expect((await status({ agents: [] })).lock).toBeNull();
  });

  test("checks: empty queue", async () => {
    await expect(
      sandcastle(
        { op: "start", slug: SLUG, config: { agent: "opus-5", parallel: 1 } },
        { ...deps, queuedIssues: async () => [] },
      ),
    ).rejects.toThrow("Warteschlange ist leer");
  });

  test("explicit tickets go to the front of the queue; stop sends Ctrl-C and frees the lock", async () => {
    const sent: [string, string[]][] = [];
    await sandcastle(
      { op: "start", slug: SLUG, config: { agent: "opus-5", parallel: 1 }, tickets: [8, 3] },
      deps,
    );
    expect(
      (await sandcastle({ op: "queue", slug: SLUG }, deps)) as { order: number[] },
    ).toMatchObject({
      order: [8, 3, 5],
    });
    expect(
      await sandcastle(
        { op: "stop" },
        { ...deps, sendKeys: async (p, k) => void sent.push([p, k]) },
      ),
    ).toEqual({ lock: null });
    expect(sent).toEqual([[pane, ["ctrl+c"]]]);
    expect((await status({ agents: deps.agents })).lock).toBeNull();
    await expect(sandcastle({ op: "stop" }, deps)).rejects.toThrow("kein Lauf");
    await expect(
      sandcastle(
        { op: "start", slug: SLUG, config: { agent: "opus-5", parallel: 1 }, tickets: [1, "x"] },
        deps,
      ),
    ).rejects.toThrow("tickets muss");
  });
});

describe("grills", () => {
  // the real STATUS.md of TENDR-1070, in the project root
  const md = [
    "# TENDR-1070 Grill-Status",
    "",
    "Grill-Ticket: #3533",
    "",
    "- [x] 1 Ticket gelesen (keine Kommentare)",
    "- [x] 2 Grill (3 Runden, Ergebnis #3533 Kommentar 7096554391)",
    "- [x] 3 Jira-Kommentar 42640, #3533 geschlossen",
    "- [x] 4 Spec/ADR-PR #3539 gemergt (…)",
    "- [ ] 5 Entwurf",
    "- [ ] 6 Story/Kinder",
    "- [ ] 7 Bericht",
    "- [ ] 5 Entwurf läuft (Agent EntwurfBelegExport)",
    "- Entwurf: Exporte v285, Dialog v286 abgenommen bis auf Kalender; …",
  ].join("\n");
  const sessions: { cwd: string; label: string; prompt: string }[] = [];
  const deps: Deps = {
    ...base,
    agents: [agent("w5:p1", shop, "blocked")],
    labels: new Map([["w5:p1", ["1", "Grill TENDR-1070 · #3533"]]]),
    startSession: async (cwd, label, prompt) => {
      sessions.push({ cwd, label, prompt });
      return `w6:p${sessions.length}`;
    },
  };

  test("status lists the STATUS.md grill with its labelled pane; the worktree's grill without one", async () => {
    mkdirSync(join(shop, ".scratch", "TENDR-1070"), { recursive: true });
    writeFileSync(join(shop, ".scratch", "TENDR-1070", "STATUS.md"), md);
    mkdirSync(join(wt, ".scratch", "SHOP-9"), { recursive: true });
    writeFileSync(join(wt, ".scratch", "SHOP-9", "STATUS.md"), "# Grill\n- [x] 1 gelesen\n");
    const { grills } = await status(deps);
    expect(grills.map((g) => [g.id, g.status, g.step, g.pane, g.mode])).toEqual([
      ["acme/shop#3533", "waiting", 5, "w5:p1", "interactive"],
      [`${wt}|SHOP-9`, "ended", 2, null, null],
    ]);
    expect(grills[0]).toMatchObject({
      slug: SLUG,
      project: "shop",
      key: "TENDR-1070",
      source: "manual",
      cwd: shop,
    });
  });

  test("grill-start: checks, refuses a live grill, opens the session and records it", async () => {
    const start = (req: Record<string, unknown>, d: Deps = deps) =>
      sandcastle({ op: "grill-start", slug: SLUG, ...req }, d) as Promise<{ grill: Grill }>;
    await expect(start({ slug: "acme/none", n: 1, mode: "auto" })).rejects.toThrow(
      "nicht ausgecheckt",
    );
    await expect(start({ n: -1, mode: "auto" })).rejects.toThrow("ganze Zahl ab 1");
    await expect(start({ n: 1, key: "x-1", mode: "auto" })).rejects.toThrow("kein JIRA-Schlüssel");
    await expect(start({ n: 1, mode: "interactive", advisor: "m" })).rejects.toThrow(
      "nur beim Auto-Grillen",
    );
    await expect(start({ n: 3533, key: "TENDR-1070", mode: "auto" })).rejects.toThrow(
      /Für #3533 läuft schon ein Grill \(.+\)\./,
    );
    expect(sessions).toHaveLength(0);

    const { grill } = await start({ n: 41, key: "SHOP-41", mode: "auto", advisor: "gpt-5.5" });
    expect(sessions[0]).toEqual({
      cwd: shop,
      label: "Auto-Grill SHOP-41 · #41",
      prompt: "/skill:lul-workr-auto-grill-jira-ticket SHOP-41 --advisor=gpt-5.5",
    });
    expect(grill).toMatchObject({
      id: "acme/shop#41",
      slug: SLUG,
      project: "shop",
      n: 41,
      key: "SHOP-41",
      mode: "auto",
      source: "hollr",
      pane: "w6:p1",
      status: "running",
      step: 1,
      cwd: null,
    });
    const second = await start({ n: 42, key: null, mode: "interactive" });
    expect(sessions[1]).toMatchObject({
      label: "Grill #42",
      prompt: "/skill:lul-workr-grill-jira-ticket #42",
    });
    expect(second.grill).toMatchObject({ id: "acme/shop#42", mode: "interactive", pane: "w6:p2" });

    const records = JSON.parse(
      readFileSync(join(root, "state", "sandcastle", "grills.json"), "utf8"),
    );
    expect(
      records.map((r: { n: number; advisor: string | null; pane: string }) => [
        r.n,
        r.advisor,
        r.pane,
      ]),
    ).toEqual([
      [41, "gpt-5.5", "w6:p1"],
      [42, null, "w6:p2"],
    ]);

    // the session idles: listed as idle; refused again; once it is closed: ended, a new start goes through
    const idle: Deps = { ...deps, agents: [agent("w6:p1", shop, "idle")] };
    const st = await status(idle);
    expect(st.grills.find((g) => g.n === 41)).toMatchObject({ status: "idle", source: "hollr" });
    await expect(start({ n: 41, mode: "auto" }, idle)).rejects.toThrow("läuft schon ein Grill");
    expect((await status({ ...deps, agents: [] })).grills.find((g) => g.n === 41)?.status).toBe(
      "ended",
    );
    await start({ n: 41, mode: "auto" }, { ...deps, agents: [] });
    expect(sessions).toHaveLength(3);
  });
});

describe("pure parts", () => {
  test("percent = merged + failed of all, rounded", () => {
    const issues = (...phases: RunIssue["phase"][]) =>
      phases.map((phase, n) => ({ n, title: null, phase, reason: null, logs: [], flags: null }));
    expect(progressOf([]).percent).toBe(0);
    expect(progressOf(issues("merged", "failed", "building")).percent).toBe(67);
    expect(
      progressOf(issues("merged", "no-commits", "queued", "planned", "reviewing", "building")),
    ).toEqual({
      total: 6,
      merged: 1,
      failed: 1,
      active: 2,
      queued: 2,
      percent: 33,
    });
  });

  test("planner plans, merger merges, error lines, sections since", () => {
    const text =
      planner(5, [{ id: "3537", title: "A" }]) + planner(90, [{ id: "1", title: "alt" }]);
    expect([...plannedIssues(sectionsSince(text, now - 10 * 60_000)).entries()]).toEqual([
      [3537, "A"],
    ]);
    expect([...mergedIssues(merger)].sort()).toEqual([11, 12]);
    expect(lastErrorLine("ok\nBash(grep error x)\nfatal: no merge base\nfertig\n")).toBe(
      "fatal: no merge base",
    );
    expect(sectionsSince("no markers", now)).toBe("no markers");
  });

  test("ps lines and environments", () => {
    const ps = [
      "  101 Mon Nov 23 10:00:42 2026 node /x/tsx/dist/cli.mjs .sandcastle/main.mts",
      "  102 Mon Nov  3 09:00:00 2026 node /p/.yarn/releases/yarn-4.18.1.cjs sandcastle",
      "  103 Mon Nov 23 10:00:42 2026 /Users/m/.local/bin/hollr /hollr/plugins/sandcastle/server.ts",
      "  104 Mon Nov 23 10:00:42 2026 node yarn.cjs sandcastle:build-image",
    ].join("\n");
    expect(parsePs(ps, 0).map((p) => p.pid)).toEqual([101, 102]);
    expect(parsePs(ps, 0)[0]?.start).toBe(Date.parse("Mon Nov 23 10:00:42 2026"));
    expect(
      sandcastleEnv("101 node x PATH=/bin SANDCASTLE_AGENT=opus-5 SANDCASTLE_MAX_PARALLEL=3"),
    ).toEqual({
      SANDCASTLE_AGENT: "opus-5",
      SANDCASTLE_MAX_PARALLEL: "3",
    });
    expect(sandcastleEnv("A=1\0SANDCASTLE_STORY_IDS=queue\0")).toEqual({
      SANDCASTLE_STORY_IDS: "queue",
    });
  });

  test("events: since filter, later merge wins over failure, broken line skipped", () => {
    const line = (e: Record<string, unknown>) => JSON.stringify(e);
    const p = parseProgress(
      [
        line({ t: "picked", at: "2026-01-01T09:00:00Z", issues: [{ id: 1, title: "alt" }] }),
        line({ t: "loop-start", at: "2026-01-01T10:00:00Z", cwd: "/w", branch: "b" }),
        line({ t: "picked", at: "2026-01-01T10:01:00Z", issues: [{ id: "612", title: "A" }] }),
        "{kaputt",
        line({ t: "failed", at: "2026-01-01T10:05:00Z", issue: 612, reason: "rot" }),
        line({ t: "merged", at: "2026-01-01T10:09:00Z", issues: [612] }),
        line({ t: "run-end", at: "2026-01-01T11:00:00Z", result: "ok", pr: 123 }),
      ].join("\n"),
      Date.parse("2026-01-01T10:00:00Z"),
    );
    expect([...p.picked]).toEqual([612]);
    expect([...p.merged]).toEqual([612]);
    expect(p.failed.size).toBe(0);
    expect(p.runEnd).toEqual({ result: "ok", pr: 123 });
  });

  test("config and skill prompt", () => {
    const p = { agents: [] } as unknown as Project;
    expect(() => validateConfig({ agent: "opus-5.5", parallel: 0 }, p)).toThrow("Parallelität");
    expect(() =>
      validateConfig({ agent: "custom", provider: "omp", model: "a b", parallel: 1 }, p),
    ).toThrow("Modell");
    const custom = validateConfig(
      { agent: "custom", provider: "cursor", model: "composer-2", parallel: 3, screencast: true },
      p,
    );
    expect(skillPrompt("tendr", custom, false)).toBe(
      "/skill:lul-workr-run-sandcastle tendr custom:cursor:composer-2 3 warteschlange --screencast",
    );
    const noDeploy = validateConfig({ agent: "opus-5.5", parallel: 1, deploy: false }, p);
    expect(skillPrompt("tendr", noDeploy, false)).toBe(
      "/skill:lul-workr-run-sandcastle tendr opus-5.5 1 warteschlange --kein-testserver",
    );
    const p2 = { agents: [], defaultBranch: "main" } as unknown as Project;
    expect(() => validateConfig({ agent: "opus-5.5", parallel: 1, branch: "-x" }, p2)).toThrow(
      "Ziel-Branch",
    );
    expect(() => validateConfig({ agent: "opus-5.5", parallel: 1, branch: "a..b" }, p2)).toThrow(
      "Ziel-Branch",
    );
    expect(
      validateConfig({ agent: "opus-5.5", parallel: 1, branch: "main" }, p2).branch,
    ).toBeNull();
    const onBranch = validateConfig(
      { agent: "opus-5.5", parallel: 1, branch: " feature/batch-1 " },
      p2,
    );
    expect(skillPrompt("tendr", onBranch, true)).toBe(
      "/skill:lul-workr-run-sandcastle tendr opus-5.5 1 warteschlange --ziel-branch feature/batch-1",
    );
  });

  test("a loop without queue mode gets the queued tickets as stories and stand-alone issues", () => {
    const parents = new Map<number, number | null>([
      [3601, 3600],
      [3602, 3600],
      [2356, null],
      [3701, 3700],
    ]);
    expect(fixedScope([3601, 2356, 3602, 3701], parents)).toEqual([3600, 2356, 3700]);
    expect(parentOf("## Parent\n\n- #3600 Story\n\n## Was zu tun ist\n- #12")).toBe(3600);
    expect(parentOf("## Was zu tun ist\n- #12")).toBeNull();
    const cfg = validateConfig({ agent: "opus-5.5", parallel: 1, deploy: false }, {
      agents: [],
    } as unknown as Project);
    expect(skillPrompt("tendr", cfg, false, [3600, 2356])).toBe(
      "/skill:lul-workr-run-sandcastle tendr opus-5.5 1 3600,2356 --batch --kein-testserver",
    );
  });
});
