import { describe, expect, test } from "bun:test";
import { type Candidate, matchAndRank } from "../src/search";

const jira = (key: string, title: string, updated: string): Candidate => ({
  kind: "jira",
  key,
  title,
  status: "In Progress",
  type: "Story",
  slug: "o/tendr",
  project: "tendr",
  updated,
});

const issue = (n: number, title: string, updated: string, slug = "o/tendr"): Candidate => ({
  kind: "issue",
  n,
  title,
  status: "offen",
  slug,
  project: "tendr",
  updated,
});

describe("matchAndRank", () => {
  const all = [
    jira("TENDR-1037", "Zeitraum filtern", "2026-01-01T00:00:00Z"),
    jira("TENDR-10370", "Export im Zeitraum", "2026-03-01T00:00:00Z"),
    issue(3575, "Zeitraum-Filter bauen", "2026-02-01T00:00:00Z"),
    issue(12, "Login reparieren", "2026-04-01T00:00:00Z"),
  ];

  test("every word must match key or title, case-insensitively; newest first", () => {
    expect(matchAndRank(all, "zeitraum", 20).map((i) => i.key ?? i.n)).toEqual(["TENDR-10370", 3575, "TENDR-1037"]);
    expect(matchAndRank(all, "ZEITRAUM filt", 20).map((i) => i.key ?? i.n)).toEqual([3575, "TENDR-1037"]);
    expect(matchAndRank(all, "zeitraum login", 20)).toEqual([]);
    expect(matchAndRank(all, "  ", 20)).toEqual([]);
  });

  test("the exact key or #n comes first", () => {
    expect(matchAndRank(all, "tendr-1037", 20).map((i) => i.key)).toEqual(["TENDR-1037", "TENDR-10370"]);
    expect(matchAndRank(all, "#3575", 20).map((i) => i.n)).toEqual([3575]);
    expect(matchAndRank([...all, issue(35750, "x", "2027-01-01T00:00:00Z")], "3575", 20).map((i) => i.n)).toEqual([3575, 35750]);
  });

  test("duplicates collapse to the newest copy; issues of other repos stay apart; limit; no updated in the answer", () => {
    const items = matchAndRank(
      [
        jira("TENDR-1037", "Zeitraum alt", "2025-01-01T00:00:00Z"),
        jira("TENDR-1037", "Zeitraum neu", "2026-01-01T00:00:00Z"),
        issue(5, "Zeitraum", "2026-01-01T00:00:00Z", "o/a"),
        issue(5, "Zeitraum", "2026-01-01T00:00:00Z", "o/b"),
      ],
      "zeitraum",
      20,
    );
    expect(items.map((i) => i.title)).toEqual(["Zeitraum neu", "Zeitraum", "Zeitraum"]);
    expect(items[0]).toEqual({ kind: "jira", key: "TENDR-1037", title: "Zeitraum neu", status: "In Progress", type: "Story", slug: "o/tendr", project: "tendr" });
    expect(matchAndRank(all, "zeitraum", 2)).toHaveLength(2);
  });
});
