import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Flow, foldFlow, GRILL_STAGES } from "../src/flows";
import {
  type CollectInput,
  collectGrills,
  flowSteps,
  type GrillRecord,
  grillLabel,
  grillPrompt,
  parseGrillLabel,
  readGrillRecords,
  recordGrill,
  validateGrillRequest,
} from "../src/grills";
import type { Agent } from "../src/herdr";

const root = mkdtempSync(join(tmpdir(), "hollr-grills-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** One Ablauf-Log line as flow-event.mjs writes it. */
let seq = 0;
const ev = (
  type: string,
  data: Record<string, unknown>,
  ts: string,
  ticket = "TT-1",
  id = "tt-1-grill",
) =>
  JSON.stringify({
    v: 1,
    id: `e${++seq}`,
    seq,
    ts,
    project: "r",
    flow: { kind: "skill", id },
    ticket,
    source: "skill:lul-workr-grill-jira-ticket",
    type,
    data,
  });

describe("grill flows", () => {
  test("stages are the 7 steps; done = ok or skipped; current = first not done; re-entry restarts a stage", () => {
    const t = (m: number) => `2026-11-25T09:${String(m).padStart(2, "0")}:00Z`;
    const lines = [
      ev("flow.started", { kind: "skill", skill: "grill", issue: 11 }, t(0)),
      ev("stage.started", { stage: "read" }, t(1)),
      ev("stage.ended", { stage: "read", outcome: "ok" }, t(2)),
      ev("stage.started", { stage: "grill", path: "diagnose" }, t(3)),
      ev("flow.paused", { reason: "wartet auf Antworten an #11" }, t(4)),
    ];
    const f = foldFlow(lines.join("\n"), "skill-tt-1-grill.ndjson");
    expect(f).toMatchObject({
      kind: "skill",
      skill: "grill",
      issue: 11,
      ticket: "TT-1",
      outcome: null,
    });
    expect(f.stages.map((s) => s.stage)).toEqual([...GRILL_STAGES]);
    expect(f.paused).toBe("wartet auf Antworten an #11");
    expect(flowSteps(f).step).toBe(2);

    foldFlow(
      [
        ev("flow.resumed", {}, t(5)),
        ev("stage.ended", { stage: "grill", outcome: "ok" }, t(6)),
        ev("stage.ended", { stage: "jira-comment", outcome: "ok" }, t(7)),
        ev("stage.ended", { stage: "spec", outcome: "ok" }, t(8)),
        ev(
          "stage.ended",
          { stage: "design", outcome: "skipped", reason: "kein design-Abschnitt" },
          t(9),
        ),
        // re-entry announces a done stage again
        ev("stage.started", { stage: "spec" }, t(10)),
      ].join("\n"),
      f.file,
      f,
    );
    expect(f.paused).toBeNull();
    const mid = flowSteps(f);
    expect(mid.steps.map((s) => [s.n, s.label, s.state, s.done])).toEqual([
      [1, "Ticket gelesen", "ok", true],
      [2, "Grill", "ok", true],
      [3, "JIRA-Kommentar", "ok", true],
      [4, "Spec/ADR-PR", "running", false],
      [5, "Entwürfe", "skipped", true],
      [6, "Story & Kinder", "pending", false],
      [7, "Bericht", "pending", false],
    ]);
    expect(mid.step).toBe(4);
    expect(mid.steps[4]?.reason).toBe("kein design-Abschnitt");

    foldFlow(
      [
        ev("stage.ended", { stage: "spec", outcome: "ok" }, t(11)),
        ev("stage.ended", { stage: "story", outcome: "ok" }, t(12)),
        ev("stage.ended", { stage: "report", outcome: "ok" }, t(13)),
        ev("flow.ended", { outcome: "ok" }, t(14)),
      ].join("\n"),
      f.file,
      f,
    );
    expect(flowSteps(f).step).toBe(8);
    expect(f.outcome).toBe("ok");
  });

  test("a back-filled old grill: stage.ended without stage.started", () => {
    const f = foldFlow(
      [
        ev(
          "flow.started",
          { kind: "skill", skill: "auto-grill", issue: null },
          "2026-11-25T10:00:00Z",
        ),
        ev("stage.ended", { stage: "read", outcome: "ok" }, "2026-11-25T10:00:01Z"),
        ev("stage.ended", { stage: "grill", outcome: "ok" }, "2026-11-25T10:00:02Z"),
      ].join("\n"),
      "skill-x.ndjson",
    );
    expect(flowSteps(f).step).toBe(3);
    expect(f.issue).toBeNull();
  });
});

describe("labels, prompts, requests", () => {
  test("label round trip, key-only labels, others", () => {
    expect(grillLabel({ mode: "interactive", key: "TENDR-1071", n: 3551 })).toBe(
      "Grill TENDR-1071 · #3551",
    );
    expect(grillLabel({ mode: "auto", key: null, n: 7 })).toBe("Auto-Grill #7");
    expect(parseGrillLabel("Grill TENDR-1071 · #3551")).toEqual({
      mode: "interactive",
      key: "TENDR-1071",
      n: 3551,
    });
    expect(parseGrillLabel("Auto-Grill #7")).toEqual({ mode: "auto", key: null, n: 7 });
    expect(parseGrillLabel("Auto-Grill TENDR-9")).toEqual({
      mode: "auto",
      key: "TENDR-9",
      n: null,
    });
    for (const no of ["Grill", "Grill TENDR-1 #3", "TENDR-1069-zeitraumkalender", "grill #3"])
      expect(parseGrillLabel(no)).toBeNull();
  });

  test("prompts", () => {
    expect(grillPrompt({ mode: "interactive", key: "TENDR-1071", n: 3551, advisor: null })).toBe(
      "/skill:lul-workr-grill-jira-ticket TENDR-1071",
    );
    expect(grillPrompt({ mode: "auto", key: null, n: 7, advisor: "gpt-5.5" })).toBe(
      "/skill:lul-workr-auto-grill-jira-ticket #7 --advisor=gpt-5.5",
    );
  });

  test("validation", () => {
    expect(validateGrillRequest({ n: 3, key: null, mode: "auto", advisor: "a/b:c" })).toEqual({
      n: 3,
      key: null,
      mode: "auto",
      advisor: "a/b:c",
    });
    expect(() => validateGrillRequest({ n: 0, mode: "auto" })).toThrow("ganze Zahl ab 1");
    expect(() => validateGrillRequest({ n: 1.5, mode: "auto" })).toThrow("ganze Zahl ab 1");
    expect(() => validateGrillRequest({ n: 3, key: "tendr-1", mode: "auto" })).toThrow(
      "kein JIRA-Schlüssel",
    );
    expect(() => validateGrillRequest({ n: 3, mode: "x" })).toThrow("Unbekannter Modus");
    expect(() => validateGrillRequest({ n: 3, mode: "interactive", advisor: "m" })).toThrow(
      "nur beim Auto-Grillen",
    );
    expect(() => validateGrillRequest({ n: 3, mode: "auto", advisor: "a b" })).toThrow("Advisor");
  });

  test("grills.json keeps 14 days and at most 200", () => {
    const file = join(root, "state", "grills.json");
    const now = Date.parse("2026-11-23T12:00:00Z");
    const rec = (n: number, daysAgo: number): GrillRecord => ({
      slug: "o/r",
      n,
      key: null,
      mode: "auto",
      advisor: null,
      pane: `w1:p${n}`,
      startedAt: new Date(now - daysAgo * 864e5).toISOString(),
    });
    recordGrill(file, rec(1, 15), now);
    recordGrill(file, rec(2, 1), now);
    expect(readGrillRecords(file).map((r) => r.n)).toEqual([2]);
    for (let n = 3; n < 210; n++) recordGrill(file, rec(n, 0), now);
    const all = readGrillRecords(file);
    expect(all).toHaveLength(200);
    expect(all.at(-1)?.n).toBe(209);
    expect(JSON.parse(readFileSync(file, "utf8"))).toHaveLength(200);
  });
});

describe("discovery", () => {
  const now = Date.now();
  const at = (hoursAgo: number, plusMin = 0) =>
    new Date(now - hoursAgo * 3600_000 + plusMin * 60_000).toISOString();
  const a = join(root, "a");
  const agent = (pane: string, cwd: string, st = "idle"): Agent => ({
    pane,
    kind: "omp",
    status: st,
    title: "t",
    cwd,
    workspace: "w",
  });
  /** a grill flow of `key`/#n, started `hoursAgo`, with `done` steps ended ok, then `extra` lines */
  const flow = (
    key: string,
    n: number | null,
    hoursAgo: number,
    done: number,
    extra: string[] = [],
    skill = "grill",
  ): Flow => {
    const id = `${key.toLowerCase()}-grill-${hoursAgo}`;
    const lines = [ev("flow.started", { kind: "skill", skill, issue: n }, at(hoursAgo), key, id)];
    GRILL_STAGES.slice(0, done).forEach((stage, i) => {
      lines.push(ev("stage.ended", { stage, outcome: "ok" }, at(hoursAgo, i + 1), key, id));
    });
    lines.push(
      // the extra lines were made first: give them this flow and a seq after its stages
      ...extra.map((x) =>
        x
          .replace(/"flow":\{[^}]*\}/, `"flow":{"kind":"skill","id":"${id}"}`)
          .replace(/"seq":\d+/, `"seq":${++seq}`),
      ),
    );
    return foldFlow(lines.join("\n"), `skill-${id}.ndjson`);
  };
  const input = (over: Partial<CollectInput>): CollectInput => ({
    flows: [],
    agents: [],
    labels: new Map(),
    records: [],
    projectOf: () => ({ slug: "o/r", name: "r" }),
    nameOf: () => "r",
    now,
    ...over,
  });
  const of = (...flows: Flow[]) => flows.map((f) => ({ slug: "o/r", name: "r", root: a, flow: f }));

  test("flows: newest per ticket, done for a day, a week back, grills only, steps from stages", () => {
    const ended = ev("flow.ended", { outcome: "ok" }, at(2, 30), "TT-3");
    const g = collectGrills(
      input({
        flows: of(
          flow("TT-1", 11, 5, 1),
          flow("TT-1", 11, 1, 2),
          flow("TT-2", 22, 30, 7, [ev("flow.ended", { outcome: "ok" }, at(29), "TT-2")]), // done, older than a day
          flow("TT-3", 33, 3, 7, [ended]), // done today
          flow("TT-4", 44, 24 * 8, 1), // older than 7 days
          flow("TT-5", 55, 1, 1, [], "bauweg"), // not a grill
          flow("TT-6", 66, 3, 0, [
            ev("flow.ended", { outcome: "aborted", reason: "x" }, at(2), "TT-6"),
          ]),
        ),
      }),
    );
    expect(g.map((x) => [x.id, x.key, x.status, x.step, x.flow])).toEqual([
      ["o/r#11", "TT-1", "ended", 3, "tt-1-grill-1"],
      ["o/r#33", "TT-3", "done", 8, "tt-3-grill-3"],
      ["o/r#66", "TT-6", "ended", 1, "tt-6-grill-3"],
    ]);
    expect(g[0]).toMatchObject({
      project: "r",
      mode: "interactive",
      source: "manual",
      pane: null,
      cwd: a,
      paused: null,
    });
    expect(g[0]?.steps?.filter((s) => s.done).map((s) => s.n)).toEqual([1, 2]);
  });

  test("status: working pane runs, blocked pane or a paused flow waits with its reason", () => {
    const paused = flow("TT-7", 77, 1, 1, [
      ev("flow.paused", { reason: "wartet auf Antworten an #77" }, at(0), "TT-7"),
    ]);
    const g = collectGrills(
      input({
        flows: of(paused, flow("TT-8", 88, 1, 3), flow("TT-9", 99, 1, 3)),
        agents: [agent("w1:p1", a, "working"), agent("w2:p1", a, "blocked")],
        labels: new Map([
          ["w1:p1", ["Grill TT-7 · #77"]],
          ["w2:p1", ["Grill TT-8 · #88"]],
        ]),
      }),
    );
    const by = new Map(g.map((x) => [x.id, x]));
    // the pane works (it reads the answers): running, the reason stays readable
    expect(by.get("o/r#77")).toMatchObject({
      status: "running",
      paused: "wartet auf Antworten an #77",
      step: 2,
    });
    expect(by.get("o/r#88")).toMatchObject({ status: "waiting", paused: null, step: 4 });
    // no session, paused: waiting on the human all the same
    const alone = collectGrills(input({ flows: of(paused) }));
    expect(alone[0]).toMatchObject({
      status: "waiting",
      pane: null,
      paused: "wartet auf Antworten an #77",
    });
  });

  test("panes and records without a flow: steps unknown, never guessed", () => {
    const g = collectGrills(
      input({
        flows: of(flow("TT-6", 66, 3, 1)),
        agents: [
          agent("w1:p1", root, "working"),
          agent("w2:p1", a, "blocked"),
          agent("w3:p1", a, "idle"),
          agent("w4:p1", root, "idle"),
        ],
        labels: new Map([
          ["w1:p1", ["1", "Auto-Grill TT-1 · #11"]],
          // key-only label: the flow of that ticket
          ["w2:p1", ["Grill TT-6", "ws"]],
          // hand-started in the flow's checkout, the label names the ticket
          ["w3:p1", ["TT-6-hand", "tendr"]],
          ["w4:p1", ["1", "Grill #99"]],
        ]),
        records: [
          {
            slug: "o/r",
            n: 99,
            key: null,
            mode: "interactive",
            advisor: null,
            pane: "w4:p1",
            startedAt: new Date(now - 3600_000).toISOString(),
          },
          {
            slug: "o/r",
            n: 77,
            key: "TT-77",
            mode: "auto",
            advisor: null,
            pane: "w9:p9",
            startedAt: new Date(now - 60_000).toISOString(),
          },
          {
            slug: "o/r",
            n: 55,
            key: null,
            mode: "auto",
            advisor: null,
            pane: "w9:p8",
            startedAt: new Date(now - 3 * 864e5).toISOString(),
          },
        ],
      }),
    );
    const by = new Map(g.map((x) => [x.id, x]));
    expect(
      g
        .slice(0, 2)
        .map((x) => x.id)
        .sort(),
    ).toEqual(["o/r#11", "o/r#66"]);
    expect(by.get("o/r#11")).toMatchObject({
      status: "running",
      mode: "auto",
      pane: "w1:p1",
      steps: null,
      step: null,
      flow: null,
    });
    expect(by.get("o/r#66")).toMatchObject({
      status: "waiting",
      mode: "interactive",
      pane: "w2:p1",
      step: 2,
    });
    expect(by.get("o/r#99")).toMatchObject({
      status: "idle",
      source: "hollr",
      mode: "interactive",
      pane: "w4:p1",
      cwd: null,
      steps: null,
      step: null,
    });
    expect(by.get("o/r#77")).toMatchObject({
      status: "ended",
      source: "hollr",
      key: "TT-77",
      steps: null,
    });
    expect(by.has("o/r#55")).toBe(false);

    // without the labelled pane, the hand-started one in the checkout is found by its label
    const hand = collectGrills(
      input({
        flows: of(flow("TT-6", 66, 3, 1)),
        agents: [agent("w3:p1", a, "idle")],
        labels: new Map([["w3:p1", ["TT-6-hand"]]]),
      }),
    );
    expect(hand[0]).toMatchObject({ id: "o/r#66", pane: "w3:p1", status: "idle" });
  });
});
