import { describe, expect, test } from "bun:test";
import { firstPrompt, isSideChatLabel, questionOf, sideChatLabel } from "./sidechat";

describe("sidechat", () => {
  test("its fork is named after the quote, on one line, and recognised by that name", () => {
    const label = sideChatLabel("Die Tabs springen,\n  weil der Punkt schrumpft und der Name nachrückt");
    expect(label.startsWith("Nachfrage · Die Tabs springen, weil der Punkt")).toBe(true);
    expect(label.includes("\n")).toBe(false);
    expect(label.length).toBe("Nachfrage · ".length + 40);
    expect(isSideChatLabel(label)).toBe(true);
    expect(isSideChatLabel("Nebengespräch · omp")).toBe(false);
  });

  test("the first prompt quotes the selection line by line, then asks", () => {
    const p = firstPrompt("Zeile eins\nZeile zwei", "Warum?");
    expect(p.includes("> Zeile eins\n> Zeile zwei")).toBe(true);
    expect(p.indexOf("Warum?") > p.indexOf("> Zeile zwei")).toBe(true);
  });

  test("the panel shows only the question of the first prompt", () => {
    expect(questionOf(firstPrompt("Ausschnitt\nmit zwei Zeilen", "Gilt das auch für den Composer?"))).toBe("Gilt das auch für den Composer?");
    expect(questionOf("Und was ist mit Tabs?")).toBe("Und was ist mit Tabs?");
  });
});
