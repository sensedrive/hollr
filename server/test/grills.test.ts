import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CollectInput,
  collectGrills,
  grillLabel,
  grillPrompt,
  type GrillRecord,
  parseGrillLabel,
  parseStatusMd,
  readGrillRecords,
  recordGrill,
  validateGrillRequest,
} from "../src/grills";
import type { Agent } from "../src/herdr";

// ~/PhpstormProjects/leicht+luftig/tackline/tendr/.scratch/TENDR-1070/STATUS.md
const REAL = `# TENDR-1070 Grill-Status

Grill-Ticket: #3533

- [x] 1 Ticket gelesen (keine Kommentare)
- [x] 2 Grill (3 Runden, Ergebnis #3533 Kommentar 7096554391)
- [x] 3 Jira-Kommentar 42640, #3533 geschlossen
- [x] 4 Spec/ADR-PR #3539 gemergt (…)
- [ ] 5 Entwurf
- [ ] 6 Story/Kinder
- [ ] 7 Bericht
- [ ] 5 Entwurf läuft (Agent EntwurfBelegExport)
- Entwurf: Exporte v285, Dialog v286 abgenommen bis auf Kalender; …
- [x] 5 Entwürfe v283–v290 (Exporte), v286 (Dialog), v287 (Kalender)
- [x] 6 Story #3540, Kinder #3542 #3543 …
- [x] 7 Jira-Kommentare 42642 (1070), 42643 (1069), Weblinks, GitHub-Abschnitt; Worktree entfernt
`;

const done = (md: string) =>
  parseStatusMd(md)
    .steps.filter((s) => s.done)
    .map((s) => s.n);

const root = mkdtempSync(join(tmpdir(), "hollr-grills-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("STATUS.md", () => {
  test("the real file: the later [x] for step 5 wins, ticket and notes", () => {
    const s = parseStatusMd(REAL.split("\n- [x] 5")[0] ?? "");
    expect(s.step).toBe(5);
    expect(s.n).toBe(3533);
    expect(done(REAL.split("\n- [x] 5")[0] ?? "")).toEqual([1, 2, 3, 4]);

    const all = parseStatusMd(REAL);
    expect(all.step).toBe(8);
    expect(all.steps.map((x) => [x.n, x.label, x.done])).toEqual([
      [1, "Ticket gelesen", true],
      [2, "Grill", true],
      [3, "JIRA-Kommentar", true],
      [4, "Spec/ADR-PR", true],
      [5, "Entwürfe", true],
      [6, "Story & Kinder", true],
      [7, "Bericht", true],
    ]);
    expect(all.notes).toEqual([
      "Grill-Ticket: #3533",
      "- Entwurf: Exporte v285, Dialog v286 abgenommen bis auf Kalender; …",
    ]);
  });

  test("plain bullets: Erledigt/Offen sections, started steps, sub-steps, Schritt N/M", () => {
    const md = `# TENDR-1037 · Grill-Stand
Grill-Ticket: https://github.com/o/r/issues/3313

## Erledigt
- 1. Ticket gelesen

## Offen
- 2. Grill — Runde 1
- 3. JIRA-Kommentar

## Fortschritt
- 2. Grill fertig
- 4. Doku-PR angelegt — CI läuft, Merge offen
- 5. gestartet: Lückenanalyse
- 5a. Entwurf veröffentlicht
  - K01 #3345
Erledigt:
- Schritt 6: Story #3417
`;
    const s = parseStatusMd(md);
    expect(s.n).toBe(3313);
    expect(done(md)).toEqual([1, 2, 6]);
    expect(s.step).toBe(3);
    expect(s.notes).toContain("- 5a. Entwurf veröffentlicht");
    expect(s.notes).toContain("- K01 #3345");
    expect(
      done("Erledigt:\n- Schritt 1/2: Grill in zwei Runden\nOffen: 3 Jira\n- 3 Kommentar"),
    ).toEqual([1, 2, 3]);
  });

  test("notes: last 30, long lines cut", () => {
    const md = Array.from(
      { length: 40 },
      (_, i) => `Zeile ${i} ${"x".repeat(i === 39 ? 400 : 1)}`,
    ).join("\n");
    const { notes } = parseStatusMd(md);
    expect(notes).toHaveLength(30);
    expect(notes[0]).toStartWith("Zeile 10");
    expect(notes[29]?.length).toBe(300);
  });
});

