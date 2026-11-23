import { describe, expect, test } from "bun:test";
import { type DriftConfig, deriveState, families, type GhIssue, planApply, ticketDrift } from "../src/drift";
import type { JiraTicket } from "../src/jira";
import { project } from "./fixtures";

const labels = project().labels;
const cfg: DriftConfig = {
  labels,
  states: project().jira.states,
  statuses: [
    { name: "Backlog", category: "new" },
    { name: "Selected", category: "new" },
    { name: "In Progress", category: "indeterminate" },
    { name: "Testing", category: "indeterminate" },
    { name: "Blocked", category: "indeterminate" },
    { name: "Done", category: "done" },
  ],
};

const gh = (number: number, over: Partial<GhIssue> = {}): GhIssue => ({
  number,
  title: `#${number}`,
  state: "open",
  labels: [],
  parent: null,
  jira: null,
  ...over,
});

const ticket = (status: string, over: Partial<JiraTicket> = {}): JiraTicket => ({
  key: "R-1",
  summary: "S",
  status,
  category: status === "Done" ? "done" : ["Backlog", "Selected"].includes(status) ? "new" : "indeterminate",
  labels: [],
  assignee: null,
  type: "Story",
  subtask: false,
  epic: null,
  parent: null,
  priority: null,
  created: "",
  updated: "",
  ...over,
});

const familyOf = (issues: GhIssue[], live?: Map<number, string>) => families(issues, labels, live).byKey.get("R-1");

describe("families", () => {
  test("children inherit the key from their story; keyless roots are reported once", () => {
    const f = families(
      [
        gh(1, { jira: "R-1", labels: ["grillTicket"], state: "closed" }),
        gh(2, { jira: "R-1", labels: ["story"] }),
        gh(3, { parent: 2 }),
        gh(4, { parent: 2, jira: "R-1" }),
        gh(5, { labels: ["story"] }),
        gh(6, { parent: 5 }),
        gh(7),
        gh(8, { state: "closed" }),
      ],
      labels,
      new Map([[3, "building"]]),
    );
    expect(f.byKey.get("R-1")).toEqual({
      grill: { n: 1, title: "#1", state: "closed", labels: ["grillTicket"] },
      story: { n: 2, title: "#2", state: "open", labels: ["story"] },
      children: [
        { n: 3, title: "#3", state: "open", labels: [], phase: "building" },
        { n: 4, title: "#4", state: "open", labels: [] },
      ],
    });
    expect(f.unlinked.map((m) => m.n)).toEqual([7, 5]);
  });

  test("of two stories the open one wins, else the newer", () => {
    expect(
      familyOf([gh(2, { jira: "R-1", labels: ["story"] }), gh(9, { jira: "R-1", labels: ["story"], state: "closed" })])
        ?.story?.n,
    ).toBe(2);
    expect(familyOf([gh(2, { jira: "R-1", labels: ["story"] }), gh(9, { jira: "R-1", labels: ["story"] })])?.story?.n).toBe(9);
  });
});

describe("deriveState", () => {
  const f = (issues: GhIssue[], live?: Map<number, string>) => {
    const fam = familyOf(issues, live);
    if (!fam) throw new Error("no family");
    return deriveState(fam, labels);
  };
  test("open grill ticket alone implies nothing", () => {
    expect(f([gh(1, { jira: "R-1", labels: ["grillTicket"] })])).toBeNull();
  });
  test("grill finished with a story → inProgress; story with the grill still open → nothing", () => {
    expect(f([gh(1, { jira: "R-1", labels: ["grillTicket"], state: "closed" }), gh(2, { jira: "R-1", labels: ["story"] })])).toBe(
      "inProgress",
    );
    expect(f([gh(1, { jira: "R-1", labels: ["grillTicket"] }), gh(2, { jira: "R-1", labels: ["story"] })])).toBeNull();
  });
  test("a queued or picked child → inProgress", () => {
    const grill = gh(1, { jira: "R-1", labels: ["grillTicket"] });
    expect(f([grill, gh(3, { jira: "R-1", labels: ["Sandcastle"] })])).toBe("inProgress");
    expect(f([grill, gh(3, { jira: "R-1" })], new Map([[3, "planned"]]))).toBe("inProgress");
    expect(f([grill, gh(3, { jira: "R-1" })], new Map([[3, "queued"]]))).toBeNull();
  });
  test("story and all children closed → testing", () => {
    const story = gh(2, { jira: "R-1", labels: ["story"], state: "closed" });
    expect(f([story, gh(3, { parent: 2, state: "closed" })])).toBe("testing");
    expect(f([story, gh(3, { parent: 2 })])).toBe("inProgress");
  });
});

