import { describe, expect, test } from "bun:test";
import { tokenize } from "./filter";
import {
  assigneeLogin,
  buildLine,
  compileTickets,
  driftText,
  dropStatus,
  guardItemText,
  guardSummary,
  initials,
  issueTickets,
  openChildren,
  prText,
  statusColumn,
  ticketColumns,
  ticketLane,
} from "./tickets";
import type { JiraStatus, JiraTicket } from "./types";

const statuses: JiraStatus[] = [
  { name: "Backlog", category: "new" },
  { name: "Selected", category: "new" },
  { name: "In Progress", category: "indeterminate" },
  { name: "Testing", category: "indeterminate" },
  { name: "Done", category: "done" },
];

const ticket = (key: string, extra: Partial<JiraTicket> = {}): JiraTicket => ({
  key,
  summary: `Ticket ${key}`,
  status: "Backlog",
  category: "new",
  labels: [],
  assignee: null,
  type: "Story",
  subtask: false,
  epic: null,
  parent: null,
  priority: null,
  created: "",
  updated: "",
  url: null,
  family: { children: [] },
  derived: null,
  drift: [],
  prs: [],
  ...extra,
});

const member = (n: number, state: "open" | "closed" = "open", labels: string[] = []) => ({ n, title: `#${n}`, state, labels });

describe("columns", () => {
  test("Zu grillen before Selected, lanes after it", () => {
    expect(ticketColumns(statuses, "Selected").map((c) => c.key)).toEqual([
      "s:Backlog",
      "grill",
      "s:Selected",
      "lanes",
      "s:In Progress",
      "s:Testing",
      "s:Done",
    ]);
  });
  test("without Selected: no grill column, lanes before the first started status", () => {
    expect(ticketColumns(statuses, null).map((c) => c.key)).toEqual(["s:Backlog", "s:Selected", "lanes", "s:In Progress", "s:Testing", "s:Done"]);
    expect(ticketColumns(statuses, "Gibt es nicht").map((c) => c.kind)).not.toContain("grill");
  });
  test("Selected without a story is still to grill", () => {
    expect(statusColumn(ticket("A-1", { status: "Selected" }), "Selected")).toBe("grill");
    expect(statusColumn(ticket("A-1", { status: "Selected", family: { story: member(5), children: [] } }), "Selected")).toBe("s:Selected");
    expect(statusColumn(ticket("A-1", { status: "In Progress" }), "Selected")).toBe("s:In Progress");
  });
  test("drop target → status", () => {
    const t = ticket("A-1", { status: "Backlog" });
    expect(dropStatus("grill", t, "Selected")).toBe("Selected");
    expect(dropStatus("s:Testing", t, "Selected")).toBe("Testing");
    expect(dropStatus("s:Backlog", t, "Selected")).toBeNull();
    expect(dropStatus("lane@m1", t, "Selected")).toBeNull();
  });
});

describe("lanes", () => {
  const t = ticket("A-1", {
    status: "In Progress",
    category: "indeterminate",
    family: { story: member(10), grill: member(9), children: [member(11, "closed"), member(12), member(13)] },
  });
  test("open children only, story and grill excluded", () => {
    expect(openChildren(t)).toEqual([12, 13]);
  });
  test("lane of the first queued child, best position in that lane", () => {
    const laneOf = new Map([
      [13, "m1"],
      [12, "m1"],
    ]);
    expect(ticketLane(t, laneOf, () => [7, 13, 12])).toEqual({ server: "m1", pos: 1 });
    expect(ticketLane(t, new Map(), () => [])).toBeNull();
    expect(ticketLane({ ...t, category: "done" }, laneOf, () => [12])).toBeNull();
  });
});

