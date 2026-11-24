import { describe, expect, test } from "bun:test";
import { findIssues, issueHref, parseIssueHref, parseLinkInfo, type LinkInfo } from "./issueLinks";

const both: LinkInfo = { repo: "leicht-luftig/tendr", jira: { baseUrl: "https://x.atlassian.net/", keys: ["TENDR"] } };
const texts = (text: string, info: LinkInfo) => findIssues(text, info).map((f) => text.slice(f.start, f.end));
const targets = (text: string, info: LinkInfo) => findIssues(text, info).map((f) => parseIssueHref(f.url));

describe("findIssues", () => {
  test("JIRA key only with its project key", () => {
    expect(texts("siehe TENDR-1037.", both)).toEqual(["TENDR-1037"]);
    expect(texts("siehe TENDR-1037", { ...both, jira: { baseUrl: "https://x.atlassian.net", keys: ["HACCP"] } })).toEqual([]);
    expect(texts("siehe TENDR-1037", { ...both, jira: null })).toEqual([]);
    expect(targets("TENDR-1037", both)).toEqual([{ open: "TENDR-1037:", web: "https://x.atlassian.net/browse/TENDR-1037" }]);
  });
  test("issue number", () => {
    expect(texts("PR #3575 ist offen", both)).toEqual(["#3575"]);
    expect(targets("(#3575)", both)).toEqual([
      { open: ":3575", repo: "leicht-luftig/tendr", web: "https://github.com/leicht-luftig/tendr/issues/3575" },
    ]);
    expect(texts("#3575", { ...both, repo: null })).toEqual([]);
  });
  test("no false friends", () => {
    for (const s of ["UTF-8", "SHA-256", "&#123;", "https://x/#12", "a#12", "x/#12", "##12", "#1234567", "#0"])
      expect(texts(s, both)).toEqual([]);
    expect(texts("https://x.atlassian.net/browse/TENDR-1 und TENDR-2", both)).toEqual(["TENDR-2"]);
  });
  test("in order", () => expect(texts("#2 vor TENDR-1 und #3", both)).toEqual(["#2", "TENDR-1", "#3"]));
});

describe("issue hrefs", () => {
  test("round trip", () => {
    const t = { open: ":12", repo: "o/r", web: "https://github.com/o/r/issues/12" };
    expect(parseIssueHref(issueHref(t))).toEqual(t);
  });
  test("other links and bad values", () => {
    expect(parseIssueHref("https://github.com")).toBeUndefined();
    expect(parseIssueHref("hollr-issue:?open=x&web=https://a")).toBeUndefined();
    expect(parseIssueHref("hollr-issue:?open=%3A1&web=javascript:alert(1)")).toBeUndefined();
  });
});

describe("parseLinkInfo", () => {
  test("valid and malformed", () => {
    expect(parseLinkInfo({ repo: "o/r", jira: { baseUrl: "https://j", keys: ["TENDR", "bad"] } })).toEqual({
      repo: "o/r",
      jira: { baseUrl: "https://j", keys: ["TENDR"] },
    });
    expect(parseLinkInfo({ repo: "nope", jira: { baseUrl: "https://j", keys: [] } })).toEqual({ repo: null, jira: null });
    expect(parseLinkInfo(null)).toEqual({ repo: null, jira: null });
  });
});