describe("labels, prompts, requests", () => {
  test("label round trip, key-only labels, others", () => {
    expect(grillLabel({ mode: "interactive", key: "TENDR-1071", n: 3551 })).toBe(
      "Grill TENDR-1071 · #3551",
    );
    expect(grillLabel({ mode: "auto", key: null, n: 7 })).toBe("Auto-Grill #7");
    expect(parseGrillLabel("Grill TENDR-1071 · #3551")).toEqual({
      mode: "interactive",
      key: "TENDR-1071",
      n: 3551,
    });
    expect(parseGrillLabel("Auto-Grill #7")).toEqual({ mode: "auto", key: null, n: 7 });
    expect(parseGrillLabel("Auto-Grill TENDR-9")).toEqual({
      mode: "auto",
      key: "TENDR-9",
      n: null,
    });
    for (const no of ["Grill", "Grill TENDR-1 #3", "TENDR-1069-zeitraumkalender", "grill #3"])
      expect(parseGrillLabel(no)).toBeNull();
  });

  test("prompts", () => {
    expect(grillPrompt({ mode: "interactive", key: "TENDR-1071", n: 3551, advisor: null })).toBe(
      "/skill:lul-workr-grill-jira-ticket TENDR-1071",
    );
    expect(grillPrompt({ mode: "auto", key: null, n: 7, advisor: "gpt-5.5" })).toBe(
      "/skill:lul-workr-auto-grill-jira-ticket #7 --advisor=gpt-5.5",
    );
  });

  test("validation", () => {
    expect(validateGrillRequest({ n: 3, key: null, mode: "auto", advisor: "a/b:c" })).toEqual({
      n: 3,
      key: null,
      mode: "auto",
      advisor: "a/b:c",
    });
    expect(() => validateGrillRequest({ n: 0, mode: "auto" })).toThrow("ganze Zahl ab 1");
    expect(() => validateGrillRequest({ n: 1.5, mode: "auto" })).toThrow("ganze Zahl ab 1");
    expect(() => validateGrillRequest({ n: 3, key: "tendr-1", mode: "auto" })).toThrow(
      "kein JIRA-Schlüssel",
    );
    expect(() => validateGrillRequest({ n: 3, mode: "x" })).toThrow("Unbekannter Modus");
    expect(() => validateGrillRequest({ n: 3, mode: "interactive", advisor: "m" })).toThrow(
      "nur beim Auto-Grillen",
    );
    expect(() => validateGrillRequest({ n: 3, mode: "auto", advisor: "a b" })).toThrow("Advisor");
  });

  test("grills.json keeps 14 days and at most 200", () => {
    const file = join(root, "state", "grills.json");
    const now = Date.parse("2026-11-23T12:00:00Z");
    const rec = (n: number, daysAgo: number): GrillRecord => ({
      slug: "o/r",
      n,
      key: null,
      mode: "auto",
      advisor: null,
      pane: `w1:p${n}`,
      startedAt: new Date(now - daysAgo * 864e5).toISOString(),
    });
    recordGrill(file, rec(1, 15), now);
    recordGrill(file, rec(2, 1), now);
    expect(readGrillRecords(file).map((r) => r.n)).toEqual([2]);
    for (let n = 3; n < 210; n++) recordGrill(file, rec(n, 0), now);
    const all = readGrillRecords(file);
    expect(all).toHaveLength(200);
    expect(all.at(-1)?.n).toBe(209);
    expect(JSON.parse(readFileSync(file, "utf8"))).toHaveLength(200);
  });
});