describe("card facts", () => {
  test("initials and logins", () => {
    expect(initials("Martin Fink")).toBe("MF");
    expect(initials("Jonas")).toBe("JO");
    expect(initials("Anna Maria von Berg")).toBe("AB");
    expect(assigneeLogin("Martin Fink")).toBe("martin");
  });
  test("build line: text, segments and the main PR as a link", () => {
    const pr = { n: 3550, title: "Kalender", url: "https://github.com/o/r/pull/3550", state: "merged" as const, checks: null, review: null, branch: "feature/R-1", mergedAt: "2026-11-23T10:00:00Z" };
    const line = buildLine({
      story: 3540,
      children: [
        { n: 1, seg: "queued" },
        { n: 2, seg: "merged" },
        { n: 3, seg: "building" },
      ],
      run: { machine: "workr", percent: 43 },
      grill: null,
      pr,
    });
    expect(line.text).toBe("Story #3540 · Kinder 1/3 gemergt · Lauf auf workr 43 %");
    expect(line.pr).toEqual({ text: "PR #3550 gemergt", url: pr.url, state: "merged" });
    expect(line.segs).toEqual(["merged", "building", "queued"]);
    expect(buildLine({ story: null, children: [], grill: "Grill 2/7" })).toEqual({ text: "Grill 2/7", segs: [], pr: null });
    expect(buildLine({ story: null, children: [] }).text).toBe("");
  });
  test("PR texts: state, CI only while open", () => {
    expect(prText({ n: 1, state: "merged", checks: "failure" })).toBe("PR #1 gemergt");
    expect(prText({ n: 2, state: "open", checks: "failure" })).toBe("PR #2 offen · CI ✗");
    expect(prText({ n: 3, state: "open", checks: "success" })).toBe("PR #3 offen · CI ✓");
    expect(prText({ n: 4, state: "draft", checks: null })).toBe("PR #4 Entwurf");
    expect(prText({ n: 5, state: "draft", checks: "pending" })).toBe("PR #5 Entwurf · CI …");
    expect(prText({ n: 6, state: "closed", checks: null })).toBe("PR #6 geschlossen");
  });
  test("drift texts", () => {
    expect(driftText({ kind: "label-on-gh", issue: 3540, label: "kundenfeedback", inJira: true })).toBe(
      "Fach-Label kundenfeedback steht auf GitHub #3540 – gehört nur ins Ticket",
    );
    expect(driftText({ kind: "label-on-gh", issue: 3540, label: "x", inJira: false })).toContain("fehlt dort noch");
    expect(driftText({ kind: "state-behind", expected: "Testing", actual: "In Progress" }, "testing")).toBe(
      "JIRA hinkt: alle Kinder gemergt, noch In Progress",
    );
    expect(driftText({ kind: "state-behind", expected: "In Progress", actual: "Selected" }, "inProgress")).toBe(
      "JIRA hinkt: auf GitHub wird gebaut, noch Selected",
    );
    expect(driftText({ kind: "no-key", issue: 3170 })).toBe("GitHub #3170 ohne JIRA-Schlüssel");
  });
  test("GitHub issue → ticket, its labels and the drift on that issue", () => {
    const t = ticket("A-1", {
      labels: ["kunde"],
      family: { story: member(10), children: [member(11, "open", ["kunde"])] },
      drift: [{ kind: "label-on-gh", issue: 11, label: "kunde", inJira: true }, { kind: "state-behind", expected: "X", actual: "Y" }],
    });
    const map = issueTickets({ tickets: [t], unlinked: [{ ...member(20), drift: [{ kind: "no-key", issue: 20 }] }] });
    expect(map.get(10)).toEqual({ key: "A-1", labels: ["kunde"], drift: [] });
    expect(map.get(11)?.drift.map((d) => d.kind)).toEqual(["label-on-gh"]);
    expect(map.get(20)).toEqual({ key: null, labels: [], drift: [{ kind: "no-key", issue: 20 }] });
  });
});

