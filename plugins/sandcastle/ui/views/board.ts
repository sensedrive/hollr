/**
 * The board: Zu grillen · Backlog · Sandcastle (one lane per machine with this repo) · Erledigt. Built once, then
 * updated in place on every poll (cards reused, lists reconciled), so scroll positions and the open panel stay.
 * Narrow (< 700 px): one column at a time behind a segmented switcher; long press on a card opens a move menu.
 */
import { moveTicket, putIssue } from "../actions";
import { api } from "../api";
import { derive, type Derived, flagsOf, type Lane, openBlockers } from "../derive";
import { dragging, enableDrag } from "../drag";
import { fill, h, reconcile } from "../dom";
import { compile } from "../filter";
import { branchColour, classify, isBusy, laneSummary, PHASE_TEXT, segments, shortBranch, since } from "../model";
import { clearGrillQueue, grillQueue } from "../grillqueue";
import { errorText, hooks, laneServers, prefGet, prefSet, state, toast } from "../state";
import type { Column, Issue, Phase, Run } from "../types";
import { STATUS_TEXT } from "./runs";
import { cardEl } from "./cards";
import { filterBar, filterTokens } from "./filterbar";
import { autoGrillCandidates, cardGrill, grillMenuItems, openGrillAllDialog } from "./grilling";
import { showMenu } from "./menu";
import { openIssue } from "./sidebar";

const NAMES: Record<Column, string> = { grill: "Zu grillen", backlog: "Backlog", queue: "Sandcastle", done: "Erledigt" };
const narrowQuery = matchMedia("(max-width: 699px)");
export const isNarrow = () => narrowQuery.matches;

let seg: Column = "backlog";

interface ColumnEls {
  el: HTMLElement;
  count: HTMLElement;
  list: HTMLElement;
}

const columnEls = {} as Record<Column, ColumnEls>;
const laneEls = new Map<string, { el: HTMLElement; head: HTMLElement; list: HTMLElement; sig: string }>();
/** group headings inside lanes, reused across polls (keyed by machine + run, or machine for „Als Nächstes“) */
const groupEls = new Map<string, HTMLElement>();
let root: HTMLElement | null = null;
let columnsEl: HTMLElement;
let segsEl: HTMLElement;
let lanesEl: HTMLElement;
let unlanedEl: HTMLElement;
let olderBtn: HTMLButtonElement;
let staleEl: HTMLElement;
/** „Alle auto-grillen“ and the page's auto-grill queue, on top of „Zu grillen“ */
let grillAllBtn: HTMLButtonElement;
let grillQueueEl: HTMLElement;
/** what „Alle auto-grillen“ would queue (the filtered cards of „Zu grillen“ without a grill) */
let grillCandidates: Issue[] = [];
let visible = { keys: [] as (string | null)[], count: 0 };
let bar: ReturnType<typeof filterBar>;

function column(c: Column): ColumnEls {
  const count = h("span", { class: "count" });
  const list = h("div", { class: "list", "data-list": true });
  const el = h("section", { class: `column col-${c}`, "data-col": c }, h("header", {}, h("span", {}, NAMES[c]), count));
  if (c !== "queue") {
    el.dataset.column = c;
    el.append(list);
  }
  return { el, count, list };
}

