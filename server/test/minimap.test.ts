import { describe, expect, test } from "bun:test";
import { miniLines } from "../src/minimap";

describe("miniLines", () => {
  test("length without escapes, first colour on visible text", () => {
    expect(miniLines("\x1b[1;38;2;200;100;255mWhy\x1b[0m the  ")).toEqual([[7, "#c864ff"]]);
    expect(miniLines("plain text\n\x1b[32m  ok")).toEqual([
      [10, null],
      [4, "#b5bd68"],
    ]);
  });
  test("a colour reset before text is not taken", () => {
    expect(miniLines("\x1b[31m\x1b[0mtext")).toEqual([[4, null]]);
  });
});
