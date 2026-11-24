/**
 * „Neuer Lauf“ from the Sandcastle dock: machine (one run per machine – busy and offline ones can't be picked),
 * target branch, agent, and optionally tickets that go to the front of that machine's queue in the order they are
 * ticked. Built once per opening and never re-rendered by polls, so typed values and ticks survive.
 */
import { queueChildren } from "../actions";
import { hasHost, openSession, sc } from "../api";
import { derive } from "../derive";
import { fill, h } from "../dom";
import { errorText, hooks, prefGet, prefSet, projectOn, state, toast } from "../state";
import { openChildren } from "../tickets";
import type { JiraTicket, Server } from "../types";
import { ticketPlaces } from "./rundock";

interface LastConfig {
  agent: string;
  parallel: number;
  screencast: boolean;
  deploy: boolean;
}

/** Why a machine can't take a new run, null when it can. */
function busyReason(s: Server): string | null {
  if (!s.online) return "offline";
  const status = state.statuses.get(s.id);
  const live = status?.runs.find((r) => r.status !== "ended");
  if (live) return `nicht wählbar – hier läuft schon ein Lauf nach ${live.branch || live.project}`;
  if (status?.lock) return `nicht wählbar – hier läuft schon ein Lauf (${String(status.lock.project ?? "?")})`;
  return null;
}

