// Composer helpers without UI (iOS ComposerAssist.swift): prompt snippets, "@" file mentions,
// inserting at the caret and the size math for downscaling images before an upload.

export interface Edit {
  text: string;
  /** caret after the edit */
  caret: number;
}

// ------------------------------------------------------------ snippets

export const SNIPPETS_KEY = "hollr.snippets";

export const DEFAULT_SNIPPETS = [
  "Lass die Tests laufen und behebe, was rot ist.",
  "Fasse kurz zusammen, was du gemacht hast.",
  "Committe mit einer sinnvollen Nachricht und öffne einen PR.",
  "Erkläre mir den Plan, bevor du anfängst.",
  "Mach weiter.",
];

/** Stored snippets (trimmed, no doubles); missing or broken storage gives the defaults (an empty list stays empty). */
export function parseSnippets(raw: string | null): string[] {
  if (raw == null) return [...DEFAULT_SNIPPETS];
  try {
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return [...DEFAULT_SNIPPETS];
    const list = v.filter((s): s is string => typeof s === "string" && s.trim() !== "").map((s) => s.trim());
    return [...new Set(list)];
  } catch {
    return [...DEFAULT_SNIPPETS];
  }
}

/** Moves item `from` by `by` places (clamped); the same list when nothing moves. */
export function move<T>(list: T[], from: number, by: number): T[] {
  const to = Math.max(0, Math.min(list.length - 1, from + by));
  if (from < 0 || from >= list.length || to === from) return list;
  const out = [...list];
  const [item] = out.splice(from, 1);
  out.splice(to, 0, item as T);
  return out;
}

/**
 * Puts `insert` in place of the selection [start, end). Keeps words apart: a space before it when the
 * text there doesn't end in whitespace, and one after it when the text after doesn't start with whitespace.
 */
export function insertAt(text: string, start: number, end: number, insert: string): Edit {
  const a = Math.max(0, Math.min(start, text.length));
  const b = Math.max(a, Math.min(end, text.length));
  const before = text.slice(0, a);
  const after = text.slice(b);
  const pre = before && !/\s$/.test(before) ? " " : "";
  const post = after && !/^\s/.test(after) ? " " : "";
  const middle = pre + insert + post;
  return { text: before + middle + after, caret: a + middle.length };
}

// ------------------------------------------------------------ "@" mentions

const MENTION = /(^|[\s(])@([\w./-]{0,80})$/;

/** "@frag" right before the caret: where the "@" is and what was typed after it. */
export function mentionAt(text: string, caret: number): { start: number; query: string } | null {
  const m = MENTION.exec(text.slice(0, caret));
  if (!m) return null;
  const query = m[2] ?? "";
  return { start: caret - query.length - 1, query };
}

/** Replaces "@frag" (from `start` up to the caret) with "@path ". */
export function applyMention(text: string, caret: number, start: number, path: string): Edit {
  const after = text.slice(caret);
  const insert = `@${path}${/^\s/.test(after) ? "" : " "}`;
  return { text: text.slice(0, start) + insert + after, caret: start + insert.length };
}

// ------------------------------------------------------------ images

export const MAX_IMAGE_SIDE = 2048;
export const JPEG_QUALITY = 0.8;
/** server limit for one upload (server/src/uploads.ts) */
export const UPLOAD_LIMIT = 20 * 1024 * 1024;

/** Target size so the longer side is at most `max` (aspect ratio kept, never upscaled). */
export function fitSize(width: number, height: number, max = MAX_IMAGE_SIDE): { width: number; height: number; scaled: boolean } {
  const long = Math.max(width, height);
  if (long <= max || long <= 0) return { width, height, scaled: false };
  const f = max / long;
  return { width: Math.max(1, Math.round(width * f)), height: Math.max(1, Math.round(height * f)), scaled: true };
}

/** File name for an image that was re-encoded as JPEG ("Bild.png" → "Bild.jpg"; pasted images have none). */
export function jpegName(name: string, now = new Date()): string {
  const base = name.replace(/\.[^./]*$/, "");
  if (base) return `${base}.jpg`;
  const stamp = now.toISOString().slice(0, 19).replace(/[-:T]/g, "");
  return `bild-${stamp}.jpg`;
}
