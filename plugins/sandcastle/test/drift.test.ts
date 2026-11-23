import { describe, expect, test } from "bun:test";
import { type DriftConfig, deriveState, families, type GhIssue, inMain, planApply, ticketDrift } from "../src/drift";
import type { JiraTicket } from "../src/jira";
import { pullOut } from "../src/pulls";
import type { Pull } from "../src/types";
import { project, pull } from "./fixtures";

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

// through pullOut, so the docs flag comes from branch and title like on the board
const pr = (n: number, over: Partial<Pull> = {}) =>
  pullOut(pull(n, { state: "merged", branch: `feature/R-1-${n}`, mergedAt: "2026-11-20T10:00:00Z", ...over }));

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
  test("grill finished with a story → selected; story with the grill still open → nothing", () => {
    expect(f([gh(1, { jira: "R-1", labels: ["grillTicket"], state: "closed" }), gh(2, { jira: "R-1", labels: ["story"] })])).toBe(
      "selected",
    );
    expect(f([gh(1, { jira: "R-1", labels: ["grillTicket"] }), gh(2, { jira: "R-1", labels: ["story"] })])).toBeNull();
  });
  test("a queued child → selected; only a child picked by a run → inProgress", () => {
    const grill = gh(1, { jira: "R-1", labels: ["grillTicket"] });
    expect(f([grill, gh(3, { jira: "R-1", labels: ["Sandcastle"] })])).toBe("selected");
    expect(f([grill, gh(3, { jira: "R-1", labels: ["Sandcastle"] })], new Map([[3, "building"]]))).toBe("inProgress");
    expect(f([grill, gh(3, { jira: "R-1" })], new Map([[3, "planned"]]))).toBe("inProgress");
    expect(f([grill, gh(3, { jira: "R-1" })], new Map([[3, "queued"]]))).toBeNull();
  });
  test("story and all children closed → testing", () => {
    const story = gh(2, { jira: "R-1", labels: ["story"], state: "closed" });
    expect(f([story, gh(3, { parent: 2, state: "closed" })])).toBe("testing");
    expect(f([story, gh(3, { parent: 2 })])).toBe("selected");
  });
});

describe("ticketDrift", () => {
  test("forward only: a ticket further on is never pulled back", () => {
    const fam = familyOf([gh(2, { jira: "R-1", labels: ["story"] })]);
    expect(ticketDrift(ticket("Backlog"), fam, cfg).drift).toEqual([
      { kind: "state-behind", expected: "Selected", actual: "Backlog" },
    ]);
    expect(ticketDrift(ticket("Selected"), fam, cfg).drift).toEqual([]);
    expect(ticketDrift(ticket("In Progress"), fam, cfg).drift).toEqual([]);
    expect(ticketDrift(ticket("Testing"), fam, cfg).drift).toEqual([]);
    expect(ticketDrift(ticket("Blocked"), fam, cfg).drift).toEqual([]);
    // Done with nothing merged into main: info only, never a step backwards
    expect(ticketDrift(ticket("Done"), fam, cfg).drift).toEqual([{ kind: "done-not-in-main" }]);
    expect(ticketDrift(ticket("Unbekannt"), fam, cfg).drift).toEqual([]);
  });

  test("everything closed: Selected is behind testing; in Testing done-candidate only once it's in main (Done is never derived)", () => {
    const fam = familyOf([gh(2, { jira: "R-1", labels: ["story"], state: "closed" }), gh(3, { parent: 2, state: "closed" })]);
    expect(ticketDrift(ticket("Selected"), fam, cfg).drift).toEqual([
      { kind: "state-behind", expected: "Testing", actual: "Selected" },
    ]);
    // children closed into a feature branch alone are not in main
    expect(ticketDrift(ticket("Testing"), fam, cfg)).toEqual({ derived: "testing", drift: [], inMain: "no" });
    expect(ticketDrift(ticket("Testing"), fam, cfg, [pr(50)])).toEqual({
      derived: "testing",
      drift: [{ kind: "done-candidate", expected: "Done", actual: "Testing" }],
      inMain: "yes",
    });
  });

  test("done-not-in-main names the open build PR, else says no merged PR; null (nothing on GitHub) stays quiet", () => {
    const fam = familyOf([gh(2, { jira: "R-1", labels: ["story"], state: "closed" }), gh(3, { parent: 2, state: "closed" })]);
    const draft = pr(3550, { state: "draft", checks: "failure", mergedAt: null });
    expect(ticketDrift(ticket("Done"), fam, cfg, [draft, pr(3535, { branch: "docs/R-1-spec" })]).drift).toEqual([
      { kind: "done-not-in-main", pr: { n: 3550, state: "draft", checks: "failure" } },
    ]);
    expect(ticketDrift(ticket("Done"), fam, cfg, [pr(50), pr(51, { state: "open", mergedAt: null })]).drift).toEqual([
      { kind: "done-not-in-main", pr: { n: 51, state: "open", checks: null } },
    ]);
    expect(ticketDrift(ticket("Done"), fam, cfg, [pr(50)]).drift).toEqual([]);
    expect(ticketDrift(ticket("Done"), undefined, cfg)).toEqual({ derived: null, drift: [], inMain: null });
    expect(ticketDrift(ticket("Done"), undefined, cfg, [pr(52, { state: "closed", mergedAt: null })]).drift).toEqual([
      { kind: "done-not-in-main" },
    ]);
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
    expect(ticketDrift(ticket("Selected"), undefined, cfg)).toEqual({ derived: null, drift: [], inMain: null });
  });
});