export function boardView(): HTMLElement {
  if (root) return root;
  seg = prefGet<Column>("seg") ?? "backlog";
  bar = filterBar(() => visible, [
    h("button", { class: "btn primary", "aria-label": "Neues Issue", onclick: () => newIssue() }, "+", h("span", { class: "wide-only" }, " Neues Issue")),
  ]);
  segsEl = h("div", { class: "segs", role: "tablist" });
  columnsEl = h("div", { class: "columns" });
  for (const c of ["grill", "backlog", "queue", "done"] as Column[]) columnEls[c] = column(c);
  lanesEl = h("div", { class: "lanes" });
  unlanedEl = h("div", { class: "lane", "data-column": "queue" }, h("div", { class: "list", "data-list": true }));
  columnEls.queue.el.append(lanesEl);
  grillAllBtn = h("button", { class: "btn grill-all-btn", onclick: () => openGrillAllDialog(grillCandidates) }, h("span", { "aria-hidden": "true" }, "🔥"), " Alle auto-grillen");
  grillQueueEl = h("div", { class: "grill-queue small", hidden: true });
  columnEls.grill.el.insertBefore(h("div", { class: "col-actions" }, grillAllBtn, grillQueueEl), columnEls.grill.list);
  olderBtn = h("button", { class: "btn older", onclick: () => loadOlder() }, "Ältere laden");
  staleEl = h("div", { class: "stale", hidden: true });
  root = h("div", { class: "board" }, bar.el, staleEl, segsEl, columnsEl);
  root.addEventListener("click", onClick);
  root.addEventListener("keydown", (e) => {
    const card = (e.target as Element).closest<HTMLElement>("[data-card]");
    if (card && e.key === "Enter") openCard(Number(card.dataset.card));
  });
  enableDrag(columnsEl, {
    canDrag: (n) => !isNarrow() && !isBusy(derive().runs.get(n)?.issue.phase),
    ordered: (key) => key.startsWith("queue@"),
    onDrop,
  });
  longPress(columnsEl);
  narrowQuery.addEventListener("change", () => renderBoard());
  return root;
}

function onClick(e: Event): void {
  const t = e.target as Element;
  const card = t.closest<HTMLElement>("[data-card]");
  if (card) openCard(Number(card.dataset.card));
  const start = t.closest<HTMLElement>("[data-start]");
  if (start) {
    state.startFor = start.dataset.start ?? null;
    hooks.show("runs");
  }
  const run = t.closest<HTMLElement>("[data-run]");
  if (run) openRun(run.dataset.server ?? "", run.dataset.run ?? "");
  const fold = t.closest<HTMLElement>("[data-lane-toggle]");
  if (fold) toggleLane(fold.dataset.laneToggle ?? "");
}

/** A run row in a lane head opens that run in „Läufe“ (its planner/merger log). */
function openRun(server: string, id: string): void {
  const run = state.statuses.get(server)?.runs.find((r) => r.id === id);
  if (!run) return;
  state.selection = { server, run: id, n: null, path: run.logs[0]?.path ?? null };
  state.grillSel = null;
  hooks.show("runs");
}

/** A building card jumps to its log, any other opens the details. */
function openCard(n: number): void {
  const tr = derive().runs.get(n);
  if (tr && isBusy(tr.issue.phase)) {
    const log = tr.issue.logs.find((l) => l.active) ?? tr.issue.logs[0];
    state.selection = { server: tr.server, run: tr.run.id, n, path: log?.path ?? null };
    state.grillSel = null;
    hooks.show("runs");
  } else openIssue(n);
}

function onDrop(n: number, key: string, before: number | null): void {
  const d = derive();
  if (key.startsWith("queue@")) {
    const server = key.slice("queue@".length);
    const from = d.laneOf.get(n);
    const phase = d.runs.get(n)?.issue.phase;
    if (from && from !== server && phase && phase !== "queued") {
      toast("Zwischen Rechnern nur, solange das Ticket wartet.");
      return;
    }
    moveTicket(n, "queue", server, before);
  } else moveTicket(n, key as Column);
}

/** Touch: long press opens the move menu (narrow list mode has no dragging). Desktop: right click. */
function longPress(el: HTMLElement): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  el.addEventListener(
    "touchstart",
    (e) => {
      if (!isNarrow()) return;
      const card = (e.target as Element).closest<HTMLElement>("[data-card]");
      const t = e.touches[0];
      if (!card || !t) return;
      const sx = t.clientX;
      const sy = t.clientY;
      const cancel = () => {
        clearTimeout(timer);
        el.removeEventListener("touchmove", onMove);
        el.removeEventListener("touchend", cancel);
      };
      const onMove = (ev: TouchEvent) => {
        const p = ev.touches[0];
        if (p && Math.hypot(p.clientX - sx, p.clientY - sy) > 8) cancel();
      };
      timer = setTimeout(() => {
        cancel();
        navigator.vibrate?.(10);
        // the click that ends the press must not open the details too
        const swallow = (ev: Event) => {
          ev.stopPropagation();
          ev.preventDefault();
        };
        window.addEventListener("click", swallow, { capture: true, once: true });
        setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 600);
        cardMenu(Number(card.dataset.card));
      }, 450);
      el.addEventListener("touchmove", onMove, { passive: true });
      el.addEventListener("touchend", cancel);
    },
    { passive: true },
  );
  el.addEventListener("contextmenu", (e) => {
    const card = (e.target as Element).closest<HTMLElement>("[data-card]");
    if (!card) return;
    e.preventDefault();
    cardMenu(Number(card.dataset.card));
  });
}

