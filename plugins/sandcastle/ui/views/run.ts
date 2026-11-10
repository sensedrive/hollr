/**
 * The run view: start form (no active run) or the active run – In Arbeit · Warteschlange (draggable) ·
 * Erledigt · Fehlgeschlagen. One run per computer; the form is kept per project so typing survives polls.
 */
import { api, openExternal } from "../api";
import { dragging, enableDrag } from "../drag";
import { fill, fmtDate, h } from "../dom";
import { currentProject, errorText, reloadAll, state, toast } from "../state";
import type { Card, Project, RunConfig, RunView } from "../types";
import { cardEl } from "./cards";
import { openIssue } from "./sidebar";

const AGENTS: [string, string][] = [
  ["opus-5.5", "Opus 5.5"],
  ["opus-5.5-high", "Opus 5.5 (high)"],
  ["opus-5", "Opus 5"],
  ["cursor-grok", "Cursor · Grok"],
  ["cursor-composer", "Cursor · Composer"],
  ["custom", "eigene Wahl"],
];
const PROVIDERS = ["claudeCode", "cursor", "omp"];
export const STATUS_TEXT: Record<string, string> = {
  running: "läuft",
  waiting: "wartet auf dich",
  "loop-ended": "Schleife fertig – Prüfungen/PR",
  ended: "beendet",
};

let root: HTMLElement | null = null;
let formBox: HTMLElement;
let infoBox: HTMLElement;
let queueBox: HTMLElement;
let queueList: HTMLElement;
let restBox: HTMLElement;
let rendered = "";

interface StartForm {
  el: HTMLFormElement;
  gate(project: Project, queueLength: number): void;
}
const forms = new Map<string, StartForm>();

/** Which project the queue section belongs to: the active run's, else the chosen one. */
const queueProject = () => {
  const run = state.run?.run;
  return run && run.status !== "ended" ? run.project.id : state.projectId;
};

export function runView(): HTMLElement {
  if (root) return root;
  formBox = h("div");
  infoBox = h("div");
  queueList = h("div", { class: "list", "data-list": true });
  queueBox = h("section", { class: "run-section column", "data-column": "queue" }, h("h3", {}, "Warteschlange"), queueList);
  restBox = h("div");
  enableDrag(queueBox, {
    canDrag: () => true,
    reorder: "queue",
    onDrop: async (n, _to, before) => {
      try {
        await api("/api/queue/move", { project: queueProject(), number: n, before });
      } catch (err) {
        toast(errorText(err));
      }
      await reloadAll();
    },
  });
  root = h("div", { class: "run" }, formBox, infoBox, queueBox, restBox);
  return root;
}

function formFor(project: Project, config: RunConfig): StartForm {
  const known = forms.get(project.id);
  if (known) return known;
  const agent = h("select", { name: "agent" }, ...AGENTS.map(([v, label]) => h("option", { value: v }, label)));
  const provider = h("select", { name: "provider" }, ...PROVIDERS.map((v) => h("option", { value: v }, v)));
  const model = h("input", { name: "model", type: "text", placeholder: "Modell, z. B. anthropic/claude-opus-5" });
  const parallel = h("input", { name: "parallel", type: "number", min: 1, step: 1 });
  const screencast = h("input", { name: "screencast", type: "checkbox" });
  const custom = h("div", { class: "row custom" }, h("label", {}, "Anbieter ", provider), h("label", { class: "grow" }, "Modell ", model));
  const warn = h("p", { class: "warn" }, "Ab 4 parallel: erhöhtes Risiko, dass der Kernel Prozesse abschießt (137).");
  const reason = h("p", { class: "reason" });
  const error = h("p", { class: "error" });
  const start = h("button", { class: "btn primary", type: "submit" }, "Lauf starten");

  agent.value = AGENTS.some(([v]) => v === config.agent) ? config.agent : "opus-5.5";
  provider.value = config.provider ?? "omp";
  model.value = config.model ?? "";
  parallel.value = String(config.parallel);
  screencast.checked = config.screencast;
  const sync = () => {
    custom.hidden = agent.value !== "custom";
    warn.hidden = !(Number(parallel.value) >= 4);
  };
  agent.addEventListener("change", sync);
  parallel.addEventListener("input", sync);
  sync();

  let blocked = "";
  const el = h(
    "form",
    {
      class: "start card-box",
      onsubmit: async (e: Event) => {
        e.preventDefault();
        if (blocked) return;
        start.disabled = true;
        error.textContent = "";
        try {
          await api("/api/run/start", {
            project: project.id,
            agent: agent.value,
            provider: agent.value === "custom" ? provider.value : null,
            model: agent.value === "custom" ? model.value : null,
            parallel: Number(parallel.value),
            screencast: screencast.checked,
          });
          await reloadAll();
        } catch (err) {
          error.textContent = errorText(err);
        }
        start.disabled = !!blocked;
      },
    },
    h("h2", {}, `Neuer Lauf: ${project.name}`),
    h("div", { class: "row" }, h("label", {}, "Agent ", agent), h("label", {}, "Parallel ", parallel), h("label", { class: "check" }, screencast, " Screencast")),
    custom,
    warn,
    h("div", { class: "btn-row" }, start, reason),
    error,
  );
  const form: StartForm = {
    el,
    gate(p, queueLength) {
      blocked =
        p.engine !== "sandcastle"
          ? `Projekt ${p.name} nutzt den Motor ${p.engine}, nicht Sandcastle.`
          : !p.queueSupported
            ? "Die Schleife dieses Projekts kennt die Warteschlange noch nicht (lul-workr-setup → Sandcastle nachziehen)."
            : !queueLength
              ? "Die Warteschlange ist leer."
              : "";
      start.disabled = !!blocked;
      reason.textContent = blocked;
    },
  };
  forms.set(project.id, form);
  return form;
}

