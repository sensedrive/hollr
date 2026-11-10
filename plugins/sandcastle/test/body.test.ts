import { describe, expect, test } from "bun:test";
import { blockedByOf, jiraKeyOf, parentOf, renderMarkdown } from "../src/body";

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
