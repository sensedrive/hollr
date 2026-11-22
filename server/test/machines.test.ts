import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Machine, machines, mergeMachines } from "../src/machines";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hollr-machines-"));
  Bun.env.HOLLR_STATE_DIR = dir;
});
afterEach(() => {
  delete Bun.env.HOLLR_STATE_DIR;
  rmSync(dir, { recursive: true, force: true });
});

const m = (fp: string, updatedAt: number, extra: Partial<Machine> = {}): Machine => ({
  fp,
  label: fp,
  addresses: ["10.0.0.1"],
  port: 22,
  user: "u",
  updatedAt,
  ...extra,
});

test("the newest entry of a machine wins – a removal spreads, a later pairing brings it back", () => {
  const a = mergeMachines([], [m("X", 1), m("Y", 1)]);
  const removed = mergeMachines(a, [m("X", 5, { removed: true })]);
  expect(removed.find((x) => x.fp === "X")?.removed).toBe(true);
  expect(mergeMachines(removed, [m("X", 3)]).find((x) => x.fp === "X")?.removed).toBe(true);
  expect(mergeMachines(removed, [m("X", 9)]).find((x) => x.fp === "X")?.removed).toBeUndefined();
});

test("a request is answered by an invite, which only the asking app can take, once", () => {
  machines({ op: "merge", machines: [m("X", 1)] });
  const asked = machines({ op: "request", fp: "X", install: "phone", name: "iPhone" });
  expect(asked.requests?.map((r) => r.install)).toEqual(["phone"]);
  const invited = machines({ op: "invite", fp: "X", install: "phone", url: "hollr://pair?c=abc" });
  expect(invited.requests).toEqual([]);
  // the doc never hands out invites except to `take`
  expect("invites" in machines({ op: "get" })).toBe(false);
  expect(machines({ op: "take", install: "mac" }).taken).toEqual([]);
  expect(machines({ op: "take", install: "phone" }).taken?.map((i) => i.url)).toEqual([
    "hollr://pair?c=abc",
  ]);
  expect(machines({ op: "take", install: "phone" }).taken).toEqual([]);
  // it holds a pairing secret
  expect(statSync(join(dir, "machines.json")).mode & 0o777).toBe(0o600);
});

test("expired invites are gone", () => {
  machines({ op: "invite", fp: "X", install: "phone", url: "hollr://pair?c=abc" }, 1000);
  expect(machines({ op: "take", install: "phone" }, 1000 + 11 * 60_000).taken).toEqual([]);
});

test("the user's snippets and vocabulary: the newest version wins on every server", () => {
  machines({ op: "merge", prefs: { snippets: { value: ["a"], updatedAt: 5 } } });
  expect(
    machines({ op: "merge", prefs: { snippets: { value: ["old"], updatedAt: 2 } } }).prefs?.snippets
      ?.value,
  ).toEqual(["a"]);
  const next = machines({
    op: "merge",
    prefs: {
      snippets: { value: ["b", "c"], updatedAt: 9 },
      vocabulary: { value: "omp = OMP", updatedAt: 1 },
    },
  });
  expect(next.prefs).toEqual({
    snippets: { value: ["b", "c"], updatedAt: 9 },
    vocabulary: { value: "omp = OMP", updatedAt: 1 },
  });
});

test("a merge or request that changes nothing doesn't write (every write wakes every app's feed)", () => {
  machines({ op: "merge", machines: [m("X", 1)] }, 1000);
  const file = join(dir, "machines.json");
  const before = statSync(file).mtimeMs;
  Bun.sleepSync(20);
  machines({ op: "merge", machines: [m("X", 1)] }, 2000);
  machines({ op: "request", fp: "X", install: "phone" }, 3000);
  const asked = statSync(file).mtimeMs;
  expect(asked).toBeGreaterThan(before);
  Bun.sleepSync(20);
  machines({ op: "request", fp: "X", install: "phone" }, 4000);
  expect(statSync(file).mtimeMs).toBe(asked);
});
