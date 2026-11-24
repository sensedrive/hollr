import { describe, expect, test } from "bun:test";
import {
  advisorOptions,
  badgeText,
  dropOpen,
  keyProject,
  nextGrills,
  parseOpen,
  type QueuedGrill,
  readOpen,
  rememberAdvisor,
  stepStates,
  stepText,
  ticketGrills,
  ticketOfIssue,
} from "./grill";
import type { Grill } from "./types";

const LABELS = ["Ticket gelesen", "Grill", "JIRA-Kommentar", "Spec/ADR-PR", "Entwürfe", "Story & Kinder", "Bericht"];

function grill(p: Partial<Grill> & { doneUpTo?: number } = {}): Grill {
  const doneUpTo = p.doneUpTo ?? 0;
  return {
    id: `${p.slug ?? "o/r"}#${p.n ?? 1}`,
    slug: "o/r",
    project: "r",
    n: 1,
    key: null,
    mode: "interactive",
    source: "hollr",
    pane: "w1:p1",
    status: "running",
    steps: LABELS.map((label, i) => ({ n: i + 1, label, done: i < doneUpTo })),
    step: doneUpTo + 1,
    notes: [],
    cwd: null,
    startedAt: "2026-11-23T10:00:00Z",
    updatedAt: "2026-11-23T10:00:00Z",
    ...p,
  };
}

describe("deep link", () => {
  test("parses KEY:n, :n and KEY:", () => {
    expect(parseOpen("TENDR-1:3551")).toEqual({ key: "TENDR-1", n: 3551 });
    expect(parseOpen(":3551")).toEqual({ key: null, n: 3551 });
    expect(parseOpen("TENDR-1071:")).toEqual({ key: "TENDR-1071", n: null });
  });

  test("rejects anything else", () => {
    for (const v of ["", ":", "3551", "tendr-1:3", "TENDR-1:x", ":0", null, undefined]) expect(parseOpen(v)).toBeNull();
  });

  test("reads the percent-encoded value next to token and filter", () => {
    expect(readOpen("#token=abc&f=l%3Abug&open=TENDR-1%3A3551")).toEqual({ key: "TENDR-1", n: 3551 });
    expect(readOpen("#open=%3A12")).toEqual({ key: null, n: 12 });
    expect(readOpen("#f=x")).toBeNull();
  });

  test("reads repo= next to open=", () => {
    expect(readOpen("#token=abc&open=%3A3575&repo=leicht-luftig%2Ftendr")).toEqual({ key: null, n: 3575, repo: "leicht-luftig/tendr" });
    expect(readOpen("#open=TENDR-1037%3A&repo=o%2Fr.js")).toEqual({ key: "TENDR-1037", n: null, repo: "o/r.js" });
    expect(parseOpen(":7", "owner/name")).toEqual({ key: null, n: 7, repo: "owner/name" });
  });

  test("drops a malformed repo, never the link", () => {
    for (const repo of ["", "noslash", "a/b/c", "../x", "a b/c"]) {
      const t = parseOpen(":7", repo);
      expect(t).toEqual({ key: null, n: 7 });
      expect(t && "repo" in t).toBe(false);
    }
    expect(readOpen("#repo=o%2Fr")).toBeNull();
  });

  test("drops only open= and repo=", () => {
    expect(dropOpen("#f=l%3Abug&open=%3A12")).toBe("#f=l%3Abug");
    expect(dropOpen("#open=%3A12")).toBe("");
    expect(dropOpen("#token=t&open=%3A12&repo=o%2Fr&f=x")).toBe("#token=t&f=x");
  });

  test("ticket of an issue: grill ticket, story or child", () => {
    const m = (n: number) => ({ n, title: "", state: "open" as const, labels: [] });
    const tickets = [
      { key: "TENDR-1", family: { grill: m(10), story: m(11), children: [m(12), m(13)] } },
      { key: "TENDR-2", family: { children: [m(20)] } },
    ];
    expect(ticketOfIssue(tickets, 10)).toBe("TENDR-1");
    expect(ticketOfIssue(tickets, 11)).toBe("TENDR-1");
    expect(ticketOfIssue(tickets, 13)).toBe("TENDR-1");
    expect(ticketOfIssue(tickets, 20)).toBe("TENDR-2");
    expect(ticketOfIssue(tickets, 99)).toBeNull();
    expect(ticketOfIssue([], 10)).toBeNull();
  });

  test("key project", () => {
    expect(keyProject("TENDR-1071")).toBe("TENDR");
    expect(keyProject("AB2-7")).toBe("AB2");
  });
});