describe("ticket filter", () => {
  const tickets = [
    ticket("HACCP-1", { labels: ["kundenfeedback"], assignee: { accountId: "a", name: "Martin Schulz", avatarUrl: null }, epic: { key: "HACCP-9", summary: "Kühlkette" } }),
    ticket("HACCP-2", {
      summary: "Lieferschein fotografieren",
      family: { story: member(600), children: [member(612)] },
      drift: [{ kind: "label-on-gh", issue: 612, label: "x", inJira: true }],
    }),
    ticket("HACCP-3", { drift: [{ kind: "done-candidate", expected: "Done", actual: "Testing" }] }),
  ];
  const run = (q: string, partialLast = false) => {
    const tokens = tokenize(q);
    const last = tokens[tokens.length - 1];
    if (partialLast && last) tokens[tokens.length - 1] = { ...last, partial: true };
    return tickets.filter(compileTickets(tokens)).map((t) => t.key);
  };
  test("labels, assignees, epic, numbers, text", () => {
    expect(run("l:kundenfeedback")).toEqual(["HACCP-1"]);
    expect(run("l:kunden", true)).toEqual(["HACCP-1"]);
    expect(run("-l:kundenfeedback")).toEqual(["HACCP-2", "HACCP-3"]);
    expect(run("@martin")).toEqual(["HACCP-1"]);
    expect(run("@schulz")).toEqual(["HACCP-1"]);
    expect(run("@ich")).toEqual([]);
    expect(run("s:HACCP-9")).toEqual(["HACCP-1"]);
    expect(run("s:kühl")).toEqual(["HACCP-1"]);
    expect(run("s:600")).toEqual(["HACCP-2"]);
    expect(run("#612")).toEqual(["HACCP-2"]);
    expect(run("haccp-3")).toEqual(["HACCP-3"]);
    expect(run("lieferschein")).toEqual(["HACCP-2"]);
  });
  test("drift: only tickets with drift to apply", () => {
    expect(run("drift:")).toEqual(["HACCP-2"]);
    expect(tokenize("drift:")[0]?.kind).toBe("drift");
  });
  test("t: types widen each other (OR) and narrow the rest (AND); Sub-Task with a dash stays one token", () => {
    const typed = [ticket("A-1", { type: "Epic" }), ticket("A-2", { type: "Story", labels: ["shop"] }), ticket("A-3", { type: "Task" }), ticket("A-4", { type: "Sub-Task" })];
    const pick = (q: string) => typed.filter(compileTickets(tokenize(q))).map((t) => t.key);
    expect(pick("t:story t:task")).toEqual(["A-2", "A-3"]);
    expect(pick("t:Story l:shop")).toEqual(["A-2"]);
    expect(pick("t:sub-task")).toEqual(["A-4"]);
    expect(pick('t:"Sub-Task" t:epic')).toEqual(["A-1", "A-4"]);
    expect(pick("-t:Epic")).toEqual(["A-2", "A-3", "A-4"]);
    expect(pick("-t:epic t:story")).toEqual(["A-2"]);
  });
  test("wildcards: l:patrick* matches every patrick-… label, ? one character, -l: and text too", () => {
    const w = [
      ticket("W-1", { labels: ["patrick-2026-10-15"] }),
      ticket("W-2", { labels: ["patrick-2026-11-12", "shop"], summary: "Rechnungskalender bauen" }),
      ticket("W-3", { labels: ["kundenfeedback"] }),
    ];
    const pick = (q: string) => w.filter(compileTickets(tokenize(q))).map((t) => t.key);
    expect(pick("l:patrick*")).toEqual(["W-1", "W-2"]);
    expect(pick("l:patrick-2026-1?-15")).toEqual(["W-1"]);
    expect(pick("-l:patrick*")).toEqual(["W-3"]);
    expect(pick("l:*feedback")).toEqual(["W-3"]);
    expect(pick("rechnung*kalender")).toEqual(["W-2"]);
    expect(pick("l:patrick")).toEqual([]);
  });
});

test("guard texts", () => {
  const now = Date.parse("2026-11-23T12:00:00Z");
  expect(guardSummary({ running: false, lastRun: null, lastResult: null }, now)).toBe("noch nie geprüft");
  expect(guardSummary({ running: true, lastRun: null, lastResult: null }, now)).toBe("prüft gerade …");
  const lastResult = { at: "", finishedAt: "", manual: false, projects: 2, tickets: 4, applied: 6, errors: 1, deferred: 0 };
  expect(guardSummary({ running: false, lastRun: "2026-11-23T11:57:00Z", lastResult }, now)).toBe("vor 3 Min. · 4 angeglichen · 1 Fehler");
  expect(guardItemText({ key: "T-5", kind: "label-on-gh", issue: 3540, label: "kunde" })).toBe("T-5: Label kunde von #3540 ins Ticket");
  expect(guardItemText({ key: "T-5", kind: "state-behind", to: "In Progress" })).toBe("T-5 → In Progress");
});
