/**
 * Ticket details in the shared side panel: JIRA status with its transitions, product labels (written to JIRA),
 * assignee, epic, description, comments; „Bau“ (story, children with run phase and machine – a link into the
 * Werkbank – and the grill of the ticket) and „Abgleich“ (drift, „Angleichen“). Text and comments load once per
 * opening; the live blocks follow every poll and rebuild only when what they show changed.
 */
import { applyTicketDrift, editTicketLabels, queueChildren, transitionTicket } from "../actions";
import { api } from "../api";
import { derive, type Derived } from "../derive";
import { fill, fmtDate, h, html } from "../dom";
import { isBusy, PHASE_TEXT } from "../model";
import { errorText, hooks, serverLabel, state, toast } from "../state";
import { actionable, applyHint, buildLine, driftText, INFO_KINDS, jiraLabel, memberPhase, statusColumn, ticketFacets, typeIcon } from "../tickets";
import type { Comment, FamilyMember, JiraIssueDetail, JiraTicket } from "../types";
import { grillBlock, grillBlockSig } from "./grilling";
import { claimPanel, closeSidebar, commentEl, extLink, externalLinks, openIssue, prListEl } from "./sidebar";

let shown: string | null = null;
let detail: JiraIssueDetail | null = null;
let panel: HTMLElement | null = null;
let live: HTMLElement | null = null;
let liveSig = "";
let grillHost: HTMLElement | null = null;
let grillSig = "";

const release = () => {
  shown = null;
  detail = null;
  live = null;
  grillHost = null;
};

const ticketOf = (key: string): JiraTicket | undefined => state.jira?.tickets.find((t) => t.key === key) ?? (detail?.ticket.key === key ? detail.ticket : undefined);

export async function openTicketSide(key: string): Promise<void> {
  if (!key) return;
  panel = claimPanel(release);
  shown = key;
  detail = null;
  render(key);
  await loadDetail(key);
}

async function loadDetail(key: string): Promise<void> {
  const slug = state.slug;
  try {
    const d = await api<JiraIssueDetail>(`/api/jira/issue?slug=${encodeURIComponent(slug)}&key=${encodeURIComponent(key)}`);
    if (shown !== key || slug !== state.slug) return;
    detail = d;
    render(key);
  } catch (err) {
    if (shown !== key || !panel) return;
    const body = panel.querySelector(".side-static");
    if (body) fill(body, h("p", { class: "error" }, errorText(err)));
  }
}

function render(key: string): void {
  if (!panel) return;
  const t = ticketOf(key);
  live = h("div", { class: "side-live" });
  liveSig = "";
  grillHost = h("div", { class: "side-grill" });
  grillSig = "";
  fill(
    panel,
    h(
      "div",
      { class: "side-head" },
      h("button", { class: "btn ghost", onclick: closeSidebar }, "✕ Schließen"),
      t?.url ? extLink(`${key} in JIRA`, t.url, "side-num") : h("span", { class: "side-num" }, key),
    ),
    h(
      "div",
      { class: "side-body" },
      h("h2", { class: "side-title" }, t?.summary ?? key),
      live,
      grillHost,
      h("div", { class: "side-static" }, ...staticPart(key)),
    ),
  );
  renderTicketLive();
}

function staticPart(key: string): (HTMLElement | null)[] {
  if (!detail) return [h("p", { class: "muted" }, "Beschreibung und Kommentare laden …")];
  const d = detail;
  const comments = h("div", { class: "comments" }, ...d.comments.map(commentEl));
  const heading = h("h3", {}, `Kommentare (${d.comments.length})`);
  const text = h("textarea", { rows: 3, placeholder: "Kommentar schreiben …" });
  const send = h("button", { class: "btn primary" }, "Kommentieren");
  send.addEventListener("click", async () => {
    const body = text.value.trim();
    if (!body) return;
    send.disabled = true;
    try {
      const { comment } = await api<{ comment: Comment }>("/api/jira/comment", { slug: state.slug, key, body });
      text.value = "";
      if (shown === key) {
        d.comments.push(comment);
        comments.append(commentEl(comment));
        heading.textContent = `Kommentare (${d.comments.length})`;
      }
    } catch (err) {
      toast(errorText(err));
    } finally {
      send.disabled = false;
    }
  });
  return [
    h(
      "details",
      { class: "side-desc", open: d.descriptionHtml.length < 1500 },
      h("summary", {}, "Beschreibung"),
      externalLinks(html("markdown", d.description.trim() ? d.descriptionHtml : '<p class="muted">Keine Beschreibung.</p>')),
    ),
    h("section", {}, heading, comments, h("div", { class: "comment-form" }, text, send)),
  ];
}

