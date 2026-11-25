/** What the lul-workr issue bodies carry in their sections, and safe HTML for the side panel. */

/** The text under `## <heading>` up to the next `## ` heading ("" when missing). */
function section(body: string, heading: string): string {
  const lines = body.split(/\r?\n/);
  const want = heading.toLowerCase();
  const start = lines.findIndex((l) => /^##\s/.test(l) && l.replace(/^##\s+/, "").trim().toLowerCase() === want);
  if (start < 0) return "";
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^##\s/.test(l));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n");
}

export function parentOf(body: string): number | undefined {
  const m = section(body, "Parent").match(/#(\d+)/);
  return m ? Number(m[1]) : undefined;
}

export function jiraKeyOf(body: string): string | undefined {
  return section(body, "JIRA").match(/\b[A-Z][A-Z0-9]+-\d+\b/)?.[0];
}

/**
 * The entries under "## Blockiert von" – the loop's queue.mts `blockerEntries`, rule for rule: HTML comments
 * dropped; a list item (`-`, `*`, `+`, `1.`, `1)`) is one entry, indented lines continue it, a blank line ends it;
 * any other non-empty line is an entry of its own; placeholders („keine …“, „none“, „n/a“, „—“) are no entries.
 * No entries either: HTML blocks (`<details>` … `</details>` with their content, any line starting with an HTML
 * tag), fenced code blocks (``` or ~~~ up to the closing fence, with their content), blockquotes (`>`) and
 * horizontal rules. A `## ` line inside a fenced code block is no heading.
 */
export function blockerEntries(body: string): string[] {
  const entries: string[] = [];
  let inSection = false;
  let current: string | null = null;
  let fence: string | null = null;
  let details = 0;
  const flush = () => {
    if (current !== null && !isPlaceholder(current)) entries.push(current);
    current = null;
  };
  for (const raw of (body ?? "").replace(/<!--[\s\S]*?-->/g, "").split(/\r?\n/)) {
    const line = raw.trim();
    if (fence !== null) {
      if (line.startsWith(fence) && new RegExp(`^${fence[0]}+$`).test(line)) fence = null;
      continue;
    }
    const open = /^(?:`{3,}|~{3,})/.exec(line);
    if (open) {
      flush();
      fence = open[0];
      continue;
    }
    if (/^##\s/.test(raw)) {
      flush();
      inSection = /^##\s*Blockiert von\b/i.test(raw);
      details = 0;
      continue;
    }
    if (!inSection) continue;
    const tags = (line.match(/<details\b/gi) ?? []).length - (line.match(/<\/details\s*>/gi) ?? []).length;
    if (details > 0 || tags !== 0 || HTML_TAG_LINE.test(line) || line.startsWith(">") || RULE_LINE.test(line)) {
      flush();
      details = Math.max(0, details + tags);
      continue;
    }
    if (!line) {
      flush();
      continue;
    }
    const item = /^(?:[-*+]|\d+[.)])(?:\s+|$)(.*)$/.exec(line);
    if (item) {
      flush();
      current = (item[1] ?? "").trim();
    } else if (current !== null && /^\s/.test(raw)) current = `${current} ${line}`;
    else {
      flush();
      current = line;
    }
  }
  flush();
  return entries;
}

/** A line starting with an HTML tag (`<summary>`, `</div>`, `<br/>`), not an autolink. */
const HTML_TAG_LINE = /^<\/?[A-Za-z][\w-]*(?:\s[^>]*)?\/?>/;

/** Horizontal rule: three or more `-`, `*` or `_`, optionally spaced. */
const RULE_LINE = /^([-*_])(?:\s*\1){2,}$/;

function isPlaceholder(entry: string): boolean {
  const text = entry.replace(/^[*_`\s]+/, "").trim();
  return text === "" || /^[—–-]+\.?$/.test(text) || /^(?:keine|none|n\/a)\b/i.test(text);
}

const refsOf = (entry: string) => [...entry.matchAll(/#(\d+)/g)].map((m) => Number(m[1]));

/** Every #N of the "## Blockiert von" entries – the loop's `blockedBy`; it waits until they are closed. */
export function blockedByOf(body: string): number[] {
  return blockerEntries(body).flatMap(refsOf);
}

/** Entries without any #N („Release v2.3.0 — erst danach …“): the loop treats the issue as blocked by them. */
export function blockedNotesOf(body: string): string[] {
  return blockerEntries(body).filter((e) => refsOf(e).length === 0);
}

// Bun ≥1.3 has Bun.markdown; the pinned @types/bun (1.2.22, same as server/) doesn't declare it yet
type BunMarkdown = { html(md: string, opts: Record<string, boolean>): string };
const markdown: BunMarkdown = Reflect.get(Bun, "markdown");

const SAFE_HREF = /^(https?:|#|\/)/i;
const SAFE_SRC = /^(https?:|\/|data:image\/)/i;

/** Markdown → HTML without raw HTML; links and images only to http(s), anchors and same-origin paths. */
export function renderMarkdown(md: string): string {
  return markdown
    .html(md, { noHtmlBlocks: true, noHtmlSpans: true })
    .replace(/\shref="([^"]*)"/g, (all, url: string) => (SAFE_HREF.test(url) ? all : ' href="#"'))
    .replace(/\ssrc="([^"]*)"/g, (all, url: string) => (SAFE_SRC.test(url) ? all : ' src=""'));
}
