/**
 * Quick filter: a tiny token language, parsed and matched per keystroke, client-side only.
 *   l:<label>  -l:<label>  @<login> (@ich = the gh user)  s:<story nr|text>  t:<JIRA issue type>  #<n>  drift:  drift:done
 *   live:  live:v2.0*  main:  main:teilweise  anything else = full text
 * Same-kind semantics: labels and text narrow (AND), assignees/stories/types/numbers widen (OR) – "#612 #615" shows both.
 */
import type { Issue } from "./types";

export type TokenKind =
  | "label"
  | "nolabel"
  | "assignee"
  | "story"
  | "type"
  | "notype"
  | "status"
  | "sandcastle"
  | "pr"
  | "live"
  | "main"
  | "number"
  | "drift"
  | "text";

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
  /** issues with a drift badge (`drift:`); missing = none known */
  drift?: ReadonlySet<number>;
}

/** One word → token. Prefixes without a value (`l:`, `@`) stay text so half-typed input doesn't empty the board. */
export function parseToken(word: string): Token | null {
  const w = word.trim();
  if (!w) return null;
  const pick = (kind: TokenKind, value: string): Token =>
    value ? { kind, value } : { kind: "text", value: w };
  // drift: = drift to apply; drift:done = JIRA Done although the work is not in main
  if (/^drift:/i.test(w)) return { kind: "drift", value: w.slice(6) };
  // sc: = a ticket Sandcastle is working on right now; sc:eingereiht also counts tickets waiting in a run's queue
  if (/^sc:/i.test(w)) return { kind: "sandcastle", value: w.slice(3) };
  // live: = shipped in a release, live:v2.0* = in that version; main: = in main (released too), main:teilweise = partly
  if (/^live:/i.test(w)) return { kind: "live", value: w.slice(5) };
  if (/^main:/i.test(w)) return { kind: "main", value: w.slice(5) };
  if (/^z:/i.test(w)) return pick("status", w.slice(2));
  if (/^pr:/i.test(w)) return pick("pr", w.slice(3));
  if (/^-l:/i.test(w)) return pick("nolabel", w.slice(3));
  if (/^l:/i.test(w)) return pick("label", w.slice(2));
  if (/^s:/i.test(w)) return pick("story", w.slice(2));
  if (/^-t:/i.test(w)) return pick("notype", w.slice(3));
  if (/^t:/i.test(w)) return pick("type", w.slice(2));
  if (w.startsWith("@")) return pick("assignee", w.slice(1));
  if (/^#\d+$/.test(w)) return { kind: "number", value: w.slice(1) };
  return { kind: "text", value: w };
}

/**
 * Splits on whitespace; `"…"` keeps spaces together (labels like `l:"needs review"`).
 */
export function tokenize(query: string): Token[] {
  const out: Token[] = [];
  const re = /(-?l:|s:|-?t:|z:|pr:|@)?"([^"]*)"?|(\S+)/g;
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
    case "type":
      return `t:${quote(t.value)}`;
    case "notype":
      return `-t:${quote(t.value)}`;
    case "number":
      return `#${t.value}`;
    case "drift":
      return `drift:${t.value}`;
    case "sandcastle":
      return `sc:${t.value}`;
    case "live":
      return `live:${t.value}`;
    case "main":
      return `main:${t.value}`;
    case "status":
      return `z:${quote(t.value)}`;
    case "pr":
      return `pr:${t.value}`;
    default:
      return quote(t.value);
  }
}

export const serialize = (tokens: Token[]) => tokens.map(tokenText).join(" ");

const lc = (s: string) => s.toLocaleLowerCase("de");

const WILD = /[*?]/;
const wildSource = (value: string) =>
  value
    .split("")
    .map((c) => (c === "*" ? ".*" : c === "?" ? "." : c.replace(/[.+^${}()|[\]\\]/g, "\\$&")))
    .join("");

/**
 * Matches a whole value (label, assignee, type): `*` any run, `?` one character, e.g. `l:patrick*`. Without
 * wildcards exact; the word still being typed (`partial`) matches by prefix. `value` is already lower case.
 */
export function valueMatcher(t: Pick<Token, "partial">, value: string): (s: string) => boolean {
  if (WILD.test(value)) {
    const re = new RegExp(`^${wildSource(value)}${t.partial ? "" : "$"}`);
    return (s) => re.test(s);
  }
  return t.partial ? (s) => s.startsWith(value) : (s) => s === value;
}

/** Free text: contained anywhere; with wildcards `rech*kalender` spans words. `value` is already lower case. */
export function textMatcher(value: string): (hay: string) => boolean {
  if (WILD.test(value)) {
    const re = new RegExp(wildSource(value));
    return (hay) => re.test(hay);
  }
  return (hay) => hay.includes(value);
}

