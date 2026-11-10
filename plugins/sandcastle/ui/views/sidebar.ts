/** Issue details beside the board (full screen on narrow windows): comment, labels, move, queue position. */
import { classify } from "../../src/board";
import { api, openExternal } from "../api";
import { fill, fmtDate, h, html } from "../dom";
import { currentProject, errorText, queueOrder, reloadAll, state, toast } from "../state";
import type { Column, IssueDetail } from "../types";

const COLUMN_NAMES: Record<Column, string> = { grill: "Zu grillen", backlog: "Backlog", queue: "Sandcastle", done: "Erledigt" };
const RUN_NAMES = { "in-arbeit": "In Arbeit", erledigt: "Erledigt", fehlgeschlagen: "Fehlgeschlagen", "ohne-commits": "Ohne Commits" };

let panel: HTMLElement | null = null;
let shown: number | null = null;
let busy = false;

function ensurePanel(): HTMLElement {
  if (panel) return panel;
  panel = h("aside", { id: "sidebar", "aria-label": "Issue-Details" });
  document.body.append(panel);
  return panel;
}

export function closeSidebar(): void {
  shown = null;
  panel?.classList.remove("open");
  document.body.classList.remove("sidebar-open");
}

/** Public links inside rendered markdown go to the system browser. */
function externalLinks(el: HTMLElement): HTMLElement {
  el.addEventListener("click", (e) => {
    const a = (e.target as Element).closest("a");
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute("href") ?? "";
    if (/^https?:/i.test(href)) openExternal(href);
  });
  return el;
}

export async function openIssue(n: number): Promise<void> {
  const el = ensurePanel();
  shown = n;
  el.classList.add("open");
  document.body.classList.add("sidebar-open");
  fill(el, header(`#${n}`), h("div", { class: "side-body" }, h("p", { class: "muted" }, "Lädt …")));
  try {
    const detail = await api<IssueDetail>(`/api/issue?project=${state.projectId}&number=${n}`);
    if (shown === n) render(detail);
  } catch (err) {
    if (shown === n) fill(el, header(`#${n}`), h("div", { class: "side-body" }, h("p", { class: "error" }, errorText(err))));
  }
}

function header(title: string, url?: string): HTMLElement {
  const open = (e: Event) => {
    e.preventDefault();
    if (url) openExternal(url);
  };
  return h(
    "div",
    { class: "side-head" },
    url ? h("a", { href: url, class: "side-num", onclick: open }, title) : h("span", { class: "side-num" }, title),
    h("button", { class: "btn", onclick: closeSidebar }, "Schließen"),
  );
}

/** Runs an action that changes the issue; shows the fresh details and reloads the board. */
async function act(fn: () => Promise<IssueDetail | unknown>, n: number): Promise<void> {
  if (busy) return;
  busy = true;
  panel?.classList.add("busy");
  try {
    const res = await fn();
    await reloadAll();
    if (shown !== n) return;
    if (res && typeof res === "object" && "bodyHtml" in res) render(res as IssueDetail);
    else await openIssue(n);
  } catch (err) {
    toast(errorText(err));
  } finally {
    busy = false;
    panel?.classList.remove("busy");
  }
}

