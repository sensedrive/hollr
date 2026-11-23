/**
 * Ticket cards. Elements are cached per ticket and only rebuilt when what they show changes (signature), so a poll
 * that brings the same data touches no DOM. Clicks are handled by the board via `data-card` (no per-card closures).
 */
import { h } from "../dom";
import { branchColour, isBusy, PHASE_TEXT, shortBranch } from "../model";
import type { Issue, Phase, TicketFlags } from "../types";

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
  locked: boolean;
}

const cache = new Map<number, { sig: string; el: HTMLElement }>();

const initials = (login: string) => login.replace(/[^a-zA-Z0-9]/g, "").slice(0, 2).toUpperCase() || "?";

export function cardEl(c: CardInfo): HTMLElement {
  const i = c.issue;
  const sig = JSON.stringify([i.title, i.state, i.labels, i.assignees, i.parent, i.jira, c.labels, c.pos, c.phase, c.branch, c.siblings, c.flags, c.blockers, c.locked]);
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
      class: `card${busy ? " running" : ""}${c.locked ? " locked" : ""}${c.phase ? ` ph-${c.phase}` : ""}`,
      "data-card": i.number,
      tabindex: 0,
    },
    h(
      "div",
      { class: "card-top" },
      c.pos ? h("span", { class: "pos" }, `${c.pos}.`) : null,
      h("span", { class: "num" }, `#${i.number}`),
      c.blockers.length ? h("span", { class: "blocked", title: "Die Schleife überspringt es, bis die Blocker zu sind" }, `wartet auf ${c.blockers.map((b) => `#${b}`).join(", ")}`) : null,
      h("span", { class: "grow" }),
      c.phase && c.phase !== "queued" ? h("span", { class: `phase ${c.phase}` }, busy ? `🔒 ${PHASE_TEXT[c.phase]}` : PHASE_TEXT[c.phase]) : null,
    ),
    h("div", { class: "card-title" }, i.title),
    h(
      "div",
      { class: "chips" },
      i.parent ? h("span", { class: "chip story" }, `Story #${i.parent}`) : null,
      i.jira ? h("span", { class: "chip jira" }, i.jira) : null,
      ...c.labels.map((l) => h("span", { class: "chip" }, l)),
      i.assignees.length
        ? h("span", { class: "avatars", title: i.assignees.join(", ") }, ...i.assignees.slice(0, 2).map((a) => h("span", { class: "avatar" }, initials(a))))
        : null,
    ),
    footer,
  );
}

/** Forget cards of tickets that no longer exist (project switch). */
export const clearCards = () => cache.clear();
