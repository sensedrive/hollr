import { describe, expect, test } from "bun:test";
import { contextShare, firstSteps } from "./sessionStart";

describe("session start", () => {
  test("contextShare reads omp's footer value", () => {
    expect(contextShare("3.3%/1M")).toEqual({ pct: 3.3, window: "1M" });
    expect(contextShare("12%/200K")).toEqual({ pct: 12, window: "200K" });
    expect(contextShare(undefined)).toBeUndefined();
    expect(contextShare("n/a")).toBeUndefined();
  });

  test("firstSteps: a repo's open changes and history, else the folder", () => {
    expect(firstSteps({ branch: "main", dirty: 3 })).toEqual([
      { text: "Worum geht es in diesem Projekt?" },
      { text: "Prüf die {n} offenen Änderungen auf {branch}", vars: { n: 3, branch: "main" } },
      { text: "Was wurde zuletzt committet?" },
    ]);
    expect(firstSteps({ branch: "main", dirty: 1 })[1]).toEqual({ text: "Prüf die offene Änderung auf {branch}", vars: { branch: "main" } });
    expect(firstSteps({ branch: "main" }).map((s) => s.text)).toEqual(["Worum geht es in diesem Projekt?", "Was wurde zuletzt committet?"]);
    expect(firstSteps({ folder: "tmp" })).toEqual([{ text: "Worum geht es in diesem Ordner?" }]);
  });
});
