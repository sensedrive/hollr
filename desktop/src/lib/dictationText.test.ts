import { describe, expect, test } from "bun:test";
import type { TimelineItem } from "./api";
import {
  DEFAULT_VOCABULARY, dropFillers, dropHallucinations, finishText, formatTickets, parseTerms, promptTerms, sessionTerms,
  ticketPrefixes, voiceSend, type TextOptions,
} from "./dictationText";

const opts = (o: Partial<TextOptions> = {}): TextOptions => ({
  vocabularyText: DEFAULT_VOCABULARY, useVocabulary: true, replacements: [], removeFillers: true, language: "de", ...o,
});

describe("vocabulary", () => {
  test("lines with aliases, comments and blanks", () => {
    expect(parseTerms("JIRA = Jira, Dschira\n\n# note\nKubernetes\n = x")).toEqual([
      { text: "JIRA", aliases: ["Jira", "Dschira"] },
      { text: "Kubernetes", aliases: [] },
    ]);
  });

  test("aliases and casing become the canonical spelling", () => {
    expect(finishText("Ich mache einen pull-request in dschira mit Type Skript", opts())).toBe(
      "Ich mache einen Pull Request in JIRA mit TypeScript",
    );
  });

  test("whole words only", () => {
    expect(finishText("Der Herderweg", opts())).toBe("Der Herderweg");
  });

  test("replacements, also with $ in the target", () => {
    const o = opts({ replacements: [{ id: "1", from: "Dollar Zeichen", to: "$" }] });
    expect(finishText("Kosten in Dollar-Zeichen", o)).toBe("Kosten in $");
  });

  test("vocabulary off: replacements still apply, aliases not", () => {
    const o = opts({ useVocabulary: false, replacements: [{ id: "1", from: "Komma", to: "," }] });
    expect(finishText("Jira Komma bitte", o)).toBe("Jira , bitte");
    expect(promptTerms(o, ["Foo"])).toEqual([]);
  });
});

describe("cleanup", () => {
  test("invented subtitles", () => {
    expect(dropHallucinations("Hallo Welt. Untertitel im Auftrag des ZDF, 2021.")).toBe("Hallo Welt.");
  });

  test("fillers, capitalised again", () => {
    expect(dropFillers("Ähm, das ist äh gut.", "de")).toBe("Das ist gut.");
    expect(dropFillers("um zehn Uhr", "de")).toBe("um zehn Uhr");
    expect(dropFillers("so um yes", "en")).toBe("so yes");
  });

  test("ticket keys from known terms", () => {
    expect(ticketPrefixes(["TENDR-725", "Foo", "ab-1"])).toEqual(new Set(["TENDR"]));
    expect(formatTickets("schau dir tendr minus 725 an", new Set(["TENDR"]))).toBe("schau dir TENDR-725 an");
    expect(finishText("Tendr 12 ist fertig", opts(), ["TENDR-725"])).toBe("TENDR-12 ist fertig");
  });
});

describe("voice send", () => {
  test("strips the command and sends", () => {
    expect(voiceSend("Bitte deployen, senden.")).toEqual({ text: "Bitte deployen", send: true });
    expect(voiceSend("Mach das und schick es ab")).toEqual({ text: "Mach das", send: true });
    expect(voiceSend("senden")).toEqual({ text: "", send: false });
    expect(voiceSend("Wir senden morgen")).toEqual({ text: "Wir senden morgen", send: false });
  });
});

describe("session terms", () => {
  test("names, tickets, files and identifiers – newest first, deduplicated", () => {
    const items: TimelineItem[] = [
      { k: "user", id: "1", text: "Fix TENDR-1 in useDraftStore" },
      { k: "tools", id: "2", calls: [{ id: "c", name: "edit", label: "", status: "ok", path: "src/lib/AgentSession.swift" }] },
      { k: "text", id: "3", text: "Done with TENDR-2, see DraftStore and 1234" },
    ];
    expect(sessionTerms(["hollr", "ab", "Hollr"], items)).toEqual([
      "hollr", "TENDR-2", "TENDR-1", "AgentSession", "DraftStore", "useDraftStore",
    ]);
  });
});
