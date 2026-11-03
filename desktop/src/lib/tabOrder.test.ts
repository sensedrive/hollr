import { describe, expect, test } from "bun:test";
import { moveBefore, ordered } from "./tabOrder";

const tabs = (...ids: string[]) => ids.map((id) => ({ id }));
const ids = (xs: { id: string }[]) => xs.map((x) => x.id);

describe("ordered", () => {
  test("nothing saved: herdr's order", () => {
    expect(ids(ordered(tabs("a", "b", "c"), undefined, (x) => x.id))).toEqual(["a", "b", "c"]);
  });
  test("saved order wins, new tabs go to the end, vanished ones drop out", () => {
    expect(ids(ordered(tabs("a", "b", "c", "d"), ["c", "x", "a"], (x) => x.id))).toEqual(["c", "a", "b", "d"]);
  });
});

describe("moveBefore", () => {
  test("moves in front of another, or to the end", () => {
    expect(moveBefore(["a", "b", "c"], "c", "a")).toEqual(["c", "a", "b"]);
    expect(moveBefore(["a", "b", "c"], "a", "c")).toEqual(["b", "a", "c"]);
    expect(moveBefore(["a", "b", "c"], "a", null)).toEqual(["b", "c", "a"]);
  });
  test("in front of itself or an unknown id: no change / to the end", () => {
    expect(moveBefore(["a", "b"], "a", "a")).toEqual(["a", "b"]);
    expect(moveBefore(["a", "b"], "a", "zz")).toEqual(["b", "a"]);
  });
});