const list = (cards: Card[], empty: string) =>
  cards.length ? cards.map((c) => cardEl(c, { onOpen: openIssue })) : [h("p", { class: "empty" }, empty)];

function runInfo(run: RunView): HTMLElement {
  const cfg = run.config;
  const agent = cfg.agent === "custom" ? `${cfg.provider}:${cfg.model}` : cfg.agent;
  return h(
    "section",
    { class: "card-box run-head" },
    h("h2", {}, `Lauf ${run.project.name} `, h("span", { class: `pill ${run.status}` }, STATUS_TEXT[run.status] ?? run.status)),
    h(
      "dl",
      {},
      h("dt", {}, "Gestartet"),
      h("dd", {}, fmtDate(run.startedAt)),
      run.endedAt ? h("dt", {}, "Beendet") : null,
      run.endedAt ? h("dd", {}, `${fmtDate(run.endedAt)}${run.endReason ? ` – ${run.endReason}` : ""}`) : null,
      h("dt", {}, "Agent"),
      h("dd", {}, `${agent}${cfg.screencast ? " · Screencast" : ""}`),
      h("dt", {}, "Parallel"),
      h("dd", {}, String(cfg.parallel)),
      run.branch ? h("dt", {}, "Branch") : null,
      run.branch ? h("dd", { class: "mono" }, run.branch) : null,
      run.pr ? h("dt", {}, "PR") : null,
      run.pr
        ? h("dd", {}, h("button", { class: "link", onclick: () => openPr(run) }, `#${run.pr}`))
        : null,
    ),
    run.status === "waiting"
      ? h("p", { class: "warn" }, `Der Lauf wartet auf eine Antwort – Sitzung „Sandcastle ${run.project.name}“ in Hollr öffnen.`)
      : null,
    run.status !== "ended"
      ? h(
          "button",
          {
            class: "btn",
            onclick: async () => {
              if (!confirm("Gibt die Sperre frei, beendet die Sitzung nicht.")) return;
              try {
                await api("/api/run/release", {});
              } catch (err) {
                toast(errorText(err));
              }
              await reloadAll();
            },
          },
          "Lauf freigeben",
        )
      : null,
  );
}

function openPr(run: RunView): void {
  const slug = state.projects.find((p) => p.id === run.project.id)?.slug;
  if (slug && run.pr) openExternal(`https://github.com/${slug}/pull/${run.pr}`);
}

function sections(run: RunView): HTMLElement[] {
  return [
    h("section", { class: "run-section" }, h("h3", {}, `In Arbeit (${run.inProgress.length})`), ...list(run.inProgress, "Nichts in Arbeit")),
    h("section", { class: "run-section" }, h("h3", {}, `Erledigt (${run.done.length})`), ...list(run.done, "Noch nichts erledigt")),
    h(
      "section",
      { class: "run-section" },
      h("h3", {}, `Fehlgeschlagen (${run.failed.length})`),
      ...(run.failed.length
        ? run.failed.map((f) => h("div", { class: "failed" }, cardEl(f.card, { onOpen: openIssue }), h("p", { class: "error small" }, f.reason)))
        : [h("p", { class: "empty" }, "Nichts fehlgeschlagen")]),
    ),
  ];
}

export function renderRun(): void {
  const data = state.run;
  const project = currentProject();
  if (!root || dragging()) return;
  if (!data) {
    rendered = "";
    fill(formBox, h("p", { class: "muted" }, "Lädt …"));
    fill(infoBox);
    fill(queueList);
    fill(restBox);
    return;
  }
  const key = JSON.stringify([data, project?.id]);
  if (key === rendered) return;
  rendered = key;
  const run = data.run;
  const active = run && run.status !== "ended" ? run : null;

  if (active) {
    fill(formBox);
    fill(infoBox, runInfo(active));
    fill(queueList, ...list(active.queue, "Leer – im Board Karten nach Sandcastle ziehen"));
    queueBox.querySelector("h3")?.replaceChildren(`Warteschlange (${active.queue.length})`);
    fill(restBox, ...sections(active));
    return;
  }
  const queue = data.queue ?? [];
  if (project && !project.error) {
    const cfg = data.lastConfig ?? {
      agent: project.defaults.agent,
      provider: null,
      model: null,
      parallel: project.defaults.parallel,
      screencast: false,
    };
    const form = formFor(project, cfg);
    form.gate(project, queue.length);
    fill(formBox, form.el);
  } else fill(formBox, h("p", { class: "muted" }, "Kein Projekt gewählt."));
  queueBox.querySelector("h3")?.replaceChildren(`Warteschlange (nächster Lauf, ${queue.length})`);
  fill(queueList, ...list(queue, "Leer – im Board Karten nach Sandcastle ziehen"));
  // the last run stays visible after it ended: what got done, what failed
  fill(infoBox, run ? runInfo(run) : null);
  fill(restBox, ...(run ? sections(run) : []));
}
