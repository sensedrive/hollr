/**
 * Versionen (design v36, `screen:versionen`): a matrix projects × machines – does the machine's lul-workr carry the
 * project's loop (passt / Update verfügbar / Bereich nicht erfüllt), or is the loop still forked, the project not
 * checked out there, the machine offline. Per machine its installed version and „Aktualisieren“ (gate `tools`
 * `run lul-workr` on that machine, like the Werkzeuge screen); per forked project the hint to migrate.
 * Narrow: machine cards on top, one card per project below. Rebuilt only when what it shows changed.
 */
import { tools } from "../api";
import { fill, h, icon } from "../dom";
import { ICON } from "../icons";
import { errorText, hooks, state, toast } from "../state";
import type { Server, ToolState } from "../types";
import { type CellState, cellLabel, cellState, type MachineVersions, newer, summary, versionRows } from "../versions";

const CELL_ICON: Record<CellState, string> = {
  ok: ICON.check,
  update: ICON.arrowUp,
  unmet: ICON.x,
  forked: ICON.gitFork,
  none: ICON.minus,
  absent: ICON.minus,
  offline: ICON.wifiOff,
  unknown: ICON.alert,
};

const LEGEND: [CellState, string][] = [
  ["ok", "passt"],
  ["update", "Update verfügbar"],
  ["unmet", "Bereich nicht erfüllt"],
  ["forked", "Schleife abgezweigt"],
  ["absent", "nicht ausgecheckt"],
  ["offline", "Rechner offline"],
];

/** server id → lul-workr in its gate `tools`, or why that didn't answer */
const toolStates = new Map<string, ToolState | { error: string }>();
/** machines whose update this page started and still waits for */
const updating = new Set<string>();
let lastTools = 0;

let root: HTMLElement | null = null;
let summaryEl: HTMLElement;
let errorEl: HTMLElement;
let matrixEl: HTMLElement;
let statusEl: HTMLElement;
let sig = "";

export function versionsView(): HTMLElement {
  if (root) return root;
  summaryEl = h("p", { class: "vm-summary" });
  errorEl = h("div", { class: "vm-error-host" });
  matrixEl = h("div", { class: "vm" });
  statusEl = h("span", { class: "sr", role: "status" });
  const legend = h(
    "ul",
    { class: "vm-legend", "aria-label": "Legende der Zustände" },
    ...LEGEND.map(([s, text]) => h("li", {}, h("span", { class: "vm-cell", "data-state": s }, icon(CELL_ICON[s], "vm-ic"), text))),
  );
  root = h(
    "div",
    { class: "vm-page" },
    h("header", { class: "vm-intro" }, h("h2", { class: "vm-heading" }, "lul-workr-Versionen"), summaryEl),
    errorEl,
    legend,
    matrixEl,
    statusEl,
  );
  return root;
}

const tool = (id: string) => {
  const t = toolStates.get(id);
  return t && "name" in t ? t : undefined;
};

function machineOf(s: Server): MachineVersions {
  const t = tool(s.id);
  return {
    server: s,
    // the tools answer is the fresher one (asked right after an update); status caches the version for minutes
    installed: t ? (t.version ?? null) : state.statuses.get(s.id)?.machine.lulWorkr,
    latest: t?.latest,
    error: s.online ? (state.statusErrors.get(s.id) ?? null) : null,
  };
}

function machines(): MachineVersions[] {
  return [...state.servers]
    .sort((a, b) => Number(b.online) - Number(a.online) || Number(b.self) - Number(a.self) || a.label.localeCompare(b.label, "de"))
    .map(machineOf);
}

/**
 * Asks the online machines' gate `tools`: each minute while shown, every 3 s while an update runs, and at once for
 * a machine not asked yet.
 */
export function loadVersionTools(force = false): void {
  const now = Date.now();
  const due = force || now - lastTools >= (updating.size ? 3000 : 60_000);
  if (due) lastTools = now;
  for (const s of state.servers) if (s.online && (due || !toolStates.has(s.id))) loadTools(s);
}

const asking = new Set<string>();