/** The blocks that follow polls. Called by app.ts after every render. */
export function renderTicketLive(): void {
  if (shown === null || !live || !panel) return;
  const key = shown;
  const t = ticketOf(key);
  if (!t) return;
  const d = derive();
  const selected = d.project?.jira.states.selected ?? null;
  const g = t.family.grill;
  const inGrill = !!g && g.state === "open" && statusColumn(t, selected) === "grill";
  const gSig = g ? grillBlockSig(d, g.n, inGrill) : "";
  if (grillHost && gSig !== grillSig) {
    grillSig = gSig;
    fill(grillHost, g ? grillBlock(d, g.n, inGrill) : null);
  }
  const fam = [t.family.story, ...t.family.children].filter((m): m is FamilyMember => !!m).map((m) => [m.n, m.state, d.runs.get(m.n)?.issue.phase, d.laneOf.get(m.n)]);
  const sig = JSON.stringify([t, detail?.transitions, fam, d.lanes.map((l) => l.server.id), state.jira?.fetchedAt, facetLabels().length]);
  if (sig === liveSig) return;
  liveSig = sig;
  const title = panel.querySelector(".side-title");
  if (title) title.textContent = t.summary;
  fill(live, metaBlock(t), statusBlock(t), labelsBlock(t), buildBlock(t, d), driftBlock(t));
}

function metaBlock(t: JiraTicket): HTMLElement {
  return h(
    "dl",
    { class: "side-meta" },
    h("dt", {}, "Ticket"),
    h("dd", {}, h("b", {}, t.key), " ", h("span", { class: "muted" }, `${typeIcon(t.type)} ${t.type}`)),
    h("dt", {}, "Zustand"),
    h("dd", {}, h("span", { class: `jstate cat-${t.category}` }, t.status)),
    h("dt", {}, "Bearbeiter"),
    h("dd", {}, t.assignee?.name ?? h("span", { class: "muted" }, "niemand")),
    t.epic ? h("dt", {}, "Epic") : null,
    t.epic ? h("dd", {}, `${t.epic.summary || t.epic.key} `, h("span", { class: "muted small" }, t.epic.key)) : null,
  );
}

function statusBlock(t: JiraTicket): HTMLElement {
  const transitions = (detail?.ticket.key === t.key ? detail.transitions : []).filter((x) => x.to !== t.status);
  const go = async (to: string) => {
    if (await transitionTicket(t.key, to)) await loadDetail(t.key);
  };
  return h(
    "section",
    {},
    h("h3", {}, "Zustand wechseln"),
    detail
      ? transitions.length
        ? h("div", { class: "btn-row" }, ...transitions.map((x) => h("button", { class: "btn", title: x.name, onclick: () => go(x.to) }, `→ ${x.to}`)))
        : h("p", { class: "muted small" }, "Von hier aus erlaubt JIRA keinen Wechsel.")
      : h("p", { class: "muted small" }, "Übergänge laden …"),
  );
}

/** Labels any ticket of the project uses: the choices of „Label hinzufügen“. */
const facetLabels = () => (state.jira ? [...ticketFacets(state.jira.tickets).labels.keys()].sort((a, b) => a.localeCompare(b, "de")) : []);

function labelsBlock(t: JiraTicket): HTMLElement {
  const listId = "jira-labels";
  const input = h("input", { type: "text", list: listId, placeholder: "Label in JIRA hinzufügen …", "aria-label": "Label hinzufügen", autocapitalize: "off" });
  const add = () => {
    const name = jiraLabel(input.value);
    if (!name || t.labels.includes(name)) return;
    input.value = "";
    editTicketLabels(t.key, [name], []);
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      add();
    }
  });
  input.addEventListener("change", () => {
    // picking from the list commits at once
    if (facetLabels().includes(input.value)) add();
  });
  return h(
    "section",
    { class: "side-labels" },
    h("h3", {}, "Labels"),
    h(
      "div",
      { class: "chips" },
      ...t.labels.map((l) => h("span", { class: "chip" }, l, h("button", { class: "chip-x", "aria-label": `${l} entfernen`, onclick: () => editTicketLabels(t.key, [], [l]) }, "×"))),
      t.labels.length ? null : h("span", { class: "muted small" }, "Keine Labels"),
    ),
    h("div", { class: "label-add" }, input, h("button", { class: "btn", onclick: add }, "Hinzufügen")),
    h("datalist", { id: listId }, ...facetLabels().filter((l) => !t.labels.includes(l)).map((l) => h("option", { value: l }))),
  );
}

