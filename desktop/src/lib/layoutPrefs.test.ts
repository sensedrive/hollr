import { describe, expect, test } from "bun:test";
import {
  AUTO_STACK_BELOW, clamp, GIT_LAYOUT, nextArrange, parseLayout, parseSidePanel, resolveArrange, sidePanelFor, SPACE_LAYOUT,
} from "./layoutPrefs";

describe("parseLayout", () => {
  test("nothing stored: the defaults", () => {
    expect(parseLayout(null, GIT_LAYOUT)).toEqual(GIT_LAYOUT);
  });
  test("stored values win, the rest stays default", () => {
    expect(parseLayout(JSON.stringify({ listW: 500, arrange: "stack" }), GIT_LAYOUT))
      .toEqual({ ...GIT_LAYOUT, listW: 500, arrange: "stack" });
    expect(parseLayout(JSON.stringify({ leftHidden: true }), SPACE_LAYOUT)).toEqual({ ...SPACE_LAYOUT, leftHidden: true });
  });
  test("wrong types, unknown keys and broken data are dropped", () => {
    expect(parseLayout(JSON.stringify({ listW: "wide", arrange: "diagonal", listHidden: 1, extra: 3 }), GIT_LAYOUT)).toEqual(GIT_LAYOUT);
    expect(parseLayout("{nope", GIT_LAYOUT)).toEqual(GIT_LAYOUT);
    expect(parseLayout("null", SPACE_LAYOUT)).toEqual(SPACE_LAYOUT);
  });
  test("does not hand out the defaults object itself", () => {
    expect(parseLayout(null, SPACE_LAYOUT)).not.toBe(SPACE_LAYOUT);
  });
  test("the git panel's tab: a known tab or the default", () => {
    expect(parseLayout(JSON.stringify({ tab: "history" }), GIT_LAYOUT).tab).toBe("history");
    expect(parseLayout(JSON.stringify({ tab: "graph" }), GIT_LAYOUT).tab).toBe("changes");
    expect(parseLayout(null, GIT_LAYOUT).tab).toBe("changes");
  });
});

describe("arrange", () => {
  test("auto stacks when narrow", () => {
    expect(resolveArrange("auto", AUTO_STACK_BELOW - 1)).toBe("stack");
    expect(resolveArrange("auto", AUTO_STACK_BELOW)).toBe("side");
    expect(resolveArrange("side", 300)).toBe("side");
    expect(resolveArrange("stack", 2000)).toBe("stack");
  });
  test("the button cycles auto → side → stack → auto", () => {
    expect(nextArrange("auto")).toBe("side");
    expect(nextArrange("side")).toBe("stack");
    expect(nextArrange("stack")).toBe("auto");
  });
});

test("clamp: min wins when there is no room", () => {
  expect(clamp(100, 200, 600)).toBe(200);
  expect(clamp(900, 200, 600)).toBe(600);
  expect(clamp(300.6, 200, 600)).toBe(301);
  expect(clamp(300, 200, 100)).toBe(200);
});

describe("side panel", () => {
  test("stored tab or closed; junk is closed", () => {
    expect(parseSidePanel("git")).toBe("git");
    expect(parseSidePanel("info")).toBe("info");
    expect(parseSidePanel("")).toBe("");
    expect(parseSidePanel(null)).toBe("");
    expect(parseSidePanel("terminal")).toBe("");
  });
  test("the panel last left open (or closed) comes back in the next session", () => {
    expect(sidePanelFor("git", undefined, false)).toBe("git");
    expect(sidePanelFor("", undefined, false)).toBe("");
    expect(sidePanelFor("browser", "terminal", false)).toBe("browser");
  });
  test("a quick action wins", () => {
    expect(sidePanelFor("", "git", false)).toBe("git");
    expect(sidePanelFor("info", "browser", false)).toBe("browser");
  });
  test("a chat with context has no Nachfragen: Git instead", () => {
    expect(sidePanelFor("chats", undefined, true)).toBe("git");
    expect(sidePanelFor("chats", undefined, false)).toBe("chats");
  });
});