function cardMenu(n: number): void {
  const d = derive();
  const issue = d.issues.get(n);
  if (!issue) return;
  const busy = isBusy(d.runs.get(n)?.issue.phase);
  const lane = d.laneOf.get(n);
  const inGrill = !!d.project && classify(issue, d.project.labels, !!state.board?.hasGrill) === "grill";
  const items = [
    ...(inGrill ? grillMenuItems(d, n) : []),
    ...d.lanes
      .filter((l) => l.server.id !== lane)
      .map((l) => ({ label: `→ Sandcastle auf ${l.server.label}`, disabled: busy, run: () => moveTicket(n, "queue", l.server.id) })),
    ...(d.lanes.length ? [] : [{ label: "→ Sandcastle", disabled: busy, run: () => moveTicket(n, "queue") }]),
    {
      label: "→ Backlog",
      disabled: busy || (!!d.project && classify(issue, d.project.labels, !!state.board?.hasGrill) === "backlog"),
      run: () => moveTicket(n, "backlog"),
    },
    { label: "Details", disabled: false, run: () => openCard(n) },
  ];
  showMenu(`#${n} ${issue.title}`, items);
}

// ---- render

function cardsFor(d: Derived, issues: Issue[], test: (i: Issue) => boolean, laneOrder = false): HTMLElement[] {
  const hide = new Set([d.project?.labels.queue, d.project?.labels.story, d.project?.labels.grill]);
  const out: HTMLElement[] = [];
  let pos = 0;
  for (const issue of issues) {
    pos++;
    if (!test(issue)) continue;
    const tr = d.runs.get(issue.number);
    // the branch belongs to the ticket while its run has it (also after merging, for the „Erledigt“ column)
    const branch = tr?.run.branch || undefined;
    out.push(
      cardEl({
        issue,
        labels: issue.labels.filter((l) => !hide.has(l)),
        pos: laneOrder ? pos : undefined,
        phase: tr?.issue.phase,
        branch,
        siblings: tr ? tr.run.issues.map((x) => x.n).filter((x) => x !== issue.number) : undefined,
        flags: flagsOf(d, issue.number),
        blockers: issue.state === "open" ? openBlockers(d, issue) : [],
        locked: isBusy(tr?.issue.phase),
        grill: cardGrill(d, issue.number),
      }),
    );
    visible.keys.push(issue.jira);
    visible.count++;
  }
  return out;
}

const empty = (text: string) => h("p", { class: "empty" }, text);

/** machines whose lane is folded to its head (remembered across tunnels in the plugin's prefs) */
const closedLanes = (): string[] => prefGet<string[]>("lanesClosed") ?? [];

function toggleLane(server: string): void {
  const closed = closedLanes();
  prefSet("lanesClosed", closed.includes(server) ? closed.filter((s) => s !== server) : [...closed, server]);
  renderBoard();
}

