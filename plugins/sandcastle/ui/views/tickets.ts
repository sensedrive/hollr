/**
 * „Tickets“: the JIRA tickets of the project as cards, one column per JIRA status in workflow order, plus the
 * derived „Zu grillen“ (Selected without a story on GitHub) before Selected. The Sandcastle runs sit in the dock
 * below the columns (views/rundock.ts); a card says where Sandcastle has it. Dragging onto a status column moves
 * the ticket in JIRA, onto a machine row of the dock queues its open children there. Built once, updated in place
 * per poll.
 */
import { queueChildren, transitionTicket } from "../actions";
import { openExternal } from "../api";
import { derive, type Derived } from "../derive";
import { dragging, enableDrag } from "../drag";
import { fill, h, reconcile } from "../dom";
import { currentStep, GRILL_STEP_COUNT, isLiveGrill } from "../grill";
import { isBusy } from "../model";
import { compileTerms } from "../query";
import { hooks, prefGet, prefSet, serverLabel, state } from "../state";
import { buildLine, compileTickets, dropStatus, LANE_PREFIX, memberPhase, statusColumn, type TicketColumn, ticketColumns } from "../tickets";
import type { JiraTicket, Phase } from "../types";
import { isNarrow, longPress } from "./board";
import { filterTerms } from "./filterbar";
import { cardGrill } from "./grilling";
import { showMenu } from "./menu";
import { placeOf, renderDock, runDockEl, type TicketPlace, ticketPlaces } from "./rundock";
import { type TicketCardInfo, ticketCardEl } from "./ticketcard";
import { openTicketSide } from "./ticketside";

interface ColumnEls {
  el: HTMLElement;
  count: HTMLElement;
  list: HTMLElement;
}

const colEls = new Map<string, ColumnEls>();
let root: HTMLElement | null = null;
let columnsEl: HTMLElement;
let segsEl: HTMLElement;
let noticeEl: HTMLElement;
let staleEl: HTMLElement;
let infoEl: HTMLElement;
let queuedEl: HTMLElement;
let queuedTimer: ReturnType<typeof setTimeout> | undefined;
let seg = "";
let visible = { keys: [] as (string | null)[], count: 0 };
/** keys and count of the visible cards (the JIRA link button) */
export const ticketsVisible = () => visible;

/** the column definitions of the last render (drop and menu targets) */
let columns: TicketColumn[] = [];

export function ticketsView(): HTMLElement {
  if (root) return root;
  seg = prefGet<string>("tseg") ?? "";
  segsEl = h("div", { class: "segs", role: "tablist" });
  columnsEl = h("div", { class: "columns tcolumns" });
  noticeEl = h("div", { class: "notice-host", hidden: true });
  staleEl = h("div", { class: "stale", hidden: true });
  infoEl = h("div", { class: "qf-info small muted", hidden: true });
  queuedEl = h("div", { class: "queued-note small", role: "status", hidden: true });
  root = h("div", { class: "board tboard" }, infoEl, staleEl, noticeEl, queuedEl, segsEl, columnsEl, runDockEl());
  columnsEl.addEventListener("click", (e) => {
    const t = e.target as Element;
    const link = t.closest<HTMLElement>("[data-url]");
    if (link) {
      e.preventDefault();
      openExternal(link.dataset.url ?? "");
      return;
    }
    const card = t.closest<HTMLElement>("[data-card]");
    if (card) openTicketSide(card.dataset.card ?? "");
  });
  columnsEl.addEventListener("keydown", (e) => {
    const target = e.target as Element;
    const card = target.closest<HTMLElement>("[data-card]");
    // Enter on a PR link is its click
    if (card && e.key === "Enter" && !target.closest("[data-url]")) openTicketSide(card.dataset.card ?? "");
  });
  // the whole view: cards start in the columns, the dock's machine rows are drop targets too
  enableDrag(root, { canDrag: () => !isNarrow(), ordered: () => false, onDrop: (key, to) => onDrop(key, to), scroller: columnsEl });
  longPress(columnsEl, cardMenu);
  matchMedia("(max-width: 699px)").addEventListener("change", () => renderTickets());
  return root;
}

const selectedState = (d: Derived) => d.project?.jira.states.selected ?? null;
const ticketOf = (key: string) => state.jira?.tickets.find((t) => t.key === key);

function onDrop(key: string, to: string): void {
  const t = ticketOf(key);
  if (!t) return;
  if (to.startsWith(LANE_PREFIX)) {
    enqueue(key, to.slice(LANE_PREFIX.length));
    return;
  }
  const status = dropStatus(to, t, selectedState(derive()));
  if (status) transitionTicket(key, status);
}

/** Queues the ticket's children on a machine and says above the board where it now stands. */
async function enqueue(key: string, server: string): Promise<void> {
  if (!(await queueChildren(key, server))) return;
  const place = placeOf(derive(), key, server);
  if (place === null) return;
  queuedEl.textContent = `${key} steht jetzt auf Platz ${place} in Sandcastle auf ${serverLabel(server)}.`;
  queuedEl.hidden = false;
  clearTimeout(queuedTimer);
  queuedTimer = setTimeout(() => {
    queuedEl.hidden = true;
    hooks.render();
  }, 20_000);
  hooks.render();
}

