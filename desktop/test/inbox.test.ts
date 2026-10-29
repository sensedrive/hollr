import { describe, expect, test } from "bun:test";
import { ANSWERED_MS, buildEntries, fromHistory, fromTimeline, isDue, plain, type InboxDetail } from "../src/lib/inbox";
import type { TimelineItem } from "../src/lib/api";

const NOW = 1_800_000_000_000;
const tl = (...items: TimelineItem[]) => ({ items });

describe("fromTimeline", () => {
  test("a pending ask wins, with its options", () => {
    const d = fromTimeline("blocked", tl(
      { k: "user", id: "u1", text: "los" },
      { k: "ask", id: "a0", question: "alt?", options: ["x"], answer: "x" },
      { k: "text", id: "t1", text: "Ich frage nach." },
      { k: "ask", id: "a1", question: "Welche **Datenbank**?", options: ["Postgres", "SQLite"], pending: true },
    ));
    expect(d).toEqual({ kind: "ask", turn: "a1", question: "Welche Datenbank?", options: ["Postgres", "SQLite"] });
  });

  test("several questions or multi-select: no one-click options (the chat answers them)", () => {
    const several = fromTimeline("blocked", tl({
      k: "ask", id: "a1", question: "DB?", options: ["SQLite"], pending: true,
      questions: [{ question: "DB?", options: ["SQLite"] }, { question: "Extras?", options: ["Auth"], multi: true }],
    }));
    expect(several).toEqual({ kind: "ask", turn: "a1", question: "DB?", options: [] });
    const multi = fromTimeline("blocked", tl({ k: "ask", id: "a2", question: "Extras?", options: ["Auth"], multi: true, pending: true }));
    expect(multi.options).toEqual([]);
  });

  test("blocked without an ask: waiting with the last text of this turn", () => {
    const d = fromTimeline("blocked", tl(
      { k: "text", id: "t0", text: "voriger Turn" },
      { k: "user", id: "u1", text: "mach" },
      { k: "text", id: "t1", text: "Darf ich `rm -rf build` ausführen?" },
      { k: "tools", id: "x1", calls: [] },
    ));
    expect(d).toEqual({ kind: "waiting", turn: "x1", text: "Darf ich rm -rf build ausführen?" });
  });

  test("a turn that ended with an error", () => {
    const d = fromTimeline("done", tl(
      { k: "user", id: "u1", text: "mach" },
      { k: "text", id: "t1", text: "Ok" },
      { k: "end", id: "e1", ms: 900, status: "error", error: "rate limit" },
    ));
    expect(d).toEqual({ kind: "error", turn: "e1", text: "rate limit" });
  });

  test("an old error does not count after a new message", () => {
    const d = fromTimeline("done", tl(
      { k: "end", id: "e0", ms: 1, status: "error", error: "alt" },
      { k: "user", id: "u1", text: "nochmal" },
      { k: "text", id: "t1", text: "Fertig." },
      { k: "end", id: "e1", ms: 5, status: "done" },
    ));
    expect(d).toEqual({ kind: "done", turn: "e1", text: "Fertig." });
  });

  test("empty timeline", () => {
    expect(fromTimeline("done", tl())).toEqual({ kind: "done", turn: "", text: undefined });
  });
});

describe("fromHistory", () => {
  test("last answer as snippet", () => {
    const d = fromHistory("done", [{ t: "user", text: "hi" }, { t: "answer", text: "a", final: false }, { t: "answer", text: "## Erledigt\n\nAlles grün", final: true }]);
    expect(d).toEqual({ kind: "done", turn: "h3", text: "Erledigt Alles grün" });
    expect(fromHistory("blocked", []).kind).toBe("waiting");
  });
});

describe("plain", () => {
  test("cuts at max with an ellipsis", () => {
    const s = plain("a".repeat(300));
    expect(s.length).toBe(200);
    expect(s.endsWith("…")).toBe(true);
    expect(plain("```\ncode\n```\nsiehe [Doku](https://x)")).toBe("siehe Doku");
  });
});

describe("buildEntries", () => {
  const empty = { details: {}, since: {}, dismissed: {}, answered: {} };
  const ask: InboxDetail = { kind: "ask", turn: "a1", question: "?", options: ["ja", "nein"] };

  test("only blocked and done panes, waiting first (oldest), then errors, then done (newest)", () => {
    const e = buildEntries(
      [
        { id: "s|1", status: "working" },
        { id: "s|2", status: "done" },
        { id: "s|3", status: "blocked" },
        { id: "s|4", status: "done" },
        { id: "s|5", status: "blocked" },
        { id: "s|6", status: "idle" },
        { id: "s|7", status: "done" },
      ],
      {
        ...empty,
        details: { "s|7": { kind: "error", turn: "e" }, "s|5": ask },
        since: { "s|2": NOW - 5000, "s|3": NOW - 1000, "s|4": NOW - 1000, "s|5": NOW - 9000, "s|7": NOW },
      },
      NOW,
    );
    expect(e.map((x) => x.id)).toEqual(["s|5", "s|3", "s|7", "s|4", "s|2"]);
    expect(e[0]?.key).toBe("s|5#a1");
    expect(e[1]?.kind).toBe("waiting");
  });

  test("a detail from the other state is ignored", () => {
    const e = buildEntries([{ id: "p", status: "done" }], { ...empty, details: { p: ask }, since: { p: NOW } }, NOW);
    expect(e[0]?.kind).toBe("done");
  });

  test("dismissed stays hidden for that turn only", () => {
    const panes = [{ id: "p", status: "blocked" }];
    const s = { ...empty, details: { p: ask }, dismissed: { "p#a1": true } };
    expect(buildEntries(panes, s, NOW)).toEqual([]);
    expect(buildEntries(panes, { ...s, details: { p: { ...ask, turn: "a2" } } }, NOW).length).toBe(1);
  });

  test("answered hides for a while, then comes back if still waiting", () => {
    const panes = [{ id: "p", status: "blocked" }];
    const s = { ...empty, details: { p: ask }, answered: { "p#a1": NOW } };
    expect(buildEntries(panes, s, NOW + 1000)).toEqual([]);
    expect(buildEntries(panes, s, NOW + ANSWERED_MS).length).toBe(1);
  });
});

describe("helpers", () => {
  test("isDue", () => {
    expect(isDue(undefined, NOW)).toBe(true);
    expect(isDue(NOW - 4000, NOW)).toBe(false);
    expect(isDue(NOW - 5000, NOW)).toBe(true);
  });
});
