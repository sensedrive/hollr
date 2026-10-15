import { describe, expect, test } from "bun:test";
import {
  beginSend, endSend, MAX_AGE, mergeText, parseDrafts, pushRecall, RECALL_MAX, serializeDrafts, setText, type Drafts,
} from "../src/lib/drafts";

const NOW = 1_800_000_000_000;

describe("parseDrafts", () => {
  test("broken or missing storage gives no drafts", () => {
    expect(parseDrafts(null, NOW)).toEqual({});
    expect(parseDrafts("{nope", NOW)).toEqual({});
    expect(parseDrafts("[1,2]", NOW)).toEqual({});
    expect(parseDrafts(JSON.stringify({ a: 1, b: { text: 2, at: NOW } }), NOW)).toEqual({});
  });

  test("drafts older than 14 days expire", () => {
    const raw = JSON.stringify({
      old: { text: "alt", at: NOW - MAX_AGE - 1 },
      fresh: { text: "neu", at: NOW - MAX_AGE + 1000 },
    });
    expect(parseDrafts(raw, NOW)).toEqual({ fresh: { text: "neu", at: NOW - MAX_AGE + 1000 } });
  });

  test("a send that never finished comes back as text", () => {
    const raw = JSON.stringify({ k: { text: "weiter", at: NOW, sending: ["erste Nachricht"] } });
    expect(parseDrafts(raw, NOW)).toEqual({ k: { text: "erste Nachricht\nweiter", at: NOW } });
  });
});

describe("drafts round trip", () => {
  test("serialize → parse keeps the text, drops empty entries", () => {
    const d: Drafts = {};
    setText(d, "s|1", "hallo", NOW);
    setText(d, "s|2", "x", NOW);
    setText(d, "s|2", "", NOW);
    expect(d["s|2"]).toBeUndefined();
    expect(parseDrafts(serializeDrafts(d), NOW)).toEqual({ "s|1": { text: "hallo", at: NOW } });
  });
});

describe("sending", () => {
  test("success clears the message", () => {
    const d: Drafts = {};
    setText(d, "k", "", NOW);
    beginSend(d, "k", "hi", NOW);
    expect(d.k?.sending).toEqual(["hi"]);
    endSend(d, "k", "hi", true, NOW);
    expect(d.k).toBeUndefined();
  });

  test("failure puts the message back without losing newer typing", () => {
    const d: Drafts = {};
    beginSend(d, "k", "hi", NOW);
    setText(d, "k", "neu getippt", NOW);
    endSend(d, "k", "hi", false, NOW);
    expect(d.k).toEqual({ text: "hi\nneu getippt", at: NOW });
  });

  test("failure into an empty draft restores exactly the message", () => {
    const d: Drafts = {};
    beginSend(d, "k", "hi", NOW);
    endSend(d, "k", "hi", false, NOW);
    expect(d.k?.text).toBe("hi");
  });
});

describe("helpers", () => {
  test("mergeText never doubles", () => {
    expect(mergeText("", "a")).toBe("a");
    expect(mergeText("x a y", "a")).toBe("x a y");
    expect(mergeText("b", "a")).toBe("a\nb");
  });

  test("pushRecall: newest first, unique, capped", () => {
    let list: string[] = [];
    for (let i = 0; i < RECALL_MAX + 5; i++) list = pushRecall(list, `m${i}`);
    list = pushRecall(list, "m10");
    expect(list.length).toBe(RECALL_MAX);
    expect(list[0]).toBe("m10");
    expect(list.filter((x) => x === "m10").length).toBe(1);
  });
});
