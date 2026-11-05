import { describe, expect, test } from "bun:test";
import type { TimelineItem } from "./api";
import { appendDraft, chatLabel, chatTranscript, historyCut } from "./contextChatText";

describe("chat with context", () => {
  test("the history before the fork is cut off – a turn running at the fork stays in the history", () => {
    const items: TimelineItem[] = [
      { k: "user", id: "u1", text: "Fix it", at: 100 },
      { k: "tools", id: "g1", calls: [], at: 150 },
      { k: "user", id: "u2", text: "Was machst du da?", source: "voice", at: 200 },
      { k: "thinking", id: "th", text: "…" },
      { k: "text", id: "x1", text: "Ich repariere den Import.", at: 210 },
    ];
    expect(items.slice(historyCut(items, 180)).map((i) => i.id)).toEqual(["u2", "th", "x1"]);
    expect(historyCut(items, 300)).toBe(items.length);
    expect(historyCut(items, 0)).toBe(0);
    expect(chatTranscript(items.slice(historyCut(items, 180)), { user: "Ich", agent: "Agent" })).toBe(
      "Ich: Was machst du da?\n\nAgent: Ich repariere den Import.",
    );
  });

  test("the result goes below the source session's draft", () => {
    expect(appendDraft("", "Ergebnis")).toBe("Ergebnis");
    expect(appendDraft("Mein Text  \n", "Ergebnis")).toBe("Mein Text\n\nErgebnis");
  });

  test("tabs of earlier forks show the session's name", () => {
    expect(chatLabel("🎙 Nebengespräch · Fix the importer")).toBe("Fix the importer");
    expect(chatLabel("Nebengespräch · Fix")).toBe("Fix");
    expect(chatLabel("🎙 Fix")).toBe("Fix");
    expect(chatLabel("Fix the importer")).toBe("Fix the importer");
  });
});
