/**
 * Grill pieces shared by board, details panel and Läufe: the „Grillen“ block (start or live state), card badges,
 * card-menu entries, the „Alle auto-grillen“ dialog and the STATUS protocol of one grill.
 */
import { hasHost, openSession } from "../api";
import type { Derived } from "../derive";
import { fill, fmtDate, h } from "../dom";
import {
  advisorOptions,
  badgeText,
  GRILL_STATUS_TEXT,
  GRILL_STEP_COUNT,
  GRILL_STEP_LABELS,
  isLiveGrill,
  MAX_GRILLS_PER_MACHINE,
  modeText,
  stepStates,
  stepText,
} from "../grill";
import { dequeueGrill, enqueueAutoGrills, isStarting, queuedGrill, startGrill } from "../grillqueue";
import { currentProject, laneServers, prefGet, prefSet, serverLabel, state } from "../state";
import type { Grill, Issue, Server } from "../types";
import type { CardInfo } from "./cards";
import type { MenuItem } from "./menu";

const CUSTOM = "__custom__";

/** Choices of the start block, kept across rebuilds (polls) and tickets. */
const form = { server: null as string | null, advisor: null as string | null };

function defaultServer(list: Server[]): string | null {
  const online = list.filter((s) => s.online);
  const want = form.server ?? prefGet<string>("grillServer");
  return online.find((s) => s.id === want)?.id ?? online[0]?.id ?? null;
}

const advisorChoices = () => advisorOptions(currentProject()?.agents ?? [], prefGet<string[]>("grillAdvisors") ?? []);

/** The 7-step bar: done green, current blue (orange when it waits for the human), rest grey. */
export function grillBar(g: Grill): HTMLElement {
  const cls = { done: "merged", active: "building", waiting: "waiting", todo: "queued" } as const;
  return h("span", { class: "segbar grill-bar", role: "img", "aria-label": stepText(g) }, ...stepStates(g).map((s) => h("span", { class: `seg ${cls[s]}` })));
}

export const grillPill = (g: Grill) => h("span", { class: `gpill ${g.status}` }, GRILL_STATUS_TEXT[g.status]);

function sessionButton(server: string, g: Grill, primary: boolean, small = false): HTMLElement {
  const can = !!g.pane && hasHost() && isLiveGrill(g);
  return h(
    "button",
    {
      class: `btn${primary ? " primary" : ""}${small ? " small" : ""}`,
      disabled: !can,
      title: can ? undefined : !g.pane ? "Keine Sitzung gefunden" : !hasHost() ? "Nur in Hollr" : "Die Sitzung ist beendet",
      onclick: () => g.pane && openSession(server, g.pane),
    },
    "Sitzung öffnen",
  );
}

// ---- card badge and menu

export function cardGrill(d: Derived, n: number): CardInfo["grill"] {
  const q = queuedGrill(n);
  if (q) return { badge: "wartet auf Start", tone: "queued", where: `Auto-Grillen auf ${serverLabel(q.entry.server)} · Platz ${q.place}` };
  if (isStarting(n)) return { badge: "startet …", tone: "running", where: "Grill startet …" };
  const tg = d.grills.get(n);
  if (!tg || tg.grill.status === "ended") return undefined;
  const g = tg.grill;
  return {
    badge: badgeText(g),
    tone: g.status === "waiting" ? "waiting" : g.status === "done" ? "done" : "running",
    where: `${modeText(g.mode)} auf ${serverLabel(tg.server)}`,
  };
}

/** „Grillen auf <M>“ / „Auto-Grillen auf <M>“ for a ticket in „Zu grillen“ without a live grill. */
export function grillMenuItems(d: Derived, n: number): MenuItem[] {
  const tg = d.grills.get(n);
  if ((tg && isLiveGrill(tg.grill)) || queuedGrill(n)) return [];
  const busy = isStarting(n);
  const advisor = prefGet<string>("grillAdvisor") || null;
  const online = laneServers().filter((s) => s.online);
  return [
    ...online.map((s) => ({ label: `Grillen auf ${s.label}`, disabled: busy, run: () => startGrill(s.id, n, "interactive", null) })),
    ...online.map((s) => ({
      label: `Auto-Grillen auf ${s.label}${advisor ? ` · Advisor ${advisor}` : ""}`,
      disabled: busy,
      run: () => startGrill(s.id, n, "auto", advisor),
    })),
  ];
}

