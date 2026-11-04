// Side conversations ("Nebengespräch", server/src/fork.ts): a write-guarded copy of a session in its own tab,
// shown in the session's side panel. The copy carries the whole history; what belongs to the side conversation
// is what its log has after the fork. No i18n here – the labels come from the caller (bun test runs this).
import type { Pane, TimelineItem } from "./api";

/** The newest side conversation forked from `main` among `panes` (the server marks forks in its tree). */
export function forkOf<T extends { pane: Pane }>(panes: T[], main: string): T | undefined {
  let best: T | undefined;
  for (const r of panes) if (r.pane.fork?.of === main && (!best || r.pane.fork.at > (best.pane.fork?.at ?? 0))) best = r;
  return best;
}

/** The items after the fork: from the first one logged at or after `at` (items without a time go with the
 *  one before them). A fork made mid-turn keeps that turn's start in the history part. */
export function sideItems(items: TimelineItem[], at: number): TimelineItem[] {
  const from = items.findIndex((i) => i.at !== undefined && i.at >= at);
  return from < 0 ? [] : items.slice(from);
}

/** The side conversation as plain text for its summary (messages only, no tool cards or thoughts). */
export function sideTranscript(items: TimelineItem[], labels: { user: string; agent: string }): string {
  return items
    .flatMap((i) => (i.k === "user" ? [`${labels.user}: ${i.text}`] : i.k === "text" ? [`${labels.agent}: ${i.text}`] : []))
    .join("\n\n");
}

/** A draft for the main chat: the result goes below what is already typed there, never replaces it. */
export const appendDraft = (draft: string, text: string) => (draft.trim() ? `${draft.replace(/\s+$/, "")}\n\n${text}` : text);
