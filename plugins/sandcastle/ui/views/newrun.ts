/**
 * „Neuer Lauf“ (design v23): every parameter of the skill lul-workr-run-sandcastle in five numbered groups – machine
 * (one run per machine), what is built (tickets in pick order, else the machine's queue; batch or single when the
 * scope has several stories), agent/model and parallelism, target branch, test server and acceptance. The footer
 * shows the exact skill line the gate would send (`preview`, built by the server like the start). Built once per
 * opening and never re-rendered by polls, so typed values and ticks survive.
 */
import { queueChildren } from "../actions";
import { hasHost, openSession, sc } from "../api";
import { derive } from "../derive";
import { fill, h, icon } from "../dom";
import { ICON } from "../icons";
import { errorText, hooks, prefGet, prefSet, projectOn, state, toast } from "../state";
import { openChildren } from "../tickets";
import type { JiraTicket, Project, RunConfig, RunPreview, RunTest, Server } from "../types";
import { ticketPlaces } from "./rundock";

type LastConfig = Omit<RunConfig, "branch">;

/** The test-server cards, in the design's order. */
export const TEST_OPTIONS: readonly { id: RunTest; title: string; text: string }[] = [
  { id: "none", title: "Kein Testserver – Abnahme lokal am PR-Entwurf", text: "Der Agent startet nichts. Du holst den Branch und prüfst selbst." },
  {
    id: "instructions",
    title: "Testserver + Testanweisung samt Testdaten",
    text: "Der Agent startet einen Testserver, legt Testdaten an und schreibt auf, was du prüfen sollst.",
  },
  { id: "video", title: "Testserver + Testanweisung + Testvideo", text: "Zusätzlich nimmt der Agent ein kurzes Video vom Durchlauf auf, das du im PR ansiehst." },
  { id: "note", title: "Testserver, nur Vermerk", text: "Der Testserver läuft; im PR steht nur ein Vermerk mit der Adresse, ohne Anleitung." },
];

const PROVIDERS = [
  { id: "claudeCode", label: "claudeCode (Claude Code)" },
  { id: "cursor", label: "cursor (Cursor Agent)" },
  { id: "omp", label: "omp (Oh My Pi)" },
];
const PARALLEL = [1, 2, 3, 4, 5, 6];
/** from this parallelism on the dialog warns about killed processes */
const PARALLEL_RISK = 4;

/** Why a machine can't take a new run, null when it can. */
function busyReason(s: Server): string | null {
  if (!s.online) return "nicht wählbar – Rechner ist offline";
  const status = state.statuses.get(s.id);
  const live = status?.runs.find((r) => r.status !== "ended");
  if (live) return `nicht wählbar – hier läuft schon ein Lauf nach ${live.branch || live.project}`;
  if (status?.lock) return `nicht wählbar – hier läuft schon ein Lauf (${String(status.lock.project ?? "?")})`;
  return null;
}

let seq = 0;
const uid = () => `nr${++seq}`;

/** A radio styled as a chip (agent presets, parallelism). */
function chip(name: string, label: string, checked: boolean, onPick: () => void, cls = ""): HTMLElement {
  const input = h("input", { class: "new-run__chip-input", type: "radio", name, checked });
  input.addEventListener("change", onPick);
  return h("label", { class: `new-run__chip${cls}` }, input, h("span", { class: "new-run__chip-text" }, label));
}

/** A radio card with a bold title and a hint (batch/single, test server). */
function card(name: string, title: string, text: string, checked: boolean, onPick: () => void): HTMLElement {
  const input = h("input", { class: "new-run__radio", type: "radio", name, checked });
  input.addEventListener("change", onPick);
  return h("label", { class: "new-run__card" }, input, h("span", { class: "new-run__card-body" }, h("strong", {}, title), h("span", { class: "new-run__hint" }, text)));
}

