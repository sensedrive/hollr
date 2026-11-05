import { describe, expect, test } from "bun:test";
import type { TimelineItem, ToolCall } from "./api";
import { chatView } from "./chatTools";
import {
  callText, findUnits, itemKind, markerAt, markerRows, matcher, matchSpans, rulerBars, rulerScale, scrollForRuler, unitHits,
  viewportBox, type RulerFrame,
} from "./chatFind";

const call = (id: string, name: string, extra: Partial<ToolCall> = {}): ToolCall => ({ id, name, label: "", status: "ok", ...extra });

describe("matching", () => {
  test("literal, case-insensitive by default, regex characters are plain text", () => {
    const re = matcher("a.b")!;
    expect(matchSpans("A.B axb a.b", re)).toEqual([[0, 3], [8, 11]]);
    expect(matchSpans("A.B axb a.b", matcher("a.b", true)!)).toEqual([[8, 11]]);
    expect(matchSpans("x (y) [z] \\ / $", matcher("(y) [z] \\ / $")!)).toEqual([[2, 15]]);
  });
  test("non-overlapping, umlauts fold case, empty query matches nothing", () => {
    expect(matchSpans("aaaa", matcher("aa")!)).toEqual([[0, 2], [2, 4]]);
    expect(matchSpans("Änderung änderung", matcher("ÄNDERUNG")!)).toEqual([[0, 8], [9, 17]]);
    expect(matcher("")).toBeUndefined();
  });
  test("the same regex can be reused (lastIndex is reset)", () => {
    const re = matcher("x")!;
    expect(matchSpans("x x", re).length).toBe(2);
    expect(matchSpans("x x", re).length).toBe(2);
  });
});

describe("units and hits", () => {
  const items: TimelineItem[] = [
    { k: "user", id: "u1", text: "Fix the Parser please" },
    { k: "thinking", id: "th", text: "the parser looks off" },
    { k: "text", id: "a1", text: "I changed **parser.ts**" },
    {
      k: "tools", id: "g1", calls: [
        call("b1", "bash", { detail: "bun test", out: ["ok", "parser: 3 pass"] }),
        call("r1", "read", { detail: "src/lexer.ts" }),
        call("t1", "todo", { todo: [{ name: "Parser", tasks: [{ content: "fix it", status: "pending" }] }] }),
      ],
    },
    { k: "ask", id: "q1", question: "Ship the parser?", options: ["Ja", "Nein"] },
    { k: "end", id: "e1", ms: 1, status: "done" },
  ];
  const units = findUnits(chatView(items), (s) => s.toUpperCase());

  test("one unit per message, one per card; folded cards keyed by their call", () => {
    expect(units.map((u) => [u.item, u.key, u.role])).toEqual([
      ["u1", "u1", "user"], ["th", "th", "other"], ["a1", "a1", "agent"],
      ["g1", "b1", "other"], ["g1", "r-r1", "other"], ["g1", "t1", "other"], ["q1", "q1", "agent"],
    ]);
    // thinking is searched the way the chat shows it
    expect(units[1]!.text).toBe("THE PARSER LOOKS OFF");
  });

  test("hits across the chat, scope and case filter them", () => {
    const all = unitHits(units, "parser");
    expect([...all.items]).toEqual(["u1", "th", "a1", "g1", "q1"]);
    expect([...all.reveal]).toEqual(["u1", "th", "a1", "b1", "t1", "q1"]);
    expect([...unitHits(units, "parser", { scope: "user" }).items]).toEqual(["u1"]);
    expect([...unitHits(units, "parser", { scope: "agent" }).items]).toEqual(["a1", "q1"]);
    expect([...unitHits(units, "Parser", { caseSensitive: true }).reveal]).toEqual(["u1", "t1"]);
    expect(unitHits(units, "").items.size).toBe(0);
  });

  test("callText covers what folded cards hide", () => {
    const text = callText(call("e", "edit", {
      file: "/a/b.ts", diff: [{ lines: [{ t: "+", text: "const hidden = 1" }] }],
      matches: [{ file: "c.ts", lines: [{ n: 3, text: "grep hit" }] }], links: [{ title: "Docs", url: "https://x.dev" }],
      sub: { answer: "subagent says hi" },
    }));
    for (const s of ["/a/b.ts", "const hidden", "grep hit", "Docs", "https://x.dev", "subagent says hi"]) expect(text.includes(s)).toBe(true);
  });

  test("itemKind: ruler colours, finished turns render nothing", () => {
    expect(items.map(itemKind)).toEqual(["user", "think", "agent", "tool", "ask", undefined]);
    expect(itemKind({ k: "tools", id: "x", calls: [call("a", "bash", { status: "error" })] })).toBe("err");
    expect(itemKind({ k: "end", id: "x", ms: 1, status: "error" })).toBe("err");
  });
});

describe("ruler layout", () => {
  const f: RulerFrame = { content: 10_000, viewport: 500, ruler: 500 };

  test("scale: whole chat fits, a short chat keeps its real size", () => {
    expect(rulerScale(f)).toBe(0.05);
    expect(rulerScale({ content: 200, viewport: 500, ruler: 500 })).toBe(1);
  });

  test("bars: scaled, minimum height, touching neighbours of one kind merge", () => {
    const bars = rulerBars([
      { top: 0, height: 100, kind: "user" },
      { top: 112, height: 4, kind: "agent" },
      { top: 128, height: 4, kind: "agent" },
      { top: 2000, height: 40, kind: "agent" },
    ], f);
    // the agent blocks get the 1 px minimum (5.6 and 6.4) and merge into one bar from 5.6 to 7.4
    expect(bars.map((b) => ({ ...b, y: +b.y.toFixed(2), h: +b.h.toFixed(2) }))).toEqual([
      { y: 0, h: 5, kind: "user" },
      { y: 5.6, h: 1.8, kind: "agent" },
      { y: 100, h: 2, kind: "agent" },
    ]);
  });

  test("thousands of items stay about one bar per ruler pixel", () => {
    const blocks = Array.from({ length: 5000 }, (_, i) => ({ top: i * 40, height: 28, kind: i % 7 ? ("agent" as const) : ("tool" as const) }));
    const bars = rulerBars(blocks, { content: 200_000, viewport: 800, ruler: 800 });
    expect(bars.length < 800 * 2).toBe(true);
  });

  test("viewport box: real size, grows to a minimum in long chats, stays inside", () => {
    expect(viewportBox(f, 1000)).toEqual({ y: 50, h: 25 });
    const long = { content: 1_000_000, viewport: 500, ruler: 500 };
    expect(viewportBox(long, 0)).toEqual({ y: 0, h: 16 });
    expect(viewportBox(long, 999_500)).toEqual({ y: 484, h: 16 });
    expect(viewportBox({ content: 200, viewport: 500, ruler: 500 }, 0)).toEqual({ y: 0, h: 500 });
  });

  test("click → scroll position centred there, clamped", () => {
    expect(scrollForRuler(f, 250)).toBe(4750);
    expect(scrollForRuler(f, 0)).toBe(0);
    expect(scrollForRuler(f, 500)).toBe(9500);
  });

  test("markers: one per bucket, the first hit wins; a click picks the nearest", () => {
    const rows = markerRows([0, 10, 100, 2000, 2010, 9990], f);
    expect(rows).toEqual([{ y: 0, index: 0 }, { y: 5, index: 2 }, { y: 100, index: 3 }, { y: 499.5, index: 5 }]);
    expect(markerAt(rows, 102)).toBe(3);
    expect(markerAt(rows, 3)).toBe(2);
    expect(markerAt(rows, 300)).toBeUndefined();
  });
});
