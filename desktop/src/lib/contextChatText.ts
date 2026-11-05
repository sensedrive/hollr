// "Neuer Chat mit Kontext" (server/src/fork.ts): an ordinary chat in a tab of its own that continues with a copy of
// another session's history. The copy carries the whole history; the chat shows only what its log has after the
// fork (the rest on demand). No i18n or Tauri here – the labels come from the caller (bun test runs this).
import type { TimelineItem } from "./api";

/** Index of the first item after the fork: the first one logged at or after `at` (items without a time go with
 *  the one before them); `items.length` when nothing came yet. A fork made mid-turn keeps that turn's start in
 *  the history part. */
export function historyCut(items: TimelineItem[], at: number): number {
  const from = items.findIndex((i) => i.at !== undefined && i.at >= at);
  return from < 0 ? items.length : from;
}

/** The chat as plain text for its summary (messages only, no tool cards or thoughts). */
export function chatTranscript(items: TimelineItem[], labels: { user: string; agent: string }): string {
  return items
    .flatMap((i) => (i.k === "user" ? [`${labels.user}: ${i.text}`] : i.k === "text" ? [`${labels.agent}: ${i.text}`] : []))
    .join("\n\n");
}

/** A draft for the source session: the result goes below what is already typed there, never replaces it. */
export const appendDraft = (draft: string, text: string) => (draft.trim() ? `${draft.replace(/\s+$/, "")}\n\n${text}` : text);

/** Tab labels of forks made by earlier versions ("🎙 Nebengespräch · X", "Nebengespräch · X", "🎙 X") show as "X". */
export const chatLabel = (label: string) => label.replace(/^🎙\uFE0F?\s*/u, "").replace(/^Nebengespräch\s*·\s*/u, "");