describe("inMain", () => {
  const closed = (n: number) => gh(n, { parent: 2, state: "closed" });
  const story = gh(2, { jira: "R-1", labels: ["story"], state: "closed" });

  test("TENDR-1069 shape: children closed into the feature branch, build PR a draft, doc PR merged → no", () => {
    const fam = familyOf([story, closed(3537), closed(3538), closed(3549)]);
    const prs = [pr(3550, { state: "draft", mergedAt: null, branch: "feature/TENDR-1069-zeitraumkalender" }), pr(3535, { branch: "docs/TENDR-1069-zeitraumkalender" })];
    expect(inMain(fam, prs, "main")).toBe("no");
  });
  test("merged build PR and all children closed → yes", () => {
    expect(inMain(familyOf([story, closed(3)]), [pr(50)], "main")).toBe("yes");
  });
  test("merged build PR plus an open draft, or children still open → partly", () => {
    expect(inMain(familyOf([story, closed(3)]), [pr(50), pr(51, { state: "draft", mergedAt: null })], "main")).toBe("partly");
    expect(inMain(familyOf([story, closed(3), gh(4, { parent: 2 })]), [pr(50)], "main")).toBe("partly");
  });
  test("only build PRs count: doc PRs (docs/ branch or type docs) and PRs into other branches don't", () => {
    expect(inMain(undefined, [pr(3535, { branch: "docs/R-1-spec" })], "main")).toBeNull();
    expect(inMain(familyOf([story]), [pr(3535, { branch: "docs/R-1-spec" })], "main")).toBe("no");
    // TENDR-636 shape: spec and ADRs merged into main ahead of the build, the build PR closed unmerged
    const spec = pr(1056, { branch: "feature/R-1-lasttest-spec", title: "📝 docs: R-1 Spec und ADRs" });
    expect(inMain(undefined, [spec, pr(1060, { state: "closed", mergedAt: null, base: "feature/R-1-lasttest-spec" })], "main")).toBeNull();
    expect(inMain(familyOf([story, closed(3)]), [pr(50, { base: "feature/R-1" })], "main")).toBe("no");
    expect(inMain(undefined, [pr(50, { base: "develop" })], "develop")).toBe("yes");
    expect(inMain(undefined, [], "main")).toBeNull();
  });
  test("released: counts as in main – no done-not-in-main; done-candidate for any status short of Done", () => {
    const released = { version: "v2.0.0", at: "2026-11-13T10:00:00Z", later: [] };
    const fam = familyOf([story, closed(3)]);
    expect(ticketDrift(ticket("Done"), fam, cfg, [], released)).toEqual({ derived: "testing", drift: [], inMain: "yes" });
    expect(ticketDrift(ticket("In Progress"), undefined, cfg, [], released)).toEqual({
      derived: null,
      drift: [{ kind: "done-candidate", expected: "Done", actual: "In Progress" }],
      inMain: "yes",
    });
  });
  test("released with work still open (TENDR-662: early work shipped, the rest in a batch PR) is partly and no done-candidate", () => {
    const released = { version: "v1.4.0", at: "2026-10-09T10:00:00Z", later: [] };
    const batch = pr(3531, { title: "✨ 2026-11-21: 26 Stories", state: "draft", mergedAt: null });
    expect(ticketDrift(ticket("Testing"), familyOf([story, closed(3)]), cfg, [batch], released)).toEqual({
      derived: "testing",
      drift: [],
      inMain: "partly",
    });
    // an open child counts as open work too; merged PRs that fell out of the window don't
    expect(ticketDrift(ticket("In Progress"), familyOf([story, gh(4, { parent: 2 })]), cfg, [], released).inMain).toBe("partly");
    expect(ticketDrift(ticket("In Progress"), familyOf([story, closed(3)]), cfg, [], released).inMain).toBe("yes");
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
