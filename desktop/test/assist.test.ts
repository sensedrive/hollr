import { describe, expect, test } from "bun:test";
import {
  applyMention, DEFAULT_SNIPPETS, fitSize, insertAt, jpegName, mentionAt, move, parseSnippets,
} from "../src/lib/assist";

describe("parseSnippets", () => {
  test("missing or broken storage gives the defaults", () => {
    expect(parseSnippets(null)).toEqual(DEFAULT_SNIPPETS);
    expect(parseSnippets("{nope")).toEqual(DEFAULT_SNIPPETS);
    expect(parseSnippets('{"a":1}')).toEqual(DEFAULT_SNIPPETS);
  });

  test("keeps the user's list, drops junk, an empty list stays empty", () => {
    expect(parseSnippets(JSON.stringify([" Mach weiter. ", "", 3, "Tests?"]))).toEqual(["Mach weiter.", "Tests?"]);
    expect(parseSnippets("[]")).toEqual([]);
    expect(parseSnippets(JSON.stringify(["a", " a", "b"]))).toEqual(["a", "b"]);
  });
});

describe("move", () => {
  test("moves up and down, clamped", () => {
    expect(move(["a", "b", "c"], 2, -1)).toEqual(["a", "c", "b"]);
    expect(move(["a", "b", "c"], 0, 1)).toEqual(["b", "a", "c"]);
    expect(move(["a", "b", "c"], 0, -1)).toEqual(["a", "b", "c"]);
    expect(move(["a", "b", "c"], 2, 5)).toEqual(["a", "b", "c"]);
  });
});

describe("insertAt", () => {
  test("into an empty field", () => {
    expect(insertAt("", 0, 0, "Mach weiter.")).toEqual({ text: "Mach weiter.", caret: 12 });
  });

  test("keeps words apart on both sides", () => {
    expect(insertAt("abc", 3, 3, "x")).toEqual({ text: "abc x", caret: 5 });
    expect(insertAt("abcdef", 3, 3, "x")).toEqual({ text: "abc x def", caret: 6 });
    expect(insertAt("abc def", 4, 4, "x")).toEqual({ text: "abc x def", caret: 6 });
    expect(insertAt("abc\n", 4, 4, "x")).toEqual({ text: "abc\nx", caret: 5 });
  });

  test("replaces the selection", () => {
    expect(insertAt("ab XX cd", 3, 5, "y")).toEqual({ text: "ab y cd", caret: 4 });
  });

  test("out-of-range positions are clamped", () => {
    expect(insertAt("ab", 9, 12, "c")).toEqual({ text: "ab c", caret: 4 });
  });
});

describe("mentionAt", () => {
  test("finds @ at the start, after whitespace and after (", () => {
    expect(mentionAt("@", 1)).toEqual({ start: 0, query: "" });
    expect(mentionAt("schau @src/li", 13)).toEqual({ start: 6, query: "src/li" });
    expect(mentionAt("(@a.ts", 6)).toEqual({ start: 1, query: "a.ts" });
    expect(mentionAt("x\n@foo-bar_1", 12)).toEqual({ start: 2, query: "foo-bar_1" });
  });

  test("only right before the caret", () => {
    expect(mentionAt("@src und", 8)).toBe(null);
    expect(mentionAt("@src und", 4)).toEqual({ start: 0, query: "src" });
  });

  test("no mail addresses, no spaces in the query", () => {
    expect(mentionAt("mail@host", 9)).toBe(null);
    expect(mentionAt("@a b", 4)).toBe(null);
  });

  test("at most 80 characters", () => {
    expect(mentionAt(`@${"a".repeat(80)}`, 81)).toEqual({ start: 0, query: "a".repeat(80) });
    expect(mentionAt(`@${"a".repeat(81)}`, 82)).toBe(null);
  });
});

describe("applyMention", () => {
  test("replaces the fragment with the path and a space", () => {
    expect(applyMention("schau @src/li", 13, 6, "src/lib/api.ts")).toEqual({ text: "schau @src/lib/api.ts ", caret: 22 });
  });

  test("keeps the text after the caret, no double space", () => {
    expect(applyMention("@ap und mehr", 3, 0, "api.ts")).toEqual({ text: "@api.ts und mehr", caret: 7 });
    expect(applyMention("@apx", 3, 0, "api.ts")).toEqual({ text: "@api.ts x", caret: 8 });
  });
});

describe("fitSize", () => {
  test("small images stay as they are", () => {
    expect(fitSize(800, 600)).toEqual({ width: 800, height: 600, scaled: false });
    expect(fitSize(2048, 1000)).toEqual({ width: 2048, height: 1000, scaled: false });
  });

  test("the longer side becomes 2048", () => {
    expect(fitSize(4096, 3072)).toEqual({ width: 2048, height: 1536, scaled: true });
    expect(fitSize(3000, 4000)).toEqual({ width: 1536, height: 2048, scaled: true });
  });

  test("never collapses to zero", () => {
    expect(fitSize(100_000, 10)).toEqual({ width: 2048, height: 1, scaled: true });
  });
});

describe("jpegName", () => {
  test("swaps the extension", () => {
    expect(jpegName("Bildschirmfoto.png")).toBe("Bildschirmfoto.jpg");
    expect(jpegName("a.b.heic")).toBe("a.b.jpg");
  });

  test("pasted images get a stamped name", () => {
    expect(jpegName("", new Date("2026-10-15T09:08:07Z"))).toBe("bild-20261015090807.jpg");
  });
});
