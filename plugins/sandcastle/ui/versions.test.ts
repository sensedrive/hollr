import { describe, expect, test } from "bun:test";
import type { LulWorkrFacts, Project, Server } from "./types";
import { cellLabel, cellState, type MachineVersions, newer, summary, versionRows } from "./versions";

const server = (id: string, online = true): Server => ({ id, label: id, self: id === "mac", online });
const project = (slug: string, lulWorkr?: Partial<LulWorkrFacts>): Project =>
  ({
    slug,
    name: slug.split("/")[1],
    ...(lulWorkr ? { lulWorkr: { required: null, configVersion: null, mode: "forked", satisfied: null, ...lulWorkr } } : {}),
  }) as Project;
const machine = (m: Partial<MachineVersions> = {}): MachineVersions => ({
  server: server("mac"),
  installed: "1.1.0",
  latest: "1.1.0",
  error: null,
  ...m,
});
const bundle = (satisfied: boolean | null, required = "^1.1") => project("ll/ilims", { mode: "bundle", required, configVersion: 1, satisfied });

describe("version cells", () => {
  test("bundle: passt, Update verfügbar, Bereich nicht erfüllt", () => {
    expect(cellState(bundle(true), machine())).toBe("ok");
    expect(cellLabel("ok", bundle(true), machine())).toBe("^1.1");
    const newer12 = machine({ latest: "1.2.0" });
    expect(cellState(bundle(true), newer12)).toBe("update");
    expect(cellLabel("update", bundle(true), newer12)).toBe("^1.1 · neu 1.2.0");
    // not satisfied wins over a newer release
    expect(cellState(bundle(false, "^1.2"), newer12)).toBe("unmet");
    expect(cellLabel("unmet", bundle(false, "^1.2"), newer12)).toBe("^1.2 · hat 1.1.0");
    // latest unknown: no update hint
    expect(cellState(bundle(true), machine({ latest: undefined }))).toBe("ok");
  });

  test("forked, not checked out, offline, no answer, older hollr", () => {
    expect(cellState(project("ll/tendr", { mode: "forked" }), machine())).toBe("forked");
    expect(cellState(project("ll/x", { mode: "none" }), machine())).toBe("none");
    expect(cellState(undefined, machine())).toBe("absent");
    expect(cellState(bundle(true), machine({ server: server("pi", false) }))).toBe("offline");
    expect(cellState(undefined, machine({ server: server("pi", false) }))).toBe("offline");
    const silent = machine({ error: "Status: Hollr antwortet nicht" });
    expect(cellState(bundle(true), silent)).toBe("unknown");
    expect(cellLabel("unknown", bundle(true), silent)).toBe("keine Antwort");
    expect(cellState(project("ll/old"), machine())).toBe("unknown");
    expect(cellLabel("unknown", project("ll/old"), machine())).toBe("unbekannt");
  });

  test("newer compares numerically, unknown is never newer", () => {
    expect(newer("1.10.0", "1.9.9")).toBe(true);
    expect(newer("v1.1.0", "1.1.0")).toBe(false);
    expect(newer(undefined, "1.1.0")).toBe(false);
    expect(newer("1.2.0", null)).toBe(false);
  });
});

describe("version rows", () => {
  test("one row per repo; forked on any machine stays forked; summary counts", () => {
    const rows = versionRows(
      new Map([
        ["mac", [bundle(true), project("ll/tendr", { mode: "forked" }), { ...project("ll/bad"), error: "kaputt" } as Project]],
        ["workr", [project("ll/ilims", { mode: "forked" }), project("ll/haccp", { mode: "forked" })]],
      ]),
    );
    expect(rows).toEqual([
      { slug: "ll/haccp", name: "haccp", mode: "forked", range: null },
      // migrated on one machine, still forked on the other: forked, the range known from the migrated checkout
      { slug: "ll/ilims", name: "ilims", mode: "forked", range: "^1.1" },
      { slug: "ll/tendr", name: "tendr", mode: "forked", range: null },
    ]);
    const migrated = versionRows(new Map([["mac", [bundle(true)]], ["workr", [bundle(false)]]]));
    expect(migrated).toEqual([{ slug: "ll/ilims", name: "ilims", mode: "bundle", range: "^1.1" }]);
    expect(summary(rows, 0)).toBe("3 Projekte · 0 auf dem Bundle, 3 noch abgezweigt");
    expect(summary(migrated, 1)).toBe("1 Projekt · 1 auf dem Bundle, 0 noch abgezweigt · 1 Bereich nicht erfüllt");
  });
});
