/**
 * „Wächter“ next to the drift counter: a switch with a popover (interval, „Jetzt prüfen“, last run, what it applied
 * last). Settings go to /api/guard (prefs ignore `guard`); status is polled while the board is on show.
 */
import { api } from "../api";
import { fill, fmtDate, h } from "../dom";
import { errorText, hooks, toast } from "../state";
import { guardItemText, guardSummary } from "../tickets";
import type { GuardStatus } from "../types";

const INTERVALS = [2, 5, 15, 30, 60];

let status: GuardStatus | null = null;
let polling: ReturnType<typeof setTimeout> | undefined;

const toggle = h("input", { type: "checkbox", "aria-label": "Wächter an/aus" });
const summary = h("summary", { class: "guard-pill", title: "Wächter: gleicht Abweichungen regelmäßig an" });
const panel = h("div", { class: "guard-pop" });
const root = h("details", { class: "guard" }, summary, panel);

async function send(patch: Record<string, unknown>): Promise<void> {
  try {
    status = await api<GuardStatus>("/api/guard", patch);
    render();
    if (status.running) follow();
  } catch (err) {
    toast(errorText(err));
    render();
  }
}

/** While a run is on: ask every 2 s; afterwards the JIRA board shows what changed. */
function follow(): void {
  clearTimeout(polling);
  polling = setTimeout(async () => {
    await loadGuard();
    if (status?.running) follow();
    else hooks.reloadJira();
  }, 2000);
}

export async function loadGuard(): Promise<void> {
  try {
    status = await api<GuardStatus>("/api/guard");
    render();
  } catch {
    // an older plugin server without the guard: the control stays hidden
    status = null;
    render();
  }
}

toggle.addEventListener("change", () => send({ enabled: toggle.checked }));

function render(): void {
  root.hidden = !status;
  if (!status) return;
  const g = status;
  toggle.checked = g.enabled;
  fill(summary, h("span", { class: `guard-dot${g.enabled ? " on" : ""}${g.running ? " running" : ""}` }), `Wächter ${g.enabled ? "an" : "aus"}`);
  const interval = h("select", { "aria-label": "Intervall" }, ...INTERVALS.map((m) => h("option", { value: m, selected: m === g.intervalMin }, `alle ${m} Min.`)));
  interval.addEventListener("change", () => send({ intervalMin: Number(interval.value) }));
  const items = g.recent.flatMap((r) => r.applied.map((a) => ({ at: r.at, text: guardItemText(a) }))).slice(0, 6);
  const errors = g.recent.flatMap((r) => r.errors.map((e) => `${e.key ? `${e.key}: ` : ""}${e.message}`)).slice(0, 3);
  fill(
    panel,
    h("label", { class: "switch" }, toggle, h("span", {}, "Abweichungen regelmäßig angleichen")),
    h("label", { class: "guard-row" }, h("span", { class: "muted small" }, "Intervall"), interval),
    h(
      "div",
      { class: "guard-row" },
      h("span", { class: "muted small" }, `Zuletzt: ${guardSummary(g)}`),
      h("button", { class: "btn small", disabled: g.running, onclick: () => send({ runNow: true }) }, "Jetzt prüfen"),
    ),
    g.enabled && g.nextRun ? h("div", { class: "muted small" }, `Nächste Prüfung: ${fmtDate(g.nextRun)}`) : null,
    items.length ? h("ul", { class: "guard-list" }, ...items.map((i) => h("li", { title: fmtDate(i.at) }, i.text))) : h("p", { class: "muted small" }, "Noch nichts angeglichen."),
    errors.length ? h("ul", { class: "guard-list errors" }, ...errors.map((e) => h("li", {}, e))) : null,
  );
}

export function guardControl(): HTMLElement {
  render();
  root.addEventListener("toggle", () => {
    if (root.open) loadGuard();
  });
  // a click outside closes the popover
  document.addEventListener("click", (e) => {
    if (root.open && !root.contains(e.target as Node)) root.open = false;
  });
  return root;
}
