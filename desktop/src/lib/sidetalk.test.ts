import { describe, expect, test } from "bun:test";
import type { Pane, TimelineItem } from "./api";
import { type Drafts, mergeDrafts, storedDrafts } from "./drafts";
import { appendDraft, forkOf, sideItems, sideParams, sideTranscript } from "./sidetalk";

const pane = (id: string, fork?: Pane["fork"]): { pane: Pane } => ({
  pane: { pane: id, agent: "omp", status: "idle", title: id, cwd: "/p", focused: false, live: true, fork },
});

describe("side conversation", () => {
  test("the newest fork of the main pane", () => {
    const panes = [pane("w1:p1"), pane("w1:p2", { of: "w1:p1", at: 10 }), pane("w1:p3", { of: "w1:p1", at: 20 }), pane("w1:p4", { of: "w1:p9", at: 30 })];
    expect(forkOf(panes, "w1:p1")?.pane.pane).toBe("w1:p3");
    expect(forkOf(panes, "w1:p2")).toBeUndefined();
  });

  test("only what came after the fork – a turn running at the fork stays in the history", () => {
    const items: TimelineItem[] = [
      { k: "user", id: "u1", text: "Fix it", at: 100 },
      { k: "tools", id: "g1", calls: [], at: 150 },
      { k: "user", id: "u2", text: "Was machst du da?", source: "voice", at: 200 },
      { k: "thinking", id: "th", text: "…" },
      { k: "text", id: "x1", text: "Ich repariere den Import.", at: 210 },
    ];
    expect(sideItems(items, 180).map((i) => i.id)).toEqual(["u2", "th", "x1"]);
    expect(sideItems(items, 300)).toEqual([]);
    expect(sideTranscript(sideItems(items, 180), { user: "Ich", agent: "Agent" })).toBe(
      "Ich: Was machst du da?\n\nAgent: Ich repariere den Import.",
    );
  });

  test("the result goes below the main chat's draft", () => {
    expect(appendDraft("", "Ergebnis")).toBe("Ergebnis");
    expect(appendDraft("Mein Text  \n", "Ergebnis")).toBe("Mein Text\n\nErgebnis");
  });
});

describe("side window", () => {
  test("page parameters (window.rs side_url)", () => {
    expect(sideParams("?window=side&server=s1&main=w1:p1&pane=w1:p9&live=1")).toEqual({ server: "s1", main: "w1:p1", pane: "w1:p9", live: true });
    expect(sideParams("?window=side&server=s1&main=w1:p1&pane=w1:p9")?.live).toBe(false);
    expect(sideParams("?bridge=7419")).toBe(null);
    expect(sideParams("?window=side&server=s1&main=w1:p1")).toBe(null);
  });

  test("two windows never write back each other's old drafts", () => {
    const at = 1;
    const stored: Drafts = { "s|w1:p1": { text: "main typed later", at }, "s|w1:p2": { text: "other", at } };
    // the side window's copy of the main draft is old; it only changed its own fork's draft
    const mine: Drafts = { "s|w1:p1": { text: "old", at }, "s|w1:p9": { text: "fork draft", at } };
    expect(mergeDrafts(stored, mine, ["s|w1:p9"])).toEqual({ ...stored, "s|w1:p9": { text: "fork draft", at } });
    // a draft cleared here goes, the others stay
    expect(mergeDrafts(stored, {}, ["s|w1:p2"])).toEqual({ "s|w1:p1": { text: "main typed later", at } });
    // another window's send in flight stays in flight
    expect(storedDrafts(JSON.stringify({ k: { text: "", at, sending: ["hi"] }, bad: { text: 1 } }))).toEqual({ k: { text: "", at, sending: ["hi"] } });
  });
});
