/**
 * Sandcastle board – head bar (project, Board | Läufe, machine chips, reload), data loading and polling.
 * First paint comes from the cache of the last visit; every source (servers, each machine's projects/status/queue,
 * the GitHub board) then loads on its own and re-renders when it arrives – nothing waits for the slowest machine.
 */
import { writing } from "./actions";
import { api, type HostTheme, hostTheme, initToken, sc, servers, hostEvents } from "./api";
import { dragging } from "./drag";
import { fill, h, reconcile } from "./dom";
import { readHash } from "./filter";
import { dropOpen, keyProject, type OpenTarget, parseOpen, readOpen } from "./grill";
import { pumpGrills } from "./grillqueue";
import {
  cacheGet,
  cacheSet,
  errorText,
  hooks,
  laneServers,
  loadPrefs,
  prefGet,
  prefSet,
  projects,
  state,
  toast,
  type View,
} from "./state";
import type { BoardData, Project, QueueState, Server, Status } from "./types";
import { boardView, renderBoard } from "./views/board";
import { clearCards } from "./views/cards";
import { setQuery } from "./views/filterbar";
import { followLog, renderRuns, runsView, STATUS_TEXT } from "./views/runs";
import { closeSidebar, openIssue, renderLive } from "./views/sidebar";
import { applyTheme } from "./theme";

initToken();
await loadPrefs();

// Hollr's palette: the last one at once (no flash), then the live one, then every switch while open
applyTheme(prefGet<HostTheme>("theme"));
const useTheme = (t: HostTheme | null) => {
  if (applyTheme(t)) prefSet("theme", t);
};
hostEvents.onTheme = useTheme;
hostEvents.onOpen = (ticket) => {
  const t = parseOpen(ticket);
  if (t) openTicket(t);
};
hostTheme().then(useTheme);

const projectSelect = h("select", { class: "project", "aria-label": "Projekt" });
const boardTab = h("button", { class: "tab", onclick: () => show("board") }, "Board");
const runsTab = h("button", { class: "tab", onclick: () => show("runs") }, "Läufe");
const chips = h("div", { class: "mchips" });
const reload = h("button", { class: "btn icon", title: "Neu laden", "aria-label": "Neu laden", onclick: () => refreshAll(true) }, "↻");
const boardHost = h("div", { class: "view" });
const runsHost = h("div", { class: "view" });
const main = h("main", {}, boardHost, runsHost);

document.body.append(
  h("header", { class: "head" }, h("span", { class: "brand" }, "Sandcastle"), projectSelect, h("div", { class: "tabs" }, boardTab, runsTab), chips, h("span", { class: "grow" }), reload),
  main,
);

// ---- cache → first paint

state.servers = cacheGet<Server[]>("servers") ?? [];
state.localProjects = cacheGet<Project[]>("localProjects") ?? [];
for (const [k, v] of Object.entries(cacheGet<Record<string, Project[]>>("machineProjects") ?? {})) state.machineProjects.set(k, v);
for (const [k, v] of Object.entries(cacheGet<Record<string, Status>>("statuses") ?? {})) state.statuses.set(k, v);
state.view = prefGet<View>("view") ?? "board";
const REFRESH = "__refresh__";

function useSlug(slug: string): void {
  state.slug = slug;
  state.board = cacheGet<BoardData>(`board.${slug}`);
  state.olderClosed = [];
  state.closedOlder = 0;
  state.queues = new Map(Object.entries(cacheGet<Record<string, QueueState>>(`queues.${slug}`) ?? {}));
  prefSet("slug", slug);
  clearCards();
}

function pickSlug(): void {
  const list = projects();
  const want = state.slug || prefGet<string>("slug") || "";
  const slug = list.find((p) => p.slug === want)?.slug ?? list[0]?.slug ?? "";
  if (slug === state.slug) return;
  useSlug(slug);
  loadBoard();
  loadQueues();
}

// ---- rendering (coalesced into one frame)

let frame = 0;
hooks.render = () => {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    renderHead();
    if (state.view === "board") renderBoard();
    else renderRuns();
    renderLive();
    if (pendingOpen) tryOpen();
  });
};

