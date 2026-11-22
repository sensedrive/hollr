import { describe, expect, test } from "bun:test";
import {
  ANSWERED_MS, buildEntries, cardKey, cardStatus, dotFor, fromHistory, fromTimeline, isDue, plain, resultSeen, type InboxDetail,
} from "../src/lib/inbox";
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
  const empty = { details: {}, answered: {} };
  const ask: InboxDetail = { kind: "ask", turn: "a1", question: "?", options: ["ja", "nein"] };

  test("only blocked and done panes, waiting first (oldest), then errors, then done (newest)", () => {
    const e = buildEntries(
      [
        { id: "s|1", status: "working", since: NOW },
        { id: "s|2", status: "done", since: NOW - 5000 },
        { id: "s|3", status: "blocked", since: NOW - 1000 },
        { id: "s|4", status: "done", since: NOW - 1000 },
        { id: "s|5", status: "blocked", since: NOW - 9000 },
        { id: "s|6", status: "idle", since: NOW },
        { id: "s|7", status: "done", since: NOW },
      ],
      { ...empty, details: { "s|7": { kind: "error", turn: "e" }, "s|5": ask } },
      NOW,
    );
    expect(e.map((x) => x.id)).toEqual(["s|5", "s|3", "s|7", "s|4", "s|2"]);
    expect(e[0]?.key).toBe(`s|5@${NOW - 9000}`);
    expect(e[0]?.entered).toBe(NOW - 9000);
    expect(e[1]?.kind).toBe("waiting");
  });

  test("the card's time is the log's when known, the key stays the status's since", () => {
    const [e] = buildEntries([{ id: "p", status: "blocked", since: NOW }], { ...empty, details: { p: { ...ask, at: NOW - 3000 } } }, NOW);
    expect(e?.since).toBe(NOW - 3000);
    expect(e?.key).toBe(cardKey("p", NOW));
  });

  test("a detail from the other state is ignored", () => {
    const e = buildEntries([{ id: "p", status: "done", since: NOW }], { ...empty, details: { p: ask } }, NOW);
    expect(e[0]?.kind).toBe("done");
  });

  test("dismissed stays hidden for that status only", () => {
    const s = { ...empty, details: { p: ask } };
    expect(buildEntries([{ id: "p", status: "blocked", since: NOW, dismissed: NOW }], s, NOW)).toEqual([]);
    // a newer status (the agent asked again later) shows again
    expect(buildEntries([{ id: "p", status: "blocked", since: NOW + 1, dismissed: NOW }], s, NOW).length).toBe(1);
  });

  test("answered hides for a while, then comes back if still waiting", () => {
    const panes = [{ id: "p", status: "blocked", since: NOW }];
    const s = { ...empty, details: { p: ask }, answered: { [cardKey("p", NOW)]: NOW } };
    expect(buildEntries(panes, s, NOW + 1000)).toEqual([]);
    expect(buildEntries(panes, s, NOW + ANSWERED_MS).length).toBe(1);
  });

  test("a result seen for its status stays away, never an open question", () => {
    const s = { ...empty, details: { err: { kind: "error" as const, turn: "e" }, q: ask } };
    const at = NOW - 5000;
    const panes = [
      { id: "done", status: "done", since: at, seen: at },
      { id: "err", status: "done", since: at, seen: at },
      { id: "q", status: "blocked", since: at, seen: at },
    ];
    expect(buildEntries(panes, s, NOW).map((e) => e.id)).toEqual(["q"]);
    // the next result (a newer since) shows again
    expect(buildEntries([{ ...panes[0]!, since: NOW }], s, NOW).map((e) => e.id)).toEqual(["done"]);
  });

  test("marked unread: shows as a fresh result in spite of seen, dismissed or an idle status", () => {
    const e = buildEntries(
      [
        { id: "a", status: "done", since: NOW, seen: NOW, unread: true },
        { id: "b", status: "done", since: NOW, dismissed: NOW, unread: true },
        { id: "c", status: "idle", since: NOW, unread: true },
        { id: "d", status: "working", since: NOW, unread: true },
      ],
      empty,
      NOW,
    );
    expect(e.map((x) => [x.id, x.kind])).toEqual([["a", "done"], ["b", "done"], ["c", "done"]]);
  });
});

describe("seen and dots", () => {
  test("resultSeen: the same status only, and not while marked unread", () => {
    expect(resultSeen({ since: NOW, seen: NOW })).toBe(true);
    expect(resultSeen({ since: NOW + 1, seen: NOW })).toBe(false);
    expect(resultSeen({ since: NOW })).toBe(false);
    expect(resultSeen({ since: NOW, seen: NOW, unread: true })).toBe(false);
  });

  test("dotFor: a seen result is quiet, unread is blue, working and waiting always show", () => {
    expect(dotFor({ status: "done", since: NOW })).toBe("done");
    expect(dotFor({ status: "done", since: NOW, seen: NOW })).toBe("idle");
    expect(dotFor({ status: "idle", since: NOW, unread: true })).toBe("done");
    expect(dotFor({ status: "blocked", since: NOW, seen: NOW, unread: true })).toBe("blocked");
    expect(dotFor({ status: "working", since: NOW, unread: true })).toBe("working");
  });

  test("cardStatus: only an idle pane marked unread changes", () => {
    expect(cardStatus({ status: "idle", unread: true })).toBe("done");
    expect(cardStatus({ status: "idle" })).toBe("idle");
    expect(cardStatus({ status: "working", unread: true })).toBe("working");
  });
});

describe("helpers", () => {
  test("isDue", () => {
    expect(isDue(undefined, NOW)).toBe(true);
    expect(isDue(NOW - 4000, NOW)).toBe(false);
    expect(isDue(NOW - 5000, NOW)).toBe(true);
  });
});
