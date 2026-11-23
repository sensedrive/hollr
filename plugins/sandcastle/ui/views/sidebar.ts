/**
 * Issue details beside the board (full screen on narrow windows). The text and comments come from /api/issue once
 * per opening; the live blocks (labels, run, Test, Branch, queue position, move) follow every poll in place and only
 * rebuild when what they show changed – a half-written comment is never touched.
 */
import { editLabels, moveTicket, setFlags } from "../actions";
import { api, openExternal } from "../api";
import { derive, type Derived, flagsOf } from "../derive";
import { fill, fmtDate, h, html } from "../dom";
import { branchColour, classify, isBusy, normaliseFlags, PHASE_TEXT } from "../model";
import { errorText, hooks, serverLabel, state, toast } from "../state";
import { grillBlock, grillBlockSig } from "./grilling";
import type { Column, Comment, IssueDetail, TicketFlags } from "../types";

const NAMES: Record<Column, string> = { grill: "Zu grillen", backlog: "Backlog", queue: "Sandcastle", done: "Erledigt" };

let panel: HTMLElement | null = null;
let shown: number | null = null;
let detail: IssueDetail | null = null;
let live: HTMLElement | null = null;
let liveSig = "";
/** the „Grillen“ block: rebuilt on its own, so a poll of the board does not reset a half-chosen advisor */
let grillHost: HTMLElement | null = null;
let grillSig = "";

function ensurePanel(): HTMLElement {
  if (panel) return panel;
  panel = h("aside", { id: "sidebar", "aria-label": "Issue-Details" });
  document.body.append(panel);
  return panel;
}

export function closeSidebar(): void {
  shown = null;
  detail = null;
  panel?.classList.remove("open");
  document.body.classList.remove("sidebar-open");
}

/** Public links inside rendered markdown go to the system browser. */
function externalLinks(el: HTMLElement): HTMLElement {
  el.addEventListener("click", (e) => {
    const a = (e.target as Element).closest("a");
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute("href") ?? "";
    if (/^https?:/i.test(href)) openExternal(href);
  });
  return el;
}

const extLink = (text: string, url: string, cls = "link") =>
  h("a", { href: url, class: cls, onclick: (e: Event) => { e.preventDefault(); openExternal(url); } }, text, " ↗");

export async function openIssue(n: number): Promise<void> {
  const el = ensurePanel();
  shown = n;
  detail = null;
  el.classList.add("open");
  document.body.classList.add("sidebar-open");
  // what the board already knows shows at once; text and comments follow
  render(n);
  const slug = state.slug;
  try {
    const d = await api<IssueDetail>(`/api/issue?slug=${encodeURIComponent(slug)}&n=${n}`);
    if (shown === n && slug === state.slug) {
      detail = d;
      render(n);
    }
  } catch (err) {
    if (shown === n) {
      const body = el.querySelector(".side-static");
      if (body) fill(body, h("p", { class: "error" }, errorText(err)));
    }
  }
}

function header(n: number, url?: string): HTMLElement {
  return h(
    "div",
    { class: "side-head" },
    h("button", { class: "btn ghost", onclick: closeSidebar }, "✕ Schließen"),
    url ? extLink(`#${n} GitHub`, url, "side-num") : h("span", { class: "side-num" }, `#${n}`),
  );
}

function render(n: number): void {
  const el = ensurePanel();
  const d = derive();
  const issue = d.issues.get(n);
  const title = issue?.title ?? detail?.title ?? `#${n}`;
  const url = issue?.url ?? detail?.url;
  const parent = issue?.parent ?? detail?.parent ?? null;
  const jira = issue?.jira ?? detail?.jira ?? null;
  const p = d.project;
  live = h("div", { class: "side-live" });
  liveSig = "";
  grillHost = h("div", { class: "side-grill" });
  grillSig = "";
  fill(
    el,
    header(n, url),
    h(
      "div",
      { class: "side-body" },
      h("h2", { class: "side-title" }, title),
      h(
        "dl",
        { class: "side-meta" },
        h("dt", {}, "Zustand"),
        h("dd", { class: "side-state" }),
        parent ? h("dt", {}, "Story") : null,
        parent ? h("dd", {}, h("button", { class: "link", onclick: () => openIssue(parent) }, `#${parent} ${d.stories.get(parent) ?? ""}`)) : null,
        jira ? h("dt", {}, "JIRA") : null,
        jira ? h("dd", {}, p?.jira.baseUrl ? extLink(jira, `${p.jira.baseUrl.replace(/\/+$/, "")}/browse/${jira}`) : jira) : null,
      ),
      grillHost,
      live,
      h("div", { class: "side-static" }, ...staticPart(n)),
    ),
  );
  renderLive();
}