let projectSig = "";
function renderHead(): void {
  const list = projects();
  const sig = JSON.stringify([list.map((p) => p.slug), state.slug]);
  if (sig !== projectSig) {
    projectSig = sig;
    const names = list.map((p) => p.name);
    fill(
      projectSelect,
      ...(list.length ? [] : [h("option", { value: "" }, "Projekte werden gesucht …")]),
      ...list.map((p) => h("option", { value: p.slug }, names.indexOf(p.name) !== names.lastIndexOf(p.name) ? `${p.name} (${p.slug})` : p.name)),
      h("option", { value: REFRESH }, "↻ Projekte neu suchen …"),
    );
    projectSelect.value = state.slug;
  }
  // one chip for every live run on every machine (all projects); „wartet auf dich“ wins the colour
  const live = state.servers.flatMap((s) => (state.statuses.get(s.id)?.runs ?? []).filter((r) => r.status !== "ended").map((r) => ({ s, r })));
  const machines = new Set(live.map((x) => x.s.id)).size;
  const status = live.find((x) => x.r.status === "waiting")?.r.status ?? live[0]?.r.status;
  const n = live.length;
  const text = n ? `● ${n} ${n === 1 ? "Lauf" : "Läufe"}${machines > 1 ? ` auf ${machines} Maschinen` : ` auf ${live[0]?.s.label}`}` : "○ Keine Läufe";
  const title = live.map((x) => `${x.s.label}: ${x.r.project} · ${x.r.branch} · ${STATUS_TEXT[x.r.status]} · ${x.r.progress.percent} %`).join("\n");
  reconcile(chips, [h("button", { class: `mchip ${status ? `st-${status}` : "idle"}`, title, onclick: () => show("runs") }, h("span", { class: "chip-long" }, text), h("span", { class: "chip-short" }, n ? `● ${n} ${n === 1 ? "Lauf" : "Läufe"}` : "○ 0"))]);
}

function show(view: View): void {
  state.view = view;
  prefSet("view", view);
  boardTab.classList.toggle("active", view === "board");
  runsTab.classList.toggle("active", view === "runs");
  if (view === "board" && !boardHost.firstChild) boardHost.append(boardView());
  if (view === "runs" && !runsHost.firstChild) runsHost.append(runsView());
  boardHost.hidden = view !== "board";
  runsHost.hidden = view !== "runs";
  if (view === "runs") closeSidebar();
  hooks.render();
  tick(true);
}
hooks.show = show;

projectSelect.addEventListener("change", async () => {
  if (projectSelect.value === REFRESH) {
    projectSelect.value = state.slug;
    toast("Projekte werden neu gesucht …", "info");
    await loadProjects(true);
    return;
  }
  closeSidebar();
  useSlug(projectSelect.value);
  hooks.render();
  last.board = 0;
  last.queues = 0;
  tick(true);
});

// ---- loading

const inflight = new Set<string>();
/** Runs a load once at a time per key; errors become toasts unless `quiet`. */
async function once(key: string, fn: () => Promise<void>, quiet = false): Promise<void> {
  if (inflight.has(key)) return;
  inflight.add(key);
  try {
    await fn();
  } catch (err) {
    if (!quiet) toast(errorText(err));
  } finally {
    inflight.delete(key);
  }
}

const saveMap = <T>(key: string, m: Map<string, T>) => cacheSet(key, Object.fromEntries(m));

async function loadServers(): Promise<void> {
  await once("servers", async () => {
    const list = await servers();
    // data of machines no longer paired (or ids from the other channel) would show as ghost lanes
    const ids = new Set(list.map((s) => s.id));
    for (const m of [state.statuses, state.machineProjects, state.queues, state.statusErrors])
      for (const k of m.keys()) if (!ids.has(k)) m.delete(k);
    state.servers = list;
    cacheSet("servers", list);
    hooks.render();
  });
}

async function loadMachineProjects(s: Server, refresh = false): Promise<void> {
  if (!s.online) return;
  await once(`projects:${s.id}`, async () => {
    try {
      state.machineProjects.set(s.id, await sc.projects(s.id, refresh));
      state.statusErrors.delete(s.id);
    } catch (err) {
      state.machineProjects.set(s.id, []);
      state.statusErrors.set(s.id, `Projekte: ${errorText(err)}`);
    }
    saveMap("machineProjects", state.machineProjects);
    // this machine may have become a lane of the selected project
    if (state.slug && !state.queues.has(s.id)) loadQueues();
    pickSlug();
    hooks.render();
  });
}

async function loadProjects(refresh = false): Promise<void> {
  const local = once("localProjects", async () => {
    const { projects: list } = await api<{ projects: Project[] }>(`/api/projects${refresh ? "?refresh=1" : ""}`);
    state.localProjects = list;
    cacheSet("localProjects", list);
    pickSlug();
    hooks.render();
  });
  await Promise.all([local, ...state.servers.map((s) => loadMachineProjects(s, refresh))]);
  last.projects = Date.now();
}

async function loadStatus(s: Server): Promise<void> {
  if (!s.online) return;
  await once(
    `status:${s.id}`,
    async () => {
      try {
        state.statuses.set(s.id, await sc.status(s.id));
        pumpGrills();
        if (state.statusErrors.get(s.id)?.startsWith("Status")) state.statusErrors.delete(s.id);
      } catch (err) {
        state.statusErrors.set(s.id, `Status: ${errorText(err)}`);
      }
      saveMap("statuses", state.statuses);
      hooks.render();
    },
    true,
  );
}
hooks.reloadStatus = () => Promise.all(state.servers.map(loadStatus)).then(() => {});

