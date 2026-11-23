/**
 * Quick filter: a tiny token language, parsed and matched per keystroke, client-side only.
 *   l:<label>  -l:<label>  @<login> (@ich = the gh user)  s:<story nr|text>  #<n>  anything else = full text
 * Same-kind semantics: labels and text narrow (AND), assignees/stories/numbers widen (OR) – "#612 #615" shows both.
 */
import type { Issue } from "./types";

export type TokenKind = "label" | "nolabel" | "assignee" | "story" | "number" | "text";

export interface Token {
  kind: TokenKind;
  value: string;
  /** the word still being typed: labels and assignees match by prefix, so `l:fro` already shows frontend */
  partial?: boolean;
}

export interface FilterContext {
  /** login for `@ich`; falsy = unknown (then `@ich` matches nothing) */
  viewer?: string | null;
  stories: { number: number; title: string }[];
}

/** One word → token. Prefixes without a value (`l:`, `@`) stay text so half-typed input doesn't empty the board. */
export function parseToken(word: string): Token | null {
  const w = word.trim();
  if (!w) return null;
  const pick = (kind: TokenKind, value: string): Token =>
    value ? { kind, value } : { kind: "text", value: w };
  if (/^-l:/i.test(w)) return pick("nolabel", w.slice(3));
  if (/^l:/i.test(w)) return pick("label", w.slice(2));
  if (/^s:/i.test(w)) return pick("story", w.slice(2));
  if (w.startsWith("@")) return pick("assignee", w.slice(1));
  if (/^#\d+$/.test(w)) return { kind: "number", value: w.slice(1) };
  return { kind: "text", value: w };
}

/**
 * Splits on whitespace; `"…"` keeps spaces together (labels like `l:"needs review"`).
 */
export function tokenize(query: string): Token[] {
  const out: Token[] = [];
  const re = /(-?l:|s:|@)?"([^"]*)"?|(\S+)/g;
  for (const m of query.matchAll(re)) {
    const word = m[3] ?? `${m[1] ?? ""}${m[2] ?? ""}`;
    const t = parseToken(word);
    if (t) out.push(t);
  }
  return out;
}

const quote = (v: string) => (/\s/.test(v) ? `"${v}"` : v);

export function tokenText(t: Token): string {
  switch (t.kind) {
    case "label":
      return `l:${quote(t.value)}`;
    case "nolabel":
      return `-l:${quote(t.value)}`;
    case "assignee":
      return `@${t.value}`;
    case "story":
      return `s:${quote(t.value)}`;
    case "number":
      return `#${t.value}`;
    default:
      return quote(t.value);
  }
}

export const serialize = (tokens: Token[]) => tokens.map(tokenText).join(" ");

const lc = (s: string) => s.toLocaleLowerCase("de");

/** A predicate over issues; built once per keystroke, then run over ≤ 600 issues. */
export function compile(tokens: Token[], ctx: FilterContext): (issue: Issue) => boolean {
  const matcher = (t: Token, value: string) => (t.partial ? (s: string) => s.startsWith(value) : (s: string) => s === value);
  const labels = tokens.filter((t) => t.kind === "label").map((t) => matcher(t, lc(t.value)));
  // a half-typed exclusion would hide tickets while typing; it counts once committed
  const nolabels = tokens.filter((t) => t.kind === "nolabel" && !t.partial).map((t) => lc(t.value));
  const assignees = tokens
    .filter((t) => t.kind === "assignee")
    .map((t) => (lc(t.value) === "ich" ? matcher({ ...t, partial: false }, lc(ctx.viewer || "\u0000")) : matcher(t, lc(t.value))));
  const numbers = tokens.filter((t) => t.kind === "number").map((t) => Number(t.value));
  const texts = tokens.filter((t) => t.kind === "text").map((t) => lc(t.value));
  // s:<nr> or s:<text in the story title> → a set of story numbers
  const storyTokens = tokens.filter((t) => t.kind === "story");
  const stories = new Set<number>();
  for (const t of storyTokens) {
    const nr = Number(t.value.replace(/^#/, ""));
    if (Number.isInteger(nr) && nr > 0) stories.add(nr);
    else for (const s of ctx.stories) if (lc(s.title).includes(lc(t.value))) stories.add(s.number);
  }
  return (issue) => {
    const own = issue.labels.map(lc);
    if (labels.some((m) => !own.some(m))) return false;
    if (nolabels.some((l) => own.includes(l))) return false;
    if (assignees.length && !issue.assignees.some((a) => assignees.some((m) => m(lc(a))))) return false;
    if (numbers.length && !numbers.includes(issue.number)) return false;
    if (storyTokens.length && !(issue.parent !== null && stories.has(issue.parent)) && !stories.has(issue.number))
      return false;
    if (texts.length) {
      const hay = lc(`${issue.number} #${issue.number} ${issue.title} ${issue.jira ?? ""}`);
      if (texts.some((t) => !hay.includes(t))) return false;
    }
    return true;
  };
}

export interface Suggestion {
  /** the full token text that replaces the word being typed */
  text: string;
  hint?: string;
}

export interface SuggestSource {
  labels: string[];
  assignees: { login: string; name?: string | null }[];
  stories: { number: number; title: string }[];
}

/** Completions for the word being typed (the input's last word). */
export function suggest(word: string, src: SuggestSource, limit = 8): Suggestion[] {
  const m = word.match(/^(-l:|l:|s:|@)(.*)$/i);
  if (!m) return [];
  const prefix = (m[1] ?? "").toLowerCase();
  const q = lc((m[2] ?? "").replace(/^"/, ""));
  let out: Suggestion[];
  if (prefix === "l:" || prefix === "-l:")
    out = src.labels.filter((l) => lc(l).includes(q)).map((l) => ({ text: `${prefix}${quote(l)}` }));
  else if (prefix === "@")
    out = [{ login: "ich", name: "ich (gh-Nutzer)" }, ...src.assignees]
      .filter((a) => lc(a.login).includes(q) || lc(a.name ?? "").includes(q))
      .map((a) => ({ text: `@${a.login}`, hint: a.name ?? undefined }));
  else
    out = src.stories
      .filter((s) => String(s.number).startsWith(q) || lc(s.title).includes(q))
      .map((s) => ({ text: `s:${s.number}`, hint: s.title }));
  // prefix matches first, then the rest in source order
  const starts = (s: Suggestion) => lc(s.text.replace(/^(-l:|l:|s:|@)"?/i, "")).startsWith(q);
  return [...out.filter(starts), ...out.filter((s) => !starts(s))].slice(0, limit);
}

/** `#f=<query>` in the location hash, so a filter survives reloads (and can be shared within Hollr). */
export function readHash(hash: string): string {
  const m = hash.match(/(?:^#|&)f=([^&]*)/);
  if (!m?.[1]) return "";
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return "";
  }
}

export const writeHash = (query: string) => (query ? `#f=${encodeURIComponent(query)}` : "");