function render(d: IssueDetail): void {
  const el = ensurePanel();
  const p = currentProject();
  if (!p) return;
  const col = classify({ state: d.state === "closed" ? "closed" : "open", labels: d.labels }, p.labels);
  const project = state.projectId;
  const n = d.number;

  const labelSelect = h(
    "select",
    {
      "aria-label": "Label hinzufügen",
      onchange: (e: Event) => {
        const name = (e.target as HTMLSelectElement).value;
        if (name) act(() => api("/api/labels", { project, number: n, add: [name], remove: [] }), n);
      },
    },
    h("option", { value: "" }, "Label hinzufügen …"),
    ...(state.board?.labels ?? []).filter((l) => !d.labels.includes(l.name)).map((l) => h("option", { value: l.name }, l.name)),
  );

  const comment = h("textarea", { rows: 3, placeholder: "Kommentar …" });
  const columns: Column[] = state.board?.hasGrill ? ["grill", "backlog", "queue", "done"] : ["backlog", "queue", "done"];

  const order = queueOrder();
  const idx = order.indexOf(n);
  const queueMove = (before: number | null) => act(() => api("/api/queue/move", { project, number: n, before }), n);

  fill(
    el,
    header(`#${n}`, d.url),
    h(
      "div",
      { class: "side-body" },
      h("h2", { class: "side-title" }, d.title),
      h(
        "div",
        { class: "side-meta" },
        h("span", { class: `state ${d.state}` }, d.state === "closed" ? "geschlossen" : "offen"),
        col !== "story" ? h("span", { class: "muted" }, COLUMN_NAMES[col]) : h("span", { class: "muted" }, "Story"),
        d.parent ? h("button", { class: "link", onclick: () => openIssue(d.parent?.number ?? 0) }, `Story #${d.parent.number} ${d.parent.title}`) : null,
        d.jira ? h("button", { class: "link", onclick: () => d.jira && openExternal(d.jira.url) }, d.jira.key) : null,
      ),
      h(
        "div",
        { class: "chips side-labels" },
        ...d.labels.map((l) =>
          h(
            "span",
            { class: "chip" },
            l,
            h("button", { class: "chip-x", "aria-label": `${l} entfernen`, onclick: () => act(() => api("/api/labels", { project, number: n, add: [], remove: [l] }), n) }, "×"),
          ),
        ),
        labelSelect,
      ),
      d.run
        ? h(
            "section",
            { class: `side-run ${d.run.status}` },
            h("h3", {}, `Lauf: ${RUN_NAMES[d.run.status]}`),
            d.run.reason ? h("p", { class: "error" }, d.run.reason) : null,
            ...d.run.logs.map((log) => h("details", {}, h("summary", {}, `Log ${log.name}`), h("pre", {}, log.tail))),
          )
        : null,
      col !== "story"
        ? h(
            "section",
            {},
            h("h3", {}, "Verschieben nach"),
            h(
              "div",
              { class: "btn-row" },
              ...columns.map((c) =>
                h("button", { class: "btn", disabled: c === col, onclick: () => act(() => api("/api/move", { project, number: n, to: c }), n) }, COLUMN_NAMES[c]),
              ),
            ),
            col === "queue" && idx >= 0
              ? h(
                  "div",
                  { class: "btn-row" },
                  h("span", { class: "muted" }, `Position ${idx + 1} von ${order.length}`),
                  h("button", { class: "btn", disabled: idx === 0, onclick: () => queueMove(order[0] ?? null) }, "Ganz nach oben"),
                  h("button", { class: "btn", disabled: idx === 0, onclick: () => queueMove(order[idx - 1] ?? null) }, "Eins hoch"),
                  h("button", { class: "btn", disabled: idx === order.length - 1, onclick: () => queueMove(order[idx + 2] ?? null) }, "Eins runter"),
                  h("button", { class: "btn", disabled: idx === order.length - 1, onclick: () => queueMove(null) }, "Ans Ende"),
                )
              : null,
          )
        : null,
      d.blockedBy.length
        ? h(
            "section",
            {},
            h("h3", {}, "Blockiert von"),
            h("div", { class: "btn-row" }, ...d.blockedBy.map((b) => h("button", { class: "link", onclick: () => openIssue(b) }, `#${b}`))),
          )
        : null,
      externalLinks(html("markdown", d.bodyHtml || "<p class=\"muted\">Kein Text.</p>")),
      h(
        "section",
        {},
        h("h3", {}, `Kommentare (${d.comments.length})`),
        ...d.comments.map((c) =>
          h("div", { class: "comment" }, h("div", { class: "muted small" }, `${c.author} · ${fmtDate(c.createdAt)}`), externalLinks(html("markdown", c.bodyHtml))),
        ),
        comment,
        h(
          "button",
          {
            class: "btn primary",
            onclick: () => {
              const text = comment.value.trim();
              if (text) act(() => api("/api/comment", { project, number: n, body: text }), n);
            },
          },
          "Kommentieren",
        ),
      ),
    ),
  );
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && shown !== null && !document.body.classList.contains("is-dragging")) closeSidebar();
});
