import { describe, expect, test } from "bun:test";
import { compile, readHash, serialize, suggest, tokenize, writeHash } from "./filter";
import type { Issue } from "./types";

const issue = (n: number, extra: Partial<Issue> = {}): Issue => ({
  number: n,
  title: `Ticket ${n}`,
  state: "open",
  labels: [],
  assignees: [],
  author: "x",
  parent: null,
  jira: null,
  blockedBy: [],
  blockedNotes: [],
  updatedAt: "2026-11-20T10:00:00Z",
  closedAt: null,
  url: `https://github.com/o/r/issues/${n}`,
  commentsCount: 0,
  ...extra,
});

const issues = [
  issue(612, { title: "Temperaturprotokoll als PDF", labels: ["frontend", "bug"], assignees: ["mara"], parent: 600, jira: "HACCP-142" }),
  issue(603, { title: "Lieferschein fotografieren", labels: ["mobile"], assignees: ["jonas"], parent: 600 }),
  issue(608, { title: "Notiz bei Übergabe", labels: ["frontend"], parent: 590 }),
  issue(620, { title: "Lieferanten importieren", labels: ["backend", "needs review"] }),
];
const ctx = { viewer: "mara", stories: [{ number: 600, title: "Kühlkette dokumentieren" }, { number: 590, title: "Rezepte" }] };
const run = (q: string) => issues.filter(compile(tokenize(q), ctx)).map((i) => i.number);

describe("tokenize", () => {
  test("kinds", () => {
    expect(tokenize("l:bug -l:mobile @mara s:600 #612 pdf")).toEqual([
      { kind: "label", value: "bug" },
      { kind: "nolabel", value: "mobile" },
      { kind: "assignee", value: "mara" },
      { kind: "story", value: "600" },
      { kind: "number", value: "612" },
      { kind: "text", value: "pdf" },
    ]);
  });
  test("quoted values keep spaces", () => {
    expect(tokenize('l:"needs review" x')).toEqual([
      { kind: "label", value: "needs review" },
      { kind: "text", value: "x" },
    ]);
  });
  test("bare prefixes stay text", () => {
    expect(tokenize("l: @")).toEqual([
      { kind: "text", value: "l:" },
      { kind: "text", value: "@" },
    ]);
  });
  test("serialize round-trips", () => {
    const q = 'l:"needs review" -l:bug @ich s:600 #5 wort';
    expect(serialize(tokenize(q))).toBe(q);
  });
});

describe("compile", () => {
  test("empty filter shows everything", () => expect(run("")).toEqual([612, 603, 608, 620]));
  test("labels narrow, case-insensitive", () => {
    expect(run("l:frontend")).toEqual([612, 608]);
    expect(run("l:Frontend l:bug")).toEqual([612]);
    expect(run('l:"needs review"')).toEqual([620]);
  });
  test("-l excludes", () => expect(run("l:frontend -l:bug")).toEqual([608]));
  test("drift: issues with a drift badge (Werkbank)", () => {
    expect(issues.filter(compile(tokenize("drift:"), { ...ctx, drift: new Set([603, 620]) })).map((i) => i.number)).toEqual([603, 620]);
    expect(run("drift:")).toEqual([]);
    expect(tokenize("drift: l:frontend").map((t) => t.kind)).toEqual(["drift", "label"]);
  });
  test("assignees widen, @ich is the viewer", () => {
    expect(run("@mara @jonas")).toEqual([612, 603]);
    expect(run("@ich")).toEqual([612]);
    expect(issues.filter(compile(tokenize("@ich"), { ...ctx, viewer: "" }))).toEqual([]);
  });
  test("story by number or title text", () => {
    expect(run("s:600")).toEqual([612, 603]);
    expect(run("s:#590")).toEqual([608]);
    expect(run("s:kühlkette")).toEqual([612, 603]);
  });
  test("numbers widen", () => expect(run("#612 #620")).toEqual([612, 620]));
  test("text over title, number and JIRA key", () => {
    expect(run("liefer")).toEqual([603, 620]);
    expect(run("haccp-142")).toEqual([612]);
    expect(run("603")).toEqual([603]);
    expect(run("liefer import")).toEqual([620]);
  });
  test("the word being typed matches labels/assignees by prefix; a half -l: excludes nothing yet", () => {
    const partial = (q: string) => {
      const t = tokenize(q);
      const last = t[t.length - 1];
      if (last) t[t.length - 1] = { ...last, partial: true };
      return issues.filter(compile(t, ctx)).map((i) => i.number);
    };
    expect(partial("l:fro")).toEqual([612, 608]);
    expect(partial("@ma")).toEqual([612]);
    expect(partial("-l:fro")).toEqual([612, 603, 608, 620]);
  });
});

describe("suggest", () => {
  const src = {
    labels: ["frontend", "backend", "needs review"],
    assignees: [{ login: "mara", name: "Mara Hoffmann" }, { login: "jonas" }],
    stories: ctx.stories,
  };
  test("labels, prefix matches first", () => {
    expect(suggest("l:end", src).map((s) => s.text)).toEqual(["l:frontend", "l:backend"]);
    expect(suggest("l:ba", src).map((s) => s.text)).toEqual(["l:backend"]);
    expect(suggest("-l:need", src).map((s) => s.text)).toEqual(['-l:"needs review"']);
  });
  test("assignees by login or name, @ich offered", () => {
    expect(suggest("@", src).map((s) => s.text)).toEqual(["@ich", "@mara", "@jonas"]);
    expect(suggest("@hoff", src).map((s) => s.text)).toEqual(["@mara"]);
  });
  test("stories by number or title", () => {
    expect(suggest("s:6", src).map((s) => s.text)).toEqual(["s:600"]);
    expect(suggest("s:rez", src)[0]).toEqual({ text: "s:590", hint: "Rezepte" });
  });
  test("plain words get nothing", () => expect(suggest("pdf", src)).toEqual([]));
});

describe("hash", () => {
  test("round trip", () => {
    const q = 'l:"needs review" @ich';
    expect(readHash(writeHash(q))).toBe(q);
    expect(writeHash("")).toBe("");
  });
  test("other hash parts and garbage", () => {
    expect(readHash("#x=1&f=l%3Abug")).toBe("l:bug");
    expect(readHash("#f=%E0%A4%A")).toBe("");
    expect(readHash("")).toBe("");
  });
});
