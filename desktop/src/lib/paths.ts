// File paths in agent output (terminal text, chat answers): absolute `/…`, `~/…` and relative paths that look like
// files – `test-results/shot.png`, `src/a.ts:12:5`, `README.md`. Clicking one opens Hollr's preview (`hollr gate file`).
// Deliberately cautious with prose: URLs stay links, and versions (1.2.3), dates (05.11.2026, 2026/11/05), ratios
// (16/9, 3/4), slash commands (/live) and word pairs (und/oder) are not paths.
import { findLinks } from "./terminal";

export interface FoundPath {
  /** string range [start, end) – includes the :line[:col] suffix */
  start: number;
  end: number;
  path: string;
  line?: number;
  col?: number;
}

/** Extensions a bare name (no slash) needs to count as a file. */
const KNOWN_EXT = new Set(
  ("ts tsx mts cts js jsx mjs cjs json jsonc json5 md mdx markdown svelte vue astro rs go py pyi rb php java kt kts swift m mm c h cc cpp hpp cs fs "
    + "css scss sass less html htm xml xsl yml yaml toml ini cfg conf env sh bash zsh fish ps1 bat sql graphql gql proto txt log csv tsv "
    + "png jpg jpeg gif webp avif svg ico bmp heic pdf lock gradle lua dart ex exs erl hs ml scala r jl zig nim tf hcl dockerfile "
    + "patch diff ipynb wasm zip tar gz tgz mp3 mp4 mov wav webm").split(" "),
);
/** "Node.js" & co. in prose are libraries, not files. */
const LIBRARY_RE = /^(node|vue|next|nuxt|react|three|d3|chart|express|ember|backbone|angular|alpine|moment|day|p5|pixi|babylon|solid|deno|bun)\.js$/i;
/** github.com/owner/repo without a scheme is an address, not a folder */
const DOMAIN_RE = /^[\w-]+(\.[\w-]+)*\.(com|org|net|io|dev|app|de|ai|co|sh|me|gg|ly|so|eu|uk|ch|at|xyz|cloud|page)$/i;

// A candidate: not glued to a path character (or a scheme's ":") on the left; path characters (brackets for
// SvelteKit/Next routes), optionally ":line[:col]" or ":from-to".
const CANDIDATE_RE = /(?<![\p{L}\p{N}_\-./~@+\\:])[~./\p{L}\p{N}_@+\[][\p{L}\p{N}_.\-+@~/\[\]()]*(?::\d+(?::\d+)?(?:-\d+)?)?/gu;
const SUFFIX_RE = /^(.*?)(?::(\d+)(?::(\d+))?(?:[-+]\d*)?)?(?::raw)?$/s;

/** "src/a.ts:12:5" → path + line + col; also omp's read selectors ("a.ts:50-80", "a.ts:50+20", "a.ts:5:raw"). */
export function splitLine(s: string): { path: string; line?: number; col?: number } {
  const [, path = s, line, col] = SUFFIX_RE.exec(s) ?? [];
  return { path, ...(line ? { line: Number(line) } : {}), ...(col ? { col: Number(col) } : {}) };
}
const count = (s: string, c: string) => s.split(c).length - 1;

/** Sentence punctuation after a path, a closing bracket the path didn't open. */
function trimEnd(s: string): string {
  for (;;) {
    if (/[.,;:!?'"}>]$/.test(s)) s = s.slice(0, -1);
    else if (s.endsWith(")") && count(s, "(") < count(s, ")")) s = s.slice(0, -1);
    else if (s.endsWith("]") && count(s, "[") < count(s, "]")) s = s.slice(0, -1);
    else return s;
  }
}

/** Whether a token (without its line suffix) reads as a file or folder path. */
export function looksLikePath(p: string): boolean {
  if (!p || p.includes("//") || !/\p{L}/u.test(p)) return false;
  if (p.startsWith("~/")) return p.length > 2;
  if (p.startsWith("/")) return p.split("/").filter(Boolean).length >= 2;
  if (p.startsWith("./") || p.startsWith("../")) return p.replace(/^(\.\.?\/)+/, "").length > 0;
  const segs = p.split("/");
  const last = segs.at(-1) ?? "";
  if (segs.length > 1) {
    if (DOMAIN_RE.test(segs[0] ?? "")) return false;
    if (segs.some((s, i) => !s && i < segs.length - 1)) return false;
    // "test-results/shot.png" or a folder written as one ("test-results/"); without either, a slash chain is
    // more often prose ("ready/loading/empty") than a folder
    return !last || /[^.]\.[a-z][a-z0-9]{0,9}$/i.test(last);
  }
  // the stem needs two characters: "d.h." and "u.a." are German abbreviations
  const ext = /^[^.].+\.([a-z0-9]+)$/i.exec(p)?.[1]?.toLowerCase();
  return !!ext && KNOWN_EXT.has(ext) && !LIBRARY_RE.test(p);
}

/** The paths in a (logical) line. URLs found by `findLinks` are skipped (they stay links). */
export function findPaths(text: string): FoundPath[] {
  const links = findLinks(text);
  const out: FoundPath[] = [];
  for (const m of text.matchAll(CANDIDATE_RE)) {
    const start = m.index;
    const raw = trimEnd(m[0]);
    const end = start + raw.length;
    if (!raw || links.some((l) => start < l.end && end > l.start)) continue;
    const p = splitLine(raw);
    if (looksLikePath(p.path)) out.push({ start, end, ...p });
  }
  return out;
}

// Paths travel through the existing `onLink(href)` plumbing (chat, terminal) as
// "hollr-file:<encoded path>#<line>" – the session view opens the preview instead of asking about a link.
const SCHEME = "hollr-file:";

export const pathHref = (path: string, line?: number) =>
  `${SCHEME}${encodeURIComponent(path)}${line ? `#${line}` : ""}`;

/** The path (and line) behind a `pathHref` or a `file://` URL; undefined for anything else. */
export function parsePathHref(href: string): { path: string; line?: number } | undefined {
  if (href.startsWith(SCHEME)) {
    const [p = "", line] = href.slice(SCHEME.length).split("#");
    const path = decodeURIComponent(p);
    return path ? { path, ...(Number(line) > 0 ? { line: Number(line) } : {}) } : undefined;
  }
  if (/^file:\/\//i.test(href)) {
    try {
      const url = new URL(href);
      const path = decodeURIComponent(url.pathname);
      const line = /^#L?(\d+)/.exec(url.hash)?.[1];
      return path ? { path, ...(line ? { line: Number(line) } : {}) } : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}