/** A GitHub issue of the family in the Werkbank. */
function toWerkbank(n: number): void {
  hooks.showMode("werkbank");
  openIssue(n);
}

function memberRow(d: Derived, m: FamilyMember, role: string | null): HTMLElement {
  const tr = d.runs.get(m.n);
  const lane = d.laneOf.get(m.n);
  const phase = tr?.issue.phase;
  const where = tr && tr.run.status !== "ended" ? serverLabel(tr.server) : lane ? serverLabel(lane) : "";
  const seg = memberPhase(m, phase);
  const text = m.state === "closed" ? (role ? "geschlossen" : "gemergt") : phase ? PHASE_TEXT[phase] : lane ? "wartet" : "offen";
  return h(
    "button",
    { class: "fam-row", title: "In der Werkbank öffnen", onclick: () => toWerkbank(m.n) },
    h("span", { class: "num" }, `#${m.n}`),
    h("span", { class: "t" }, role ? h("span", { class: "fam-role" }, role) : null, m.title),
    h("span", { class: `fam-state seg-${seg}` }, where ? `${text} · ${where}` : text),
  );
}

function buildBlock(t: JiraTicket, d: Derived): HTMLElement {
  const f = t.family;
  const children = f.children.map((c) => ({ n: c.n, seg: memberPhase(c, d.runs.get(c.n)?.issue.phase) }));
  const live = f.children.map((c) => d.runs.get(c.n)).find((tr) => tr && tr.run.status !== "ended");
  const line = buildLine({
    story: f.story?.n ?? null,
    children,
    run: live ? { machine: serverLabel(live.server), percent: live.run.progress.percent } : null,
  });
  const open = f.children.filter((c) => c.state === "open");
  const busy = open.some((c) => isBusy(d.runs.get(c.n)?.issue.phase));
  return h(
    "section",
    { class: "side-build" },
    h("h3", {}, "Bau auf GitHub"),
    !f.story && !f.children.length && !f.grill && !t.prs.length ? h("p", { class: "muted small" }, "Noch nichts auf GitHub – erst grillen.") : null,
    line.text ? h("p", { class: "build-text" }, line.text) : null,
    line.segs.length ? h("span", { class: "segbar" }, ...line.segs.map((s) => h("span", { class: `seg ${s}` }))) : null,
    h(
      "div",
      { class: "fam" },
      f.grill ? memberRow(d, f.grill, "Grill") : null,
      f.story ? memberRow(d, f.story, "Story") : null,
      ...f.children.map((c) => memberRow(d, c, null)),
    ),
    t.prs.length ? h("h4", { class: "side-sub" }, "Pull Requests") : null,
    t.prs.length ? prListEl(t.prs) : null,
    open.length && d.lanes.length
      ? h(
          "div",
          { class: "btn-row" },
          ...d.lanes.map((l) =>
            h("button", { class: "btn small", disabled: busy && !open.every((c) => d.laneOf.get(c.n) === l.server.id), onclick: () => queueChildren(t.key, l.server.id) }, `Kinder in Sandcastle · ${l.server.label}`),
          ),
        )
      : null,
  );
}

function driftBlock(t: JiraTicket): HTMLElement {
  const act = actionable(t);
  const info = t.drift.filter((x) => INFO_KINDS[x.kind]);
  const checked = state.jira?.fetchedAt ? fmtDate(state.jira.fetchedAt) : "";
  const apply = h("button", { class: "btn primary", title: applyHint(t) }, "Angleichen");
  apply.addEventListener("click", async () => {
    apply.disabled = true;
    await applyTicketDrift(t.key);
    if (shown === t.key) await loadDetail(t.key);
    apply.disabled = false;
  });
  return h(
    "section",
    { class: "side-drift" },
    h("h3", {}, "Abgleich"),
    !t.drift.length ? h("p", { class: "ok small" }, "✓ JIRA und GitHub stimmen überein.") : null,
    act.length ? h("ul", { class: "drift-list" }, ...act.map((x) => h("li", {}, driftText(x, t.derived)))) : null,
    info.length ? h("ul", { class: "drift-list info" }, ...info.map((x) => h("li", {}, driftText(x, t.derived)))) : null,
    act.length ? h("div", { class: "btn-row" }, apply, h("span", { class: "muted small" }, applyHint(t))) : null,
    checked ? h("p", { class: "muted small" }, `Zuletzt geprüft: ${checked}`) : null,
  );
}