describe("steps", () => {
  test("step text names the current step; done says so", () => {
    expect(stepText(grill({ doneUpTo: 3 }))).toBe("Schritt 4/7 · Spec/ADR-PR");
    expect(stepText(grill({ doneUpTo: 7, status: "done" }))).toBe("Alle 7 Schritte erledigt");
  });

  test("step states mark the current step active or waiting", () => {
    expect(stepStates(grill({ doneUpTo: 1 }))).toEqual(["done", "active", "todo", "todo", "todo", "todo", "todo"]);
    expect(stepStates(grill({ doneUpTo: 1, status: "waiting" }))[1]).toBe("waiting");
    // an ended grill has no current step
    expect(stepStates(grill({ doneUpTo: 1, status: "ended" }))[1]).toBe("todo");
  });

  test("badge: waiting beats progress, ended shows nothing", () => {
    expect(badgeText(grill({ doneUpTo: 3 }))).toBe("gegrillt 4/7");
    expect(badgeText(grill({ doneUpTo: 3, status: "waiting" }))).toBe("wartet auf dich");
    expect(badgeText(grill({ doneUpTo: 7, status: "done" }))).toBe("gegrillt 7/7");
    // done always reads complete, whatever step the record carries
    expect(badgeText(grill({ doneUpTo: 3, status: "done" }))).toBe("gegrillt 7/7");
    expect(badgeText(grill({ status: "ended" }))).toBeNull();
  });
});

describe("ticketGrills", () => {
  test("matches by slug + n and by key; live beats done beats ended, then newest", () => {
    const statuses = new Map([
      ["mbp", { grills: [grill({ n: 5, status: "done" }), grill({ n: 6, status: "ended", updatedAt: "2026-11-23T12:00:00Z" })] }],
      [
        "workr",
        {
          grills: [
            grill({ n: 5, status: "waiting" }),
            grill({ n: 6, status: "ended", updatedAt: "2026-11-23T11:00:00Z" }),
            grill({ id: "/x|K-9", n: null, key: "K-9", slug: null }),
            grill({ n: 7, slug: "other/repo" }),
          ],
        },
      ],
    ]);
    const out = ticketGrills(statuses, "o/r", new Map([["K-9", 9]]));
    expect(out.get(5)?.server).toBe("workr");
    expect(out.get(6)?.server).toBe("mbp");
    expect(out.get(9)?.grill.key).toBe("K-9");
    expect(out.has(7)).toBe(false);
  });

  test("tolerates machines without grills", () => {
    expect(ticketGrills(new Map([["old", {}]]), "o/r", new Map()).size).toBe(0);
  });
});

describe("nextGrills", () => {
  const q = (server: string, n: number): QueuedGrill => ({ server, slug: "o/r", n, key: null, advisor: null });

  test("at most two per machine, counting busy ones, queue order kept", () => {
    const queue = [q("a", 1), q("a", 2), q("b", 3), q("a", 4), q("b", 5), q("b", 6)];
    expect(nextGrills(queue, new Map()).map((x) => x.n)).toEqual([1, 2, 3, 5]);
    expect(nextGrills(queue, new Map([["a", 1], ["b", 2]])).map((x) => x.n)).toEqual([1]);
    expect(nextGrills(queue, new Map([["a", 2], ["b", 2]]))).toEqual([]);
  });
});

describe("advisors", () => {
  test("project models first, then recent ones, valid and unique", () => {
    const opts = advisorOptions(
      [
        { label: "Opus 5.5", model: "anthropic/claude-opus-5-5" },
        { label: "Opus again", model: "anthropic/claude-opus-5-5" },
        { label: "bad", model: "has space" },
      ],
      ["openai/gpt-5", "anthropic/claude-opus-5-5"],
    );
    expect(opts).toEqual([
      { value: "anthropic/claude-opus-5-5", label: "Opus 5.5 (anthropic/claude-opus-5-5)" },
      { value: "openai/gpt-5", label: "openai/gpt-5" },
    ]);
  });

  test("remember puts the last one first, max 8", () => {
    const list = ["a", "b", "c", "d", "e", "f", "g", "h"];
    expect(rememberAdvisor(list, "c")).toEqual(["c", "a", "b", "d", "e", "f", "g", "h"]);
    expect(rememberAdvisor(list, "z")).toHaveLength(8);
  });
});