// ---- details panel block

/** What the block shows; the panel rebuilds it only when this changes (choices live in `form`). */
export function grillBlockSig(d: Derived, n: number, inGrillColumn: boolean): string {
  const tg = d.grills.get(n);
  return JSON.stringify([inGrillColumn, tg, queuedGrill(n), isStarting(n), laneServers().map((s) => [s.id, s.online]), advisorChoices(), hasHost()]);
}

export function grillBlock(d: Derived, n: number, inGrillColumn: boolean): HTMLElement | null {
  const tg = d.grills.get(n);
  const live = tg && isLiveGrill(tg.grill) ? tg : null;
  const queued = queuedGrill(n);
  if (!inGrillColumn && !tg && !queued) return null;
  const waiting = live?.grill.status === "waiting";
  const el = h(
    "section",
    { class: `grill-panel${waiting ? " waiting" : ""}`, "aria-label": "Grillen" },
    h("h3", { class: "grill-title" }, h("span", { class: "grill-icon", "aria-hidden": "true" }, "🔥"), "Grillen"),
  );
  if (tg && (live || !inGrillColumn || tg.grill.status === "done")) {
    el.append(...grillFacts(tg.server, tg.grill));
    return el;
  }
  if (queued) {
    el.append(
      h("p", { class: "grill-hint" }, `Wartet auf Start: Auto-Grillen auf ${serverLabel(queued.entry.server)}, Platz ${queued.place}${queued.entry.advisor ? ` · Advisor ${queued.entry.advisor}` : ""}.`),
      h("p", { class: "grill-hint" }, "Die Warteschlange läuft in dieser Seite – wird sie geschlossen, starten die übrigen nicht."),
      h("div", { class: "btn-row" }, h("button", { class: "btn", onclick: () => dequeueGrill(n) }, "Aus der Warteschlange nehmen")),
    );
    return el;
  }
  if (tg) el.append(h("p", { class: "grill-hint" }, `Letzter Grill auf ${serverLabel(tg.server)}: ${GRILL_STATUS_TEXT[tg.grill.status]} · ${stepText(tg.grill)}`));
  el.append(...startPart(n));
  return el;
}

function grillFacts(server: string, g: Grill): HTMLElement[] {
  const waiting = g.status === "waiting";
  return [
    h(
      "dl",
      { class: "grill-facts" },
      h("dt", {}, "Rechner"),
      h("dd", {}, serverLabel(server)),
      h("dt", {}, "Modus"),
      h("dd", {}, modeText(g.mode)),
      h("dt", {}, "Status"),
      h("dd", {}, grillPill(g)),
    ),
    h(
      "div",
      { class: "grill-progress" },
      grillBar(g),
      h("p", { class: "grill-step" }, stepText(g)),
      waiting ? h("p", { class: "grill-hint" }, "Der Agent wartet im Hollr-Chat auf deine Antwort.") : null,
      g.status === "idle" ? h("p", { class: "grill-hint" }, "Die Sitzung arbeitet gerade nicht – in der Sitzung nachsehen.") : null,
    ),
    h("div", { class: "btn-row" }, sessionButton(server, g, waiting)),
  ];
}

function machineChooser(list: Server[], chosen: string | null, onPick: (id: string) => void): HTMLElement {
  return h(
    "fieldset",
    { class: "grill-field" },
    h("legend", { class: "grill-label" }, "Rechner"),
    h(
      "div",
      { class: "grill-segments" },
      ...list.map((s) => {
        const radio = h("input", { type: "radio", name: "grill-machine", value: s.id, checked: s.id === chosen, disabled: !s.online });
        radio.addEventListener("change", () => onPick(s.id));
        return h("label", { class: "grill-segment" }, radio, h("span", {}, s.online ? s.label : `${s.label} · offline`));
      }),
    ),
  );
}

