// Unsent composer text per session ("serverId|pane"), persisted in localStorage.
// Pure helpers (no runes) – the reactive store lives in store.svelte.ts.

export interface Draft {
  text: string;
  /** last change (ms) – drafts older than MAX_AGE are dropped on load */
  at: number;
  /** messages on their way to the server – back into `text` if sending fails or the app quits meanwhile */
  sending?: string[];
}
export type Drafts = Record<string, Draft>;

export const DRAFTS_KEY = "hollr.drafts";
export const MAX_AGE = 14 * 24 * 60 * 60 * 1000;
export const RECALL_MAX = 50;

export const draftKey = (server: string, pane: string) => `${server}|${pane}`;

/** Puts `msg` back in front of what is typed now (never drops either). */
export function mergeText(current: string, msg: string): string {
  if (!msg.trim() || current.includes(msg)) return current;
  if (!current.trim()) return msg;
  return `${msg}\n${current}`;
}

const empty = (d: Draft) => !d.text && !d.sending?.length;

/** Reads stored drafts: drops broken and expired ones; sends that never finished come back as text. */
export function parseDrafts(raw: string | null, now = Date.now()): Drafts {
  let data: unknown;
  try {
    data = JSON.parse(raw ?? "{}");
  } catch {
    return {};
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return {};
  const out: Drafts = {};
  for (const [key, v] of Object.entries(data as Record<string, unknown>)) {
    if (!v || typeof v !== "object") continue;
    const d = v as Partial<Draft>;
    if (typeof d.text !== "string" || typeof d.at !== "number" || now - d.at > MAX_AGE) continue;
    let text = d.text;
    if (Array.isArray(d.sending)) for (const s of d.sending) if (typeof s === "string") text = mergeText(text, s);
    if (text) out[key] = { text, at: d.at };
  }
  return out;
}

export function serializeDrafts(drafts: Drafts): string {
  const out: Drafts = {};
  for (const [key, d] of Object.entries(drafts)) if (!empty(d)) out[key] = d;
  return JSON.stringify(out);
}

/** Sets the typed text (empty text and nothing in flight removes the draft). */
export function setText(drafts: Drafts, key: string, text: string, now = Date.now()) {
  const d = drafts[key];
  if (d?.text === text) return;
  const next: Draft = { ...d, text, at: now };
  if (empty(next)) delete drafts[key];
  else drafts[key] = next;
}

/** A message leaves the composer: keep it until the server confirmed it. */
export function beginSend(drafts: Drafts, key: string, msg: string, now = Date.now()) {
  const d = drafts[key];
  drafts[key] = { text: d?.text ?? "", at: now, sending: [...(d?.sending ?? []), msg] };
}

/** Sending finished: on success forget the message, on failure put it back into the text. */
export function endSend(drafts: Drafts, key: string, msg: string, ok: boolean, now = Date.now()) {
  const d = drafts[key];
  const i = d?.sending?.indexOf(msg) ?? -1;
  const sending = d?.sending?.filter((_, j) => j !== i) ?? [];
  const text = ok ? (d?.text ?? "") : mergeText(d?.text ?? "", msg);
  const next: Draft = { text, at: now, ...(sending.length ? { sending } : {}) };
  if (empty(next)) delete drafts[key];
  else drafts[key] = next;
}

/** ↑ history: newest first, no duplicates, capped. */
export const pushRecall = (list: string[], msg: string, max = RECALL_MAX) =>
  [msg, ...list.filter((x) => x !== msg)].slice(0, max);