async function loadTools(s: Server): Promise<void> {
  if (asking.has(s.id)) return;
  asking.add(s.id);
  try {
    const t = (await tools.list(s.id)).find((x) => x.name === "lul-workr");
    if (!t) throw new Error("Werkzeug lul-workr unbekannt (Hollr zu alt)");
    toolStates.set(s.id, t);
    if (updating.has(s.id) && !t.running) finished(s, t);
  } catch (err) {
    toolStates.set(s.id, { error: errorText(err) });
  } finally {
    asking.delete(s.id);
  }
  hooks.render();
}

function finished(s: Server, t: ToolState): void {
  updating.delete(s.id);
  if (t.exit) {
    const last = t.log?.trim().split("\n").pop() ?? "";
    toast(`lul-workr auf ${s.label}: Aktualisierung fehlgeschlagen (Exit ${t.exit})${last ? ` – ${last}` : ""}`);
  } else toast(`lul-workr auf ${s.label} ist jetzt ${t.version ?? "aktualisiert"}.`, "info");
  statusEl.textContent = "";
  // the ranges are checked against the installed version: the machine's projects and status anew
  hooks.reloadProjects(s.id);
  hooks.reloadStatus();
}

async function update(s: Server): Promise<void> {
  updating.add(s.id);
  statusEl.textContent = `Aktualisierung von lul-workr auf ${s.label} läuft …`;
  hooks.render();
  try {
    const t = (await tools.updateLulWorkr(s.id)).find((x) => x.name === "lul-workr");
    if (t) toolStates.set(s.id, t);
    lastTools = Date.now();
  } catch (err) {
    updating.delete(s.id);
    statusEl.textContent = "";
    toast(`lul-workr auf ${s.label}: ${errorText(err)}`);
  }
  hooks.render();
}

function machineHead(m: MachineVersions): HTMLElement {
  const s = m.server;
  const t = tool(s.id);
  const busy = updating.has(s.id) || !!t?.running;
  const hasNew = newer(m.latest, m.installed);
  const host = state.statuses.get(s.id)?.machine.host ?? "";
  // why the newest release is unknown (gh missing, an older Hollr without gate `tools` for plugins …)
  const asked = toolStates.get(s.id);
  const unknownLatest = asked && "error" in asked ? `Neueste Version unbekannt: ${asked.error}` : t?.latestError;
  const version = !s.online
    ? "offline · Version unbekannt"
    : m.error
      ? "keine Antwort"
      : m.installed === null
        ? "lul-workr nicht installiert"
        : m.installed === undefined
          ? "lul-workr …"
          : [
              "lul-workr ",
              h("span", { class: "vm-num" }, m.installed),
              hasNew ? h("span", { class: "vm-new" }, icon(ICON.arrowUp, "vm-ic"), `neu: ${m.latest}`) : null,
            ];
  return h(
    "div",
    { class: "vm-machine", "data-offline": !s.online || m.error ? "true" : undefined },
    h("span", { class: "vm-machine-name" }, icon(ICON.server, "vm-ic"), s.label),
    h("span", { class: "vm-host" }, host),
    h("span", { class: "vm-version", title: unknownLatest }, ...(Array.isArray(version) ? version : [version])),
    s.online && !m.error
      ? h(
          "span",
          { class: "vm-update" },
          h(
            "button",
            {
              class: `btn${hasNew && !busy ? " primary" : ""}`,
              disabled: busy,
              "aria-label": busy ? `Aktualisierung auf ${s.label} läuft` : `lul-workr auf ${s.label} aktualisieren`,
              onclick: () => update(s),
            },
            busy ? "läuft …" : "Aktualisieren",
          ),
        )
      : null,
  );
}