function staticPart(n: number): (HTMLElement | null)[] {
  if (!detail) return [h("p", { class: "muted" }, "Text und Kommentare laden …")];
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
      const { comment } = await api<{ comment: Comment }>("/api/comment", { slug: state.slug, n, body });
      text.value = "";
      if (shown === n) {
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
    h("details", { class: "side-desc", open: d.bodyHtml.length < 1500 }, h("summary", {}, "Beschreibung"), externalLinks(html("markdown", d.bodyHtml || '<p class="muted">Kein Text.</p>'))),
    d.blockedBy.length
      ? h("section", {}, h("h3", {}, "Blockiert von"), h("div", { class: "btn-row" }, ...d.blockedBy.map((b) => h("button", { class: "link", onclick: () => openIssue(b) }, `#${b}`))))
      : null,
    h("section", {}, heading, comments, h("div", { class: "comment-form" }, text, send)),
  ];
}

const commentEl = (c: Comment) =>
  h("div", { class: "comment" }, h("div", { class: "small" }, h("b", {}, c.author), h("span", { class: "muted" }, ` · ${fmtDate(c.createdAt)}`)), externalLinks(html("markdown", c.bodyHtml)));

/** The blocks that follow polls. Called by app.ts after every render. */
export function renderLive(): void {
  if (shown === null || !live || !panel) return;
  const n = shown;
  const d = derive();
  const issue = d.issues.get(n);
  const labels = issue?.labels ?? detail?.labels ?? [];
  const stateText = (issue?.state ?? detail?.state) === "closed" ? "geschlossen" : "offen";
  const p = d.project;
  const col = p && issue ? classify(issue, p.labels, !!state.board?.hasGrill) : null;
  const tr = d.runs.get(n);
  const lane = d.laneOf.get(n) ?? null;
  const flags = flagsOf(d, n);
  const inGrill = col === "grill";
  const gSig = grillBlockSig(d, n, inGrill);
  if (grillHost && gSig !== grillSig) {
    grillSig = gSig;
    fill(grillHost, grillBlock(d, n, inGrill));
  }
  const sig = JSON.stringify([labels, stateText, col, tr?.issue, tr?.run.branch, tr?.run.issues.map((i) => i.n), lane, flags, lane ? d.lanes.find((l) => l.server.id === lane)?.order : null, d.lanes.map((l) => l.server.id), state.board?.labels.length]);
  if (sig === liveSig) return;
  liveSig = sig;
  const stateEl = panel.querySelector(".side-state");
  if (stateEl) fill(stateEl, h("span", { class: `state ${stateText === "offen" ? "open" : "closed"}` }, stateText), col && col !== "story" ? ` ${NAMES[col]}${lane ? ` · ${serverLabel(lane)}` : ""}` : col === "story" ? " Story" : "");
  const busy = isBusy(tr?.issue.phase);
  fill(live, labelsBlock(n, labels), runBlock(n, d), testBlock(n, d, lane ?? tr?.server ?? null, flags, busy), branchBlock(d, n), queueBlock(n, d, lane, busy), col && col !== "story" ? moveBlock(n, d, col, lane, busy) : null);
}

function labelsBlock(n: number, labels: string[]): HTMLElement {
  const all = state.board?.labels ?? [];
  const add = h(
    "select",
    {
      "aria-label": "Label hinzufügen",
      onchange: (e: Event) => {
        const name = (e.target as HTMLSelectElement).value;
        if (name) editLabels(n, [name], []);
      },
    },
    h("option", { value: "" }, "Label hinzufügen …"),
    ...all.filter((l) => !labels.includes(l.name)).map((l) => h("option", { value: l.name }, l.name)),
  );
  return h(
    "div",
    { class: "side-labels" },
    h("div", { class: "chips" }, ...labels.map((l) => h("span", { class: "chip" }, l, h("button", { class: "chip-x", "aria-label": `${l} entfernen`, onclick: () => editLabels(n, [], [l]) }, "×")))),
    add,
  );
}

function jumpToLog(server: string, run: string, n: number | null, path: string | null): void {
  state.selection = { server, run, n, path };
  state.grillSel = null;
  hooks.show("runs");
}

function runBlock(n: number, d: Derived): HTMLElement | null {
  const tr = d.runs.get(n);
  if (!tr) return null;
  const i = tr.issue;
  return h(
    "section",
    { class: "side-run" },
    h("h3", {}, "Im Lauf"),
    h("div", { class: "btn-row" }, h("span", { class: `phase ${i.phase}` }, PHASE_TEXT[i.phase]), h("span", { class: "muted small" }, `auf ${serverLabel(tr.server)} · ${tr.run.project}`)),
    i.reason ? h("p", { class: "error small" }, i.reason) : null,
    i.logs.length
      ? h("div", { class: "btn-row" }, ...i.logs.map((l) => h("button", { class: "btn small", onclick: () => jumpToLog(tr.server, tr.run.id, n, l.path) }, `Log ${l.role === "other" ? l.name : l.role}${l.active ? " ●" : ""}`)))
      : null,
  );
}

