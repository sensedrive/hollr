import { describe, expect, test } from "bun:test";
import {
  advisorOptions,
  dropOpen,
  grillFamilies,
  grillView,
  keyProject,
  nextGrills,
  parseOpen,
  type QueuedGrill,
  readOpen,
  rememberAdvisor,
  ticketGrills,
  ticketOfIssue,
} from "./grill";
import type { Family, Grill } from "./types";

const LABELS = ["Ticket gelesen", "Grill", "JIRA-Kommentar", "Spec/ADR-PR", "Entwürfe", "Story & Kinder", "Bericht"];

const STAGES = ["read", "grill", "jira-comment", "spec", "design", "story", "report"];

/** A grill with a flow whose first `doneUpTo` steps are done; `doneUpTo: null` = no flow (steps unknown). */
function grill(p: Partial<Grill> & { doneUpTo?: number | null } = {}): Grill {
  const { doneUpTo: upTo, ...rest } = p;
  const doneUpTo = upTo === undefined ? 0 : upTo;
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
    steps: doneUpTo === null ? null : LABELS.map((label, i) => ({ n: i + 1, stage: STAGES[i] ?? "", label, state: i < doneUpTo ? "ok" : "pending", done: i < doneUpTo, reason: null })),
    step: doneUpTo === null ? null : doneUpTo + 1,
    paused: null,
    flow: doneUpTo === null ? null : "k-1-grill",
    cwd: null,
    startedAt: "2026-11-23T10:00:00Z",
    updatedAt: "2026-11-23T10:00:00Z",
    ...rest,
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

const member = (n: number, state: "open" | "closed" = "open") => ({ n, title: `#${n}`, state, labels: [] });
const family = (p: { grillClosed?: boolean; story?: number; children?: number } = {}): Family => ({
  grill: member(1, p.grillClosed ? "closed" : "open"),
  story: p.story ? member(p.story) : undefined,
  children: Array.from({ length: p.children ?? 0 }, (_, i) => member(100 + i)),
});

describe("grill view", () => {
  test("log: the current step, its badge and build-line part", () => {
    const v = grillView(grill({ doneUpTo: 3 }));
    expect(v).toMatchObject({ source: "log", text: "Schritt 4/7 · Spec/ADR-PR", badge: "gegrillt 4/7", tone: "running", progress: "Grill 4/7" });
    expect(v?.steps).toEqual(["done", "done", "done", "active", "todo", "todo", "todo"]);
    expect(grillView(grill({ doneUpTo: 7, status: "done" }))).toMatchObject({ text: "Alle 7 Schritte erledigt", badge: "gegrillt 7/7", tone: "done", progress: null });
  });

  test("log: waiting names the pause reason; ended shows no badge; skipped counts as done", () => {
    const w = grillView(grill({ doneUpTo: 1, status: "waiting", paused: "wartet auf Antworten an #1" }));
    expect(w).toMatchObject({ badge: "wartet auf dich", tone: "waiting", reason: "wartet auf Antworten an #1" });
    expect(w?.steps[1]).toBe("waiting");
    const ended = grillView(grill({ doneUpTo: 1, status: "ended" }));
    expect(ended?.badge).toBeNull();
    expect(ended?.steps[1]).toBe("todo");
    const g = grill({ doneUpTo: 4 });
    const design = g.steps?.[4];
    if (design) Object.assign(design, { state: "skipped", done: true });
    g.step = 6;
    expect(grillView(g)?.steps.slice(3, 6)).toEqual(["done", "skipped", "active"]);
  });

  test("artifacts beat the log and the pane: story with a child is finished", () => {
    for (const g of [grill({ doneUpTo: 0 }), grill({ doneUpTo: 3, status: "waiting" }), grill({ doneUpTo: null, status: "idle" }), null]) {
      const v = grillView(g, family({ story: 254, children: 3 }));
      expect(v).toMatchObject({ source: "artifacts", status: "done", badge: "gegrillt ✓", tone: "done", text: "Fertig gegrillt · Story #254 mit 3 Kindern", progress: null });
      expect(v?.steps.every((s) => s === "done")).toBe(true);
    }
    expect(grillView(null, family({ story: 9, children: 1 }))?.text).toBe("Fertig gegrillt · Story #9 mit 1 Kind");
    // a story without children is not finished: the log still counts
    expect(grillView(grill({ doneUpTo: 5 }), family({ story: 9 }))?.source).toBe("log");
    expect(grillView(null, family({ story: 9 }))).toBeNull();
  });

  test("log beats unknown; without either: „Stand unbekannt“, never a guessed step", () => {
    expect(grillView(grill({ doneUpTo: 2 }), family())?.source).toBe("log");
    const u = grillView(grill({ doneUpTo: null }));
    expect(u).toMatchObject({ source: "unknown", text: "Stand unbekannt", badge: "Stand unbekannt", tone: "unknown", progress: "Grill: Stand unbekannt" });
    expect(u?.steps).toEqual(Array(7).fill("unknown"));
    expect(grillView(grill({ doneUpTo: null, status: "waiting" }))).toMatchObject({ badge: "wartet auf dich", tone: "waiting", text: "Stand unbekannt" });
    expect(grillView(grill({ doneUpTo: null, status: "ended" }))).toMatchObject({ badge: null, progress: null });
  });

  test("a closed grill ticket marks step 2 done, with or without a log", () => {
    expect(grillView(grill({ doneUpTo: null }), family({ grillClosed: true }))?.steps).toEqual(["unknown", "done", "unknown", "unknown", "unknown", "unknown", "unknown"]);
    expect(grillView(grill({ doneUpTo: 1 }), family({ grillClosed: true }))?.steps.slice(0, 3)).toEqual(["done", "done", "todo"]);
  });

  test("families by grill issue", () => {
    const f = family({ story: 5, children: 1 });
    expect(grillFamilies([{ family: f }, { family: { children: [] } }])).toEqual(new Map([[1, f]]));
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
