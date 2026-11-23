/**
 * Ticket cards of the „Tickets“ view (JIRA) and the drift block both card kinds show. Cached per ticket key and
 * rebuilt only when what they show changes; clicks go through the view via `data-card` (the key).
 */
import { h, icon } from "../dom";
import { PHASE_TEXT } from "../model";
import { type BuildLine, driftText, INFO_KINDS, initials, type LiveKind, liveState, typeIcon } from "../tickets";
import type { DriftItem, JiraTicket, Phase } from "../types";
import type { CardInfo } from "./cards";

/** Lines a card shows per drift kind group; the rest is counted (the details list all). */
const MAX_LINES = 2;

/** „⚠ Abweichung“ with up to two lines to apply; info items below in muted text. Null without drift. */
export function driftEl(items: DriftItem[], derived: JiraTicket["derived"], released: JiraTicket["released"] = null): HTMLElement | null {
  if (!items.length) return null;
  const act = items.filter((d) => !INFO_KINDS[d.kind]);
  const info = items.filter((d) => INFO_KINDS[d.kind]);
  const more = act.length - MAX_LINES;
  return h(
    "div",
    { class: "drift" },
    act.length ? h("span", { class: "drift-badge" }, act.length > 1 ? `⚠ ${act.length} Abweichungen` : "⚠ Abweichung") : null,
    ...act.slice(0, MAX_LINES).map((d) => h("div", { class: "drift-line" }, driftText(d, derived, released))),
    more > 0 ? h("div", { class: "drift-line" }, `+ ${more} weitere`) : null,
    ...info.map((d) => h("div", { class: "drift-line info" }, `ℹ ${driftText(d, derived, released)}`)),
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
  const sig = JSON.stringify([t.summary, t.status, t.type, t.labels, t.assignee?.name, t.epic, t.drift, t.derived, t.inMain, t.released, t.prs, c.pos, c.build, c.phase, c.grill, c.busy]);
  const hit = cache.get(t.key);
  if (hit?.sig === sig) return hit.el;
  const el = build(c);
  cache.set(t.key, { sig, el });
  return el;
}

const ROCKET =
  '<path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/>';

/** Lucide icons of the live hint (magicfink sandcastle-board IssueCard: Rocket, GitMerge, CircleDashed, GitPullRequestDraft). */
const LIVE_ICON: Record<LiveKind, string> = {
  live: ROCKET,
  partlive: ROCKET,
  main: '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 21V9a9 9 0 0 0 9 9"/>',
  partial:
    '<path d="M10.1 2.182a10 10 0 0 1 3.8 0"/><path d="M13.9 21.818a10 10 0 0 1-3.8 0"/><path d="M17.609 3.721a10 10 0 0 1 2.69 2.7"/><path d="M2.182 13.9a10 10 0 0 1 0-3.8"/><path d="M20.279 17.609a10 10 0 0 1-2.7 2.69"/><path d="M21.818 10.1a10 10 0 0 1 0 3.8"/><path d="M3.721 6.391a10 10 0 0 1 2.7-2.69"/><path d="M6.391 20.279a10 10 0 0 1-2.69-2.7"/>',
  "not-main": '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M18 6V5"/><path d="M18 11v-1"/><path d="M6 9v12"/>',
};
const INFO_ICON = '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>';

function build(c: TicketCardInfo): HTMLElement {
  const t = c.t;
  const hasDrift = t.drift.some((d) => !INFO_KINDS[d.kind]);
  const live = liveState(t);
  // live while JIRA isn't done: the card says so under the build line, not in the drift block
  const stalled = t.released ? t.drift.find((d) => d.kind === "done-candidate") : undefined;
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
    c.build.text || c.build.pr || live
      ? h(
          "div",
          { class: "build" },
          h(
            "div",
            { class: "build-text" },
            c.build.text,
            c.build.text && c.build.pr ? " · " : null,
            c.build.pr ? prLinkEl(c.build.pr) : null,
            live
              ? h("span", { class: `live-hint live-${live.kind}`, title: live.tip }, icon(LIVE_ICON[live.kind], "live-ico"), live.label)
              : null,
          ),
          c.build.segs.length ? h("span", { class: "segbar" }, ...c.build.segs.map((s) => h("span", { class: `seg ${s}` }))) : null,
          stalled ? h("div", { class: "live-info" }, icon(INFO_ICON, "live-ico"), driftText(stalled, t.derived, t.released)) : null,
        )
      : null,
    driftEl(
      t.drift.filter((d) => d !== stalled),
      t.derived,
      t.released,
    ),
  );
}

/** A PR as a link („PR #3550 gemergt“); the views open `data-url` in the system browser instead of the card. */
export const prLinkEl = (pr: { text: string; url: string; state: string }) =>
  h("a", { class: `pr-link pr-${pr.state}`, href: pr.url, "data-url": pr.url, title: "Auf GitHub öffnen" }, pr.text);

export const clearTicketCards = () => cache.clear();