function laneEl(d: Derived, lane: Lane) {
  let el = laneEls.get(lane.server.id);
  if (!el) {
    const head = h("div", { class: "lane-head" });
    const list = h("div", { class: "list", "data-list": true });
    el = { el: h("div", { class: "lane", "data-column": `queue@${lane.server.id}` }, head, list), head, list, sig: "" };
    laneEls.set(lane.server.id, el);
  }
  const closed = closedLanes().includes(lane.server.id);
  const live = lane.runs.filter((r) => r.status !== "ended");
  const summary = closed
    ? laneSummary(lane.order, (n) => d.runs.get(n)?.issue.phase, (n) => {
        const i = d.issues.get(n);
        return !!i && openBlockers(d, i).length > 0;
      })
    : null;
  const sig = JSON.stringify([lane.server, closed, summary, lane.runs.map((r) => [r.id, r.status, r.progress, r.config, r.branch, r.issues.map((i) => i.phase)])]);
  if (sig !== el.sig) {
    el.sig = sig;
    el.el.classList.toggle("closed", closed);
    const ended = lane.runs.find((r) => r.status === "ended");
    // folded: the last ended run still says how it went; open: just a line, the cards tell the rest
    const runs = live.length ? live : closed && ended ? [ended] : [];
    fill(
      el.head,
      h(
        "div",
        { class: "lane-top" },
        h(
          "button",
          { class: "lane-toggle", "aria-expanded": String(!closed), "data-lane-toggle": lane.server.id, title: closed ? "Aufklappen" : "Zuklappen" },
          h("span", { class: "chev" }, closed ? "›" : "⌄"),
          h("span", { class: "lane-machine" }, lane.server.label),
        ),
        h("span", { class: "grow" }),
        live.length ? null : h("button", { class: "link", "data-start": lane.server.id }, "Lauf starten"),
      ),
      ...runs.map((r) => runRow(lane.server.id, r)),
      !runs.length ? h("div", { class: "lane-info muted" }, ended ? `beendet vor ${since(ended.endedAt ?? ended.startedAt)}` : "Kein Lauf") : null,
      summary ? summaryEl(summary) : null,
    );
  }
  return el;
}

function summaryEl(s: ReturnType<typeof laneSummary>): HTMLElement | null {
  if (!s.total) return null;
  const phases = (Object.entries(s.phases) as [Phase, number][]).filter(([, n]) => n > 0);
  return h(
    "div",
    { class: "lane-summary" },
    s.queued ? h("div", {}, `${s.queued} in der Warteschlange`) : null,
    s.blocked ? h("div", { class: "warn" }, `davon ${s.blocked} blockiert`) : null,
    phases.length ? h("div", { class: "chips" }, ...phases.map(([p, n]) => h("span", { class: `phase ${p}` }, `${PHASE_TEXT[p]} ${n}`))) : null,
  );
}

function runRow(server: string, r: Run): HTMLElement {
  const agent = r.config.agentLabel || r.config.agent;
  const done = r.status === "ended";
  return h(
    "button",
    { class: "lane-run", "data-server": server, "data-run": r.id, title: `${r.branch} – in „Läufe“ öffnen` },
    h(
      "span",
      { class: "lane-run-top" },
      h("span", { class: "dot", style: `background:${branchColour(r.branch)}` }),
      h("b", {}, shortBranch(r.branch) || r.project),
      h("span", { class: "grow" }),
      done ? null : h("span", { class: `st st-${r.status}` }, STATUS_TEXT[r.status].split(" –")[0] ?? ""),
    ),
    done ? h("span", { class: "lane-run-meta" }, `beendet vor ${since(r.endedAt ?? r.startedAt)}`) : null,
    h(
      "span",
      { class: "lane-run-meta" },
      [`${r.progress.merged + r.progress.failed}/${r.progress.total} · ${r.progress.percent} %`, done ? "" : agent, !done && r.config.parallel ? `×${r.config.parallel}` : ""]
        .filter(Boolean)
        .join(" · "),
    ),
    h("span", { class: "segbar" }, ...segments(r.issues).map((p) => h("span", { class: `seg ${p}` }))),
  );
}

function groupEl(key: string, dot: string | null, text: string): HTMLElement {
  let el = groupEls.get(key);
  if (!el) {
    el = h("div", { class: "lane-group" });
    groupEls.set(key, el);
  }
  const sig = `${dot}|${text}`;
  if (el.dataset.sig !== sig) {
    el.dataset.sig = sig;
    fill(el, dot ? h("span", { class: "dot", style: `background:${dot}` }) : null, text);
  }
  return el;
}

/** Lane body: per live run its tickets (run order), then this machine's queue under „Als Nächstes“. */
function laneCards(d: Derived, lane: Lane, test: (i: Issue) => boolean): HTMLElement[] {
  const issue = (n: number) => d.issues.get(n);
  const live = lane.runs.filter((r) => r.status !== "ended");
  const inRun = new Set<number>();
  const out: HTMLElement[] = [];
  for (const r of live) {
    const mine = lane.order.filter((n) => d.runs.get(n)?.run === r);
    for (const n of mine) inRun.add(n);
    const cards = cardsFor(d, mine.map(issue).filter((i): i is Issue => !!i), test, r.source !== "manual");
    if (!cards.length) continue;
    const manual = r.source === "manual" ? " · von Hand gestartet" : "";
    out.push(groupEl(`${lane.server.id}|${r.id}`, branchColour(r.branch), `Im Lauf ${shortBranch(r.branch)}${manual}`), ...cards);
  }
  const next = cardsFor(d, lane.order.filter((n) => !inRun.has(n)).map(issue).filter((i): i is Issue => !!i), test, true);
  if (next.length && out.length) out.push(groupEl(lane.server.id, null, "Als Nächstes"));
  out.push(...next);
  return out;
}

