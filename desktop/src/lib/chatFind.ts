// Pure parts of the chat's find bar and overview ruler (components/chat/ChatFind + ChatRuler): which items and
// cards may hold a hit, where a query matches in a text, and the ruler's scale maths. No DOM / Svelte / Tauri
// imports, so `bun test` covers them.
//
// The data only decides *where to look*: an item whose text has a hit gets its rendered DOM searched (that is
// what is counted and highlighted – the rendered text differs from the log: Markdown marks, relative paths),
// and a folded card whose data has a hit is opened, so the hit is there to be found.
import type { TimelineItem, ToolCall } from "./api";
import type { ChatView } from "./chatTools";

// ------------------------------------------------------------ matching

/** "nur meine Nachrichten" = your prompts, "nur Antworten" = the agent's answers and questions */
export type FindScope = "all" | "user" | "agent";
export interface FindOptions {
  caseSensitive?: boolean;
  scope?: FindScope;
}

/** A literal (not regex) search for `query`; undefined for an empty query. */
export function matcher(query: string, caseSensitive = false): RegExp | undefined {
  if (!query) return undefined;
  return new RegExp(query.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&"), caseSensitive ? "g" : "gi");
}

/** Every hit of `re` in `text` as [start, end) – non-overlapping, left to right. */
export function matchSpans(text: string, re: RegExp): [number, number][] {
  const out: [number, number][] = [];
  re.lastIndex = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    // a literal query is never empty, but a zero-length match would loop forever
    if (!m[0].length) re.lastIndex++;
    else out.push([m.index, m.index + m[0].length]);
  }
  return out;
}

// ------------------------------------------------------------ what is searched

export type UnitRole = "user" | "agent" | "other";
/** Searchable text of one item, or of one card of a tools item. `key` is what a folded card opens on
 *  (TimelineView's thinking: the item id; tool cards: the call id, todo cards: their first call's id). */
export interface FindUnit {
  item: string;
  key: string;
  role: UnitRole;
  text: string;
}

/** Everything a tool card can show – generous on purpose: a false positive only searches one card's DOM. */
export function callText(c: ToolCall): string {
  const parts: (string | undefined)[] = [c.detail, c.label, c.result, c.cwd, c.path, c.file, c.bg, c.range, c.sub?.answer, c.sub?.agent];
  if (c.out) parts.push(c.out.join("\n"));
  for (const h of c.diff ?? []) parts.push(h.file, h.lines.map((l) => l.text).join("\n"));
  for (const m of c.matches ?? []) parts.push(m.file, m.lines.map((l) => l.text).join("\n"));
  if (c.files) parts.push(c.files.join("\n"));
  for (const l of c.links ?? []) parts.push(l.title, l.url);
  for (const p of c.todo ?? []) parts.push(p.name, p.tasks.map((x) => x.content).join("\n"));
  for (const w of c.waited ?? []) parts.push(w.id, w.label);
  return parts.filter(Boolean).join("\n");
}

/**
 * The chat's searchable units in display order. `prose` turns raw thinking into what the chat shows
 * (thinkingProse; injected so this module stays free of the app's API layer).
 */
export function findUnits(view: ChatView, prose: (s: string) => string = (s) => s): FindUnit[] {
  const out: FindUnit[] = [];
  for (const it of view.items) {
    const one = (role: UnitRole, text: string) => out.push({ item: it.id, key: it.id, role, text });
    switch (it.k) {
      case "user": one("user", it.text); break;
      case "text": one("agent", it.text); break;
      case "thinking": one("other", prose(it.text)); break;
      case "ask": {
        const qs = it.questions?.length ? it.questions : [it];
        one("agent", [...qs.flatMap((q) => [q.header, q.question, ...q.options, ...(q.descriptions ?? [])]), it.answer].filter(Boolean).join("\n"));
        break;
      }
      case "end": if (it.status !== "done") one("other", it.error ?? ""); break;
      case "info": one("other", it.text); break;
      case "tools":
        for (const p of view.pieces.get(it.id) ?? []) {
          const calls = p.kind === "call" ? [p.call] : p.calls;
          const key = p.kind === "call" ? p.call.id : p.kind === "todo" ? calls[0]!.id : p.id;
          out.push({ item: it.id, key, role: "other", text: calls.map(callText).join("\n") });
        }
        break;
    }
  }
  return out;
}