/** `full`: the reload button – the server fetches everything again (new labels, users), not only changed issues. */
async function loadBoard(full = false): Promise<void> {
  const slug = state.slug;
  if (!slug) return;
  await once(`board:${slug}`, async () => {
    const since = state.board?.etag ? `&since=${encodeURIComponent(state.board.etag)}` : "";
    const res = await api<BoardData | { same: true }>(`/api/board?slug=${encodeURIComponent(slug)}${since}${full ? "&refresh=1" : ""}`);
    last.board = Date.now();
    if (slug === state.slug) freshBoard = slug;
    if (slug !== state.slug || "same" in res || writing() || dragging()) return;
    state.board = res;
    cacheSet(`board.${slug}`, res);
    // the server refreshes a stale answer in the background: ask again soon
    if (res.stale) last.board = Date.now() - 12_000;
    hooks.render();
  });
}
hooks.reloadBoard = loadBoard;

async function loadQueues(): Promise<void> {
  const slug = state.slug;
  await Promise.all(
    laneServers().map((s) =>
      once(`queue:${s.id}:${slug}`, async () => {
        const q = await sc.queue(s.id, slug);
        if (slug !== state.slug || writing() || dragging()) return;
        state.queues.set(s.id, q);
        saveMap(`queues.${slug}`, state.queues);
        hooks.render();
      }, true),
    ),
  );
  last.queues = Date.now();
}
hooks.reloadQueues = loadQueues;

// ---- polling: only what is visible, only while the page is visible

const last = { servers: 0, projects: 0, status: 0, board: 0, queues: 0 };

function tick(force = false, full = false): void {
  if (document.hidden) return;
  const now = Date.now();
  if (now - last.servers > 60_000) {
    last.servers = now;
    loadServers().then(() => {
      for (const s of state.servers) {
        if (!state.machineProjects.has(s.id)) loadMachineProjects(s);
        if (!state.statuses.has(s.id)) loadStatus(s);
      }
    });
  }
  if (now - last.projects > 10 * 60_000) {
    last.projects = now;
    loadProjects();
  }
  if (force || now - last.status >= 4000) {
    last.status = now;
    hooks.reloadStatus();
  }
  if (state.view === "board" && (force || now - last.board >= 15_000)) {
    last.board = now;
    loadBoard(full);
  }
  if (state.view === "board" && (force || now - last.queues >= 15_000)) {
    last.queues = now;
    loadQueues();
  }
}

/** Reload button / visibility return: everything now, projects re-scanned only on the button. */
function refreshAll(button = false): void {
  last.servers = 0;
  if (button) last.projects = 0;
  reload.classList.add("spin");
  setTimeout(() => reload.classList.remove("spin"), 600);
  tick(true, button);
}

setInterval(() => tick(), 1000);
setInterval(() => {
  if (!document.hidden && state.view === "runs") followLog();
}, 1500);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refreshAll();
});

// ---- deep link `open=KEY:n` / `:n` / `KEY:` and Hollr's `open` event („Im Board zeigen“)

let pendingOpen: OpenTarget | null = null;
/** the project switch is decided once per link, as soon as projects are known */
let openSwitched = false;
/** slug whose board answered from the network since the page opened (a key-only link may then give up) */
let freshBoard = "";

function openTicket(t: OpenTarget): void {
  pendingOpen = t;
  openSwitched = false;
  tryOpen();
}

/** Switches to the ticket's project (by JIRA project key, else stays) and opens its details once it can. */
function tryOpen(): void {
  const t = pendingOpen;
  if (!t) return;
  if (!openSwitched) {
    const list = projects();
    if (!list.length) return;
    openSwitched = true;
    const key = t.key;
    const target = key ? list.find((p) => p.jira.projectKey === keyProject(key)) : undefined;
    if (target && target.slug !== state.slug) {
      closeSidebar();
      useSlug(target.slug);
      last.board = 0;
      last.queues = 0;
    }
    if (state.view !== "board") show("board");
    else tick(true);
  }
  if (t.n !== null) {
    pendingOpen = null;
    openIssue(t.n);
    return;
  }
  const issue = state.board?.issues.find((i) => i.jira === t.key);
  if (issue) {
    pendingOpen = null;
    openIssue(issue.number);
  } else if (freshBoard === state.slug) {
    pendingOpen = null;
    toast(`${t.key} ist in diesem Board nicht zu finden.`);
  }
}

const initial = readHash(location.hash) || prefGet<string>("filter") || "";
const linked = readOpen(location.hash);
if (linked) history.replaceState(null, "", location.pathname + location.search + dropOpen(location.hash));
pickSlug();
show(state.view);
if (initial) setQuery(initial);
if (linked) openTicket(linked);