/** „Alle auto-grillen“ (count of what it would queue) and the waiting part of the page's auto-grill queue. */
function renderGrillActions(d: Derived, shown: Issue[]): void {
  grillCandidates = autoGrillCandidates(d, shown);
  grillAllBtn.disabled = !grillCandidates.length || !laneServers().some((s) => s.online);
  grillAllBtn.title = grillCandidates.length ? `${grillCandidates.length} Tickets ohne Grill auto-grillen` : "Alle sichtbaren Tickets haben schon einen Grill";
  const waiting = grillQueue().filter((q) => q.slug === state.slug).length;
  const text = waiting ? `${waiting} warten auf Start – nur solange diese Seite offen ist` : "";
  if (grillQueueEl.dataset.text === text) return;
  grillQueueEl.dataset.text = text;
  grillQueueEl.hidden = !waiting;
  fill(grillQueueEl, h("span", {}, text), " ", h("button", { class: "link", onclick: clearGrillQueue }, "Stoppen"));
}

export function renderBoard(): void {
  if (!root || dragging()) return;
  const d = derive();
  const board = state.board;
  const test = board ? compile(filterTokens(), { viewer: board.viewer, stories: board.stories }) : () => true;
  visible = { keys: [], count: 0 };
  const hasGrill = !!board?.hasGrill;
  const cols: Column[] = hasGrill ? ["grill", "backlog", "queue", "done"] : ["backlog", "queue", "done"];
  if (!cols.includes(seg)) seg = "backlog";
  const counts = {} as Record<Column, number>;

  for (const c of ["grill", "backlog"] as const) {
    const cards = cardsFor(d, d.columns[c], test);
    counts[c] = cards.length;
    reconcile(columnEls[c].list, cards.length ? cards : [empty(board ? "Keine Issues" : "Lädt …")]);
  }
  renderGrillActions(d, d.columns.grill.filter(test));

  // Sandcastle: a lane per machine
  let queueCount = 0;
  const lanes = d.lanes.map((lane) => {
    const el = laneEl(d, lane);
    const cards = laneCards(d, lane, test);
    queueCount += cards.filter((c) => c.dataset.card).length;
    // folded lanes keep no cards in the DOM (a drop there appends to its queue)
    el.list.hidden = closedLanes().includes(lane.server.id);
    if (el.list.hidden) reconcile(el.list, []);
    else reconcile(el.list, cards.length ? cards : [empty(lane.order.length ? "Ausgefiltert" : "Leer – hierher ziehen")]);
    return el.el;
  });
  if (!d.lanes.length) {
    const cards = cardsFor(d, d.unlaned.map((n) => d.issues.get(n)).filter((i): i is Issue => !!i), test);
    queueCount = cards.length;
    const list = unlanedEl.firstElementChild as HTMLElement;
    reconcile(list, cards.length ? cards : [empty(state.servers.length ? "Kein Rechner hat dieses Projekt ausgecheckt" : "Rechner werden gesucht …")]);
    lanes.push(unlanedEl);
  }
  reconcile(lanesEl, lanes);
  counts.queue = queueCount;

  const done = cardsFor(d, d.columns.done, test);
  counts.done = done.length;
  const closedOlder = state.olderClosed.length ? state.closedOlder : (board?.closedOlder ?? 0);
  olderBtn.textContent = `Ältere laden (${closedOlder})`;
  reconcile(columnEls.done.list, [...(done.length ? done : [empty("Keine Issues")]), ...(closedOlder > 0 ? [olderBtn] : [])]);

  for (const c of cols) columnEls[c].count.textContent = String(counts[c]);
  const narrow = isNarrow();
  reconcile(columnsEl, cols.map((c) => columnEls[c].el));
  for (const c of cols) columnEls[c].el.classList.toggle("seg-hidden", narrow && c !== seg);
  segsEl.hidden = !narrow;
  if (narrow)
    reconcile(
      segsEl,
      cols.map((c) => {
        const b = h("button", { class: `seg-btn${c === seg ? " active" : ""}`, role: "tab", onclick: () => pickSeg(c) }, NAMES[c], h("span", { class: "count" }, counts[c]));
        return b;
      }),
    );
  staleEl.hidden = !board?.refreshError;
  staleEl.textContent = board?.refreshError ? `GitHub nicht erreichbar – Stand ${new Date(board.fetchedAt).toLocaleTimeString("de-DE", { timeStyle: "short" })}: ${board.refreshError}` : "";
  bar.update();
}

