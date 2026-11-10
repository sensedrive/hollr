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

/** Every #N under "## Blockiert von" – the same rule as the loop's queue.mts `blockedBy`. */
export function blockedByOf(body: string): number[] {
  return [...section(body, "Blockiert von").matchAll(/#(\d+)/g)].map((m) => Number(m[1]));
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