/** Long press / right click: move to a status, queue the children on a machine, details. */
function cardMenu(key: string): void {
  const t = ticketOf(key);
  if (!t) return;
  const d = derive();
  const selected = selectedState(d);
  const here = statusColumn(t, selected);
  const items = [
    ...columns
      .filter((c) => c.key !== here)
      .flatMap((c) => {
        const status = dropStatus(c.key, t, selected);
        return status ? [{ label: `→ ${c.name}`, disabled: false, run: () => transitionTicket(key, status) }] : [];
      }),
    ...d.lanes.map((l) => ({ label: `→ Sandcastle auf ${l.server.label} (Kinder einreihen)`, disabled: !t.family.children.length, run: () => enqueue(key, l.server.id) })),
    { label: "Details", disabled: false, run: () => openTicketSide(key) },
  ];
  showMenu(`${t.key} ${t.summary}`, items);
}

/** Columns folded to a thin rail (e.g. Done), per project; the cards inside aren't rendered while folded. */
const hiddenCols = (): string[] => prefGet<Record<string, string[]>>("hiddenCols")?.[state.slug] ?? [];

function toggleColumn(key: string): void {
  const all = prefGet<Record<string, string[]>>("hiddenCols") ?? {};
  const cur = all[state.slug] ?? [];
  prefSet("hiddenCols", { ...all, [state.slug]: cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key] });
  renderTickets();
}

function columnEl(c: TicketColumn): ColumnEls {
  let el = colEls.get(c.key);
  if (!el) {
    const count = h("span", { class: "count" });
    const list = h("div", { class: "list", "data-list": true });
    const fold = h("button", { class: "col-fold", title: "Spalte einklappen", "aria-label": `${c.name} einklappen`, onclick: (e: Event) => { e.stopPropagation(); toggleColumn(c.key); } }, "‹›");
    const header = h("header", { title: "", onclick: () => { if (hiddenCols().includes(c.key)) toggleColumn(c.key); } }, h("span", { class: "col-name" }, c.name), count, fold);
    const section = h("section", { class: `column tcol-${c.kind}${c.kind === "status" ? ` cat-${c.status.category}` : ""}`, "data-column": c.key }, header, list);
    el = { el: section, count, list };
    colEls.set(c.key, el);
  }
  return el;
}

const PHASE_RANK: Phase[] = ["reviewing", "building", "failed", "no-commits", "planned", "merged", "queued"];

/** What a card shows of the ticket's GitHub family: build line, run phase, grill, place in Sandcastle. */
function cardInfo(d: Derived, t: JiraTicket, places: Map<string, TicketPlace>): TicketCardInfo {
  const f = t.family;
  const pr = t.prs[0] ?? null;
  const phases: Phase[] = [];
  const children = f.children.map((c) => {
    const tr = d.runs.get(c.n);
    if (tr && tr.run.status !== "ended") phases.push(tr.issue.phase);
    return { n: c.n, seg: memberPhase(c, tr?.issue.phase) };
  });
  const tg = f.grill ? d.grills.get(f.grill.n) : undefined;
  const grill = tg && isLiveGrill(tg.grill) ? `Grill ${currentStep(tg.grill)}/${GRILL_STEP_COUNT}` : null;
  const busy = phases.some((p) => isBusy(p));
  const place = t.category === "done" ? undefined : places.get(t.key);
  return {
    t,
    build: buildLine({ story: f.story?.n ?? null, children, run: null, grill, pr }),
    phase: PHASE_RANK.find((p) => phases.includes(p)),
    grill: f.grill ? cardGrill(d, f.grill.n) : undefined,
    busy,
    where: busy ? "wird gebaut" : place ? `${place.live ? "in Lauf" : "wartet"} auf ${place.label} · Platz ${place.pos}` : undefined,
  };
}

function notice(title: string, text: string, actions: HTMLElement[]): HTMLElement {
  return h("div", { class: "notice" }, h("b", {}, title), h("p", { class: "notice-text" }, text), actions.length ? h("div", { class: "btn-row" }, ...actions) : null);
}

