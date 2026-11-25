/**
 * Werkbank cards (GitHub issues). Elements are cached per issue and only rebuilt when what they show changes
 * (signature), so a poll that brings the same data touches no DOM. Clicks are handled by the board via `data-card`
 * and `data-jira` (the ticket link, into „Tickets“) – no per-card closures.
 */
import { shortReason, withoutKey } from "../dock";
import { h, icon } from "../dom";
import { ICON } from "../icons";
import { branchColour, isBusy, PHASE_TEXT, shortBranch } from "../model";
import type { DriftItem, Issue, Phase, TicketFlags } from "../types";
import { driftEl, prLinkEl } from "./ticketcard";

export interface CardInfo {
  issue: Issue;
  /** labels to show as chips (without queue/story/grill) */
  labels: string[];
  pos?: number;
  phase?: Phase;
  branch?: string;
  siblings?: number[];
  flags: TicketFlags | null;
  blockers: number[];
  /** „Blockiert von“ entries without #N: the loop skips the issue until they are done and removed */
  notes: string[];
  locked: boolean;
  /** grill of the ticket: badge text (`gegrillt ✓`, `gegrillt 4/7`, `wartet auf dich`, `Stand unbekannt`, `wartet auf Start`), tone, where ("" = no line) and why it waits */
  grill?: { badge: string | null; tone: "waiting" | "running" | "done" | "queued" | "unknown"; where: string; reason?: string | null };
  /** the JIRA ticket the issue belongs to: key (null = none), its product labels, drift on this issue */
  ticket: { key: string | null; labels: string[]; drift: DriftItem[] };
  /** the main PR closing the issue, as a link („PR #3550 gemergt“) */
  pr: { text: string; url: string; state: string } | null;
}

const cache = new Map<number, { sig: string; el: HTMLElement }>();

const initials = (login: string) => login.replace(/[^a-zA-Z0-9]/g, "").slice(0, 2).toUpperCase() || "?";

export function cardEl(c: CardInfo): HTMLElement {
  const i = c.issue;
  const sig = JSON.stringify([i.title, i.state, i.labels, i.assignees, i.parent, c.labels, c.pos, c.phase, c.branch, c.siblings, c.flags, c.blockers, c.notes, c.locked, c.grill, c.ticket, c.pr]);
  const hit = cache.get(i.number);
  if (hit?.sig === sig) return hit.el;
  const el = build(c);
  cache.set(i.number, { sig, el });
  return el;
}

function build(c: CardInfo): HTMLElement {
  const i = c.issue;
  const busy = isBusy(c.phase);
  const f = c.flags;
  const footer =
    f?.deploy || f?.video || f?.testnote || c.branch
      ? h(
          "div",
          { class: "card-foot" },
          f?.deploy ? h("span", { class: "ico deploy", title: "Deploy auf workr" }, "⬆") : null,
          f?.video ? h("span", { class: "ico video", title: "Testvideo" }, "▶") : null,
          f?.testnote ? h("span", { class: "ico note", title: "Testanweisung" }, "✎") : null,
          c.branch
            ? h(
                "span",
                {
                  class: "branch",
                  title: `${c.branch}${c.siblings?.length ? `\nMit: ${c.siblings.map((s) => `#${s}`).join(", ")}` : ""}`,
                },
                h("span", { class: "dot", style: `background:${branchColour(c.branch)}` }),
                shortBranch(c.branch),
              )
            : null,
        )
      : null;
  return h(
    "article",
    {
      class: `card${busy ? " running" : ""}${c.locked ? " locked" : ""}${c.phase ? ` ph-${c.phase}` : ""}${c.notes.length ? " note-blocked" : ""}`,
      "data-card": i.number,
      tabindex: 0,
    },
    h(
      "div",
      { class: "card-top" },
      c.pos ? h("span", { class: "pos" }, `${c.pos}.`) : null,
      h("span", { class: "num" }, `#${i.number}`),
      h("span", { class: "grow" }),
      c.phase && c.phase !== "queued" ? h("span", { class: `phase ${c.phase}` }, busy ? `🔒 ${PHASE_TEXT[c.phase]}` : PHASE_TEXT[c.phase]) : null,
      c.grill?.badge ? h("span", { class: `grill-badge ${c.grill.tone}` }, c.grill.badge) : null,
    ),
    c.blockers.length ? waitRow(c.blockers) : null,
    c.notes.length ? noteRow(c.notes) : null,
    // the key is on the chip right below
    h("div", { class: "card-title" }, withoutKey(i.title, c.ticket.key ?? i.jira)),
    h(
      "div",
      { class: "chips" },
      i.parent ? h("span", { class: "chip story" }, `Story #${i.parent}`) : null,
      c.ticket.key ? h("button", { class: "chip jira", "data-jira": c.ticket.key, title: `${c.ticket.key} in „Tickets“ öffnen` }, c.ticket.key) : null,
      ...c.labels.map((l) => h("span", { class: "chip" }, l)),
      // product labels live in JIRA only: shown dimmed, from the ticket
      ...c.ticket.labels.filter((l) => !c.labels.includes(l)).map((l) => h("span", { class: "chip dim", title: "Fach-Label des JIRA-Tickets" }, l)),
      i.assignees.length
        ? h("span", { class: "avatars", title: i.assignees.join(", ") }, ...i.assignees.slice(0, 2).map((a) => h("span", { class: "avatar" }, initials(a))))
        : null,
    ),
    driftEl(c.ticket.drift, null),
    c.pr ? h("div", { class: "card-pr" }, prLinkEl(c.pr)) : null,
    footer,
    c.grill?.reason ? h("div", { class: "card-grill reason" }, c.grill.reason) : null,
    c.grill?.where ? h("div", { class: "card-grill" }, c.grill.where) : null,
  );
}

/** „🔒 blockiert“ + the free-text blocker, shortened; the full text and what it means in the tooltip. */
function noteRow(notes: string[]): HTMLElement {
  const text = notes.join(" · ");
  return h(
    "div",
    {
      class: "card-note",
      title: `Blockiert von: ${text}. Ohne #N zählt der Eintrag als offen – die Schleife überspringt dieses Issue, bis der Eintrag unter „Blockiert von“ erledigt oder entfernt ist.`,
    },
    h("span", { class: "pill", "data-tone": "neutral" }, icon(ICON.lock, "pill-ico"), h("span", { class: "pill-text" }, "blockiert")),
    h("span", { class: "card-note-text" }, shortReason(text)),
  );
}

/** „⛓ wartet auf #3544, #3543“: the same neutral pill as „blockiert“, the chain says it waits for issues. */
function waitRow(blockers: number[]): HTMLElement {
  const text = `wartet auf ${blockers.map((b) => `#${b}`).join(", ")}`;
  return h(
    "div",
    { class: "card-note", title: "Die Schleife überspringt es, bis die Blocker zu sind" },
    h("span", { class: "pill", "data-tone": "neutral" }, icon(ICON.link2, "pill-ico"), h("span", { class: "pill-text" }, text)),
  );
}

/** Forget cards of tickets that no longer exist (project switch). */
export const clearCards = () => cache.clear();
