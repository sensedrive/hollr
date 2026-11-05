import { describe, expect, test } from "bun:test";
import { findPaths, looksLikePath, parsePathHref, pathHref } from "./paths";

const paths = (s: string) => findPaths(s).map((p) => p.path);

describe("findPaths", () => {
  test("absolute, home and relative paths from an omp answer", () => {
    const line = "- /Users/martin/PhpstormProjects/finksmart/magicfink/test-results/v3-states-canvas.png";
    expect(findPaths(line)).toEqual([
      { start: 2, end: line.length, path: "/Users/martin/PhpstormProjects/finksmart/magicfink/test-results/v3-states-canvas.png" },
    ]);
    expect(paths("├─ test-results/v3-states-canvas.png")).toEqual(["test-results/v3-states-canvas.png"]);
    expect(paths("cwd ~/PhpstormProjects/finksmart/magicfink  main")).toEqual(["~/PhpstormProjects/finksmart/magicfink"]);
    expect(paths("see ./scripts/build and ../other/x")).toEqual(["./scripts/build", "../other/x"]);
    expect(paths("bare names: package.json, README.md and +page.svelte")).toEqual(["package.json", "README.md", "+page.svelte"]);
    expect(paths("routes: src/routes/[id]/+page.svelte")).toEqual(["src/routes/[id]/+page.svelte"]);
    expect(paths("folders test-results/ and ./src/lib, not src/lib/components")).toEqual(["test-results/", "./src/lib"]);
    expect(paths("Umlaute: ~/Dokumente/Prüfung.pdf")).toEqual(["~/Dokumente/Prüfung.pdf"]);
  });

  test(":line and :line:col, ranges take their first line", () => {
    expect(findPaths("src/a.ts:12")).toEqual([{ start: 0, end: 11, path: "src/a.ts", line: 12 }]);
    expect(findPaths("at file.ts:12:5,")).toEqual([{ start: 3, end: 15, path: "file.ts", line: 12, col: 5 }]);
    expect(findPaths("Read README.md:10-40 / 120")).toEqual([{ start: 5, end: 20, path: "README.md", line: 10 }]);
  });

  test("trailing punctuation and unopened brackets dropped, balanced ones kept", () => {
    expect(paths("Öffne /tmp/x/shot.png.")).toEqual(["/tmp/x/shot.png"]);
    expect(paths("(siehe src/a.ts)")).toEqual(["src/a.ts"]);
    expect(paths("„src/a.ts“")).toEqual(["src/a.ts"]);
    expect(paths("Datei `src/a.ts`:")).toEqual(["src/a.ts"]);
    expect(paths("app/(group)/page.tsx;")).toEqual(["app/(group)/page.tsx"]);
    expect(paths("is it src/a.ts? yes: src/b.ts!")).toEqual(["src/a.ts", "src/b.ts"]);
  });

  test("URLs stay links, their path parts are not files", () => {
    expect(paths("https://example.com/docs/a.md and www.x.org/y/z.png")).toEqual([]);
    expect(paths("http://localhost:5173/src/app.ts")).toEqual([]);
    expect(paths("localhost:3000/a/b.js")).toEqual([]);
    expect(paths("github.com/owner/repo/blob/main/x.md")).toEqual([]);
    expect(paths("file:///tmp/a.png")).toEqual([]);
  });

  test("prose is not a path: versions, dates, ratios, slash commands, word pairs, libraries", () => {
    for (const s of [
      "Version 0.37.0 und v1.2.3",
      "am 05.11.2026 oder 2026/11/05",
      "16/9, 3/4, 24/7 und 1.5/2.0",
      "tippe /live oder /model",
      "und/oder, Lesen/Schreiben, TCP/IP, km/h, Ein/Aus/Auto, ready/loading/empty/error/locked",
      "mit Node.js, Vue.js und Three.js",
      "z.B. d.h. u.a. e.g. i.e.",
      "martin@finksmart.de schreibt an hollr.app",
      "Opus 5.5 · 20.4%/1M · $67.41",
      "12:30 Uhr, Seite 3",
    ])
      expect(paths(s)).toEqual([]);
  });
});

describe("looksLikePath", () => {
  test("rules", () => {
    expect(looksLikePath("/a/b")).toBe(true);
    expect(looksLikePath("/live")).toBe(false);
    expect(looksLikePath("~/")).toBe(false);
    expect(looksLikePath("~/x")).toBe(true);
    expect(looksLikePath("a//b.ts")).toBe(false);
    expect(looksLikePath("x.unknownext")).toBe(false);
    expect(looksLikePath("dir/x.unknownext")).toBe(true);
  });
});

describe("path hrefs", () => {
  test("roundtrip with a line; file:// URLs too; other links are not paths", () => {
    expect(parsePathHref(pathHref("test-results/a b.png"))).toEqual({ path: "test-results/a b.png" });
    expect(parsePathHref(pathHref("/x/#y.ts", 12))).toEqual({ path: "/x/#y.ts", line: 12 });
    expect(parsePathHref("file:///tmp/a%20b.ts#L7")).toEqual({ path: "/tmp/a b.ts", line: 7 });
    expect(parsePathHref("https://x.com/a.ts")).toBeUndefined();
    expect(parsePathHref("hollr-file:")).toBeUndefined();
  });
});
