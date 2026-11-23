import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BoardAnswer, BoardCache, type Fetchers, FULL_MS, STALE_MS } from "../src/cache";
import type { RepoSnapshot } from "../src/github";
import type { BoardData, Issue } from "../src/types";
import { issue, NOW, project, snapshot } from "./fixtures";

let dir: string;
let clock: number;
let calls: string[];
let full: RepoSnapshot;
let changed: Issue[];
let offline: boolean;

const fetchers: Fetchers = {
  async fetchBoard(slug) {
    calls.push(`full ${slug}`);
    return structuredClone(full);
  },
  async fetchChanged(slug, since) {
    if (offline) throw new Error("gh: offline");
    calls.push(`changed ${slug} ${since}`);
    return structuredClone(changed);
  },
};

const made: BoardCache[] = [];
function make() {
  const c = new BoardCache(dir, fetchers, () => clock);
  made.push(c);
  return c;
}
function data(a: BoardAnswer): BoardData {
  if ("same" in a) throw new Error("expected a board");
  return JSON.parse(a.json);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sc-cache-"));
  clock = NOW;
  calls = [];
  changed = [];
  offline = false;
  full = snapshot([
    issue(1, { labels: ["Sandcastle"] }),
    issue(2, { labels: ["story"], title: "Story zwei" }),
    issue(3, { state: "closed", closedAt: "2026-11-20T09:00:00Z", updatedAt: "2026-11-20T09:00:00Z" }),
  ]);
});
afterEach(async () => {
  // pending disk copies first, else their rename races the cleanup
  await Promise.all(made.splice(0).map((c) => c.saved()));
  rmSync(dir, { recursive: true, force: true });
});

describe("BoardCache", () => {
  test("first request fetches, splits stories off, answers the contract shape", async () => {
    const b = data(await make().board(project()));
    expect(calls).toEqual(["full o/r"]);
    expect(b.issues.map((i) => i.number).sort()).toEqual([1, 3]);
    expect(b.stories).toEqual([{ number: 2, title: "Story zwei" }]);
    expect(b.hasGrill).toBe(true);
    expect(b.closedOlder).toBe(42);
    expect(b.viewer).toBe("martin");
    expect(b.stale).toBe(false);
    expect(b.labels[0]).toEqual({ name: "Sandcastle", color: "0e8a16" });
    expect(typeof b.etag).toBe("string");
  });

  test("same etag answers {same:true}; a change gives a new etag", async () => {
    const c = make();
    const first = data(await c.board(project()));
    expect(await c.board(project(), first.etag)).toEqual({ same: true });
    await c.put("o/r", issue(1, { labels: [], updatedAt: "2026-11-23T11:59:00Z" }));
    const next = data(await c.board(project(), first.etag));
    expect(next.etag).not.toBe(first.etag);
    expect(next.issues.find((i) => i.number === 1)?.labels).toEqual([]);
  });

  test("a fresh process answers from the disk copy without asking GitHub", async () => {
    const a = make();
    const first = data(await a.board(project()));
    await a.saved();
    calls = [];
    const b = data(await make().board(project()));
    expect(calls).toEqual([]);
    expect(b.etag).toBe(first.etag);
  });

  test("older than 15 s: answers at once, refreshes only the changes in the background", async () => {
    const c = make();
    await c.board(project());
    clock += STALE_MS + 1;
    changed = [issue(4, { title: "neu", updatedAt: "2026-11-23T12:00:10Z" })];
    const stale = data(await c.board(project()));
    expect(stale.stale).toBe(true);
    expect(stale.issues.some((i) => i.number === 4)).toBe(false);
    // joins the refresh the request above started
    await c.board(project(), null, true);
    expect(calls[1]).toStartWith("changed o/r ");
    const fresh = data(await c.board(project()));
    expect(fresh.stale).toBe(false);
    expect(fresh.issues.some((i) => i.number === 4)).toBe(true);
  });

  test("after 10 min the refresh is a full fetch (labels, deleted issues)", async () => {
    const c = make();
    await c.board(project());
    clock += FULL_MS + 1;
    full = snapshot([issue(1)]);
    await c.board(project(), null, true);
    expect(calls).toEqual(["full o/r", "full o/r"]);
    expect(data(await c.board(project())).issues.map((i) => i.number)).toEqual([1]);
  });

  test("a written issue beats an older fetched copy (search index lag)", async () => {
    const c = make();
    await c.board(project());
    clock += FULL_MS - 30_000;
    const closed = issue(1, { state: "closed", closedAt: "2026-11-23T12:09:00Z", updatedAt: "2026-11-23T12:09:00Z" });
    await c.put("o/r", closed);
    clock += 60_000; // the full fetch now still has #1 open with the old updatedAt
    await c.board(project(), null, true);
    expect(calls).toEqual(["full o/r", "full o/r"]);
    expect(data(await c.board(project())).issues.find((i) => i.number === 1)?.state).toBe("closed");
  });

  test("closed issues leave with the 14-day window", async () => {
    const c = make();
    await c.board(project());
    clock = Date.parse("2026-12-20T12:00:00Z");
    await c.board(project(), null, true);
    expect(data(await c.board(project())).issues.map((i) => i.number)).toEqual([1]);
  });

  test("a failed refresh keeps the data and says why", async () => {
    const c = make();
    await c.board(project());
    clock += STALE_MS + 1;
    offline = true;
    await expect(c.board(project(), null, true)).rejects.toThrow("offline");
    const b = data(await c.board(project()));
    expect(b.refreshError).toBe("gh: offline");
    expect(b.issues.length).toBe(2);
  });

  test("unsafe slugs never reach the file system", async () => {
    await expect(make().board(project({ slug: "../x" }))).rejects.toThrow("Ungültiges Repo");
  });

  test("warm board of 600 issues answers in well under 30 ms", async () => {
    full = snapshot(Array.from({ length: 600 }, (_, i) => issue(i + 1, { title: `Ein längerer Titel ${i}` })));
    const c = make();
    await c.board(project());
    const t = performance.now();
    for (let i = 0; i < 20; i++) await c.board(project());
    expect((performance.now() - t) / 20).toBeLessThan(30);
  });
});
