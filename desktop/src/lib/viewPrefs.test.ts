import { describe, expect, test } from "bun:test";
import { initialView, parsePrefs } from "./viewPrefs";

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

describe("initialView", () => {
  const omp = { agent: "omp", fork: false, last: "chat" as const };
  test("as last left in this session", () => {
    expect(initialView({ ...omp, saved: "terminal" })).toBe("terminal");
    expect(initialView({ ...omp, saved: "chat", last: "terminal" })).toBe("chat");
  });
  test("a session never set uses the last choice made anywhere", () => {
    expect(initialView({ ...omp, last: "terminal" })).toBe("terminal");
    expect(initialView({ ...omp, last: "chat" })).toBe("chat");
  });
  test("a dashboard Terminal click wins; plain shells are terminals", () => {
    expect(initialView({ ...omp, saved: "chat", open: "terminal" })).toBe("terminal");
    expect(initialView({ fork: false, last: "chat" })).toBe("terminal");
  });
  test("a chat with context is always a chat", () => {
    expect(initialView({ ...omp, fork: true, saved: "terminal", last: "terminal" })).toBe("chat");
    expect(initialView({ fork: true, last: "terminal" })).toBe("chat");
    expect(initialView({ agent: "shell", fork: true, open: "terminal", last: "chat" })).toBe("terminal");
  });
});
