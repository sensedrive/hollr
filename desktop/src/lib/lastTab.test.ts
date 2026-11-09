import { describe, expect, test } from "bun:test";
import { parseLastTabs, restoreTab } from "./lastTab";

describe("restoreTab", () => {
  test("the remembered session while it's still in the space", () => {
    expect(restoreTab("w1:p3", ["w1:p1", "w1:p3"])).toEqual({ pane: "w1:p3" });
  });
  test("the overview tab when that was selected last", () => {
    expect(restoreTab("", ["w1:p1"])).toEqual({ overview: true });
  });
  test("nothing when the session was closed or nothing was remembered", () => {
    expect(restoreTab("w1:p3", ["w1:p1"])).toBeUndefined();
    expect(restoreTab(undefined, ["w1:p1"])).toBeUndefined();
  });
});

describe("parseLastTabs", () => {
  test("keeps string entries, survives junk", () => {
    expect(parseLastTabs('{"s|w1":"w1:p2","s|w2":"","s|w3":4}')).toEqual({ "s|w1": "w1:p2", "s|w2": "" });
    expect(parseLastTabs("not json")).toEqual({});
    expect(parseLastTabs("[1]")).toEqual({});
    expect(parseLastTabs(null)).toEqual({});
  });
});