export function renderVersions(): void {
  if (!root) return;
  const ms = machines();
  const rows = versionRows(state.machineProjects);
  const projectOn = (server: string, slug: string) => state.machineProjects.get(server)?.find((p) => p.slug === slug && !p.error);
  const cells = rows.map((r) => ms.map((m) => cellState(projectOn(m.server.id, r.slug), m)));
  const loading = !rows.length && ms.some((m) => m.server.online && !state.machineProjects.has(m.server.id) && !m.error);
  const failing = ms.find((m) => m.server.online && m.error);
  const next = JSON.stringify([
    ms.map((m) => [m.server, m.installed, m.latest, m.error, updating.has(m.server.id), toolStates.get(m.server.id), state.statuses.get(m.server.id)?.machine.host]),
    rows,
    cells,
    loading,
  ]);
  if (next === sig) return;
  sig = next;

  const unmet = cells.flat().filter((c) => c === "unmet").length;
  summaryEl.textContent = loading ? "Frage die Rechner nach ihrer lul-workr-Version …" : summary(rows, unmet);
  fill(
    errorEl,
    failing && !loading
      ? h(
          "div",
          { class: "vm-error", role: "alert" },
          icon(ICON.alert, "vm-error-ic"),
          h(
            "div",
            { class: "vm-error-body" },
            h("p", { class: "vm-error-title" }, `${failing.server.label} antwortet nicht – seine Spalte zeigt keinen Stand.`),
            h("p", { class: "vm-error-text" }, h("code", {}, failing.error ?? "")),
          ),
          h("button", { class: "btn", onclick: () => hooks.refresh() }, "Erneut abfragen"),
        )
      : null,
  );

  if (loading) {
    fill(
      matrixEl,
      h(
        "div",
        { class: "vm-skeleton", "aria-busy": "true" },
        h("span", { class: "sr", role: "status" }, "Versionen werden von den Rechnern geladen …"),
        ...Array.from({ length: 8 }, () =>
          h(
            "div",
            { class: "vm-skeleton-row", style: `--vm-cols: ${Math.max(ms.length, 1)}` },
            h("span", { class: "vm-bar wide" }),
            ...ms.map(() => h("span", { class: "vm-bar" })),
          ),
        ),
      ),
    );
    return;
  }
  if (!rows.length) {
    fill(
      matrixEl,
      h(
        "div",
        { class: "vm-empty" },
        h("p", { class: "vm-empty-title" }, "Noch kein Projekt mit .lul-workr.json"),
        h("p", { class: "vm-empty-text" }, "Auf keinem Rechner ist ein lul-workr-Projekt ausgecheckt."),
      ),
    );
    return;
  }
  const off = (m: MachineVersions) => (!m.server.online || m.error ? "true" : undefined);
  fill(
    matrixEl,
    h("ul", { class: "vm-machines", "aria-label": "Rechner" }, ...ms.map((m) => h("li", { class: "vm-machine-card" }, machineHead(m)))),
    h(
      "div",
      { class: "vm-scroll" },
      h(
        "table",
        { class: "vm-table" },
        h("caption", { class: "sr" }, "lul-workr-Version je Projekt und Rechner"),
        h(
          "thead",
          { class: "vm-thead" },
          h(
            "tr",
            {},
            h("th", { scope: "col", class: "vm-corner" }, "Projekt"),
            ...ms.map((m) => h("th", { scope: "col", class: "vm-col", "data-offline": off(m) }, machineHead(m))),
          ),
        ),
        h(
          "tbody",
          {},
          ...rows.map((r, i) =>
            h(
              "tr",
              { class: "vm-row" },
              h(
                "th",
                { scope: "row", class: "vm-project" },
                h("span", { class: "vm-project-name" }, r.name),
                r.mode === "forked"
                  ? h("span", { class: "vm-hint" }, "Umstellen: ", h("code", {}, "lul-workr project migrate"))
                  : r.mode === "bundle"
                    ? h("span", { class: "vm-hint" }, "Bundle · lulWorkr ", h("code", {}, r.range ?? ""))
                    : r.mode === "none"
                      ? h("span", { class: "vm-hint" }, "ohne Schleife und ohne lulWorkr-Bereich")
                      : null,
              ),
              ...ms.map((m, j) => {
                const s = cells[i]?.[j] ?? "unknown";
                return h(
                  "td",
                  { class: "vm-td", "data-offline": s === "offline" || s === "unknown" ? "true" : undefined },
                  h("span", { class: "vm-td-machine" }, m.server.label),
                  h("span", { class: "vm-cell", "data-state": s }, icon(CELL_ICON[s], "vm-ic"), cellLabel(s, projectOn(m.server.id, r.slug), m)),
                );
              }),
            ),
          ),
        ),
      ),
    ),
  );
}