/** Advisor select („ohne“, project models, recent ones, „Anderes Modell …“ with a field) bound to `form`. */
function advisorField(id: string): HTMLElement {
  const choices = advisorChoices();
  form.advisor ??= prefGet<string>("grillAdvisor") ?? "";
  const current = form.advisor;
  const known = !current || choices.some((c) => c.value === current);
  const select = h(
    "select",
    { id, "aria-describedby": `${id}-hint` },
    h("option", { value: "" }, "ohne"),
    ...choices.map((c) => h("option", { value: c.value }, c.label)),
    h("option", { value: CUSTOM }, "Anderes Modell …"),
  );
  select.value = known ? current : CUSTOM;
  const custom = h("input", { type: "text", placeholder: "Modell-ID, z. B. openai/gpt-5", "aria-label": "Advisor-Modell", value: known ? "" : current });
  custom.hidden = select.value !== CUSTOM;
  select.addEventListener("change", () => {
    custom.hidden = select.value !== CUSTOM;
    form.advisor = select.value === CUSTOM ? custom.value.trim() : select.value;
    if (!custom.hidden) custom.focus();
  });
  custom.addEventListener("input", () => {
    form.advisor = custom.value.trim();
  });
  return h(
    "div",
    { class: "grill-field" },
    h("label", { class: "grill-label", for: id }, "Advisor"),
    select,
    custom,
    h("p", { class: "grill-hint", id: `${id}-hint` }, "Gegenprüfung durch ein zweites Modell – nur beim Auto-Grillen."),
  );
}

function startPart(n: number): HTMLElement[] {
  const list = laneServers();
  form.server = defaultServer(list);
  const starting = isStarting(n);
  const none = !form.server;
  const start = (mode: "interactive" | "auto") => {
    if (form.server) startGrill(form.server, n, mode, mode === "auto" ? form.advisor || null : null);
  };
  return [
    list.length
      ? machineChooser(list, form.server, (id) => {
          form.server = id;
        })
      : h("p", { class: "grill-hint" }, "Kein gekoppelter Rechner hat dieses Projekt ausgecheckt."),
    advisorField("grill-advisor"),
    h(
      "div",
      { class: "grill-actions" },
      h(
        "div",
        { class: "grill-action" },
        h("button", { class: "btn primary", disabled: none || starting, onclick: () => start("interactive") }, starting ? "startet …" : "Grillen"),
        h("p", { class: "grill-hint" }, "Du beantwortest die Fragen im Hollr-Chat."),
      ),
      h(
        "div",
        { class: "grill-action" },
        h("button", { class: "btn", disabled: none || starting, onclick: () => start("auto") }, "Auto-Grillen"),
        h("p", { class: "grill-hint" }, "Entscheidet ohne Rückfrage – nächster Mensch erst bei der Abnahme."),
      ),
    ),
  ];
}

// ---- „Alle auto-grillen“

/** Tickets the action would queue: shown in the column, open, no live grill, not queued yet. */
export function autoGrillCandidates(d: Derived, shown: Issue[]): Issue[] {
  return shown.filter((i) => {
    const tg = d.grills.get(i.number);
    return i.state === "open" && !(tg && isLiveGrill(tg.grill)) && !queuedGrill(i.number) && !isStarting(i.number);
  });
}