describe("discovery", () => {
  const now = Date.now();
  const a = join(root, "a");
  const b = join(root, "b");
  const wt = join(root, "wt");
  const status = (dir: string, key: string, text: string, hoursAgo = 0) => {
    const d = join(dir, ".scratch", key);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "STATUS.md"), text);
    const t = new Date(now - hoursAgo * 3600_000);
    utimesSync(join(d, "STATUS.md"), t, t);
  };
  const agent = (pane: string, cwd: string, st = "idle"): Agent => ({
    pane,
    kind: "omp",
    status: st,
    title: "t",
    cwd,
    workspace: "w",
  });
  const input = (over: Partial<CollectInput>): CollectInput => ({
    dirs: [a, b, wt],
    agents: [],
    labels: new Map(),
    records: [],
    projectOf: () => ({ slug: "o/r", name: "r" }),
    nameOf: () => "r",
    now,
    ...over,
  });

  status(a, "TT-1", "# Grill\nGrill-Ticket: #11\n- [x] 1 a\n- [ ] 2 b", 5);
  status(b, "TT-1", "# Grill\nGrill-Ticket: #11\n- [x] 1 a\n- [x] 2 b", 1);
  status(a, "TT-2", REAL, 30); // done, older than a day
  status(a, "TT-3", REAL, 2); // done today
  status(a, "TT-4", "# Grill\n- [x] 1 a", 24 * 8); // older than 7 days
  status(a, "TT-5", "# Bauweg\n- [x] 1 a", 1); // no grill
  status(wt, "TT-6", "# Grill\nGrill-Ticket: #66\n- [x] 1 a", 3);

  test("STATUS.md: newest copy per ticket, done for a day, a week back, grills only", () => {
    const g = collectGrills(input({}));
    expect(g.map((x) => [x.id, x.key, x.status, x.step, x.cwd])).toEqual([
      ["o/r#11", "TT-1", "ended", 3, b],
      ["o/r#3533", "TT-3", "done", 8, a],
      ["o/r#66", "TT-6", "ended", 2, wt],
    ]);
    expect(g[0]).toMatchObject({ project: "r", mode: null, source: "manual", pane: null });
  });

  test("panes: grill label (with or without n), key in a hand-started label, records", () => {
    const g = collectGrills(
      input({
        agents: [
          agent("w1:p1", b, "working"),
          agent("w2:p1", wt, "blocked"),
          agent("w3:p1", a, "idle"),
          agent("w4:p1", a, "idle"),
          agent("w5:p1", root),
        ],
        labels: new Map([
          ["w1:p1", ["1", "Auto-Grill TT-1 · #11"]],
          // key-only label in the STATUS folder
          ["w2:p1", ["Grill TT-6", "ws"]],
          ["w3:p1", ["TT-3-hand", "tendr"]],
          ["w4:p1", ["1", "Grill #99"]],
        ]),
        records: [
          {
            slug: "o/r",
            n: 99,
            key: null,
            mode: "interactive",
            advisor: null,
            pane: "w4:p1",
            startedAt: new Date(now - 3600_000).toISOString(),
          },
          {
            slug: "o/r",
            n: 77,
            key: "TT-77",
            mode: "auto",
            advisor: null,
            pane: "w9:p9",
            startedAt: new Date(now - 60_000).toISOString(),
          },
          {
            slug: "o/r",
            n: 55,
            key: null,
            mode: "auto",
            advisor: null,
            pane: "w9:p8",
            startedAt: new Date(now - 3 * 864e5).toISOString(),
          },
        ],
      }),
    );
    const by = new Map(g.map((x) => [x.id, x]));
    expect(g.slice(0, 2).map((x) => x.id)).toEqual(["o/r#11", "o/r#66"]);
    expect(by.get("o/r#11")).toMatchObject({ status: "running", mode: "auto", pane: "w1:p1" });
    expect(by.get("o/r#66")).toMatchObject({
      status: "waiting",
      mode: "interactive",
      pane: "w2:p1",
    });
    // done but its session is still open
    expect(by.get("o/r#3533")).toMatchObject({ status: "done", pane: "w3:p1", mode: null });
    expect(by.get("o/r#99")).toMatchObject({
      status: "idle",
      source: "hollr",
      mode: "interactive",
      pane: "w4:p1",
      cwd: null,
      step: 1,
    });
    expect(by.get("o/r#77")).toMatchObject({ status: "ended", source: "hollr", key: "TT-77" });
    expect(by.has("o/r#55")).toBe(false);
  });
});
