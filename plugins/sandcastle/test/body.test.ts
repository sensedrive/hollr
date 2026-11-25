import { describe, expect, test } from "bun:test";
import { blockedByOf, blockedNotesOf, blockerEntries, jiraKeyOf, parentOf, renderMarkdown } from "../src/body";

const BODY = `## Parent
#601

## JIRA
GHACCP-42 — https://x.atlassian.net/browse/GHACCP-42

## Was gebaut wird
Siehe #999 und ABC-1.

## Blockiert von
- #612
- #615 (API)

## Notizen
#700`;

describe("issue body sections", () => {
  test("parent, JIRA key and blockers come only from their own sections", () => {
    expect(parentOf(BODY)).toBe(601);
    expect(jiraKeyOf(BODY)).toBe("GHACCP-42");
    expect(blockedByOf(BODY)).toEqual([612, 615]);
  });

  test("missing sections give nothing", () => {
    expect(parentOf("## Was gebaut wird\n#5")).toBeUndefined();
    expect(jiraKeyOf("Kein JIRA: ABC-1")).toBeUndefined();
    expect(blockedByOf("## Blockiert von\n- keine")).toEqual([]);
  });

  // the rule of the loop's queue.mts blockerEntries/blockedBy, with the bodies seen in tendr
  test("blocker entries: placeholders drop out, free text stays as a note, #N anywhere in an entry counts", () => {
    const of = (s: string) => `## Was gebaut wird\nx\n\n## Blockiert von\n${s}\n\n## Notizen\n- Release v9`;
    for (const placeholder of ["- keine — kann sofort starten", "keine — kann sofort starten", "—", "Keine", "- keine — kann sofort starten (#612 ist zusammengeführt)", "- n/a", "- **keine**"]) {
      expect([placeholder, blockerEntries(of(placeholder))]).toEqual([placeholder, []]);
    }
    expect(blockedByOf(of("- keine — #612 ist zusammengeführt"))).toEqual([]);
    const body = of("- Release v2.3.0 — erst danach\n  die Spalte löschen\n- #612 — Migration\n#615\n- #12 und Release v2.4.0\n<!-- - #99 -->");
    expect(blockerEntries(body)).toEqual(["Release v2.3.0 — erst danach die Spalte löschen", "#612 — Migration", "#615", "#12 und Release v2.4.0"]);
    expect(blockedByOf(body)).toEqual([612, 615, 12]);
    expect(blockedNotesOf(body)).toEqual(["Release v2.3.0 — erst danach die Spalte löschen"]);
    // the heading matches case-insensitively and with more after it; a blank line ends an entry
    expect(blockedNotesOf("## blockiert von (extern)\n- Release v2.3.0\n\n  danach")).toEqual(["Release v2.3.0", "danach"]);
    expect(blockedNotesOf(BODY)).toEqual([]);
  });
});

describe("renderMarkdown", () => {
  test("raw HTML is escaped, not rendered", () => {
    const html = renderMarkdown("<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\nText <b onclick=x>fett</b>");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b ");
  });

  test("javascript: links are defused, http links and anchors stay", () => {
    const html = renderMarkdown("[a](javascript:alert(1)) [b](https://example.com) [c](#x) ![i](javascript:x)");
    expect(html).not.toContain("javascript:");
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('href="#x"');
  });
});
