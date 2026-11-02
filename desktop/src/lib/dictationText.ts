// Text side of the local dictation (iOS DictationSettings.swift, DictationPipeline.swift `DictationText`,
// SessionVocabulary.swift): vocabulary lines, replacements, filler words, invented subtitles, ticket keys,
// "… senden" and the words an open session contributes. Pure functions – the store is dictation.svelte.ts.
import type { TimelineItem } from "./api";

/** One vocabulary line: "Kubernetes" or "TypeScript = Type Script, Type Skript" (misheard variants after "="). */
export interface Term {
  text: string;
  aliases: string[];
}

export interface Replacement {
  id: string;
  from: string;
  to: string;
}

/** ggml models of whisper.cpp on Hugging Face (`ggml-<id>.bin`). */
export const WHISPER_MODELS = [
  { id: "large-v3-q5_0", name: "Large v3", size: "1,08 GB", note: "Maximale Genauigkeit" },
  { id: "large-v3-turbo-q5_0", name: "Large v3 Turbo", size: "574 MB", note: "Fast so genau, deutlich schneller" },
  { id: "small", name: "Small", size: "488 MB", note: "Kompakt, gute Genauigkeit" },
  { id: "base", name: "Base", size: "148 MB", note: "Schnell, für kurze Notizen" },
];

/** language codes for Whisper; names are German UI strings (translated with t()) */
export const LANGUAGES: { code: string; name: string }[] = [
  { code: "de", name: "Deutsch" }, { code: "en", name: "Englisch" }, { code: "auto", name: "Automatisch erkennen" },
  { code: "fr", name: "Französisch" }, { code: "es", name: "Spanisch" }, { code: "it", name: "Italienisch" },
  { code: "nl", name: "Niederländisch" }, { code: "pl", name: "Polnisch" }, { code: "pt", name: "Portugiesisch" },
];

export const DEFAULT_VOCABULARY = `omp = OMP, Oh My Pi
herdr = Herder, Hörder
Hollr = Holler
Claude Code
Codex
GitHub
Pull Request
JIRA = Jira, Dschira, Vira
deployen = deploien
deploye = deploie
Sandcastle
TypeScript = Type Script, Type Skript, Typescript
JavaScript
SwiftUI = Swift UI
pnpm = PNPM
Kubernetes
Docker
Dokku
Postgres = Postgres-Datenbank
Redis
Refactoring
Endpoint
Frontend
Backend
Deployment
Staging
Commit
Rebase
Merge Request`;

export function parseTerms(text: string): Term[] {
  return text.split("\n").flatMap((line) => {
    const eq = line.indexOf("=");
    const head = (eq < 0 ? line : line.slice(0, eq)).trim();
    if (!head || head.startsWith("#")) return [];
    const aliases = eq < 0 ? [] : line.slice(eq + 1).split(",").map((a) => a.trim()).filter(Boolean);
    return [{ text: head, aliases }];
  });
}

