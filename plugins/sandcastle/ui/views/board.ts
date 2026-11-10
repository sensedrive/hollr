/** The board: Zu grillen · Backlog · Sandcastle · Erledigt, a story filter and "+ Neues Issue". */
import { api } from "../api";
import { dragging, enableDrag } from "../drag";
import { fill, h } from "../dom";
import { errorText, reloadAll, state, toast } from "../state";
import type { Board, Card, Column } from "../types";
import { cardEl } from "./cards";
import { openIssue } from "./sidebar";

const NAMES: Record<Column, string> = { grill: "Zu grillen", backlog: "Backlog", queue: "Sandcastle", done: "Erledigt" };

let root: HTMLElement | null = null;
let columnsEl: HTMLElement;
let filterEl: HTMLSelectElement;
let rendered = "";

function cardsOf(board: Board, col: Column): Card[] {
  const cards = board.columns[col] ?? [];
  if (state.filter === "all") return cards;
  if (state.filter === "none") return cards.filter((c) => !c.parent);
  return cards.filter((c) => String(c.parent) === state.filter);
}

function find(n: number): Card | undefined {
  for (const cards of Object.values(state.board?.columns ?? {})) {
    const c = cards?.find((x) => x.number === n);
    if (c) return c;
  }
  return undefined;
}

async function onDrop(n: number, to: Column, before: number | null): Promise<void> {
  const from = Object.entries(state.board?.columns ?? {}).find(([, cards]) => cards?.some((c) => c.number === n))?.[0];
  columnsEl.querySelector(`[data-card="${n}"]`)?.classList.add("pending");
  try {
    if (from === to) await api("/api/queue/move", { project: state.projectId, number: n, before });
    else state.board = await api<Board>("/api/move", { project: state.projectId, number: n, to });
  } catch (err) {
    toast(errorText(err));
  }
  await reloadAll();
}

/** The view's element (built once; drag stays attached to the columns). */
export function boardView(): HTMLElement {
  if (root) return root;
  filterEl = h("select", {
    "aria-label": "Nach Story filtern",
    onchange: () => {
      state.filter = filterEl.value;
      rendered = "";
      renderBoard();
    },
  });
  columnsEl = h("div", { class: "columns" });
  enableDrag(columnsEl, {
    canDrag: (n) => !find(n)?.running,
    onDrop: (n, to, before) => void onDrop(n, to, before),
    reorder: "queue",
  });
  root = h(
    "div",
    { class: "board" },
    h("div", { class: "toolbar" }, filterEl, h("button", { class: "btn primary", onclick: newIssue }, "+ Neues Issue")),
    columnsEl,
  );
  return root;
}

export function renderBoard(): void {
  const board = state.board;
  if (!root || dragging()) return;
  if (!board) {
    // another project is loading: never leave the previous one's cards on screen
    rendered = "";
    fill(columnsEl, h("p", { class: "empty" }, "Lädt …"));
    return;
  }
  // unchanged data: keep the DOM (no flicker, scroll positions stay)
  const key = JSON.stringify([board, state.filter]);
  if (key === rendered) return;
  rendered = key;

  const stories = board.stories;
  if (state.filter !== "all" && state.filter !== "none" && !stories.some((s) => String(s.number) === state.filter)) state.filter = "all";
  fill(
    filterEl,
    h("option", { value: "all" }, "Alle"),
    ...stories.map((s) => h("option", { value: String(s.number) }, `#${s.number} ${s.title}`)),
    h("option", { value: "none" }, "Ohne Story"),
  );
  filterEl.value = state.filter;

  const scrollX = columnsEl.scrollLeft;
  const scrollY = new Map([...columnsEl.querySelectorAll<HTMLElement>("[data-column]")].map((c) => [c.dataset.column, c.querySelector("[data-list]")?.scrollTop ?? 0]));
  const cols: Column[] = board.hasGrill ? ["grill", "backlog", "queue", "done"] : ["backlog", "queue", "done"];
  fill(
    columnsEl,
    ...cols.map((col) => {
      const cards = cardsOf(board, col);
      const list = h(
        "div",
        { class: "list", "data-list": true },
        ...cards.map((c) => cardEl(c, { position: col === "queue" ? (board.columns.queue?.indexOf(c) ?? -1) + 1 : undefined, onOpen: openIssue, locked: c.running })),
      );
      if (!cards.length) list.append(h("p", { class: "empty" }, "Keine Issues"));
      return h(
        "section",
        { class: `column col-${col}`, "data-column": col },
        h("header", {}, h("span", {}, NAMES[col]), h("span", { class: "count" }, cards.length)),
        list,
      );
    }),
  );
  columnsEl.scrollLeft = scrollX;
  for (const c of columnsEl.querySelectorAll<HTMLElement>("[data-column]")) {
    const list = c.querySelector<HTMLElement>("[data-list]");
    if (list) list.scrollTop = scrollY.get(c.dataset.column) ?? 0;
  }
}

function newIssue(): void {
  const title = h("input", { type: "text", placeholder: "Titel", required: true });
  const body = h("textarea", { rows: 8, placeholder: "Beschreibung (Markdown)" });
  const column = h(
    "select",
    {},
    ...(state.board?.hasGrill ? [h("option", { value: "grill" }, "Zu grillen")] : []),
    h("option", { value: "backlog", selected: true }, "Backlog"),
    h("option", { value: "queue" }, "Sandcastle (ans Ende)"),
  );
  const error = h("p", { class: "error" });
  const create = h("button", { class: "btn primary", type: "submit" }, "Anlegen");
  const close = () => overlay.remove();
  const form = h(
    "form",
    {
      class: "modal",
      onsubmit: async (e: Event) => {
        e.preventDefault();
        if (!title.value.trim()) return;
        create.disabled = true;
        try {
          const { number } = await api<{ number: number }>("/api/issue", {
            project: state.projectId,
            title: title.value,
            body: body.value,
            column: column.value,
          });
          close();
          await reloadAll();
          openIssue(number);
        } catch (err) {
          error.textContent = errorText(err);
          create.disabled = false;
        }
      },
    },
    h("h2", {}, "Neues Issue"),
    title,
    body,
    h("label", {}, "Spalte ", column),
    error,
    h("div", { class: "btn-row end" }, h("button", { class: "btn", type: "button", onclick: () => close() }, "Abbrechen"), create),
  );
  const overlay = h("div", { class: "overlay", onclick: (e: Event) => e.target === overlay && close() }, form);
  document.body.append(overlay);
  title.focus();
}
