import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeAskSteps, claudePromptSteps } from "../src/ask";
import {
  canonicalTool,
  claudeFooter,
  claudeLive,
  claudeProjectDir,
  claudeSessionFile,
  parseClaudeLog,
  promptAsk,
  readClaudeHistory,
} from "../src/claudelog";
import { parseClaudePrompt } from "../src/claudeprompt";
import type { TimelineItem, ToolCall } from "../src/timeline";

const FIX = join(import.meta.dir, "fixtures", "claude");
const fixture = (name: string) => Bun.file(join(FIX, name)).text();
const screen = (name: string) => Bun.file(join(FIX, "screens", name)).text();
const calls = (items: TimelineItem[]) => items.flatMap((i) => (i.k === "tools" ? i.calls : []));
const call = (items: TimelineItem[], id: string) =>
  calls(items).find((c) => c.id === id) as ToolCall;

describe("claude session file", () => {
  test("the project folder is the cwd with every non-alphanumeric made a dash", () => {
    expect(claudeProjectDir("/tmp/hollr-chatlab")).toBe("-tmp-hollr-chatlab");
    expect(claudeProjectDir("/Users/lab/.herdr/worktrees/x")).toBe("-Users-lab--herdr-worktrees-x");
    expect(claudeProjectDir("/Users/lab/leicht+luftig/tendr")).toBe(
      "-Users-lab-leicht-luftig-tendr",
    );
  });

  test("found under the cwd, its real path, or any project folder", () => {
    const root = mkdtempSync(join(tmpdir(), "hollr-claude-"));
    const projects = join(root, "projects");
    try {
      const work = join(root, "work");
      mkdirSync(work);
      const link = join(root, "link");
      symlinkSync(work, link);
      const id = "9f3aa094-ff0d-4c90-8fad-9a59222bb64b";
      // Claude files it under the real path (macOS: /tmp → /private/tmp), herdr may report the link
      const real = join(projects, claudeProjectDir(require("node:fs").realpathSync(work)));
      mkdirSync(real, { recursive: true });
      writeFileSync(join(real, `${id}.jsonl`), "");
      expect(claudeSessionFile(link, id, projects)).toBe(join(real, `${id}.jsonl`));
      expect(claudeSessionFile(work, id, projects)).toBe(join(real, `${id}.jsonl`));
      // started elsewhere (cd afterwards): any project folder with that session
      expect(claudeSessionFile("/somewhere/else", id, projects)).toBe(join(real, `${id}.jsonl`));
      // not written yet / nonsense ids
      expect(
        claudeSessionFile(work, "0b7c1e2d-0000-4000-8000-000000000000", projects),
      ).toBeUndefined();
      expect(claudeSessionFile(work, "../../etc/passwd", projects)).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("claude transcript", () => {
  test("lab session: prompt, grouped tools with output and diffs, answer, open question", async () => {
    const { timeline, usage } = parseClaudeLog(await fixture("lab.jsonl"));
    expect(timeline.agent).toBe("claude");
    expect(timeline.title).toBe("Inventory.py Fehler beheben");
    expect(timeline.model).toBe("claude-opus-5-5");
    expect(usage.context).toBeGreaterThan(50_000);
    const kinds = timeline.items.map((i) => i.k);
    expect(kinds[0]).toBe("user");
    expect(kinds.at(-1)).toBe("ask");
    // empty (redacted) thinking is left out, the readable one kept
    expect(timeline.items.filter((i) => i.k === "thinking")).toHaveLength(1);
    const first = calls(timeline.items)[0] as ToolCall;
    expect(first).toMatchObject({
      name: "bash",
      tool: "Bash",
      label: "List and print all tracked files",
      status: "ok",
    });
    expect(first.outTotal).toBeGreaterThanOrEqual(first.out?.length ?? 0);
    expect(first.out?.length).toBeLessThanOrEqual(60);
    const edits = calls(timeline.items).filter((c) => c.name === "edit");
    expect(edits.map((e) => [e.add, e.del])).toEqual([
      [8, 3],
      [23, 0],
    ]);
    expect(edits[0]?.file).toBe("/private/tmp/hollr-chatlab/inventory.py");
    // the structured patch keeps line numbers: context on both sides, "-" old, "+" new
    const lines = edits[0]?.diff?.[0]?.lines ?? [];
    expect(lines[0]).toMatchObject({ t: " ", o: 21, n: 21 });
    expect(lines.find((l) => l.t === "-")).toMatchObject({ o: 24 });
    // the question Claude asks at the end: from the log, with descriptions and header
    const ask = timeline.items.at(-1) as Extract<TimelineItem, { k: "ask" }>;
    expect(ask).toMatchObject({
      pending: true,
      header: "Nächstes",
      question: "Welche Funktion soll als Nächstes ins Bäckerei-Inventar kommen?",
      options: ["CLI", "Preis-Report", "Mindestbestand-Warnung"],
    });
    expect(ask.descriptions?.[0]).toContain("Kommandozeile");
    // waiting for an answer is not "working"
    expect(timeline.running).toBe(false);
  });

  test("dialogs session: answers, rejections, plans", async () => {
    const { timeline } = parseClaudeLog(await fixture("dialogs.jsonl"));
    const asks = timeline.items.filter(
      (i): i is Extract<TimelineItem, { k: "ask" }> => i.k === "ask",
    );
    expect(asks.every((a) => !a.pending)).toBe(true);
    expect(asks.map((a) => a.answer)).toContain("Käse, Soße, Gurke · Blau");
    expect(asks.map((a) => a.answer)).toContain("Ein Pferd bitte");
    const multi = asks.find((a) => a.questions)?.questions?.find((q) => q.multi);
    expect(multi?.options).toEqual(["Käse", "Salat", "Soße"]);
    // a refused edit: shown with what it would have changed, the turn ends as aborted
    const refused = calls(timeline.items).find((c) => c.name === "edit" && c.status === "error");
    expect(refused).toMatchObject({ result: "abgelehnt", add: 1, del: 1 });
    expect(
      timeline.items.filter((i) => i.k === "end" && i.status === "aborted").length,
    ).toBeGreaterThan(0);
    // the plan as text, its call with the user's feedback / approval
    const plans = calls(timeline.items).filter((c) => c.name === "plan");
    expect(plans.map((p) => p.result)).toContain("abgelehnt: Bitte servus welt statt servus");
    expect(plans.map((p) => p.result)).toContain("freigegeben");
    expect(timeline.items.some((i) => i.k === "text" && i.id.endsWith(":plan"))).toBe(true);
    // Claude loading tool schemas is plumbing: not a step in the chat
    expect(calls(timeline.items).some((c) => c.tool === "ToolSearch")).toBe(false);
    // ids are unique – follow diffs by id
    const ids = timeline.items.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("tools, jobs, todos, commands, notifications, errors", async () => {
    const now = Date.parse("2026-11-01T11:00:00Z");
    const { timeline, usage } = parseClaudeLog(await fixture("features.jsonl"), 150, now);
    const items = timeline.items;
    expect(timeline.title).toBe("Aufräumen & Doku");
    expect(timeline.model).toBe("claude-sonnet-5");
    expect(claudeFooter(usage)).toEqual({ context: "42k", cost: "1.23" });
    // subagents' own lines stay out of the chat
    expect(JSON.stringify(items)).not.toContain("Subagent-Text");
    // a background subagent: its answer from the later task-notification lands on its own card
    expect(call(items, "t_agent")).toMatchObject({ name: "task", status: "ok", sub: { answer: "Ein Diagramm." } });

    expect(call(items, "t_todo")).toMatchObject({
      name: "todo",
      tool: "TodoWrite",
      detail: "0/2 erledigt",
    });
    expect(call(items, "t_todo").todo?.[0]?.tasks).toHaveLength(2);
    expect(call(items, "t_grep")).toMatchObject({
      name: "grep",
      result: "3 Treffer in 2 Dateien",
      path: "/work/app",
    });
    // matching lines only (the "-4-" context line is not one), indentation kept
    expect(call(items, "t_grep").matches).toEqual([
      { file: "/work/app/a.py", lines: [{ n: 3, text: "    # TODO: rund" }] },
      { file: "/work/app/b.py", lines: [{ n: 10, text: "# TODO tests" }] },
    ]);
    expect(call(items, "t_glob")).toMatchObject({
      name: "glob",
      files: ["/work/app/a.py", "/work/app/b.py"],
      result: "2 Dateien",
    });
    expect(call(items, "t_read")).toMatchObject({
      name: "read",
      range: "1-40/120",
      file: "/work/app/a.py",
    });
    expect(call(items, "t_medit")).toMatchObject({
      name: "edit",
      tool: "MultiEdit",
      add: 2,
      del: 2,
    });
    expect(call(items, "t_bash_err")).toMatchObject({
      status: "error",
      exit: 1,
      result: "Exit 1: Ran 2 tests ⏎ FAILED (failures=1)",
    });
    expect(call(items, "t_bash_bg")).toMatchObject({
      bg: "bash_1",
      result: "im Hintergrund · bash_1",
    });
    expect(call(items, "t_bout")).toMatchObject({ name: "wait", out: ["ready on :3000"] });
    expect(call(items, "t_task")).toMatchObject({
      name: "task",
      label: "Code prüfen",
      ms: 9000,
      sub: { answer: "a.py sieht gut aus.", calls: 3, agent: "general-purpose" },
    });
    expect(call(items, "t_ws")).toMatchObject({ name: "web_search", result: "2 Treffer" });
    expect(call(items, "t_ws").links?.[0]).toEqual({
      title: "decimal — Python docs",
      url: "https://docs.python.org/3/library/decimal.html",
    });
    expect(call(items, "t_wf")).toMatchObject({ name: "fetch", result: "200 OK" });
    // a turn's end takes Claude's own duration when it logs one
    expect(items.find((i) => i.k === "end")).toMatchObject({
      id: "end-a15",
      ms: 31000,
      status: "done",
    });

    const texts = items.map((i) => (i.k === "user" || i.k === "info" ? `${i.k}:${i.text}` : i.k));
    expect(texts).toContain("user:/model sonnet");
    expect(texts).toContain("info:Set model to Sonnet 5");
    expect(texts).toContain("user:! git status --short");
    expect(call(items, "sh-u3")).toMatchObject({ name: "bash", out: [" M a.py"], status: "ok" });
    expect(texts).toContain("user:[Bild]\nWas siehst du hier?");
    expect(texts).toContain(
      'info:Hintergrund-Job fertig: Background command "npm run build && echo ok" completed (exit code 0)',
    );
    // retries update one notice, the API error ends the turn
    expect(texts.filter((t) => t.startsWith("info:API-Fehler"))).toEqual([
      "info:API-Fehler: Connection dropped (ECONNRESET) – neuer Versuch 2/10",
    ]);
    expect(items.find((i) => i.k === "end" && i.status === "error")).toMatchObject({
      error: "API Error: Connection dropped",
    });
    // refused → aborted; the message typed meanwhile is a user message of that turn
    expect(call(items, "t_rm")).toMatchObject({ status: "error", result: "abgelehnt" });
    expect(call(items, "t_rm").out).toBeUndefined();
    expect(texts).toContain("user:doch nicht");
    expect(texts).toContain("info:Kontext wurde zusammengefasst");
    expect(texts).toContain("info:Zusammenfassung: Aufgeräumt; als Nächstes kommt die Doku.");
    expect(texts).not.toContain("user:This session is being continued");
    // jobs: the build and the agent reported in, the killed shell is gone, the monitor still runs
    expect(timeline.jobs.map((j) => j.id)).toEqual(["mon7"]);
    // TaskCreate/TaskUpdate keep the todo list
    expect(timeline.todo).toEqual([
      {
        name: "Aufgaben",
        tasks: [
          { content: "Doku schreiben", status: "completed" },
          { content: "Release bauen", status: "pending" },
        ],
      },
    ]);
    // the last call (a write waiting for permission) shows what it will write, the turn is running
    expect(call(items, "t_write")).toMatchObject({ name: "write", status: "running", add: 3 });
    expect(call(items, "t_write").diff?.[0]?.lines.map((l) => l.text)).toEqual([
      "# App",
      "",
      "Doku.",
    ]);
    expect(timeline.running).toBe(true);
    const ids = items.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("canonical names: omp's where the meaning matches, else lower case", () => {
    expect(
      [
        "Bash",
        "MultiEdit",
        "Write",
        "WebFetch",
        "Agent",
        "TaskUpdate",
        "ExitPlanMode",
        "NotebookEdit",
      ].map(canonicalTool),
    ).toEqual(["bash", "edit", "write", "fetch", "task", "todo", "plan", "notebook"]);
    expect(canonicalTool("ScheduleWakeup")).toBe("schedulewakeup");
    expect(canonicalTool("mcp__imap__imap_send_email")).toBe("mcp__imap__imap_send_email");
  });

  test("history: prompts, tools, answers (the turn's last one final)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hollr-claude-h-"));
    try {
      const file = join(dir, "s.jsonl");
      writeFileSync(file, await fixture("lab.jsonl"));
      const events = await readClaudeHistory(file, 500);
      expect(events[0]).toMatchObject({ t: "user" });
      expect(events.some((e) => e.t === "tool" && e.name === "edit")).toBe(true);
      expect(events.some((e) => e.t === "answer")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("claude dialogs on screen", () => {
  test("permission prompts: what is asked, the question and the options – not Claude's preview", async () => {
    expect(parseClaudePrompt(await screen("permission-bash.txt"))).toEqual({
      kind: "permission",
      question:
        "Bash command\nCreate empty perm-test file\ntouch /tmp/hollr-claudetest/perm-test.txt\n\nDo you want to proceed?",
      options: [
        "Yes",
        "Yes, and always allow access to /tmp/hollr-claudetest from this project",
        "Yes, and switch to auto mode · auto mode handles these prompts for you",
        "No",
      ],
      numbered: true,
      cursor: 0,
    });
    // the numbered diff preview is the pending call's card in the chat
    const edit = parseClaudePrompt(await screen("permission-edit.txt"));
    expect(edit?.kind).toBe("permission");
    expect(edit?.question).toBe("Edit file\na.py\n\nDo you want to make this edit to a.py?");
    expect(edit?.options).toHaveLength(3);
  });

  test("plan approval, folder trust, AskUserQuestion tabs", async () => {
    expect(parseClaudePrompt(await screen("plan.txt"))).toMatchObject({
      kind: "plan",
      question: "Claude has written up a plan and is ready to execute. Would you like to proceed?",
      options: [
        "Yes, and use auto mode",
        "Yes, manually approve edits",
        "Tell Claude what to change",
      ],
      textOption: 2,
    });
    expect(parseClaudePrompt(await screen("trust.txt"))).toMatchObject({
      kind: "trust",
      options: ["No, exit", "Yes, I trust this folder"],
      numbered: false,
      cursor: 0,
    });
    expect(parseClaudePrompt(await screen("ask-multi-q2.txt"))).toMatchObject({
      kind: "question",
      question: "Welche Extras?",
      options: ["Käse", "Salat", "Soße", "Type something"],
      textOption: 3,
    });
    expect(parseClaudePrompt(await screen("ask-multi-submit.txt"))?.options).toEqual([
      "Submit answers",
      "Cancel",
    ]);
    expect(parseClaudePrompt(await screen("lab-ask.txt"))?.question).toBe(
      "Welche Funktion soll als Nächstes ins Bäckerei-Inventar kommen?",
    );
  });

  test("Claude's own input box is no dialog, even with a numbered text in it", async () => {
    expect(parseClaudePrompt(await screen("idle.txt"))).toBeUndefined();
    expect(parseClaudePrompt("")).toBeUndefined();
  });

  test("live: an on-screen dialog is a pending ask, a question gone from the screen is not", async () => {
    const { timeline } = parseClaudeLog(await fixture("lab.jsonl"));
    // Claude works on: the question was answered in the terminal
    const working = claudeLive(timeline, "working");
    expect(working.items.at(-1)).toMatchObject({ k: "ask", pending: false });
    // still asking
    expect(claudeLive(timeline, "blocked", await screen("lab-ask.txt")).items.at(-1)).toMatchObject(
      { k: "ask", pending: true },
    );

    const bash = await screen("permission-bash.txt");
    const live = claudeLive(timeline, "blocked", bash);
    const perm = live.items.at(-1) as Extract<TimelineItem, { k: "ask" }>;
    expect(perm).toMatchObject({
      k: "ask",
      header: "Freigabe",
      pending: true,
      options: expect.arrayContaining(["No"]),
    });
    expect(live.running).toBe(false);
    // the id follows what is asked: the same dialog keeps it, another command gets another one
    expect(claudeLive(timeline, "blocked", bash).items.at(-1)?.id).toBe(perm.id);
    expect(
      claudeLive(timeline, "blocked", bash.replaceAll("perm-test.txt", "other.txt")).items.at(-1)
        ?.id,
    ).not.toBe(perm.id);
    // the trust check comes before any log
    const empty = { items: [], jobs: [], running: false, waiting: false };
    const trust = parseClaudePrompt(await screen("trust.txt"));
    expect(trust && promptAsk(trust, empty)).toMatchObject({
      id: "trust",
      header: "Ordner vertrauen",
      pending: true,
    });
    expect(claudeLive({ ...timeline, running: true }, "idle").running).toBe(false);
  });
});

describe("answering claude", () => {
  const q = (options: string[], multi = false) => ({
    question: "?",
    options,
    ...(multi ? { multi } : {}),
  });

  test("AskUserQuestion: a digit picks (and moves on); a lone single question needs nothing else", () => {
    expect(claudeAskSteps([q(["Hund", "Katze"])], [{ options: [1] }])).toEqual([{ keys: ["2"] }]);
    // own text: the digit of the text row only moves there, Enter sends the typed text
    expect(claudeAskSteps([q(["Hund", "Katze"])], [{ text: " Ein\nPferd " }])).toEqual([
      { keys: ["3"] },
      { text: "Ein Pferd" },
      { keys: ["enter"] },
    ]);
  });

  test("multi-select toggles digit by digit, goes on from its Next row; the review tab submits", () => {
    expect(claudeAskSteps([q(["A", "B", "C"], true)], [{ options: [2, 0] }])).toEqual([
      { keys: ["1"] },
      { keys: ["3"] },
      { keys: ["down", "down", "down", "down", "enter"] },
      { keys: ["1"] },
    ]);
    expect(
      claudeAskSteps(
        [q(["Käse", "Salat", "Soße"], true), q(["Rot", "Blau"])],
        [{ options: [0, 2], text: "Gurke" }, { options: [1] }],
      ),
    ).toEqual([
      { keys: ["1"] },
      { keys: ["3"] },
      { keys: ["down", "down", "down"] },
      { text: "Gurke" },
      { keys: ["down", "enter"] },
      { keys: ["2"] },
      { keys: ["1"] },
    ]);
    expect(() => claudeAskSteps([q(["A"])], [{ options: [1] }])).toThrow();
    expect(() => claudeAskSteps([q(["A", "B"])], [{ options: [0, 1] }])).toThrow();
  });

  test("screen dialogs: digits, arrows for the trust check, a text through the text row or after No", async () => {
    const bash = parseClaudePrompt(await screen("permission-bash.txt"));
    const plan = parseClaudePrompt(await screen("plan.txt"));
    const trust = parseClaudePrompt(await screen("trust.txt"));
    if (!bash || !plan || !trust) throw new Error("fixtures");
    expect(claudePromptSteps(bash, { options: [0] })).toEqual([{ keys: ["1"] }]);
    // no text row: refuse, then the text is the next message
    expect(claudePromptSteps(bash, { text: "lieber nicht" })).toEqual([
      { keys: ["4"] },
      { text: "lieber nicht" },
      { keys: ["enter"] },
    ]);
    expect(claudePromptSteps(plan, { text: "kürzer" })).toEqual([
      { keys: ["3"] },
      { text: "kürzer" },
      { keys: ["enter"] },
    ]);
    expect(claudePromptSteps(trust, { options: [1] })).toEqual([{ keys: ["down", "enter"] }]);
    expect(() => claudePromptSteps(trust, { text: "ja" })).toThrow();
    expect(() => claudePromptSteps(bash, { options: [4] })).toThrow();
  });
});
