import { describe, expect, test } from "bun:test";
import { parsePrefs } from "./viewPrefs";

describe("parsePrefs", () => {
  test("takes over the old chat/terminal list", () => {
    const m = parsePrefs(null, JSON.stringify([["s|w1:p1", "terminal"], ["s|w1:p2", "chat"], ["s|w1:p3", "bogus"]]));
    expect([...m]).toEqual([["s|w1:p1", { view: "terminal" }], ["s|w1:p2", { view: "chat" }]]);
  });
  test("the new store wins over the old one", () => {
    const m = parsePrefs(JSON.stringify([["s|w1:p1", { term: "shell", zen: true }]]), JSON.stringify([["s|w1:p1", "chat"]]));
    expect(m.get("s|w1:p1")).toEqual({ term: "shell", zen: true });
  });
  test("broken data: empty", () => {
    expect(parsePrefs("{nope", null).size).toBe(0);
    expect(parsePrefs(null, null).size).toBe(0);
  });
});
