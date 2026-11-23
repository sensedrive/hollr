import { describe, expect, test } from "bun:test";
import type { Family, FamilyMember } from "../src/drift";
import {
  checksState,
  closingPulls,
  isDocsPull,
  type PullNode,
  pullCloses,
  pullKeys,
  pullState,
  pullsByTicket,
  reviewState,
  toPull,
} from "../src/pulls";
import { pull } from "./fixtures";

const node = (over: Partial<PullNode> = {}): PullNode => ({
  number: 3550,
  title: "✨ TENDR-1069: Zeitraumkalender im Abrechnungslauf nach Entwurf",
  url: "https://github.com/o/r/pull/3550",
  state: "OPEN",
  isDraft: true,
  mergedAt: null,
  closedAt: null,
  headRefName: "feature/TENDR-1069-zeitraumkalender",
  headRefOid: "e7d64f4c4",
  baseRefName: "main",
  updatedAt: "2026-11-23T10:40:13Z",
  body: "Closes #3537\nFixes: #3538",
  reviewDecision: "REVIEW_REQUIRED",
  commits: { nodes: [{ commit: { statusCheckRollup: { state: "FAILURE" } } }] },
  closingIssuesReferences: { nodes: [{ number: 3549 }] },
  ...over,
});

const member = (n: number): FamilyMember => ({ n, title: `#${n}`, state: "open", labels: [] });

describe("pull request facts", () => {
  test("keys: title and head branch (any case), the body only when they name none", () => {
    expect(pullKeys("✨ TENDR-1069: Kalender", "feature/TENDR-1069-zeitraum", "siehe TENDR-1000")).toEqual(["TENDR-1069"]);
    expect(pullKeys("Kalender", "feature/tendr-1070-x", "")).toEqual(["TENDR-1070"]);
    expect(pullKeys("Kalender", "sandcastle/run", "## JIRA\nTENDR-1071")).toEqual(["TENDR-1071"]);
    // only the body's start counts
    expect(pullKeys("x", "y", `${"a".repeat(2000)} TENDR-1`)).toEqual([]);
  });

  test("closes: GitHub's references plus Closes/Fixes/Resolves #n in the body", () => {
    expect(pullCloses([3549], "Closes #3537\nfixes: #3538\nresolved #12, siehe #13")).toEqual([12, 3537, 3538, 3549]);
    expect(pullCloses([], "Teil von #5")).toEqual([]);
  });

  test("state, checks and review mapping", () => {
    expect(pullState("OPEN", false)).toBe("open");
    expect(pullState("OPEN", true)).toBe("draft");
    expect(pullState("MERGED", false)).toBe("merged");
    expect(pullState("CLOSED", true)).toBe("closed");
    expect(checksState("SUCCESS")).toBe("success");
    expect(checksState("FAILURE")).toBe("failure");
    expect(checksState("ERROR")).toBe("failure");
    expect(checksState("PENDING")).toBe("pending");
    expect(checksState("EXPECTED")).toBe("pending");
    expect(checksState(null)).toBeNull();
    expect(checksState(undefined)).toBeNull();
    expect(reviewState("CHANGES_REQUESTED")).toBe("changes-requested");
    expect(reviewState(null)).toBeNull();
  });

  test("toPull maps a GraphQL node", () => {
    expect(toPull(node())).toEqual({
      n: 3550,
      title: "✨ TENDR-1069: Zeitraumkalender im Abrechnungslauf nach Entwurf",
      url: "https://github.com/o/r/pull/3550",
      state: "draft",
      checks: "failure",
      review: "review-required",
      branch: "feature/TENDR-1069-zeitraumkalender",
      base: "main",
      head: "e7d64f4c4",
      mergedAt: null,
      closedAt: null,
      updatedAt: "2026-11-23T10:40:13Z",
      keys: ["TENDR-1069"],
      codeKeys: [],
      closes: [3537, 3538, 3549],
    });
    // merged PRs come without review and checks
    const merged = toPull(node({ state: "MERGED", isDraft: false, reviewDecision: undefined, commits: undefined, body: null }));
    expect([merged.state, merged.checks, merged.review, merged.closes]).toEqual(["merged", null, null, [3549]]);
  });
});