function testBlock(n: number, d: Derived, server: string | null, flags: TicketFlags | null, busy: boolean): HTMLElement {
  const f = flags ?? { deploy: false, testnote: false, video: false };
  const can = !!server && !busy && !!d.issues.get(n) && d.issues.get(n)?.state === "open";
  const toggle = (key: keyof TicketFlags, label: string) => {
    const box = h("input", { type: "checkbox", checked: f[key], disabled: !can });
    box.addEventListener("change", () => {
      if (server) setFlags(server, n, normaliseFlags({ ...f, [key]: box.checked }, key));
    });
    return h("label", { class: "switch" }, box, h("span", {}, label));
  };
  return h(
    "section",
    { class: "side-test" },
    h("h3", {}, "Test"),
    toggle("deploy", "Deploy auf workr"),
    toggle("testnote", "Testanweisung"),
    toggle("video", "Testvideo"),
    h(
      "p",
      { class: "muted small" },
      !server ? "Gilt je Rechner – erst in eine Sandcastle-Spalte ziehen." : busy ? "🔒 Wird gerade gebaut." : `Gilt für den Lauf auf ${serverLabel(server)}.`,
    ),
  );
}

function branchBlock(d: Derived, n: number): HTMLElement | null {
  const tr = d.runs.get(n);
  if (!tr?.run.branch) return null;
  const siblings = tr.run.issues.filter((i) => i.n !== n);
  return h(
    "section",
    { class: "side-branch" },
    h("h3", {}, "Branch"),
    h("div", { class: "branch-full mono" }, h("span", { class: "dot", style: `background:${branchColour(tr.run.branch)}` }), tr.run.branch),
    tr.run.pr && tr.run.slug ? h("div", {}, extLink(`PR #${tr.run.pr}`, `https://github.com/${tr.run.slug}/pull/${tr.run.pr}`)) : null,
    siblings.length
      ? h("div", { class: "btn-row" }, h("span", { class: "muted small" }, "Mit auf dem Branch:"), ...siblings.map((s) => h("button", { class: "link", onclick: () => openIssue(s.n) }, `#${s.n}`)))
      : null,
  );
}

function queueBlock(n: number, d: Derived, lane: string | null, busy: boolean): HTMLElement | null {
  if (!lane) return null;
  const order = d.lanes.find((l) => l.server.id === lane)?.order ?? [];
  const idx = order.indexOf(n);
  if (idx < 0) return null;
  const move = (before: number | null) => moveTicket(n, "queue", lane, before);
  const last = idx === order.length - 1;
  return h(
    "section",
    {},
    h("h3", {}, `Warteschlange ${serverLabel(lane)}: Platz ${idx + 1} von ${order.length}`),
    h(
      "div",
      { class: "btn-row" },
      h("button", { class: "btn", disabled: busy || idx === 0, onclick: () => move(order[0] ?? null) }, "Ganz nach oben"),
      h("button", { class: "btn", disabled: busy || idx === 0, onclick: () => move(order[idx - 1] ?? null) }, "Eins hoch"),
      h("button", { class: "btn", disabled: busy || last, onclick: () => move(order[idx + 2] ?? null) }, "Eins runter"),
      h("button", { class: "btn", disabled: busy || last, onclick: () => move(null) }, "Ans Ende"),
    ),
  );
}

function moveBlock(n: number, d: Derived, col: Column, lane: string | null, busy: boolean): HTMLElement {
  const targets: { label: string; run: () => unknown; current: boolean }[] = [];
  if (state.board?.hasGrill) targets.push({ label: NAMES.grill, run: () => moveTicket(n, "grill"), current: col === "grill" });
  targets.push({ label: NAMES.backlog, run: () => moveTicket(n, "backlog"), current: col === "backlog" });
  if (d.lanes.length)
    for (const l of d.lanes) targets.push({ label: `Sandcastle · ${l.server.label}`, run: () => moveTicket(n, "queue", l.server.id), current: col === "queue" && lane === l.server.id });
  else targets.push({ label: NAMES.queue, run: () => moveTicket(n, "queue"), current: col === "queue" });
  targets.push({ label: NAMES.done, run: () => moveTicket(n, "done"), current: col === "done" });
  return h(
    "section",
    {},
    h("h3", {}, "Verschieben nach"),
    h("div", { class: "btn-row" }, ...targets.filter((t) => !t.current).map((t) => h("button", { class: "btn", disabled: busy, onclick: t.run }, t.label))),
    busy ? h("p", { class: "muted small" }, "🔒 Wird gerade gebaut") : null,
  );
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && shown !== null && !document.body.classList.contains("is-dragging") && !document.querySelector(".overlay")) closeSidebar();
});