/** Which items to search in the DOM and which folded units to open for `query`. */
export function unitHits(units: FindUnit[], query: string, opts: FindOptions = {}): { items: Set<string>; reveal: Set<string> } {
  const items = new Set<string>();
  const reveal = new Set<string>();
  const re = matcher(query, opts.caseSensitive);
  if (!re) return { items, reveal };
  for (const u of units) {
    if (opts.scope && opts.scope !== "all" && u.role !== opts.scope) continue;
    re.lastIndex = 0;
    if (!re.test(u.text)) continue;
    items.add(u.item);
    reveal.add(u.key);
  }
  return { items, reveal };
}

// ------------------------------------------------------------ overview ruler

/** What a bar in the ruler stands for (its colour). */
export type OvKind = "user" | "agent" | "think" | "tool" | "err" | "ask" | "info";

/** The ruler's colour for an item; undefined = the item renders nothing. */
export function itemKind(it: TimelineItem): OvKind | undefined {
  switch (it.k) {
    case "user": return "user";
    case "text": return "agent";
    case "thinking": return "think";
    case "tools": return it.calls.some((c) => c.status === "error") ? "err" : "tool";
    case "ask": return "ask";
    case "end": return it.status === "done" ? undefined : "err";
    case "info": return "info";
  }
}

/** Heights in px: the scrolled content, the visible part of it, the ruler. */
export interface RulerFrame {
  content: number;
  viewport: number;
  ruler: number;
}
/** One measured item: top and height in content px. */
export interface OvBlock {
  top: number;
  height: number;
  kind: OvKind;
}
export interface OvBar {
  y: number;
  h: number;
  kind: OvKind;
}

/** Ruler px per content px – the whole chat fits the ruler; a chat shorter than the view keeps its real size. */
export const rulerScale = (f: RulerFrame) => f.ruler / Math.max(f.content, f.viewport, 1);

/**
 * The bars to draw: every block scaled, at least `minPx` high; neighbours of the same kind that touch at this
 * scale merge into one bar, so a chat of thousands of items stays at about one bar per ruler pixel.
 */
export function rulerBars(blocks: OvBlock[], f: RulerFrame, minPx = 1): OvBar[] {
  const s = rulerScale(f);
  const out: OvBar[] = [];
  for (const b of blocks) {
    const y = b.top * s;
    const h = Math.max(b.height * s, minPx);
    const prev = out.at(-1);
    if (prev && prev.kind === b.kind && y <= prev.y + prev.h + 1) prev.h = Math.max(prev.h, y + h - prev.y);
    else out.push({ y, h, kind: b.kind });
  }
  return out;
}

/** The visible part as a box in the ruler – never smaller than `minPx`, so it stays grabbable in long chats. */
export function viewportBox(f: RulerFrame, scrollTop: number, minPx = 16): { y: number; h: number } {
  const s = rulerScale(f);
  const used = Math.max(f.content, f.viewport) * s;
  const real = f.viewport * s;
  if (real >= minPx) return { y: Math.min(scrollTop * s, used - real), h: real };
  const h = Math.min(minPx, used);
  const center = (scrollTop + f.viewport / 2) * s;
  return { y: Math.min(Math.max(center - h / 2, 0), used - h), h };
}

/** The scroll position that centres the view on ruler height `y` (a click into the ruler). */
export function scrollForRuler(f: RulerFrame, y: number): number {
  const top = y / rulerScale(f) - f.viewport / 2;
  return Math.min(Math.max(top, 0), Math.max(f.content - f.viewport, 0));
}

/** Hit markers: one per `bucket` ruler px (the first hit there), so thousands of hits stay a few hundred marks. */
export function markerRows(tops: number[], f: RulerFrame, bucket = 2): { y: number; index: number }[] {
  const s = rulerScale(f);
  const out: { y: number; index: number }[] = [];
  let last = -Infinity;
  tops.forEach((top, index) => {
    const y = top * s;
    if (Math.floor(y / bucket) === Math.floor(last / bucket)) return;
    out.push({ y, index });
    last = y;
  });
  return out;
}

/** The hit nearest to ruler height `y` within `tolerance` px (clicking a marker picks it), else undefined. */
export function markerAt(rows: { y: number; index: number }[], y: number, tolerance = 4): number | undefined {
  let best: { d: number; index: number } | undefined;
  for (const r of rows) {
    const d = Math.abs(r.y - y);
    if (d <= tolerance && (!best || d < best.d)) best = { d, index: r.index };
  }
  return best?.index;
}