describe("ticketDrift", () => {
  test("forward only: a ticket further on is never pulled back", () => {
    const fam = familyOf([gh(2, { jira: "R-1", labels: ["story"] })]);
    expect(ticketDrift(ticket("Selected"), fam, cfg).drift).toEqual([
      { kind: "state-behind", expected: "In Progress", actual: "Selected" },
    ]);
    expect(ticketDrift(ticket("Testing"), fam, cfg).drift).toEqual([]);
    expect(ticketDrift(ticket("Blocked"), fam, cfg).drift).toEqual([]);
    expect(ticketDrift(ticket("Done"), fam, cfg).drift).toEqual([]);
    expect(ticketDrift(ticket("Unbekannt"), fam, cfg).drift).toEqual([]);
  });

  test("everything closed: Selected is behind testing; in Testing only done-candidate (Done is never derived)", () => {
    const fam = familyOf([gh(2, { jira: "R-1", labels: ["story"], state: "closed" }), gh(3, { parent: 2, state: "closed" })]);
    expect(ticketDrift(ticket("Selected"), fam, cfg).drift).toEqual([
      { kind: "state-behind", expected: "Testing", actual: "Selected" },
    ]);
    expect(ticketDrift(ticket("Testing"), fam, cfg)).toEqual({
      derived: "testing",
      drift: [{ kind: "done-candidate", expected: "Done", actual: "Testing" }],
    });
  });

  test("product labels on open family issues are drift; workflow labels and closed issues are left alone", () => {
    const fam = familyOf([
      gh(2, { jira: "R-1", labels: ["story", "Backend", "ready-for-agent", "Help Wanted", "wayfinder:map"] }),
      gh(3, { parent: 2, labels: ["Sandcastle", "public api", "release", "needs-triage", "bug"] }),
      gh(4, { parent: 2, state: "closed", labels: ["alt"] }),
    ]);
    // case-insensitive; a GitHub label with spaces matches its JIRA spelling with dashes
    expect(ticketDrift(ticket("In Progress", { labels: ["backend", "story", "Public-API"] }), fam, cfg).drift).toEqual([
      { kind: "label-on-gh", issue: 2, label: "Backend", inJira: true },
      { kind: "label-on-gh", issue: 3, label: "public api", inJira: true },
    ]);
    expect(ticketDrift(ticket("In Progress"), fam, cfg).drift).toEqual([
      { kind: "label-on-gh", issue: 2, label: "Backend", inJira: false },
      { kind: "label-on-gh", issue: 3, label: "public api", inJira: false },
    ]);
  });

  test("a ticket without family has no drift", () => {
    expect(ticketDrift(ticket("Selected"), undefined, cfg)).toEqual({ derived: null, drift: [] });
  });
});

describe("planApply", () => {
  test("labels JIRA lacks go there first (spaces → dashes, once), every product label comes off GitHub", () => {
    const t = ticket("Backlog");
    expect(
      planApply(
        t,
        [
          { kind: "label-on-gh", issue: 3, label: "public api", inJira: false },
          { kind: "label-on-gh", issue: 3, label: "backend", inJira: true },
          { kind: "label-on-gh", issue: 2, label: "Public API", inJira: false },
          { kind: "state-behind", expected: "Testing", actual: "Backlog" },
          { kind: "done-candidate", expected: "Done", actual: "Testing" },
          { kind: "no-key", issue: 9 },
        ],
        cfg,
      ),
    ).toEqual({
      jiraAdd: ["Public-API"],
      gh: [
        { n: 2, remove: ["Public API"] },
        { n: 3, remove: ["public api", "backend"] },
      ],
      transition: ["Selected", "In Progress", "Testing"],
    });
    expect(planApply(ticket("Selected"), [{ kind: "state-behind", expected: "In Progress" }], cfg).transition).toEqual([
      "In Progress",
    ]);
    expect(planApply(t, [{ kind: "done-candidate" }], cfg)).toEqual({ jiraAdd: [], gh: [], transition: [] });
  });
});