/** Own vocabulary plus words from the open session (deduplicated, own terms first). */
export function allTerms(terms: Term[], extra: string[]): Term[] {
  const seen = new Set<string>();
  return [...terms, ...extra.map((text) => ({ text, aliases: [] }))].filter((t) => {
    const k = t.text.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

const L = "[\\p{L}\\p{N}]";
// no "-": it is literal outside classes, and "\-" is a syntax error in unicode patterns
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/** Whole-word pattern where spaces and hyphens inside the phrase are interchangeable. */
export function loosePattern(phrase: string): string {
  const parts = phrase.split(/[ -]+/).filter(Boolean).map(escape);
  return `(?<!${L})${parts.join("[\\s-]*")}(?!${L})`;
}

const replaceAll = (text: string, pattern: string, to: string, flags = "giu") =>
  text.replace(new RegExp(pattern, flags), () => to);

/** Phrases Whisper invents on silence or noise (it learned them from subtitles). */
const HALLUCINATIONS = [
  "Untertitel im Auftrag des ZDF", "Untertitelung im Auftrag des ZDF", "Untertitel der Amara.org-Community",
  "Untertitelung des ZDF", "Untertitel von Stephanie Geiges", "Copyright WDR", "Vielen Dank fürs Zuschauen",
  "Vielen Dank für's Zuschauen", "Danke fürs Zuschauen", "Bis zum nächsten Mal", "Thanks for watching",
  "Thank you for watching", "Subtitles by the Amara.org community", "Amara.org",
];

export function dropHallucinations(text: string): string {
  let out = text;
  for (const phrase of HALLUCINATIONS) out = out.replace(new RegExp(`${escape(phrase)}[^.!?\\n]*[.!?]?`, "giu"), "");
  return out.replace(/\s{2,}/g, " ").trim();
}

const isLower = (c: string) => c !== c.toUpperCase() && c === c.toLowerCase();
const isUpper = (c: string) => c !== c.toLowerCase() && c === c.toUpperCase();

/** "ähm", "äh", "öhm" … (English "um"/"uh" only when dictating English – "um" is a German word). */
export function dropFillers(text: string, language: string): string {
  let words = "ähm+|äh+|öhm+|ehm+|hmm+|mhm";
  if (language === "en") words += "|um+|uh+|erm";
  let out = text.replace(new RegExp(`(?<!${L})(?:${words})(?!${L})[,.…]*\\s*`, "giu"), "");
  out = out.replace(/\s+([,.!?])/g, "$1").replace(/\s{2,}/g, " ");
  // a sentence that started with a filler: capitalise again
  const first = out[0];
  if (first && isLower(first) && text[0] && isUpper(text[0])) out = first.toUpperCase() + out.slice(1);
  return out.replace(/^[ \t]+|[ \t]+$/g, "");
}

/** Ticket prefixes in known terms ("TENDR-725" → "TENDR"). */
export function ticketPrefixes(terms: string[]): Set<string> {
  return new Set(terms.flatMap((t) => t.match(/^[A-Z][A-Z0-9]{1,9}(?=-\d+$)/)?.[0] ?? []));
}

/** "tendr 725", "Tendr minus 725" → "TENDR-725" for ticket prefixes known from the session/vocabulary. */
export function formatTickets(text: string, prefixes: Set<string>): string {
  let out = text;
  for (const p of prefixes) {
    if (p.length < 2) continue;
    const re = new RegExp(`(?<!${L})${escape(p)}[\\s-]*(?:minus\\s*|bindestrich\\s*|strich\\s*|dash\\s*)?(\\d{1,6})(?!\\p{N})`, "giu");
    out = out.replace(re, (_, n: string) => `${p}-${n}`);
  }
  return out;
}

/** "… senden" / "… abschicken" at the very end: strip it and send. */
export function voiceSend(text: string): { text: string; send: boolean } {
  const m = text.match(/[\s,.;:]*(?:und\s+)?(?:senden|abschicken|schick(?:e)?\s+(?:es\s+)?ab|send it)[\s.!]*$/iu);
  if (!m || m.index === undefined) return { text, send: false };
  const rest = text.slice(0, m.index).replace(/^[ \t]+|[ \t]+$/g, "");
  return { text: rest, send: !!rest };
}

export interface TextOptions {
  vocabularyText: string;
  useVocabulary: boolean;
  replacements: Replacement[];
  removeFillers: boolean;
  language: string;
}

/** Replacements + vocabulary aliases (alias → canonical spelling), case-insensitive whole words. */
export function applyVocabulary(text: string, o: TextOptions, extra: string[] = []): string {
  let out = text;
  const terms = allTerms(parseTerms(o.vocabularyText), extra);
  const rules: [string, string][] = o.replacements.map((r) => [r.from, r.to]);
  if (o.useVocabulary) for (const term of terms) for (const a of term.aliases) rules.push([a, term.text]);
  for (const [from, to] of rules) if (from.trim()) out = replaceAll(out, loosePattern(from), to);
  if (o.useVocabulary) {
    // fix casing/spacing of known terms ("typescript", "Type-Script" → "TypeScript")
    for (const term of terms) if (term.text.length >= 3) out = replaceAll(out, loosePattern(term.text), term.text);
  }
  return out;
}

/** Everything after recognition: invented subtitles, fillers, replacements, vocabulary, ticket keys. */
export function finishText(raw: string, o: TextOptions, extra: string[] = []): string {
  let out = dropHallucinations(raw);
  if (o.removeFillers) out = dropFillers(out, o.language);
  out = applyVocabulary(out, o, extra);
  const all = allTerms(parseTerms(o.vocabularyText), extra).map((t) => t.text);
  out = formatTickets(out, ticketPrefixes(all));
  return out.trim();
}

/** Terms for Whisper's prompt (own vocabulary first, then the session's). */
export function promptTerms(o: Pick<TextOptions, "vocabularyText" | "useVocabulary">, extra: string[]): string[] {
  return o.useVocabulary ? allTerms(parseTerms(o.vocabularyText), extra).map((t) => t.text) : [];
}

const matches = (re: RegExp, text: string) => [...text.matchAll(re)].map((m) => m[0]);

/** Words the open session is about: names (workspace, folder, title), ticket keys, file names and
 *  identifiers from the recent conversation. They help recognition and fix spelling afterwards. */
export function sessionTerms(names: string[], items: TimelineItem[]): string[] {
  const words = [...names];
  const texts: string[] = [];
  const paths: string[] = [];
  for (const item of items.slice(-40)) {
    if (item.k === "user" || item.k === "text") texts.push(item.text.slice(0, 4000));
    else if (item.k === "ask") for (const q of item.questions ?? [item]) texts.push(`${q.question} ${q.options.join(" ")}`);
    else if (item.k === "tools") for (const c of item.calls) if (c.path) paths.push(c.path);
  }
  const all = texts.join("\n");
  // ticket keys like TENDR-725 – the most recent ones first
  words.push(...matches(/\b[A-Z][A-Z0-9]{1,9}-\d{1,6}\b/g, all).reverse());
  // file names without extension ("AgentSession.swift" → "AgentSession")
  for (const path of paths.reverse()) {
    const name = path.split("/").pop() ?? "";
    const dot = name.lastIndexOf(".");
    const stem = dot > 0 ? name.slice(0, dot) : name;
    if (stem.length >= 4) words.push(stem);
  }
  // CamelCase identifiers people say out loud
  words.push(...matches(/\b[a-z]+[A-Z][A-Za-z0-9]+\b|\b[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]+\b/g, all).reverse());
  const seen = new Set<string>();
  const out: string[] = [];
  for (const w of words.map((w) => w.trim())) {
    const k = w.toLowerCase();
    if (w.length < 3 || /^[+-]?\d+$/.test(w) || seen.has(k)) continue;
    seen.add(k);
    out.push(w);
    if (out.length === 40) break;
  }
  return out;
}
