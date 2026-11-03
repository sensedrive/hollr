import { describe, expect, test } from "bun:test";
import type { TimelineItem } from "./api";
import { buildEntries, fromTimeline } from "./inbox";
import { clock, recentSaid, stampedIds } from "./msgTimes";

const t0 = new Date(2026, 10, 3, 17, 56).getTime();
const min = 60_000;

describe("stampedIds", () => {
  test("user messages and the start of each reply, not every tool card", () => {
    const items: TimelineItem[] = [
      { k: "user", id: "u1", text: "Los", at: t0 },
      { k: "thinking", id: "th", text: "…", at: t0 + 2000 },
      { k: "tools", id: "g1", calls: [], at: t0 + 2000 },
      { k: "text", id: "x1", text: "Zwischenstand", at: t0 + 3 * min },
      { k: "tools", id: "g2", calls: [], at: t0 + 30 * min },
      { k: "text", id: "x2", text: "Fertig", at: t0 + 31 * min },
      { k: "end", id: "e", ms: 1, status: "done", at: t0 + 31 * min },
      { k: "user", id: "u2", text: "Danke", at: t0 + 40 * min },
      { k: "text", id: "x3", text: "Gern", at: t0 + 41 * min },
    ];
    // x2: a text again after a long quiet stretch; g2 (tools) never on its own
    expect([...stampedIds(items)]).toEqual(["u1", "th", "x2", "u2", "x3"]);
  });
  test("without times nothing is stamped", () => {
    expect(stampedIds([{ k: "user", id: "u", text: "a" }, { k: "text", id: "t", text: "b" }]).size).toBe(0);
  });
});

describe("clock", () => {
  test("time today, date and time on another day, short year in another year", () => {
    expect(clock(t0, "de", t0 + 60 * min)).toBe("17:56");
    expect(clock(t0, "de", t0 + 24 * 60 * min)).toBe("3.11. 17:56");
    expect(clock(new Date(2025, 0, 2, 9, 5).getTime(), "de", t0)).toBe("2.1.25 09:05");
  });
});

describe("recentSaid", () => {
  test("last messages with a time, newest last, one line each", () => {
    const items: TimelineItem[] = [
      { k: "user", id: "u0", text: "alt" },
      { k: "user", id: "u1", text: "Mach **das**\nfertig", source: "voice", at: t0 },
      { k: "tools", id: "g", calls: [], at: t0 + 1000 },
      { k: "text", id: "x1", text: "Erledigt.", at: t0 + 2000 },
      { k: "ask", id: "a", question: "Push?", options: ["ja"], pending: true, at: t0 + 3000 },
      { k: "user", id: "u2", text: "Weiter", source: "agent", at: t0 + 4000 },
    ];
    expect(recentSaid(items, 3).map((s) => [s.id, s.who, s.text])).toEqual([
      ["x1", "agent", "Erledigt."],
      ["a", "agent", "? Push?"],
      ["u2", "peer", "Weiter"],
    ]);
    expect(recentSaid(items)[0]).toEqual({ id: "u1", at: t0, who: "you", voice: true, text: "Mach das fertig" });
  });
});

test("inbox: a finished turn dates from its end in the log, seen is judged on this app's clock", () => {
  const detail = fromTimeline("done", { items: [{ k: "user", id: "u", text: "a", at: 5 }, { k: "end", id: "e", ms: 1, status: "done", at: 9 }] });
  const s = { details: { p: detail }, since: { p: 20 }, dismissed: {}, answered: {}, seen: {} as Record<string, number> };
  expect(buildEntries([{ id: "p", status: "done" }], s, 30)[0]?.since).toBe(9);
  // looked at before this app noticed it finished: still new, even though the log says it ended earlier
  s.seen.p = 15;
  expect(buildEntries([{ id: "p", status: "done" }], s, 30).length).toBe(1);
});
