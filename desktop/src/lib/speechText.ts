// Read aloud (speech.svelte.ts): selected chat / terminal text → what a voice should say, and which
// language it is in. Pure functions, tested in speechText.test.ts.

/** The languages Phonon 40m multilingual speaks (speech.rs knows the same five). */
export type SpeechLang = "de" | "en" | "fr" | "es" | "pt";
export const SPEECH_LANGS: SpeechLang[] = ["de", "en", "fr", "es", "pt"];

/** Settings › Vorlesen: one test sentence per language (detectLanguage recognises each). */
export const SAMPLES: Record<SpeechLang, string> = {
  de: "Hallo! So klingt Hollr, wenn es dir markierten Text aus dem Chat oder dem Terminal vorliest.",
  en: "Hello! This is how Hollr sounds when it reads the text you selected in the chat or the terminal.",
  fr: "Bonjour ! Voici comment Hollr lit à voix haute le texte sélectionné dans le chat ou le terminal.",
  es: "¡Hola! Así suena Hollr cuando lee en voz alta el texto seleccionado en el chat o el terminal.",
  pt: "Olá! É assim que o Hollr lê em voz alta o texto selecionado no chat ou no terminal.",
};

const FENCE = /^\s*(```+|~~~+)/;
// box drawing, block elements and the glyphs TUIs draw frames, trees and status lines with
const CHROME = /[\u2500-\u259f\u23bf\u23fa\u2800-\u28ff●○◉◆◇◐◑▸▹►▶▷◂◀✓✔✗✘✱✻✽⎯⏵⏴]/g;
const ANSI = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g;
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>()\]]+/gi;

/** A link is read as its host ("github.com"), not letter by letter. */
function host(url: string): string {
  try {
    return new URL(url.startsWith("www.") ? `https://${url}` : url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function inline(s: string): string {
  return s
    .replace(ANSI, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1") // images: alt text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // links: their text
    .replace(/<((?:https?:\/\/)[^>]+)>/g, (_, u: string) => host(u))
    .replace(URL_RE, (u) => {
      const tail = /[.,;:!?]+$/.exec(u)?.[0] ?? "";
      return host(u.slice(0, u.length - tail.length)) + tail;
    })
    .replace(/<\/?[a-z][^>]*>/gi, " ") // html tags
    .replace(/`+([^`]*)`+/g, "$1") // inline code: keep the name, drop the ticks
    .replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, "$2")
    .replace(/(^|[^\w*])\*(?=\S)([^*]+?)(?<=\S)\*(?!\w)/g, "$1$2")
    .replace(/(^|[^\w])_(?=\S)([^_]+?)(?<=\S)_(?!\w)/g, "$1$2") // not snake_case
    .replace(/~~(.+?)~~/g, "$1")
    .replace(CHROME, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** A sentence of its own gets an end, so the voice pauses (headings, list items, table rows). */
const sentence = (s: string) => (/[.!?:;…]$/.test(s) ? s : `${s}.`);

/** Lines of a fenced block (without the fences); the text outside them otherwise. */
function splitFences(lines: string[]): { code: string[][]; prose: string[] } {
  const code: string[][] = [];
  const prose: string[] = [];
  let block: string[] | null = null;
  for (const line of lines) {
    if (FENCE.test(line)) {
      if (block) {
        code.push(block);
        block = null;
        prose.push(""); // a paragraph break where the code was
      } else block = [];
      continue;
    }
    if (block) block.push(line);
    else prose.push(line);
  }
  if (block) code.push(block); // an unclosed fence (the selection ended inside it) is code too
  return { code, prose };
}

/** Markdown / terminal text → plain sentences. Code blocks are skipped – unless only code is selected:
 *  then that is what you want to hear. Hard-wrapped lines join up again; "" = nothing to say. */
export function speakable(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const { code, prose } = splitFences(lines);
  const proseText = prose.map(inline).join("");
  const source = !proseText && code.length ? code.flat() : prose;

  const out: string[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push(para.join(" "));
    para = [];
  };
  for (const raw of source) {
    // TUI frames (│ … │) and quote markers around the text; ASCII | stays for tables
    const line = raw.replace(ANSI, "").replace(/^\s*(?:[│┃]\s*)+/, "").replace(/\s*[│┃]\s*$/, "").replace(/^\s*(?:>\s?)+/, "").trimEnd();
    if (!line.trim() || /^\s*([-*_=]\s*){3,}$/.test(line)) {
      flush();
      continue;
    }
    // table rows: cells with commas; the |---|---| separator goes
    if (/^\s*\|.*\|\s*$/.test(line)) {
      if (/^[\s|:\-]+$/.test(line)) continue;
      flush();
      const cells = line.trim().slice(1, -1).split("|").map(inline).filter(Boolean);
      if (cells.length) out.push(sentence(cells.join(", ")));
      continue;
    }
    const heading = /^\s*#{1,6}\s+(.*)$/.exec(line);
    const item = /^\s*(?:[-*+•·]|\d{1,3}[.)])\s+(?:\[[ xX]\]\s+)?(.*)$/.exec(line);
    if (heading || item) {
      flush();
      const s = inline((heading ?? item)![1]);
      if (s) out.push(sentence(s));
      continue;
    }
    const s = inline(line);
    if (s) para.push(s);
  }
  flush();
  return out.join("\n").trim();
}

// ------------------------------------------------------------ language

const WORDS: Record<SpeechLang, string[]> = {
  de: ["der", "die", "das", "und", "ist", "nicht", "ich", "du", "wir", "ihr", "ein", "eine", "einen", "mit", "auf", "für", "von",
    "zu", "den", "dem", "des", "im", "auch", "wird", "sind", "noch", "bei", "wie", "aber", "oder", "kann", "nur", "schon", "jetzt",
    "dann", "wenn", "dass", "hier", "mal", "bitte", "danke", "habe", "hat", "haben", "wurde", "werden", "sich", "aus", "nach", "über",
    "keine", "kein", "diese", "dieser", "alle", "mehr", "sehr", "gibt", "jetzt", "damit", "weil", "doch", "also", "beim", "vom", "zum", "zur"],
  en: ["the", "and", "is", "are", "not", "you", "we", "it", "this", "that", "with", "for", "of", "to", "in", "on", "be", "have",
    "has", "was", "were", "will", "can", "but", "or", "if", "then", "what", "which", "there", "here", "from", "an", "as", "at", "by",
    "do", "does", "should", "would", "could", "now", "just", "all", "any", "some", "its", "they", "these", "those", "into", "about"],
  fr: ["le", "la", "les", "et", "est", "une", "un", "des", "pas", "que", "qui", "pour", "dans", "sur", "avec", "ce", "cette", "sont",
    "je", "vous", "nous", "il", "elle", "du", "au", "aux", "mais", "ou", "très", "être", "avoir", "fait", "comme", "plus", "leur"],
  es: ["el", "la", "los", "las", "y", "es", "una", "un", "que", "no", "por", "para", "con", "en", "del", "se", "lo", "como", "pero",
    "más", "está", "son", "yo", "usted", "nosotros", "muy", "hay", "también", "esto", "este", "esta", "cuando", "donde", "sí"],
  pt: ["o", "os", "as", "e", "é", "uma", "um", "que", "não", "por", "para", "com", "em", "do", "da", "dos", "das", "se", "como",
    "mas", "mais", "está", "são", "eu", "você", "nós", "muito", "também", "isso", "este", "esta", "quando", "onde", "sim", "ao"],
};
const SETS = Object.fromEntries(SPEECH_LANGS.map((l) => [l, new Set(WORDS[l])])) as Record<SpeechLang, Set<string>>;
/** letters that (almost) only one of them uses */
const LETTERS: [SpeechLang, RegExp][] = [
  ["de", /[äöüß]/g],
  ["fr", /[èêëàâîïôûùœ]/g],
  ["es", /[ñ¿¡]/g],
  ["pt", /[ãõ]/g],
];

/** The language of `text` by its common words and letters; `fallback` when it doesn't say
 *  (only names and code, a tie). German with English tech terms stays German. */
export function detectLanguage(text: string, fallback: SpeechLang): SpeechLang {
  const lower = text.toLowerCase();
  const words = lower.match(/\p{L}+/gu) ?? [];
  const score: Record<SpeechLang, number> = { de: 0, en: 0, fr: 0, es: 0, pt: 0 };
  for (const w of words) for (const l of SPEECH_LANGS) if (SETS[l].has(w)) score[l]++;
  for (const [l, re] of LETTERS) score[l] += 2 * (lower.match(re)?.length ?? 0);
  const ranked = [...SPEECH_LANGS].sort((a, b) => score[b] - score[a]);
  const [best, second] = [score[ranked[0]], score[ranked[1]]];
  // one common word decides only when no other language has any
  if (best === 0 || (best === 1 && second > 0) || score[fallback] === best) return fallback;
  return ranked[0];
}
