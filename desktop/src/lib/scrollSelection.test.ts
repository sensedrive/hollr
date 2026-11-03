import { describe, expect, test } from "bun:test";
import { cleanSelection, ScrollSelection } from "./scrollSelection";

/** a scrolled view of `doc`: `rows` lines starting at `top` */
const view = (doc: string[], top: number, rows: number) => doc.slice(top, top + rows);
const doc = Array.from({ length: 40 }, (_, i) => `zeile ${i}`);

describe("ScrollSelection", () => {
  test("scrolling up adds the lines above and keeps the anchor on its text", () => {
    const sel = new ScrollSelection(view(doc, 30, 8), 2, 0); // anchor on "zeile 32"
    expect(sel.update(view(doc, 27, 8))).toBe(true);
    expect(sel.update(view(doc, 21, 8))).toBe(true);
    expect(sel.top).toBe(0);
    expect(sel.lines[sel.anchor.line]).toBe("zeile 32");
    // dragged above the screen: from the first visible line's start down to just before the anchor cell
    expect(sel.text(sel.point(-1, 5, 8))).toBe(`${doc.slice(21, 32).join("\n")}\n`);
  });

  test("scrolling back down reuses the lines already collected", () => {
    const sel = new ScrollSelection(view(doc, 30, 8), 0, 0);
    sel.update(view(doc, 24, 8));
    const known = sel.lines.length;
    expect(sel.update(view(doc, 27, 8))).toBe(true);
    expect(sel.lines.length).toBe(known);
    expect(sel.lines[sel.top]).toBe("zeile 27");
  });

  test("dragging below the screen after the drag started high selects to the last line's end", () => {
    const sel = new ScrollSelection(view(doc, 0, 8), 6, 3);
    sel.update(view(doc, 5, 8));
    expect(sel.text(sel.point(8, 0, 8))).toBe(`le 6\n${doc.slice(7, 13).join("\n")}`);
  });

  test("a screen that matches nowhere (a frame half drawn) changes nothing", () => {
    const sel = new ScrollSelection(view(doc, 10, 8), 0, 0);
    const garbled = view(doc, 7, 8).map((l, i) => (i % 2 ? l : `x${l}`));
    expect(sel.update(garbled)).toBe(false);
    expect(sel.top).toBe(0);
    expect(sel.lines).toEqual(view(doc, 10, 8));
  });

  test("blank lines alone don't place a screen", () => {
    const sel = new ScrollSelection(["a", "", "", "", "b"], 0, 0);
    expect(sel.update(["", "", "", "", ""])).toBe(false);
  });
});

describe("cleanSelection", () => {
  test("drops a TUI's right padding, shared left margin and trailing empty lines", () => {
    expect(cleanSelection("  erste   \n    zwei  \n      drei\n\n")).toBe("erste\nzwei\n  drei");
  });
});