function heading(n: number, text: string, id: string): HTMLElement[] {
  return [h("span", { class: "new-run__step", "aria-hidden": "true" }, n), h("span", { class: "new-run__group-title", id }, text)];
}

export function newRunModal(preselect: string | null): void {
  const d = derive();
  const project = d.project;
  if (!project) return;
  const slug = state.slug;
  const last = prefGet<Partial<LastConfig>>(`cfg.${slug}`);
  const ids = { heading: uid(), machine: uid(), tickets: uid(), agent: uid(), parallel: uid(), branch: uid(), test: uid(), batch: uid(), preset: uid(), model: uid() };
  // machines with a checkout of the repo; offline ones (their checkouts are unknown) only to say so
  const machines = state.servers.filter((s) => projectOn(s.id) || !s.online);
  const free = machines.filter((s) => !busyReason(s));
  let server = (preselect && free.some((s) => s.id === preselect) ? preselect : free[0]?.id) ?? null;
  const projectHere = (): Project => (server && projectOn(server)) || project;

  // ---- 1 machine
  const machineRows = machines.map((s) => {
    const reason = busyReason(s);
    const input = h("input", { class: "new-run__radio", type: "radio", name: ids.machine, value: s.id, disabled: !!reason, checked: s.id === server });
    input.addEventListener("change", () => {
      server = s.id;
      renderAgents();
      sync();
    });
    return h(
      "label",
      { class: "new-run__option", "data-disabled": reason ? "true" : undefined },
      input,
      h("span", { class: "new-run__option-name" }, s.label),
      reason ? h("span", { class: "new-run__busy" }, icon(ICON.lock, "new-run__busy-icon"), reason) : null,
    );
  });

  // ---- 2 tickets: open, grilled (open children on GitHub), not in any machine's lane yet
  const places = ticketPlaces(d);
  const startable = (state.jira?.tickets ?? []).filter((t) => t.category !== "done" && openChildren(t).length > 0 && !places.has(t.key));
  const picked: string[] = [];
  const posEls = new Map<string, HTMLElement>();
  const ticketRow = (t: JiraTicket) => {
    const box = h("input", { class: "new-run__radio", type: "checkbox" });
    const pos = h("span", { class: "new-run__pos" });
    posEls.set(t.key, pos);
    box.addEventListener("change", () => {
      const i = picked.indexOf(t.key);
      if (box.checked && i < 0) picked.push(t.key);
      if (!box.checked && i >= 0) picked.splice(i, 1);
      sync();
    });
    return h("label", { class: "new-run__option" }, box, h("span", { class: "new-run__option-name" }, h("strong", {}, t.key), " ", t.summary), pos);
  };
  let split: "batch" | "single" = last?.split === "single" ? "single" : "batch";
  const batch = h(
    "div",
    { class: "new-run__sub", role: "radiogroup", "aria-label": "Wie die Stories gebaut werden" },
    card(ids.batch, "Zusammen als ein Batch (ein PR, ein Testserver)", "Alle Stories landen in einem PR; du prüfst einmal.", split === "batch", () => {
      split = "batch";
      sync();
    }),
    card(ids.batch, "Einzeln nacheinander (je Story ein PR)", "Kleine PRs, die du einzeln abnehmen oder verwerfen kannst.", split === "single", () => {
      split = "single";
      sync();
    }),
  );
  const fixedNote = h(
    "p",
    { class: "new-run__note" },
    icon(ICON.info, "new-run__note-icon"),
    "Feste Liste: Die Schleife kennt die Warteschlange nicht. Tickets, die du später einreihst, nimmt dieser Lauf nicht mehr auf.",
  );

  // ---- 3 agent, model, parallelism
  let preset = "";
  let custom = last?.agent === "custom";
  const presets = h("div", { class: "new-run__chips", role: "radiogroup", "aria-label": "Agent / Modell" });
  const provider = h("select", { class: "new-run__input", id: ids.model }, ...PROVIDERS.map((p) => h("option", { value: p.id }, p.label)));
  provider.value = PROVIDERS.some((p) => p.id === last?.provider) ? (last?.provider ?? "") : "claudeCode";
  const model = h("input", { class: "new-run__input", type: "text", value: last?.model ?? "opus-5.5", autocomplete: "off", spellcheck: false, "aria-label": "Modellname" });
  const modelHint = h("p", { class: "new-run__hint" });
  const customRow = h(
    "div",
    { class: "new-run__row" },
    h("div", { class: "new-run__field" }, h("label", { class: "new-run__label", for: ids.model }, "Anbieter"), provider),
    h("div", { class: "new-run__field" }, h("span", { class: "new-run__label" }, "Modellname"), model, modelHint),
  );
  const renderAgents = () => {
    const p = projectHere();
    const agents = p.agents.length ? p.agents : [{ key: p.defaults.agent, label: p.defaults.agent, harness: "", model: "" }];
    const keep = preset || (last?.agent && last.agent !== "custom" ? last.agent : p.defaults.agent);
    preset = agents.some((a) => a.key === keep) ? keep : (agents[0]?.key ?? p.defaults.agent);
    fill(
      presets,
      ...agents.map((a) =>
        chip(ids.preset, a.label, !custom && preset === a.key, () => {
          preset = a.key;
          custom = false;
          sync();
        }),
      ),
      chip(ids.preset, "Eigene Wahl", custom, () => {
        custom = true;
        sync();
      }),
    );
  };
  renderAgents();
  let parallel = PARALLEL.includes(last?.parallel ?? 0) ? (last?.parallel ?? 1) : Math.min(6, Math.max(1, project.defaults.parallel));
  const parallelWarn = h(
    "p",
    { class: "new-run__note", "data-tone": "warn", role: "status" },
    icon(ICON.alert, "new-run__note-icon"),
    "Risiko: Kernel beendet Prozesse (137). Nimm höchstens 3, wenn der Rechner wenig Arbeitsspeicher hat.",
  );
  const parallelChips = h(
    "div",
    { class: "new-run__chips", role: "radiogroup", "aria-labelledby": ids.parallel },
    ...PARALLEL.map((n) =>
      chip(
        ids.parallel,
        String(n),
        parallel === n,
        () => {
          parallel = n;
          sync();
        },
        " new-run__chip--num",
      ),
    ),
  );

  // ---- 4 target branch
  const branch = h("input", { class: "new-run__input", id: ids.branch, type: "text", value: project.defaultBranch, autocomplete: "off", spellcheck: false });
  const branchHint = h("p", { class: "new-run__hint" });

  // ---- 5 test server
  let test: RunTest = TEST_OPTIONS.some((o) => o.id === last?.test) ? (last?.test ?? "none") : "none";
  const testCards = TEST_OPTIONS.map((o) =>
    card(ids.test, o.title, o.text, test === o.id, () => {
      test = o.id;
      sync();
    }),
  );

  // ---- footer: the real command
  const code = h("code", { class: "new-run__code" }, "…");
  const command = h("p", { class: "new-run__command" }, h("span", { class: "new-run__command-label" }, "Startet:"), " ", code);
  const reason = h("p", { class: "new-run__hint new-run__reason" });
  const error = h("p", { class: "new-run__hint", "data-error": "true" });
  const submit = h("button", { class: "btn primary", type: "submit" }, "Lauf mit Warteschlange starten");
  let touched = false;
  let preview: RunPreview | null = null;
  let previewError = "";
  let previewSeq = 0;
  let previewTimer: ReturnType<typeof setTimeout> | undefined;

  /** issue numbers of the picked tickets, in pick order: they go to the front of the queue */
  const pickedIssues = () =>
    picked.flatMap((key) => {
      const t = state.jira?.tickets.find((x) => x.key === key);
      return t ? openChildren(t) : [];
    });
  const config = (): RunConfig => ({
    agent: custom ? "custom" : preset,
    ...(custom ? { provider: provider.value, model: model.value.trim() } : {}),
    parallel,
    test,
    split,
    branch: branch.value.trim(),
  });
  const showCommand = () => {
    code.textContent = preview ? preview.prompt : previewError ? "–" : "…";
    command.title = preview?.prompt ?? "";
    const queueMode = preview ? preview.queueMode : projectHere().queueSupported;
    // batch or single only when the run gets a fixed list with several stories
    batch.hidden = !(preview?.scope && preview.scope.length > 1);
    fixedNote.hidden = queueMode;
    if (!reason.dataset.blocked) reason.textContent = previewError;
  };
  const loadPreview = async () => {
    const mine = ++previewSeq;
    if (!server || reason.dataset.blocked) {
      preview = null;
      previewError = "";
      showCommand();
      return;
    }
    try {
      const r = await sc.preview(server, slug, config(), pickedIssues());
      if (mine !== previewSeq) return;
      preview = r;
      previewError = "";
    } catch (err) {
      if (mine !== previewSeq) return;
      preview = null;
      previewError = errorText(err);
    }
    showCommand();
  };

  const sync = () => {
    for (const [key, el] of posEls) {
      const i = picked.indexOf(key);
      el.textContent = i >= 0 ? `Platz ${i + 1}` : "";
    }
    customRow.hidden = !custom;
    const modelMissing = touched && custom && !model.value.trim();
    model.toggleAttribute("aria-invalid", modelMissing);
    modelHint.dataset.error = String(modelMissing);
    modelHint.textContent = modelMissing ? "Gib einen Modellnamen an, z. B. opus-5.5." : "z. B. opus-5.5 oder gpt-5-codex";
    parallelWarn.hidden = parallel < PARALLEL_RISK;
    const branchMissing = touched && !branch.value.trim();
    branch.toggleAttribute("aria-invalid", branchMissing);
    branchHint.dataset.error = String(branchMissing);
    branchHint.textContent = branchMissing
      ? `Gib einen Branch an, z. B. ${project.defaultBranch} oder feature/batch-${new Date().toISOString().slice(0, 10)}.`
      : `Standard ist ${project.defaultBranch}. Ein anderer Branch wird gestapelt: der PR zielt auf diesen Branch statt auf ${project.defaultBranch}.`;
    const queued = d.lanes.find((l) => l.server.id === server)?.order.length ?? 0;
    const p = projectHere();
    const blocked = !server
      ? "Kein Rechner frei."
      : p.engine !== "sandcastle"
        ? `Projekt ${p.name} nutzt den Motor ${p.engine}, nicht Sandcastle.`
        : !picked.length && !queued
          ? "Die Warteschlange auf diesem Rechner ist leer – Tickets auswählen."
          : "";
    reason.dataset.blocked = blocked;
    reason.textContent = blocked || previewError;
    submit.disabled = !!blocked;
    submit.textContent = picked.length ? `Lauf mit ${picked.length} ${picked.length === 1 ? "Ticket" : "Tickets"} starten` : "Lauf mit Warteschlange starten";
    showCommand();
    clearTimeout(previewTimer);
    previewTimer = setTimeout(loadPreview, 250);
  };
  model.addEventListener("input", sync);
  provider.addEventListener("change", sync);
  branch.addEventListener("input", sync);

  const close = () => {
    clearTimeout(previewTimer);
    previewSeq++;
    overlay.remove();
  };
  const form = h(
    "form",
    {
      class: "new-run__panel",
      novalidate: true,
      onsubmit: async (e: Event) => {
        e.preventDefault();
        touched = true;
        sync();
        if (submit.disabled || !server || !branch.value.trim() || (custom && !model.value.trim())) return;
        const target = server;
        const label = machines.find((s) => s.id === target)?.label ?? target;
        submit.disabled = true;
        error.textContent = "";
        try {
          // label and queue the picked tickets' children on that machine first, in pick order
          for (const key of picked) if (!(await queueChildren(key, target))) throw new Error(`${key} konnte nicht eingereiht werden.`);
          const cfg = config();
          const res = await sc.start(target, slug, cfg, pickedIssues());
          const { branch: _target, ...remembered } = cfg;
          prefSet(`cfg.${slug}`, remembered);
          close();
          toast(`Lauf auf ${label} gestartet`, "info");
          if (res.pane && hasHost()) openSession(target, res.pane);
          await hooks.reloadStatus();
        } catch (err) {
          error.textContent = errorText(err);
          sync();
        }
      },
    },
    h(
      "header",
      { class: "new-run__head" },
      h("div", {}, h("h2", { class: "new-run__heading", id: ids.heading }, "Neuer Lauf"), h("p", { class: "new-run__hint" }, "Stell alles ein – der Agent fragt danach nichts mehr.")),
      h("button", { class: "new-run__close", type: "button", "aria-label": "Schließen", onclick: close }, icon(ICON.x, "new-run__close-icon")),
    ),
    h(
      "div",
      { class: "new-run__scroll" },
      h(
        "fieldset",
        { class: "new-run__group" },
        h("legend", { class: "new-run__legend" }, ...heading(1, "Rechner", uid())),
        h("p", { class: "new-run__hint" }, "Pro Rechner läuft höchstens ein Lauf."),
        ...(machineRows.length ? machineRows : [h("p", { class: "new-run__hint" }, "Kein Rechner hat dieses Projekt ausgecheckt.")]),
      ),
      h(
        "fieldset",
        { class: "new-run__group" },
        h("legend", { class: "new-run__legend" }, ...heading(2, "Was gebaut wird", ids.tickets)),
        h("p", { class: "new-run__hint" }, "Tickets in der Reihenfolge deiner Auswahl. Ohne Auswahl baut der Lauf die Warteschlange."),
        ...(startable.length ? startable.map(ticketRow) : [h("p", { class: "new-run__hint" }, "Keine startbereiten Tickets – der Lauf baut die Warteschlange des Rechners.")]),
        batch,
        fixedNote,
      ),
      h(
        "fieldset",
        { class: "new-run__group" },
        h("legend", { class: "new-run__legend" }, ...heading(3, "Agent, Modell und Parallelität", ids.agent)),
        presets,
        customRow,
        h("div", { class: "new-run__field" }, h("span", { class: "new-run__label", id: ids.parallel }, "Parallelität (Tickets gleichzeitig)"), parallelChips, parallelWarn),
      ),
      h(
        "div",
        { class: "new-run__group" },
        h("div", { class: "new-run__legend" }, ...heading(4, "Ziel-Branch", uid())),
        h("div", { class: "new-run__field" }, h("label", { class: "new-run__label", for: ids.branch }, "Branch, in den der Lauf mergt"), branch, branchHint),
      ),
      h("fieldset", { class: "new-run__group" }, h("legend", { class: "new-run__legend" }, ...heading(5, "Testserver und Abnahme", uid())), ...testCards),
    ),
    h(
      "footer",
      { class: "new-run__foot" },
      command,
      reason,
      error,
      h("div", { class: "new-run__actions" }, h("button", { class: "btn", type: "button", onclick: close }, "Abbrechen"), submit),
    ),
  );
  const overlay = h(
    "div",
    {
      class: "new-run",
      role: "dialog",
      "aria-modal": "true",
      "aria-labelledby": ids.heading,
      onclick: (e: Event) => e.target === overlay && close(),
      onkeydown: (e: Event) => (e as KeyboardEvent).key === "Escape" && close(),
    },
    form,
  );
  sync();
  document.body.append(overlay);
  // the chosen machine first, like the design
  (overlay.querySelector<HTMLInputElement>("input:checked") ?? overlay.querySelector<HTMLInputElement>("input"))?.focus();
}