/** A predicate over GitHub issues (Werkbank); `t:` is a JIRA field and doesn't narrow issues. */
export function compile(tokens: Token[], ctx: FilterContext): (issue: Issue) => boolean {
  const matcher = valueMatcher;
  const labels = tokens.filter((t) => t.kind === "label").map((t) => matcher(t, lc(t.value)));
  // a half-typed exclusion would hide tickets while typing; it counts once committed
  const nolabels = tokens.filter((t) => t.kind === "nolabel" && !t.partial).map((t) => valueMatcher(t, lc(t.value)));
  const assignees = tokens
    .filter((t) => t.kind === "assignee")
    .map((t) => (lc(t.value) === "ich" ? matcher({ ...t, partial: false }, lc(ctx.viewer || "\u0000")) : matcher(t, lc(t.value))));
  const numbers = tokens.filter((t) => t.kind === "number").map((t) => Number(t.value));
  const texts = tokens.filter((t) => t.kind === "text").map((t) => textMatcher(lc(t.value)));
  const drift = tokens.some((t) => t.kind === "drift");
  // s:<nr> or s:<text in the story title> → a set of story numbers
  const storyTokens = tokens.filter((t) => t.kind === "story");
  const stories = new Set<number>();
  for (const t of storyTokens) {
    const nr = Number(t.value.replace(/^#/, ""));
    if (Number.isInteger(nr) && nr > 0) stories.add(nr);
    else {
      const m = textMatcher(lc(t.value));
      for (const s of ctx.stories) if (m(lc(s.title))) stories.add(s.number);
    }
  }
  return (issue) => {
    const own = issue.labels.map(lc);
    if (labels.some((m) => !own.some(m))) return false;
    if (nolabels.some((m) => own.some(m))) return false;
    if (assignees.length && !issue.assignees.some((a) => assignees.some((m) => m(lc(a))))) return false;
    if (numbers.length && !numbers.includes(issue.number)) return false;
    if (drift && !ctx.drift?.has(issue.number)) return false;
    if (storyTokens.length && !(issue.parent !== null && stories.has(issue.parent)) && !stories.has(issue.number))
      return false;
    if (texts.length) {
      const hay = lc(`${issue.number} #${issue.number} ${issue.title} ${issue.jira ?? ""}`);
      if (texts.some((m) => !m(hay))) return false;
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
  /** GitHub stories by number, or JIRA epics by key */
  stories: { number: number | string; title: string }[];
  /** JIRA issue types (Tickets view); empty on the Werkbank */
  types?: string[];
  /** JIRA status names without emoji (Tickets view) */
  statuses?: string[];
  /** release versions the tickets shipped in, newest first (Tickets view) */
  versions?: string[];
}

/** Completions for the word being typed (the input's last word). */
export function suggest(word: string, src: SuggestSource, limit = 8): Suggestion[] {
  const m = word.match(/^(-l:|l:|s:|-?t:|z:|pr:|sc:|live:|main:|drift:|@)(.*)$/i);
  if (!m) return [];
  const prefix = (m[1] ?? "").toLowerCase();
  const q = lc((m[2] ?? "").replace(/^"/, ""));
  let out: Suggestion[];
  if (prefix === "l:" || prefix === "-l:")
    out = src.labels.filter((l) => lc(l).includes(q)).map((l) => ({ text: `${prefix}${quote(l)}` }));
  else if (prefix === "t:" || prefix === "-t:")
    out = (src.types ?? []).filter((x) => lc(x).includes(q)).map((x) => ({ text: `${prefix}${quote(x)}` }));
  else if (prefix === "z:")
    out = [
      ...(src.statuses ?? []).map((s) => ({ text: `z:${quote(s)}` })),
      { text: "z:offen", hint: "noch nicht begonnen" },
      { text: "z:arbeit", hint: "in Arbeit (jede Spalte dazwischen)" },
      { text: "z:fertig", hint: "erledigt" },
    ].filter((s) => lc(s.text.slice(2)).includes(q));
  else if (prefix === "pr:")
    out = [
      { text: "pr:gemergt", hint: "Bau-PR in main (Doku-PRs zählen nicht)" },
      { text: "pr:offen" },
      { text: "pr:entwurf" },
      { text: "pr:geschlossen", hint: "ohne Merge" },
      { text: "pr:rot", hint: "CI schlägt fehl" },
      { text: "pr:keiner", hint: "kein Pull Request" },
    ].filter((s) => s.text.slice(3).includes(q));
  else if (prefix === "sc:")
    out = [
      { text: "sc:", hint: "Sandcastle arbeitet gerade daran" },
      { text: "sc:eingereiht", hint: "… oder es wartet in einem Lauf" },
    ].filter((s) => s.text.slice(3).startsWith(q));
  else if (prefix === "live:")
    out = [
      { text: "live:", hint: "in einem Release ausgeliefert" },
      ...(src.versions ?? []).map((v) => ({ text: `live:${v}` })),
    ].filter((s) => lc(s.text.slice(5)).startsWith(q));
  else if (prefix === "main:")
    out = [
      { text: "main:", hint: "Arbeit ist in main (auch ausgeliefert)" },
      { text: "main:teilweise", hint: "nur teilweise in main" },
    ].filter((s) => s.text.slice(5).startsWith(q));
  else if (prefix === "drift:")
    out = [
      { text: "drift:", hint: "Abweichung zum Angleichen" },
      { text: "drift:done", hint: "JIRA Done, aber nicht in main" },
    ].filter((s) => s.text.slice(6).startsWith(q));
  else if (prefix === "@")
    out = [{ login: "ich", name: "ich (gh-Nutzer)" }, ...src.assignees]
      .filter((a) => lc(a.login).includes(q) || lc(a.name ?? "").includes(q))
      .map((a) => ({ text: `@${a.login}`, hint: a.name ?? undefined }));
  else
    out = src.stories
      .filter((s) => lc(String(s.number)).startsWith(q) || lc(s.title).includes(q))
      .map((s) => ({ text: `s:${s.number}`, hint: s.title }));
  // prefix matches first, then the rest in source order
  const starts = (s: Suggestion) => lc(s.text.replace(/^(-l:|l:|s:|-?t:|z:|pr:|sc:|live:|main:|drift:|@)"?/i, "")).startsWith(q);
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