export function newRunModal(preselect: string | null): void {
  const d = derive();
  const project = d.project;
  if (!project) return;
  const slug = state.slug;
  const last = prefGet<LastConfig>(`cfg.${slug}`);
  // machines with a checkout of the repo; offline ones (their checkouts are unknown) only to say so
  const machines = state.servers.filter((s) => projectOn(s.id) || !s.online);
  const free = machines.filter((s) => !busyReason(s));
  let server = (preselect && free.some((s) => s.id === preselect) ? preselect : free[0]?.id) ?? null;

  const radios = machines.map((s) => {
    const reason = busyReason(s);
    const input = h("input", { type: "radio", name: "machine", value: s.id, disabled: !!reason, checked: s.id === server });
    input.addEventListener("change", () => {
      server = s.id;
      syncAgents();
      sync();
    });
    return h("label", { class: `radio${reason ? " disabled" : ""}` }, h("span", { class: "radio-top" }, input, s.label), reason ? h("span", { class: "radio-note" }, `🔒 ${reason}`) : null);
  });

  const branch = h("input", { value: project.defaultBranch, "aria-label": "Ziel-Branch", spellcheck: false });
  const today = new Date().toISOString().slice(0, 10);
  const agent = h("select", { "aria-label": "Agent / Modell" });
  const syncAgents = () => {
    const p = (server && projectOn(server)) || project;
    const agents = p.agents.length ? p.agents : [{ key: p.defaults.agent, label: p.defaults.agent, harness: "", model: "" }];
    const keep = agent.value || last?.agent || p.defaults.agent;
    fill(agent, ...agents.map((a) => h("option", { value: a.key }, a.label)));
    agent.value = agents.some((a) => a.key === keep) ? keep : p.defaults.agent;
  };
  syncAgents();

  // tickets that can go into a run: open, grilled (open children on GitHub), not in any machine's lane yet
  const places = ticketPlaces(d);
  const startable = (state.jira?.tickets ?? []).filter((t) => t.category !== "done" && openChildren(t).length > 0 && !places.has(t.key));
  const picked: string[] = [];
  const placeEls = new Map<string, HTMLElement>();
  const ticketRow = (t: JiraTicket) => {
    const box = h("input", { type: "checkbox" });
    const place = h("span", { class: "place" });
    placeEls.set(t.key, place);
    box.addEventListener("change", () => {
      const i = picked.indexOf(t.key);
      if (box.checked && i < 0) picked.push(t.key);
      if (!box.checked && i >= 0) picked.splice(i, 1);
      sync();
    });
    return h("label", { class: "check ticket-pick" }, box, h("span", { class: "grow" }, h("b", {}, t.key), " ", t.summary), place);
  };

  const reason = h("p", { class: "reason small" });
  const error = h("p", { class: "error small" });
  const submit = h("button", { class: "btn primary", type: "submit" }, "Lauf starten");
  const sync = () => {
    for (const [key, el] of placeEls) {
      const i = picked.indexOf(key);
      el.textContent = i >= 0 ? `Platz ${i + 1}` : "";
    }
    const queued = d.lanes.find((l) => l.server.id === server)?.order.length ?? 0;
    const p = (server && projectOn(server)) || project;
    const blocked = !server
      ? "Kein Rechner frei."
      : p.engine !== "sandcastle"
        ? `Projekt ${p.name} nutzt den Motor ${p.engine}, nicht Sandcastle.`
        : !picked.length && !queued
          ? "Die Warteschlange auf diesem Rechner ist leer – Tickets auswählen."
          : "";
    // the loop of this project doesn't read the queue yet: the run gets the tickets as a fixed list
    const note = !blocked && !p.queueSupported
      ? "Diese Schleife kennt die Warteschlange noch nicht: der Lauf baut genau die eingereihten Tickets – was du danach einreihst, kommt in den nächsten Lauf."
      : "";
    reason.textContent = blocked || note;
    reason.classList.toggle("note", !blocked && !!note);
    submit.disabled = !!blocked;
    submit.textContent = picked.length ? `Lauf mit ${picked.length} ${picked.length === 1 ? "Ticket" : "Tickets"} starten` : "Lauf starten";
  };

  const close = () => {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
  };
  const form = h(
    "form",
    {
      class: "modal newrun",
      onsubmit: async (e: Event) => {
        e.preventDefault();
        if (submit.disabled || !server) return;
        const target = server;
        const label = machines.find((s) => s.id === target)?.label ?? target;
        submit.disabled = true;
        error.textContent = "";
        try {
          // label and queue the picked tickets' children on that machine first, in pick order
          for (const key of picked) if (!(await queueChildren(key, target))) throw new Error(`${key} konnte nicht eingereiht werden.`);
          const ns = picked.flatMap((key) => {
            const t = state.jira?.tickets.find((x) => x.key === key);
            return t ? openChildren(t) : [];
          });
          const config = {
            agent: agent.value,
            parallel: last?.parallel ?? project.defaults.parallel,
            screencast: last?.screencast ?? false,
            deploy: last?.deploy ?? true,
            branch: branch.value.trim(),
          };
          const res = await sc.start(target, slug, config, ns);
          prefSet(`cfg.${slug}`, { agent: config.agent, parallel: config.parallel, screencast: config.screencast, deploy: config.deploy });
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
    h("div", { class: "modal-head" }, h("h2", {}, "Neuer Lauf"), h("button", { class: "btn ghost icon", type: "button", "aria-label": "Schließen", onclick: close }, "✕")),
    h("div", { class: "field" }, h("div", { class: "field-label" }, "Rechner"), h("div", { class: "muted small" }, "Pro Rechner läuft höchstens ein Lauf."), ...(radios.length ? radios : [h("p", { class: "muted small" }, "Kein Rechner hat dieses Projekt ausgecheckt.")])),
    h(
      "div",
      { class: "row" },
      h("label", {}, "Ziel-Branch", branch, h("span", { class: "muted small" }, `z. B. ${project.defaultBranch} oder feature/batch-${today}`)),
      h("label", {}, "Agent / Modell", agent),
    ),
    h(
      "div",
      { class: "field" },
      h("div", { class: "field-label" }, "Tickets ", h("span", { class: "muted" }, "(optional, in Reihenfolge der Auswahl)")),
      ...(startable.length ? startable.map(ticketRow) : [h("p", { class: "muted small" }, "Keine startbereiten Tickets – sonst arbeitet der Lauf die Warteschlange des Rechners ab.")]),
    ),
    reason,
    error,
    h("div", { class: "btn-row end" }, h("button", { class: "btn", type: "button", onclick: close }, "Abbrechen"), submit),
  );
  const overlay = h("div", { class: "overlay", onclick: (e: Event) => e.target === overlay && close() }, form);
  document.addEventListener("keydown", onKey);
  sync();
  document.body.append(overlay);
}