function pickSeg(c: Column): void {
  seg = c;
  prefSet("seg", c);
  renderBoard();
  columnsEl.scrollTop = 0;
}

async function loadOlder(): Promise<void> {
  const d = derive();
  const oldest = d.columns.done.reduce<string | null>((min, i) => (i.closedAt && (!min || i.closedAt < min) ? i.closedAt : min), null);
  const slug = state.slug;
  olderBtn.disabled = true;
  try {
    const page = await api<{ issues: Issue[]; closedOlder: number }>(
      `/api/board/closed?slug=${encodeURIComponent(slug)}&before=${encodeURIComponent(oldest ?? new Date().toISOString())}`,
    );
    if (slug !== state.slug) return;
    state.olderClosed = [...state.olderClosed, ...page.issues.filter((i) => !d.issues.has(i.number))];
    state.closedOlder = page.closedOlder;
    renderBoard();
  } catch (err) {
    toast(errorText(err));
  } finally {
    olderBtn.disabled = false;
  }
}

// ---- new issue

function newIssue(): void {
  const d = derive();
  const board = state.board;
  if (!board || !d.project) return;
  const title = h("input", { placeholder: "Titel", required: true });
  const body = h("textarea", { rows: 6, placeholder: "Beschreibung (Markdown)" });
  const col = h(
    "select",
    { "aria-label": "Spalte" },
    ...(board.hasGrill ? [h("option", { value: "grill" }, "Zu grillen")] : []),
    h("option", { value: "backlog", selected: true }, "Backlog"),
    ...(d.lanes.length ? d.lanes.map((l) => h("option", { value: `queue@${l.server.id}` }, `Sandcastle · ${l.server.label}`)) : [h("option", { value: "queue" }, "Sandcastle")]),
  );
  const story = h("select", { "aria-label": "Story" }, h("option", { value: "" }, "Ohne Story"), ...board.stories.map((s) => h("option", { value: s.number }, `#${s.number} ${s.title}`)));
  const error = h("p", { class: "error" });
  const submit = h("button", { class: "btn primary", type: "submit" }, "Anlegen");
  const close = () => overlay.remove();
  const overlay = h(
    "div",
    { class: "overlay", onclick: (e: Event) => e.target === overlay && close() },
    h(
      "form",
      {
        class: "modal",
        onsubmit: async (e: Event) => {
          e.preventDefault();
          if (!title.value.trim()) return;
          submit.disabled = true;
          error.textContent = "";
          const [column, server] = col.value.split("@");
          const slug = state.slug;
          try {
            const { issue } = await api<{ issue: Issue }>("/api/issue", {
              slug,
              title: title.value.trim(),
              body: body.value,
              column,
              ...(story.value ? { parent: Number(story.value) } : {}),
            });
            if (slug !== state.slug) return close();
            putIssue(issue);
            close();
            if (server) await moveTicket(issue.number, "queue", server, null);
            hooks.render();
            toast(`#${issue.number} angelegt`, "info");
          } catch (err) {
            error.textContent = errorText(err);
            submit.disabled = false;
          }
        },
      },
      h("h2", {}, "Neues Issue"),
      title,
      body,
      h("div", { class: "row" }, h("label", {}, "Spalte ", col), h("label", {}, "Story ", story)),
      error,
      h("div", { class: "btn-row end" }, h("button", { class: "btn", type: "button", onclick: close }, "Abbrechen"), submit),
    ),
  );
  document.body.append(overlay);
  title.focus();
}
