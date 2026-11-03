// When things were said: the chat's quiet time stamps and the terminal's time strip, from the `at` the server
// puts on timeline items (nothing is shown where it is missing).
import type { TimelineItem } from "./api";
import { plain } from "./inbox";

/** a reply's text gets a time again after this much quiet since the last one shown */
export const STAMP_GAP_MS = 10 * 60_000;

/**
 * Which items show their time in the chat: every user message, the first item of each reply and, in a long
 * turn, a text after a quiet gap – never every tool card. A reply that starts in the same minute as the stamp
 * above it (your message) stays without one: the same time twice in a row is only noise.
 */
export function stampedIds(items: TimelineItem[], gapMs = STAMP_GAP_MS): Set<string> {
  const out = new Set<string>();
  let replyStart = true;
  let last = -Infinity;
  const minute = (at: number) => Math.floor(at / 60_000);
  for (const i of items) {
    if (i.k === "user") {
      if (i.at !== undefined) {
        out.add(i.id);
        last = i.at;
      }
      replyStart = true;
      continue;
    }
    if (i.k === "end" || i.k === "info" || i.at === undefined) continue;
    if (replyStart || (i.k === "text" && i.at - last >= gapMs)) {
      if (minute(i.at) !== minute(last)) {
        out.add(i.id);
        last = i.at;
      }
      replyStart = false;
    }
  }
  return out;
}

/** "17:57" today, "2.11. 17:57" on another day, "2.11.25 17:57" in another year (English: "5:57 PM" …). */
export function clock(at: number, locale: string, now = Date.now()): string {
  const d = new Date(at);
  const n = new Date(now);
  const time = d.toLocaleTimeString(locale, { timeStyle: "short" });
  if (d.toDateString() === n.toDateString()) return time;
  const year = d.getFullYear() === n.getFullYear() ? undefined : "2-digit";
  return `${d.toLocaleDateString(locale, { day: "numeric", month: "numeric", year })} ${time}`;
}

/** For the tooltip: "Dienstag, 3. November 2026 um 17:57:28". */
export const fullTime = (at: number, locale: string) =>
  new Date(at).toLocaleString(locale, { dateStyle: "full", timeStyle: "medium" });

/** One line of the terminal's time strip. */
export interface Said {
  id: string;
  at: number;
  /** you (typed, spoken, a skill) · the agent's answer or question · another agent steering it */
  who: "you" | "agent" | "peer";
  voice?: boolean;
  text: string;
}

/** The last `n` messages with a time – prompts, answers and questions, newest last. */
export function recentSaid(items: TimelineItem[], n = 4): Said[] {
  const out: Said[] = [];
  for (let k = items.length - 1; k >= 0 && out.length < n; k--) {
    const i = items[k]!;
    if (i.at === undefined) continue;
    if (i.k === "user") {
      const who = i.source === "agent" ? "peer" : "you";
      out.push({ id: i.id, at: i.at, who, voice: i.source === "voice" || undefined, text: plain(i.text, 200) });
    } else if (i.k === "text") {
      const text = plain(i.text, 200);
      if (text) out.push({ id: i.id, at: i.at, who: "agent", text });
    } else if (i.k === "ask") {
      out.push({ id: i.id, at: i.at, who: "agent", text: `? ${plain(i.question, 200)}` });
    }
  }
  return out.reverse();
}
