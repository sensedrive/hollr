import { describe, expect, test } from "bun:test";
import {
  entryOf, missing, needsMerge, newerPrefs, toAnswer, toRemove, union, type LocalServer, type Machine,
} from "../src/lib/machinesSync";

const m = (fp: string, updatedAt: number, extra: Partial<Machine> = {}): Machine => ({
  fp, label: fp.toUpperCase(), addresses: [`${fp}.local`], port: 22, user: "u", updatedAt, ...extra,
});
const server = (fp: string, updatedAt: number): LocalServer => ({
  id: `id-${fp}`, label: fp.toUpperCase(), addresses: [`${fp}.local`], port: 22, user: "u", hostFingerprint: fp, updatedAt,
});

describe("union", () => {
  test("newest per machine wins, equal times keep the first", () => {
    const all = union([[m("a", 5), m("b", 1)], [m("a", 7, { label: "neu" }), m("b", 1, { label: "später" }), m("c", 2)]]);
    expect(all.get("a")?.label).toBe("neu");
    expect(all.get("b")?.label).toBe("B");
    expect([...all.keys()].sort()).toEqual(["a", "b", "c"]);
  });

  test("a removal spreads like an addition, a later pairing brings it back", () => {
    expect(union([[m("a", 1)], [m("a", 9, { removed: true })]]).get("a")?.removed).toBe(true);
    expect(union([[m("a", 9, { removed: true })], [m("a", 10)]]).get("a")?.removed).toBeUndefined();
  });
});

describe("what to do here", () => {
  test("remove: removed elsewhere later than paired here – not an older removal", () => {
    const all = union([[m("a", 9, { removed: true }), m("b", 3, { removed: true })]]);
    const servers = [server("a", 1), server("b", 5)];
    expect(toRemove(all, servers)).toEqual([{ server: servers[0]!, at: 9 }]);
  });

  test("missing: alive, not paired here, not removed here later", () => {
    const all = union([[m("a", 1), m("b", 4), m("c", 4), m("d", 2, { removed: true })]]);
    const stones = [m("c", 6, { removed: true })];
    expect(missing(all, [server("a", 1)], stones).map((x) => x.fp)).toEqual(["b"]);
    // paired again elsewhere after the removal here: missing again
    expect(missing(union([[m("c", 8)]]), [], stones).map((x) => x.fp)).toEqual(["c"]);
  });

  test("entryOf: a paired server as a machine entry", () => {
    expect(entryOf(server("a", 3))).toEqual(m("a", 3));
  });
});

describe("needsMerge", () => {
  test("only when the server lacks something newer from here", () => {
    const doc = { machines: [m("a", 5)], prefs: { snippets: { value: ["x"], updatedAt: 4 } } };
    expect(needsMerge(doc, [m("a", 5)], { snippets: { value: ["y"], updatedAt: 4 } })).toBe(false);
    expect(needsMerge(doc, [m("a", 3)], {})).toBe(false);
    expect(needsMerge(doc, [m("a", 6)], {})).toBe(true);
    expect(needsMerge(doc, [m("b", 1)], {})).toBe(true);
    expect(needsMerge(doc, [], { snippets: { value: ["y"], updatedAt: 5 } })).toBe(true);
    expect(needsMerge(doc, [], { vocabulary: { value: "v", updatedAt: 1 } })).toBe(true);
  });
});

describe("toAnswer", () => {
  const req = (fp: string, install: string, at = 1) => ({ fp, install, name: "iPhone", at });

  test("other installations' requests for machines paired here, once each", () => {
    const paired = new Map([["a", "id-a"], ["b", "id-b"]]);
    const out = toAnswer(
      [
        { server: "id-a", requests: [req("b", "phone"), req("a", "me"), req("z", "phone")] },
        { server: "id-b", requests: [req("b", "phone"), req("a", "phone", 2)] },
      ],
      "me",
      paired,
      new Set(["a|phone|2"]),
    );
    expect(out).toEqual([{ source: "id-a", via: "id-b", request: req("b", "phone") }]);
  });

  test("a newer request of the same installation is answered again", () => {
    const out = toAnswer([{ server: "s", requests: [req("a", "phone", 5)] }], "me", new Map([["a", "id-a"]]), new Set(["a|phone|1"]));
    expect(out.length).toBe(1);
  });
});

describe("newerPrefs", () => {
  test("newest value per setting", () => {
    expect(newerPrefs([
      { snippets: { value: ["a"], updatedAt: 2 }, vocabulary: { value: "x", updatedAt: 9 } },
      undefined,
      { snippets: { value: ["b"], updatedAt: 3 } },
    ])).toEqual({ snippets: { value: ["b"], updatedAt: 3 }, vocabulary: { value: "x", updatedAt: 9 } });
  });
});