export function openGrillAllDialog(tickets: Issue[]): void {
  if (!tickets.length) return;
  const list = laneServers();
  const chosen = defaultServer(list);
  const machine = h(
    "select",
    { id: "grill-all-machine" },
    ...list.map((s) => h("option", { value: s.id, disabled: !s.online }, s.online ? s.label : `${s.label} (offline)`)),
  );
  if (chosen) machine.value = chosen;
  const count = tickets.length;
  const close = () => {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
  };
  const confirm = h("button", { class: "btn primary", type: "submit", disabled: !chosen }, count === 1 ? "Auto-Grillen" : `${count} auto-grillen`);
  const overlay = h(
    "div",
    { class: "overlay sheet", onclick: (e: Event) => e.target === overlay && close() },
    h(
      "form",
      {
        class: "modal grill-all",
        role: "dialog",
        "aria-modal": "true",
        "aria-labelledby": "grill-all-heading",
        onsubmit: (e: Event) => {
          e.preventDefault();
          if (!machine.value) return;
          close();
          form.server = machine.value;
          prefSet("grillServer", machine.value);
          enqueueAutoGrills(machine.value, tickets.map((t) => t.number), form.advisor || null);
        },
      },
      h(
        "div",
        { class: "modal-head" },
        h("h2", { id: "grill-all-heading" }, count === 1 ? "1 Ticket auto-grillen?" : `${count} Tickets auto-grillen?`),
        h("button", { class: "btn ghost", type: "button", "aria-label": "Schließen", onclick: close }, "✕"),
      ),
      h("p", { class: "grill-all-text" }, "Der Agent entscheidet ohne Rückfrage; der nächste Mensch kommt erst bei der Abnahme."),
      h("ul", { class: "grill-all-tickets", "aria-label": "Betroffene Tickets" }, ...tickets.map((t) => h("li", {}, h("span", { class: "nr" }, `#${t.number}`), t.title))),
      h("div", { class: "grill-all-fields" }, h("div", { class: "grill-field" }, h("label", { class: "grill-label", for: "grill-all-machine" }, "Rechner"), machine), advisorField("grill-all-advisor")),
      h(
        "p",
        { class: "grill-hint" },
        `Höchstens ${MAX_GRILLS_PER_MACHINE} gleichzeitig je Rechner – die übrigen Tickets starten nacheinander, solange diese Seite offen ist.`,
      ),
      h("div", { class: "btn-row end" }, h("button", { class: "btn", type: "button", onclick: close }, "Abbrechen"), confirm),
    ),
  );
  document.addEventListener("keydown", onKey);
  document.body.append(overlay);
  machine.focus();
}

// ---- Läufe: one grill's STATUS protocol

const STEP_STATE_TEXT = { done: "erledigt", active: "läuft", waiting: "wartet auf dich", todo: "offen" } as const;

/** Right side of „Läufe“ for a selected grill: summary, the 7 steps and the notes from STATUS.md. */
export function grillLog(el: HTMLElement, server: string, g: Grill | undefined, onBack: () => void): void {
  if (!g) {
    fill(el, h("button", { class: "btn small back", onclick: onBack }, "‹ Läufe"), h("p", { class: "muted pad" }, "Grill nicht mehr da."));
    return;
  }
  const issue = g.slug === state.slug && g.n !== null ? state.board?.issues.find((i) => i.number === g.n) : undefined;
  const title = [g.key, g.n !== null ? `#${g.n}` : null].filter(Boolean).join(" · ") + (issue ? ` ${issue.title}` : g.project ? ` · ${g.project}` : "");
  const states = stepStates(g);
  const waiting = g.status === "waiting";
  fill(
    el,
    h("div", { class: "grill-log-head" }, h("button", { class: "btn small back", onclick: onBack }, "‹ Läufe"), h("h2", {}, title)),
    h(
      "div",
      { class: "grill-log-summary" },
      grillPill(g),
      h("span", { class: "muted grow" }, `${modeText(g.mode)} auf ${serverLabel(server)} · ${stepText(g)}${g.startedAt ? ` · seit ${fmtDate(g.startedAt)}` : ""}`),
      sessionButton(server, g, waiting),
    ),
    h("h3", {}, "STATUS-Protokoll"),
    h(
      "ol",
      { class: "grill-steps", "aria-label": `Die ${GRILL_STEP_COUNT} Schritte des Grills` },
      ...states.map((s, i) =>
        h(
          "li",
          { class: `grill-step-row ${s}` },
          h("span", { class: "mark", "aria-hidden": "true" }, s === "done" ? "✓" : "○"),
          h("span", { class: "name" }, `${i + 1}. ${g.steps.find((x) => x.n === i + 1)?.label ?? GRILL_STEP_LABELS[i]}`),
          h("span", { class: "st" }, STEP_STATE_TEXT[s]),
        ),
      ),
    ),
    g.notes.length ? h("h3", {}, "Notizen") : null,
    g.notes.length ? h("ul", { class: "grill-notes" }, ...g.notes.map((l) => h("li", {}, l))) : null,
    h("p", { class: "muted small" }, g.cwd ? `Aus ${g.cwd}/.scratch/${g.key ?? "…"}/STATUS.md auf ${serverLabel(server)}.` : `Auf ${serverLabel(server)}.`),
  );
}