export function renderTickets(): void {
  if (!root || dragging()) return;
  const d = derive();
  const jira = state.jira;
  visible = { keys: [], count: 0 };
  const toWerkbank = () => h("button", { class: "btn", onclick: () => hooks.showMode("werkbank") }, "Zur Werkbank wechseln");
  let note: HTMLElement | null = null;
  if (state.jiraMissing)
    note = notice(
      "Kein JIRA-Zugang hinterlegt",
      "JIRA-Zugang in Hollr › Einstellungen › Integrationen eintragen. Dann erscheinen die Tickets deines Projekts hier. Die Werkbank mit den GitHub-Issues funktioniert weiter.",
      [toWerkbank()],
    );
  else if (d.project && !d.project.jira.projectKey)
    note = notice(
      "Kein JIRA-Projekt eingerichtet",
      `Projekt ${d.project.name} nennt keinen JIRA-Projektschlüssel (.lul-workr.json › jira.projectKey). Die Werkbank funktioniert weiter.`,
      [toWerkbank()],
    );
  else if (!jira && state.jiraError) note = notice("JIRA nicht erreichbar", state.jiraError, [toWerkbank()]);
  const sig = note?.textContent ?? "";
  if (noticeEl.dataset.sig !== sig) {
    noticeEl.dataset.sig = sig;
    fill(noticeEl, note);
  }
  noticeEl.hidden = !note;
  renderDock(d);
  if (note || !jira) {
    columnsEl.hidden = true;
    segsEl.hidden = true;
    staleEl.hidden = true;
    infoEl.hidden = true;
    if (!note) {
      noticeEl.hidden = false;
      fill(noticeEl, h("p", { class: "empty" }, "Tickets laden …"));
      noticeEl.dataset.sig = "loading";
    }
    return;
  }
  columnsEl.hidden = false;

  const selected = selectedState(d);
  columns = ticketColumns(jira.statuses, selected);
  // sc: asks every machine's live runs, not only the plugin's own machine
  const livePhase = (n: number) => {
    const tr = d.runs.get(n);
    return tr && tr.run.status !== "ended" ? tr.issue.phase : undefined;
  };
  const test = compileTerms(filterTerms(), (tokens) => compileTickets(tokens, livePhase));
  const byCol = new Map<string, JiraTicket[]>(columns.map((c) => [c.key, []]));
  let shown = 0;
  for (const t of jira.tickets) {
    if (!test(t)) continue;
    shown++;
    const key = statusColumn(t, selected);
    let list = byCol.get(key);
    if (!list) {
      // a status the workflow list lacks (sub-task workflows): its own column at the end
      const c: TicketColumn = { key, kind: "status", name: t.status, status: { name: t.status, category: t.category } };
      columns.push(c);
      list = [];
      byCol.set(key, list);
    }
    list.push(t);
  }
  const places = ticketPlaces(d);
  const counts = new Map<string, number>();
  const folded = new Set(isNarrow() ? [] : hiddenCols());
  for (const c of columns) {
    const els = columnEl(c);
    const isFolded = folded.has(c.key);
    els.el.classList.toggle("col-folded", isFolded);
    els.el.querySelector("header")?.setAttribute("title", isFolded ? `${c.name} – klicken zum Aufklappen` : "");
    let list = byCol.get(c.key) ?? [];
    counts.set(c.key, list.length);
    if (isFolded) {
      // folded: count only, no cards (a dropped card still lands here via the header's data-column)
      reconcile(els.list, []);
      continue;
    }
    if (c.kind === "status" && c.status.category === "done") list = [...list].sort((a, b) => Date.parse(b.updated) - Date.parse(a.updated));
    for (const t of list) visible.keys.push(t.key);
    reconcile(els.list, list.length ? list.map((t) => ticketCardEl(cardInfo(d, t, places))) : [h("p", { class: "empty" }, "Keine Tickets")]);
  }
  visible.count = visible.keys.length;
  for (const c of columns) columnEl(c).count.textContent = String(counts.get(c.key) ?? 0);
  const narrow = isNarrow();
  if (!columns.some((c) => c.key === seg)) seg = columns[0]?.key ?? "";
  reconcile(columnsEl, columns.map((c) => columnEl(c).el));
  for (const c of columns) columnEl(c).el.classList.toggle("seg-hidden", narrow && c.key !== seg);
  segsEl.hidden = !narrow;
  if (narrow)
    reconcile(
      segsEl,
      columns.map((c) =>
        h("button", { class: `seg-btn${c.key === seg ? " active" : ""}`, role: "tab", onclick: () => pickSeg(c.key) }, shortName(c.name), h("span", { class: "count" }, counts.get(c.key) ?? 0)),
      ),
    );
  const filtered = shown !== jira.tickets.length;
  infoEl.hidden = !filtered;
  infoEl.textContent = filtered ? `${shown} von ${jira.tickets.length} Tickets` : "";
  staleEl.hidden = !jira.refreshError;
  staleEl.textContent = jira.refreshError
    ? `Nicht aktuell – Stand ${new Date(jira.fetchedAt).toLocaleTimeString("de-DE", { timeStyle: "short" })}: ${jira.refreshError}`
    : "";
}

/** „🔖 Selected for Development“ → „Selected“, „🏗 In Progress“ → „In Progress“ for the narrow switcher. */
function shortName(name: string): string {
  const words = name.replace(/^[^\p{L}\d]+/u, "").split(/\s+/);
  return (words[0]?.length ?? 0) <= 3 ? words.slice(0, 2).join(" ") : (words[0] ?? name);
}

function pickSeg(key: string): void {
  seg = key;
  prefSet("tseg", key);
  renderTickets();
  columnsEl.scrollTop = 0;
}
