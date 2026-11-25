import { describe, expect, test } from "bun:test";
import { checkSummary, copyRows, nextStep, queueMove, sizeText, switchBlocked, switchTargets } from "./machine";
import type { CheckItem, Run, Server, SetupCheck, SetupFileInfo, Status } from "./types";

const server = (id: string, online = true): Server => ({ id, label: id, self: id === "mac", online });
const idle: Status = { machine: { host: "x" }, runs: [], lock: null };
const running: Status = { ...idle, runs: [{ status: "running", project: "ilims" } as Run] };

describe("switch targets", () => {
  test("other machines: with the project first, then to set up, busy, offline", () => {
    const targets = switchTargets(
      [server("mac"), server("zeta"), server("workr"), server("box"), server("old", false)],
      "mac",
      (id) => id === "workr",
      new Map([["box", running]]),
    );
    expect(targets.map((t) => [t.server.id, t.kind, t.reason])).toEqual([
      ["workr", "ready", null],
      ["zeta", "setup", null],
      ["box", "busy", "Lauf läuft (ilims)"],
      ["old", "offline", "offline"],
    ]);
  });

  test("the source can't switch while it runs or with an empty queue", () => {
    expect(switchBlocked(running, 6)).toContain("Lauf");
    expect(switchBlocked({ ...idle, lock: { project: "ilims" } as Status["lock"] }, 6)).toContain("Lauf");
    expect(switchBlocked(idle, 0)).toBe("Die Warteschlange ist leer – es gibt nichts umzuziehen.");
    expect(switchBlocked(undefined, 2)).toBeNull();
  });
});

describe("queue move", () => {
  test("appended in source order behind the target's lane; flags move along, the source empties", () => {
    const flags = { deploy: true, testnote: false, video: false };
    const m = queueMove([354, 352, 355], { order: [352, 354, 355, 9], tickets: { "352": flags } }, [700, 355]);
    expect(m.target).toEqual({ order: [700, 355, 354, 352], tickets: { "352": flags } });
    expect(m.source).toEqual({ order: [9], tickets: { "352": null } });
    expect(queueMove([1, 2], undefined, []).source).toEqual({ order: [], tickets: {} });
  });
});

describe("setup steps", () => {
  const item = (id: string, ok: boolean, hint = false): CheckItem => ({ id, label: id, ok, detail: "", fix: null, hint });

  test("summary: what is missing apart from hints", () => {
    expect(checkSummary([item("a", true), item("b", false), item("c", false), item("central", false, true)])).toBe("1 von 4 ok · 2 fehlen · 1 Hinweis");
    expect(checkSummary([item("a", true)])).toBe("1 von 1 ok");
  });
  const check = (over: Partial<SetupCheck>, items: CheckItem[]): SetupCheck => ({
    host: "workr",
    slug: "acme/shop",
    path: "/p",
    cloned: true,
    known: false,
    pm: { name: "yarn", lockfile: "yarn.lock", version: "4.12.0" },
    items,
    jobs: { clone: null, install: null },
    ...over,
  });

  test("clone → files → install → checklist", () => {
    const missing = [item("file:.env", false), item("deps", false)];
    expect(nextStep(check({ cloned: false }, missing), false, false)).toBe("clone");
    expect(nextStep(check({}, missing), false, false)).toBe("files");
    expect(nextStep(check({}, missing), true, false)).toBe("install");
    expect(nextStep(check({}, missing), true, true)).toBe("check");
    expect(nextStep(check({ pm: null }, [item("file:.env", true), item("deps", true)]), false, false)).toBe("check");
  });

  test("copy rows: only what the source has, marked when the target has it too", () => {
    const f = (path: SetupFileInfo["path"], exists: boolean): SetupFileInfo => ({ path, exists, size: 1, secret: false, keys: [] });
    const rows = copyRows([f(".lul-workr.json", true), f(".env", false), f(".sandcastle/.env", true)], [f(".sandcastle/.env", true)]);
    expect(rows.map((r) => [r.file.path, r.onTarget])).toEqual([
      [".lul-workr.json", false],
      [".sandcastle/.env", true],
    ]);
  });

  test("sizes in German", () => {
    expect(sizeText(821)).toBe("821 B");
    expect(sizeText(1524)).toBe("1,5 KB");
  });
});
