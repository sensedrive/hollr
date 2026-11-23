/**
 * Ticket cards of the „Tickets“ view (JIRA) and the drift block both card kinds show. Cached per ticket key and
 * rebuilt only when what they show changes; clicks go through the view via `data-card` (the key).
 */
import { h } from "../dom";
import { PHASE_TEXT } from "../model";
import { type BuildLine, driftText, INFO_KINDS, initials, typeIcon } from "../tickets";
import type { DriftItem, JiraTicket, Phase } from "../types";
import type { CardInfo } from "./cards";

/** Lines a card shows per drift kind group; the rest is counted (the details list all). */
const MAX_LINES = 2;

/** „⚠ Abweichung“ with up to two lines to apply; info items below in muted text. Null without drift. */
export function driftEl(items: DriftItem[], derived: JiraTicket["derived"]): HTMLElement | null {
  if (!items.length) return null;
  const act = items.filter((d) => !INFO_KINDS[d.kind]);
  const info = items.filter((d) => INFO_KINDS[d.kind]);
  const more = act.length - MAX_LINES;
  return h(
    "div",
    { class: "drift" },
    act.length ? h("span", { class: "drift-badge" }, act.length > 1 ? `⚠ ${act.length} Abweichungen` : "⚠ Abweichung") : null,
    ...act.slice(0, MAX_LINES).map((d) => h("div", { class: "drift-line" }, driftText(d, derived))),
    more > 0 ? h("div", { class: "drift-line" }, `+ ${more} weitere`) : null,
    ...info.map((d) => h("div", { class: "drift-line info" }, `ℹ ${driftText(d, derived)}`)),
  );
}

export interface TicketCardInfo {
  t: JiraTicket;
  /** place in its machine lane */
  pos?: number;
  build: BuildLine;
  /** the most advanced phase of a child in a live run */
  phase?: Phase;
  grill?: CardInfo["grill"];
  /** locked: a child is being built */
  busy: boolean;
}

const cache = new Map<string, { sig: string; el: HTMLElement }>();

export function ticketCardEl(c: TicketCardInfo): HTMLElement {
  const t = c.t;
  const sig = JSON.stringify([t.summary, t.status, t.type, t.labels, t.assignee?.name, t.epic, t.drift, t.derived, c.pos, c.build, c.phase, c.grill, c.busy]);
  const hit = cache.get(t.key);
  if (hit?.sig === sig) return hit.el;
  const el = build(c);
  cache.set(t.key, { sig, el });
  return el;
}

function build(c: TicketCardInfo): HTMLElement {
  const t = c.t;
  const hasDrift = t.drift.some((d) => !INFO_KINDS[d.kind]);
  return h(
    "article",
    {
      class: `card tcard${c.busy ? " running locked" : ""}${hasDrift ? " has-drift" : ""}${t.category === "done" ? " is-done" : ""}`,
      "data-card": t.key,
      tabindex: 0,
    },
    h(
      "div",
      { class: "card-top" },
      c.pos ? h("span", { class: "pos" }, `${c.pos}.`) : null,
      h("span", { class: "ticon", title: t.type, "aria-label": t.type }, typeIcon(t.type)),
      h("span", { class: "key" }, t.key),
      h("span", { class: "grow" }),
      c.phase && c.phase !== "queued" ? h("span", { class: `phase ${c.phase}` }, PHASE_TEXT[c.phase]) : null,
      c.grill?.badge ? h("span", { class: `grill-badge ${c.grill.tone}` }, c.grill.badge) : null,
      t.assignee ? h("span", { class: "avatar", title: t.assignee.name }, initials(t.assignee.name)) : null,
    ),
    h("div", { class: "card-title" }, t.summary),
    t.labels.length || t.epic
      ? h(
          "div",
          { class: "chips" },
          ...t.labels.map((l) => h("span", { class: "chip" }, l)),
          t.epic ? h("span", { class: "chip epic", title: t.epic.key }, `Epic ${t.epic.summary || t.epic.key}`) : null,
        )
      : null,
    c.build.text || c.build.pr
      ? h(
          "div",
          { class: "build" },
          h("div", { class: "build-text" }, c.build.text, c.build.text && c.build.pr ? " · " : null, c.build.pr ? prLinkEl(c.build.pr) : null),
          c.build.segs.length ? h("span", { class: "segbar" }, ...c.build.segs.map((s) => h("span", { class: `seg ${s}` }))) : null,
        )
      : null,
    driftEl(t.drift, t.derived),
  );
}

/** A PR as a link („PR #3550 gemergt“); the views open `data-url` in the system browser instead of the card. */
export const prLinkEl = (pr: { text: string; url: string; state: string }) =>
  h("a", { class: `pr-link pr-${pr.state}`, href: pr.url, "data-url": pr.url, title: "Auf GitHub öffnen" }, pr.text);

export const clearTicketCards = () => cache.clear();
