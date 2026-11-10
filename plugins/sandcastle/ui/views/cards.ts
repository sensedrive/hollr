/** A card as the board and the run view show it. */
import { h } from "../dom";
import { currentProject } from "../state";
import type { Card } from "../types";

export function cardEl(card: Card, opts: { position?: number; onOpen: (n: number) => void; locked?: boolean }): HTMLElement {
  const p = currentProject();
  const hidden = new Set([p?.labels.queue, p?.labels.story, p?.labels.grill].filter(Boolean));
  const chips: HTMLElement[] = [];
  if (card.parent) chips.push(h("span", { class: "chip story" }, `#${card.parent}`));
  if (card.jira) chips.push(h("span", { class: "chip jira" }, card.jira));
  for (const l of card.labels) if (!hidden.has(l)) chips.push(h("span", { class: "chip" }, l));
  const el = h(
    "div",
    {
      class: `card${card.running ? " running" : ""}${opts.locked ? " locked" : ""}`,
      "data-card": card.number,
      tabindex: 0,
      role: "button",
      onclick: () => opts.onOpen(card.number),
      onkeydown: (e: Event) => {
        if ((e as KeyboardEvent).key === "Enter") opts.onOpen(card.number);
      },
    },
    h(
      "div",
      { class: "card-top" },
      opts.position ? h("span", { class: "pos" }, `${opts.position}.`) : null,
      h("span", { class: "num" }, `#${card.number}`),
      card.running ? h("span", { class: "badge" }, "läuft") : null,
    ),
    h("div", { class: "card-title" }, card.title),
    chips.length ? h("div", { class: "chips" }, ...chips) : null,
  );
  return el;
}
