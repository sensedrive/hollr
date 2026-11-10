/** Sandcastle board – head bar (project, Board | Lauf, run pill, reload) and polling of the visible view. */
import { api, initToken } from "./api";
import { dragging } from "./drag";
import { fill, h } from "./dom";
import { errorText, hooks, state, toast } from "./state";
import type { Board, Project, RunResponse } from "./types";
import { boardView, renderBoard } from "./views/board";
import { renderRun, runView, STATUS_TEXT } from "./views/run";
import { closeSidebar } from "./views/sidebar";

const PROJECT_KEY = "sc.project";
const REFRESH = "__refresh__";

initToken();

const projectSelect = h("select", { "aria-label": "Projekt", onchange: () => onProjectChange() });
const boardTab = h("button", { class: "tab", onclick: () => show("board") }, "Board");
const runTab = h("button", { class: "tab", onclick: () => show("run") }, "Lauf");
const pill = h("button", { class: "pill", hidden: true, onclick: () => show("run") });
const reload = h("button", { class: "btn icon", title: "Neu laden", "aria-label": "Neu laden", onclick: () => refreshNow() }, "↻");
const main = h("main");
const notice = h("div", { class: "notice", hidden: true });

document.body.append(
  h("header", { class: "head" }, projectSelect, h("div", { class: "tabs" }, boardTab, runTab), pill, h("span", { class: "grow" }), reload),
  notice,
  main,
);

let lastBoard = 0;
let lastRun = 0;
let loading = false;

function renderProjects(): void {
  const names = state.projects.map((p) => p.name);
  // two checkouts can carry the same project name (tackline/tendr, tackline/tackline): add the folder
  const label = (p: Project) =>
    names.indexOf(p.name) !== names.lastIndexOf(p.name) ? `${p.name} – ${p.root.split("/").pop()}` : p.name;
  fill(
    projectSelect,
    ...state.projects.map((p) => h("option", { value: p.id, disabled: !!p.error }, p.error ? `${label(p)} (${p.error})` : label(p))),
    h("option", { value: REFRESH }, "↻ Projekte neu suchen …"),
  );
  projectSelect.value = state.projectId;
}

function selectProject(id: string): void {
  if (id === state.projectId) return;
  state.projectId = id;
  state.board = null;
  state.run = null;
  renderBoard();
  renderRun();
  state.filter = "all";
  localStorage.setItem(PROJECT_KEY, id);
  projectSelect.value = id;
  closeSidebar();
}

async function loadProjects(refresh = false): Promise<void> {
  fill(notice, refresh ? "Suche Projekte …" : "Lade Projekte …");
  notice.hidden = false;
  try {
    const { projects } = await api<{ projects: Project[] }>(`/api/projects${refresh ? "?refresh=1" : ""}`);
    state.projects = projects;
    const usable = projects.filter((p) => !p.error);
    const saved = localStorage.getItem(PROJECT_KEY);
    state.projectId = usable.find((p) => p.id === (state.projectId || saved))?.id ?? usable[0]?.id ?? "";
    renderProjects();
    notice.hidden = !!usable.length;
    if (!usable.length) fill(notice, "Keine lul-workr-Projekte gefunden (Hauptordner mit .lul-workr.json unter ~).");
  } catch (err) {
    fill(notice, errorText(err));
  }
}

async function onProjectChange(): Promise<void> {
  if (projectSelect.value === REFRESH) {
    projectSelect.value = state.projectId;
    await loadProjects(true);
  } else selectProject(projectSelect.value);
  await refreshNow();
}

hooks.reloadBoard = async () => {
  if (!state.projectId) return;
  const id = state.projectId;
  try {
    const board = await api<Board>(`/api/board?project=${id}`);
    if (id !== state.projectId) return;
    state.board = board;
    lastBoard = Date.now();
    renderBoard();
  } catch (err) {
    toast(errorText(err));
  }
};

hooks.reloadRun = async () => {
  try {
    const id = state.projectId;
    let data = await api<RunResponse>(`/api/run?project=${id}`);
    if (id !== state.projectId) return;
    const active = data.run && data.run.status !== "ended" ? data.run : null;
    // with a run going, the run view is about its project
    if (active && state.view === "run" && active.project.id !== state.projectId) {
      selectProject(active.project.id);
      data = await api<RunResponse>(`/api/run?project=${state.projectId}`);
    }
    state.run = data;
    lastRun = Date.now();
    renderPill();
    renderRun();
  } catch (err) {
    toast(errorText(err));
  }
};

function renderPill(): void {
  const run = state.run?.run;
  pill.hidden = !run;
  if (!run) return;
  pill.className = `pill ${run.status}`;
  pill.textContent = `${run.project.name}: ${STATUS_TEXT[run.status] ?? run.status}`;
}

function show(view: "board" | "run"): void {
  state.view = view;
  boardTab.classList.toggle("active", view === "board");
  runTab.classList.toggle("active", view === "run");
  fill(main, view === "board" ? boardView() : runView());
  if (view === "board") renderBoard();
  else renderRun();
  refreshNow();
}

/** One refresh at a time; a request during one runs once more after it (a project switch must not get lost). */
let again = false;
async function refreshNow(): Promise<void> {
  if (loading) {
    again = true;
    return;
  }
  loading = true;
  reload.classList.add("spin");
  try {
    do {
      again = false;
      // the pill needs the run on the board too
      await Promise.all([state.view === "board" ? hooks.reloadBoard() : Promise.resolve(), hooks.reloadRun()]);
    } while (again);
  } finally {
    loading = false;
    reload.classList.remove("spin");
  }
}

// board every 10 s, run every 5 s – only what is visible, not while hidden or mid-drag
setInterval(() => {
  if (document.hidden || dragging() || loading || !state.projectId) return;
  const now = Date.now();
  if (state.view === "board" && now - lastBoard >= 10_000) refreshNow();
  else if (state.view === "run" && now - lastRun >= 5_000) refreshNow();
}, 1000);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refreshNow();
});

await loadProjects();
show("board");
