import { expect, test } from "bun:test";
import { tokenize } from "./filter";
import { githubOnly, jiraLink } from "./jira";

const cfg = { baseUrl: "https://acme.atlassian.net/", projectKey: "HACCP", boardId: null };

test("issue search with JQL in board order, duplicates and junk dropped", () => {
  const link = jiraLink(cfg, ["HACCP-142", null, "HACCP-139", "HACCP-142", "nope"]);
  expect(link?.keys).toEqual(["HACCP-142", "HACCP-139"]);
  expect(link?.url).toBe(
    `https://acme.atlassian.net/issues/?jql=${encodeURIComponent("key in (HACCP-142, HACCP-139) ORDER BY Rank ASC")}`,
  );
});

test("board view with board id; project key from the tickets when not configured", () => {
  const jql = encodeURIComponent("key in (TENDR-1) ORDER BY Rank ASC");
  expect(jiraLink({ ...cfg, boardId: "12" }, ["TENDR-1"])?.url).toBe(
    `https://acme.atlassian.net/jira/software/c/projects/HACCP/boards/12?jql=${jql}`,
  );
  expect(jiraLink({ ...cfg, projectKey: null, boardId: "12" }, ["TENDR-1"])?.url).toBe(
    `https://acme.atlassian.net/jira/software/c/projects/TENDR/boards/12?jql=${jql}`,
  );
});

test("no base url or no keys → null", () => {
  expect(jiraLink({ ...cfg, baseUrl: null }, ["HACCP-1"])).toBeNull();
  expect(jiraLink(cfg, [null, undefined])).toBeNull();
});

test("GitHub-only tokens", () => {
  expect(githubOnly(tokenize("l:bug -l:x @ich s:600 #5 text")).map((t) => t.kind)).toEqual(["label", "nolabel", "assignee"]);
});
