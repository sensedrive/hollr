import { describe, expect, test } from "bun:test";
import {
  applyChanges, dropServer, effective, emptyShared, migrationChanges, normalize, sameValue, staleEntries, toFront,
  type Legacy,
} from "../src/lib/sharedState";

describe("normalize", () => {
  test("keeps well-formed entries, drops the rest", () => {
    const doc = normalize({
      seen: { p1: 5, p2: "x" },
      unread: { p1: true, p2: 1 },
      mySessions: ["p1", 2],
      spaceOrder: ["w1"],
      tabOrder: { w1: ["t1"], w2: "t" },
      extra: 1,
    });
    expect(doc.seen).toEqual({ p1: 5 });
    expect(doc.unread).toEqual({ p1: true });
    expect(doc.mySessions).toEqual([]);
    expect(doc.spaceOrder).toEqual(["w1"]);
    expect(doc.tabOrder).toEqual({ w1: ["t1"] });
    expect(normalize(null)).toEqual(emptyShared());
  });
});

describe("changes", () => {
  test("applyChanges sets and removes map entries and whole lists, leaving the input alone", () => {
    const before = { ...emptyShared(), seen: { p1: 1 }, mySessions: ["a"] };
    const after = applyChanges(before, [
      { path: ["seen", "p2"], value: 2 },
      { path: ["seen", "p1"], value: null },
      { path: ["mySessions"], value: ["b", "a", "b"] },
    ]);
    expect(after.seen).toEqual({ p2: 2 });
    expect(after.mySessions).toEqual(["b", "a"]);
    expect(before.seen).toEqual({ p1: 1 });
  });

  test("effective: an unchanged value is never sent", () => {
    const doc = { ...emptyShared(), seen: { p1: 1 }, unread: { p1: true as const }, spaceOrder: ["a", "b"] };
    expect(effective(doc, [
      { path: ["seen", "p1"], value: 1 },
      { path: ["unread", "p2"], value: null },
      { path: ["spaceOrder"], value: ["a", "b"] },
      { path: ["mySessions"], value: [] },
    ])).toEqual([]);
    expect(effective(doc, [{ path: ["seen", "p1"], value: 2 }, { path: ["spaceOrder"], value: ["b", "a"] }]).length).toBe(2);
  });

  test("sameValue: null, absent and an empty list match", () => {
    expect(sameValue(undefined, null)).toBe(true);
    expect(sameValue([], null)).toBe(true);
    expect(sameValue(["a"], ["a"])).toBe(true);
    expect(sameValue(["a"], ["b"])).toBe(false);
    expect(sameValue(0, null)).toBe(false);
  });

  test("toFront moves to the front and keeps at most max", () => {
    expect(toFront(["a", "b", "c"], "c")).toEqual(["c", "a", "b"]);
    expect(toFront(["a", "b"], "x", 2)).toEqual(["x", "a"]);
  });

  test("staleEntries removes orders of spaces that are gone", () => {
    expect(staleEntries("tabOrder", { w1: [], w2: [] }, new Set(["w1"]))).toEqual([{ path: ["tabOrder", "w2"], value: null }]);
  });
});

describe("migration", () => {
  const local: Legacy = {
    mySessions: ["s1|p1", "s2|p9", "s1|p2"],
    spaceOrder: { s1: ["w2", "w1"], s2: ["x"] },
    worktreeOrder: { "s1|w1": ["w3", "w4"], "s2|x": ["y"] },
    tabOrder: { servers: ["s2", "s1"], "s1|w1": ["t2", "t1"], "gone|w": ["t"] },
  };

  test("this server's values, without the server prefix, for empty keys only", () => {
    expect(migrationChanges(emptyShared(), "s1", local)).toEqual([
      { path: ["mySessions"], value: ["p1", "p2"] },
      { path: ["spaceOrder"], value: ["w2", "w1"] },
      { path: ["worktreeOrder", "w1"], value: ["w3", "w4"] },
      { path: ["tabOrder", "w1"], value: ["t2", "t1"] },
    ]);
    const filled = { ...emptyShared(), mySessions: ["p7"], tabOrder: { w9: ["t"] } };
    expect(migrationChanges(filled, "s1", local).map((c) => c.path[0])).toEqual(["spaceOrder", "worktreeOrder"]);
    expect(migrationChanges(emptyShared(), "s3", local)).toEqual([]);
  });

  test("dropServer keeps other paired servers and the server tabs' own order", () => {
    expect(dropServer(local, "s1", ["s1", "s2"])).toEqual({
      mySessions: ["s2|p9"],
      spaceOrder: { s2: ["x"] },
      worktreeOrder: { "s2|x": ["y"] },
      tabOrder: { servers: ["s2", "s1"] },
    });
  });
});
