import { describe, expect, test } from "bun:test";
import { forksAfterParents, moveBefore, orderAfterMove, ordered } from "./tabOrder";

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

describe("forksAfterParents", () => {
  const sort = (parents: Record<string, string>, ...order: string[]) =>
    ids(forksAfterParents(tabs(...order), (x) => x.id, (x) => parents[x.id]));
  test("a chat with context follows its session's tab, several in their order", () => {
    expect(sort({ f1: "a", f2: "a" }, "a", "b", "f1", "f2", "c")).toEqual(["a", "f1", "f2", "b", "c"]);
    expect(sort({ f1: "c" }, "f1", "a", "c")).toEqual(["a", "c", "f1"]);
  });
  test("a fork of a fork hangs off that one; an unknown parent keeps its place", () => {
    expect(sort({ f1: "a", g: "f1" }, "g", "a", "b", "f1")).toEqual(["a", "f1", "g", "b"]);
    expect(sort({ f1: "gone" }, "a", "f1", "b")).toEqual(["a", "f1", "b"]);
  });
  test("a parent cycle loses no tab", () => {
    expect(sort({ x: "y", y: "x" }, "a", "x", "y").sort()).toEqual(["a", "x", "y"]);
  });
});

describe("orderAfterMove", () => {
  // the server lists a..e; c and e are hidden, so the sidebar shows a, b, d
  const all = ["a", "b", "c", "d", "e"];
  const saved = ["d", "c", "a", "e", "b"];

  test("a space not shown keeps its place – the saved order never shrinks by hidden ones", () => {
    // drag b in front of d (the shown order is d, a, b)
    expect(orderAfterMove(all, saved, "b", "d")).toEqual(["b", "d", "c", "a", "e"]);
    // to the end of the shown list
    expect(orderAfterMove(all, saved, "d", null)).toEqual(["c", "a", "e", "b", "d"]);
  });

  test("only ids that no longer exist drop out; new ones follow in their own order", () => {
    expect(orderAfterMove(["a", "b", "x"], ["gone", "b", "a"], "x", "b")).toEqual(["x", "b", "a"]);
  });

  test("nothing saved yet: the existing order with the move", () => {
    expect(orderAfterMove(all, undefined, "e", "a")).toEqual(["e", "a", "b", "c", "d"]);
    expect(orderAfterMove(all, [], "a", null)).toEqual(["b", "c", "d", "e", "a"]);
  });
});