describe("pullsByTicket", () => {
  const fam = new Map<string, Family>([
    ["T-1", { grill: member(1), story: member(2), children: [member(3), member(4)] }],
    ["T-2", { story: member(10), children: [member(11)] }],
  ]);
  const known = new Set(["T-1", "T-2", "T-3"]);

  test("several PRs per ticket by key, main PR first (open, draft, merged, closed; newest first)", () => {
    const doc = pull(20, { keys: ["T-1"], state: "merged", mergedAt: "2026-11-10T10:00:00Z", closedAt: "2026-11-10T10:00:00Z" });
    const build = pull(21, { keys: ["T-1"], state: "draft" });
    const old = pull(22, { keys: ["T-1"], state: "closed", closedAt: "2026-11-15T10:00:00Z" });
    const map = pullsByTicket([doc, old, build], known, fam);
    expect(map.get("T-1")?.map((p) => p.n)).toEqual([21, 20, 22]);
    expect(map.get("T-2")).toBeUndefined();
  });

  test("without a known key: through the family issues it closes; a known key wins over closing refs", () => {
    const viaChild = pull(30, { keys: ["UTF-8"], closes: [11] });
    const keyed = pull(31, { keys: ["T-3"], closes: [3] });
    const both = pull(32, { closes: [3, 11] });
    const stray = pull(33, { closes: [99] });
    const map = pullsByTicket([viaChild, keyed, both, stray], known, fam);
    expect(map.get("T-2")?.map((p) => p.n)).toEqual([32, 30]);
    expect(map.get("T-1")?.map((p) => p.n)).toEqual([32]);
    expect(map.get("T-3")?.map((p) => p.n)).toEqual([31]);
    expect(map.get("T-2")?.[0]).toEqual({
      n: 32,
      title: "PR 32",
      url: "https://github.com/o/r/pull/32",
      state: "open",
      checks: null,
      review: null,
      branch: "feature/pr-32",
      base: "main",
      mergedAt: null,
      docs: false,
    });
  });

  test("a batch PR naming no ticket belongs to every ticket its code commits name", () => {
    const batch = pull(3531, { title: "✨ 2026-11-21: 26 Stories", branch: "feature/batch-2026-11-21", state: "draft", codeKeys: ["T-1", "T-3", "UTF-8"] });
    const map = pullsByTicket([batch], known, fam);
    expect(map.get("T-1")?.map((p) => p.n)).toEqual([3531]);
    expect(map.get("T-3")?.map((p) => p.n)).toEqual([3531]);
    expect(map.get("T-2")).toBeUndefined();
  });

  test("closingPulls: only PRs closing a board issue, with what they close", () => {
    const out = closingPulls([pull(40, { closes: [3] }), pull(41, { closes: [99] }), pull(42, { closes: [] })], new Set([3]));
    expect(out.map((p) => [p.n, p.closes])).toEqual([[40, [3]]]);
  });
});

describe("documentation PRs", () => {
  test("isDocsPull: grill doc branch or type docs behind any gitmoji – never a feat/fix/test PR naming docs", () => {
    expect(isDocsPull({ branch: "docs/TENDR-1069-zeitraumkalender", title: "Spec" })).toBe(true);
    expect(isDocsPull({ branch: "feature/TENDR-636-lasttest-spec", title: "📝 docs: TENDR-636 Spec und ADRs" })).toBe(true);
    expect(isDocsPull({ branch: "x", title: "📄 docs(tendr-956): notiz-layout" })).toBe(true);
    expect(isDocsPull({ branch: "x", title: ":memo: docs!: Umbau" })).toBe(true);
    expect(isDocsPull({ branch: "x", title: "docs: README" })).toBe(true);
    expect(isDocsPull({ branch: "x", title: "✨ feat(docs): Handbuch-Seite" })).toBe(false);
    expect(isDocsPull({ branch: "x", title: "📝 test(backoffice-app): TENDR-731 kommentar" })).toBe(false);
    expect(isDocsPull({ branch: "x", title: "🔖 chore(release): v1.1.0 docs" })).toBe(false);
  });
});
