/**
 * Quick filter above both board modes: the top-level terms of the query (query.ts) as chips – a click switches one
 * off and on, × deletes it –, the text being typed in the input, autocomplete from the cached labels/assignees/stories
 * (Tickets: JIRA labels, assignees, epics), a row of frequent ones plus `drift:` to toggle with one tap, a syntax help
 * and saved filters per project. `/` focuses, Tab completes, Backspace on an empty input drops the last chip, Esc
 * clears.
 */
import { copyText, fill, h } from "../dom";
import { derive } from "../derive";
import { type SuggestSource, type Suggestion, suggest, type Token, tokenText, writeHash } from "../filter";
import { githubOnly, jiraLink } from "../jira";
import { activeTokens as activeOf, canonical, combine, exprText, isOpen, parse, serializeTerms, type Term, tokensOf, typedWord, unfinished } from "../query";
import { hooks, prefGet, prefSet, state, toast } from "../state";
import { ticketFacets, typeIcon } from "../tickets";

let committed: Term[] = [];
let active = 0;
let suggestions: Suggestion[] = [];

const input = h("input", {
  class: "qf-input",
  type: "search",
  placeholder: "Filtern: l:label  @person  s:story  #nr  ODER  -( … )  Text   ( / )",
  "aria-label": "Schnellfilter",
  autocomplete: "off",
  autocapitalize: "off",
  spellcheck: "false",
});
const chipsEl = h("span", { class: "qf-chips" });
const dropdown = h("div", { class: "qf-suggest", role: "listbox", hidden: true });
const quick = h("div", { class: "qf-quick" });
const jiraBtn = h("button", { class: "btn", "aria-label": "JIRA-Link kopieren" }, "JIRA", h("span", { class: "wide-only" }, "-Link"));
const fallback = h("div", { class: "qf-fallback", hidden: true });
const clearBtn = h("button", { class: "qf-clear", title: "Filter leeren", "aria-label": "Filter leeren", hidden: true, onclick: () => clearAll() }, "×");

/** The terms in effect: chips plus whatever is in the input. */
const currentTerms = () => combine(committed, input.value);

/** What the board filters by: like currentTerms, the word under the cursor matching by prefix. */
export const filterTerms = () => combine(committed, input.value, true);

/** Plain tokens standing as switched-on chips (the drift counter and the quick row toggle these). */
export const activeTokens = () => activeOf(currentTerms());

function apply(): void {
  state.query = serializeTerms(currentTerms());
  clearBtn.hidden = !state.query && !input.value;
  prefSet("filter", state.query);
  history.replaceState(null, "", location.pathname + location.search + writeHash(state.query));
  hooks.render();
}

function setCommitted(terms: Term[]): void {
  committed = canonical(terms);
  renderChips();
  apply();
}

/** Typed text → chips; unless forced (Enter), only once groups are closed and no operator dangles. */
function commit(force: boolean): void {
  if (!force && unfinished(input.value)) return;
  committed = combine(committed, input.value);
  input.value = "";
  renderChips();
  closeSuggest();
  apply();
}

/** Sets the whole query (from the hash on start, a saved filter, or the drift counter). */
export function setQuery(q: string): void {
  input.value = "";
  setCommitted(parse(q));
}

const isToken = (text: string) => (t: Term) => t.expr.k === "tok" && tokenText(t.expr.token) === text;

/** A one-tap chip: on → removed; off or missing → switched on at the end. */
export function toggleToken(text: string): void {
  const same = isToken(text);
  const on = committed.some((t) => same(t) && !t.off);
  setCommitted([...committed.filter((t) => !same(t)), ...(on ? [] : parse(text))]);
}

/** A small stroke icon (constant markup only). */
function icon(paths: string): HTMLSpanElement {
  const el = h("span", { class: "qf-ico", "aria-hidden": "true" });
  el.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
  return el;
}
const EYE = '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>';
const EYE_OFF = `${EYE}<path d="M3 3l18 18"/>`;
const TRASH = '<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v6M14 11v6"/>';
const COPY = '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>';

/** A query as someone else should get it: switched-off parts (`~`) stay home. */
function shareable(query: string): { text: string; dropped: number } {
  const terms = parse(query);
  const on = terms.filter((t) => !t.off);
  return { text: serializeTerms(on), dropped: terms.length - on.length };
}

/** Copies a filter; a blocked clipboard shows the text selected for copying by hand (like the JIRA link). */
async function copyFilter(query: string): Promise<void> {
  const { text, dropped } = shareable(query);
  if (!text) return void toast("Kein aktiver Filter zum Kopieren.", "info");
  if (await copyText(text)) {
    fallback.hidden = true;
    toast(`Filter kopiert: ${text}${dropped ? ` (${dropped} ausgeschaltete${dropped === 1 ? "r Teil" : " Teile"} nicht dabei)` : ""}`, "info");
    return;
  }
  const field = h("input", { class: "grow mono", readonly: true, value: text });
  fill(fallback, field, h("button", { class: "btn", onclick: () => { fallback.hidden = true; } }, "Schließen"));
  fallback.hidden = false;
  field.select();
}

function renderChips(): void {
  const all = committed.length > 1 ? committed.some((t) => !t.off) : null;
  fill(
    chipsEl,
    ...committed.map((t, i) => {
      const text = exprText(t.expr);
      const broken = isOpen(t.expr);
      const kind = t.expr.k === "tok" ? t.expr.token.kind : "expr";
      // a negated group or term: the minus in red, as the -l: chips are red
      const neg = t.expr.k === "not";
      return h(
        "span",
        { class: `chip qf-chip k-${kind}${t.off ? " is-off" : ""}${broken ? " broken" : ""}`, title: broken ? "Klammer fehlt" : undefined },
        h(
          "button",
          {
            class: "qf-chip-t",
            "aria-pressed": t.off ? "false" : "true",
            "aria-label": `Filter ${text}: ${t.off ? "ausgeschaltet, einschalten" : "eingeschaltet, ausschalten"}`,
            title: broken ? "Klammer fehlt" : t.off ? "Ausgeschaltet – klicken zum Einschalten" : "Klicken zum Ausschalten",
            onclick: (e: Event) => {
              e.stopPropagation();
              setCommitted(committed.map((x, j) => (j === i ? { ...x, off: !x.off } : x)));
            },
          },
          t.off ? icon(EYE_OFF) : null,
          neg ? h("span", { class: "qf-neg" }, "-") : null,
          h("span", { class: "qf-chip-text" }, neg ? text.slice(1) : text),
        ),
        h(
          "button",
          {
            class: "chip-x",
            "aria-label": `${text} entfernen`,
            onclick: (e: Event) => {
              // the box used to be a <label>: its activation clicked the first chip's × as well
              e.preventDefault();
              e.stopPropagation();
              setCommitted(committed.filter((_, j) => j !== i));
              input.focus();
            },
          },
          "×",
        ),
      );
    }),
    all === null
      ? null
      : h(
          "button",
          { class: "qf-all", onclick: () => setCommitted(committed.map((t) => ({ ...t, off: all }))) },
          icon(all ? EYE_OFF : EYE),
          all ? "Alle aus" : "Alle an",
        ),
  );
  renderQuick();
}

function clearAll(): void {
  input.value = "";
  closeSuggest();
  setCommitted([]);
}

/** Suggestions and the one-tap row of the mode on show: Tickets → JIRA, Werkbank → GitHub. */
function source(): (SuggestSource & { quick: string[]; typeCounts?: [string, number][] }) | null {
  const top = (m: Map<string, number>, n: number) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k);
  const drift = state.jira?.counts.drift ? ["drift:"] : [];
  if (state.mode === "tickets") {
    const j = state.jira;
    if (!j) return null;
    const f = ticketFacets(j.tickets);
    return {
      labels: [...f.labels.keys()].sort((a, b) => a.localeCompare(b, "de")),
      assignees: [...f.assignees].map(([login, a]) => ({ login, name: a.name })),
      stories: [...f.epics].map(([key, summary]) => ({ number: key, title: summary })),
      types: [...f.types.keys()],
      statuses: j.statuses.map((s) => s.name.replace(/^[^\p{L}\p{N}]+/u, "").trim()),
      versions: [
        ...new Set(
          j.tickets
            .flatMap((t) => (t.released?.version ? [{ v: t.released.version, at: t.released.at }] : []))
            .sort((a, b) => b.at.localeCompare(a.at))
            .map((r) => r.v),
        ),
      ],
      typeCounts: [...f.types].sort((a, b) => typeRank(a[0]) - typeRank(b[0]) || a[0].localeCompare(b[0], "de")),
      quick: [
        ...drift,
        ...top(f.labels, 7).map((l) => tokenText({ kind: "label", value: l })),
        ...top(new Map([...f.assignees].map(([login, a]) => [login, a.count])), 4).map((u) => `@${u}`),
      ],
    };
  }
  const b = state.board;
  const p = derive().project;
  if (!b || !p) return null;
  const hidden = new Set([p.labels.queue, p.labels.story, p.labels.grill]);
  const labelCount = new Map<string, number>();
  const userCount = new Map<string, number>();
  for (const i of b.issues) {
    if (i.state !== "open") continue;
    for (const l of i.labels) if (!hidden.has(l)) labelCount.set(l, (labelCount.get(l) ?? 0) + 1);
    for (const a of i.assignees) userCount.set(a, (userCount.get(a) ?? 0) + 1);
  }
  return {
    labels: b.labels.map((l) => l.name).filter((l) => !hidden.has(l)),
    assignees: b.assignees,
    stories: b.stories,
    quick: [
      ...drift,
      ...(b.viewer ? ["@ich"] : []),
      ...top(labelCount, 7).map((l) => tokenText({ kind: "label", value: l })),
      ...top(userCount, 4).map((u) => `@${u}`),
    ],
  };
}

function openSuggest(): void {
  const src = source();
  // a token already in the filter (any chip, on or off, also inside a group; any case) is no suggestion
  const taken = new Set(committed.flatMap((t) => tokensOf(t.expr)).map((t) => tokenText(t).toLowerCase()));
  suggestions = src ? suggest(typedWord(input.value).word, src, 20).filter((s) => !taken.has(s.text.toLowerCase())).slice(0, 8) : [];
  active = 0;
  dropdown.hidden = !suggestions.length;
  fill(
    dropdown,
    ...suggestions.map((s, i) =>
      h(
        "button",
        {
          class: `qf-opt${i === active ? " active" : ""}`,
          role: "option",
          // mousedown, not click: the input must not lose focus first
          onmousedown: (e: Event) => {
            e.preventDefault();
            take(s);
          },
        },
        h("span", { class: "mono" }, s.text),
        s.hint ? h("span", { class: "muted" }, s.hint) : null,
      ),
    ),
  );
}

function closeSuggest(): void {
  suggestions = [];
  dropdown.hidden = true;
}

/** Replaces the word being typed; inside an open group the text stays in the input until the group is closed. */
function take(s: Suggestion): void {
  input.value = `${input.value.slice(0, typedWord(input.value).start)}${s.text} `;
  if (unfinished(input.value)) {
    closeSuggest();
    apply();
  } else commit(false);
  input.focus();
}

input.addEventListener("input", () => {
  // a finished word (space typed) becomes a chip – an open group or a dangling operator waits for more
  if (/\s$/.test(input.value) && input.value.trim() && !unfinished(input.value)) commit(false);
  else {
    openSuggest();
    apply();
  }
});
// pasting a whole filter (from „Filter kopieren“ or a colleague) turns it into chips at once
input.addEventListener("paste", (e) => {
  const text = e.clipboardData?.getData("text/plain")?.trim();
  if (!text || !/\s|[()|]/.test(text)) return;
  e.preventDefault();
  input.value = `${input.value}${input.value && !/\s$/.test(input.value) ? " " : ""}${text}`;
  if (!unfinished(input.value)) commit(false);
  else apply();
});
input.addEventListener("keydown", (e) => {
  if (e.key === "Tab" && suggestions.length) {
    e.preventDefault();
    const s = suggestions[active];
    if (s) take(s);
  } else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && suggestions.length) {
    e.preventDefault();
    active = (active + (e.key === "ArrowDown" ? 1 : suggestions.length - 1)) % suggestions.length;
    dropdown.querySelectorAll(".qf-opt").forEach((o, i) => {
      o.classList.toggle("active", i === active);
    });
  } else if (e.key === "Enter") {
    e.preventDefault();
    const s = suggestions[active];
    if (s && suggestions.length) take(s);
    else commit(true);
  } else if (e.key === "Backspace" && !input.value && committed.length) {
    setCommitted(committed.slice(0, -1));
  } else if (e.key === "Escape") {
    e.stopPropagation();
    clearAll();
    input.blur();
  }
});
input.addEventListener("blur", () => setTimeout(closeSuggest, 100));
input.addEventListener("focus", openSuggest);
document.addEventListener("keydown", (e) => {
  const t = e.target as HTMLElement;
  if (e.key === "/" && state.view === "board" && !/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) && !t.isContentEditable) {
    e.preventDefault();
    input.focus();
  }
});

/** Epic → Story → Task → Bug → Sub-Task, other types after them. */
const TYPE_ORDER = ["epic", "story", "task", "bug", "sub-task", "subtask", "unteraufgabe"];
const typeRank = (type: string) => {
  const i = TYPE_ORDER.indexOf(type.toLowerCase());
  return i < 0 ? TYPE_ORDER.length : i;
};

/**
 * Frequent labels and assignees of the open tickets, for one-tap toggles on touch; in Tickets the type group first.
 * Active = a switched-on top-level chip; the same token inside a group doesn't count.
 */
function renderQuick(): void {
  const src = source();
  const opts = src?.quick ?? [];
  const tokens = activeOf(committed);
  const on = new Set(tokens.map(tokenText));
  const types = src?.typeCounts ?? [];
  const anyType = tokens.some((t) => t.kind === "type" || t.kind === "notype");
  const typeGroup = types.length
    ? [
        h("span", { class: "qf-group" }, "Typ"),
        h("button", { class: `qchip${anyType ? "" : " on"}`, title: "Alle Typen", onclick: () => clearTypes() }, "Alle"),
        ...types.map(([type, n]) => {
          const only = on.has(tokenText({ kind: "type", value: type }));
          const hidden = on.has(tokenText({ kind: "notype", value: type }));
          const title = only ? `nur ${type} – Klick: ${type} ausblenden` : hidden ? `${type} ausgeblendet – Klick: wieder zeigen` : `Klick: nur ${type} (mehrere möglich)`;
          return h("button", { class: `qchip${only ? " on" : hidden ? " off" : ""}`, title, "aria-pressed": only ? "true" : hidden ? "mixed" : "false", onclick: () => cycleType(type) }, `${typeIcon(type)} ${type} `, h("span", { class: "qf-count" }, String(n)));
        }),
        h("span", { class: "qf-sep", "aria-hidden": "true" }),
      ]
    : [];
  fill(quick, ...typeGroup, ...opts.map((o) => h("button", { class: `qchip${on.has(o) ? " on" : ""}`, title: o, onclick: () => toggleToken(o) }, o.replace(/^l:"?|"$/g, ""))));
}

const typeTerm = (type?: string) => (t: Term) =>
  t.expr.k === "tok" && (t.expr.token.kind === "type" || t.expr.token.kind === "notype") && (!type || t.expr.token.value.toLowerCase() === type.toLowerCase());

/** „Alle“: drops the switched-on type chips; switched-off ones stay for later. */
function clearTypes(): void {
  const isType = typeTerm();
  setCommitted(committed.filter((t) => t.off || !isType(t)));
}

/** A type chip cycles: off → only this type (t:) → hide this type (-t:) → off. */
function cycleType(type: string): void {
  const same = typeTerm(type);
  const cur = committed.find((t) => same(t) && !t.off);
  const kind = cur?.expr.k === "tok" ? cur.expr.token.kind : null;
  const rest = committed.filter((t) => !same(t));
  const next: Token | null = kind === "type" ? { kind: "notype", value: type } : kind === "notype" ? null : { kind: "type", value: type };
  setCommitted(next ? [...rest, { expr: { k: "tok", token: next }, off: false }] : rest);
}

// ---- popovers: syntax help and saved filters

let openPop: { pop: HTMLElement; anchor: HTMLElement } | null = null;

function closePop(): void {
  if (!openPop) return;
  openPop.pop.hidden = true;
  openPop.anchor.setAttribute("aria-expanded", "false");
  openPop = null;
}

function togglePop(pop: HTMLElement, anchor: HTMLElement): void {
  const was = openPop?.pop === pop;
  closePop();
  if (was) return;
  pop.hidden = false;
  anchor.setAttribute("aria-expanded", "true");
  openPop = { pop, anchor };
}

document.addEventListener("pointerdown", (e) => {
  const t = e.target as Node;
  if (openPop && !openPop.pop.contains(t) && !openPop.anchor.contains(t)) closePop();
});
// capture phase: Esc closes the popover only – not the filter input's clear-all, not the sidebar
window.addEventListener(
  "keydown",
  (e) => {
    if (e.key !== "Escape" || !openPop) return;
    e.stopPropagation();
    if (naming && openPop.pop.contains(e.target as Node)) {
      naming = false;
      renderSaved();
      savedBtn.focus();
      return;
    }
    const { anchor } = openPop;
    closePop();
    anchor.focus();
  },
  true,
);

const SYNTAX: [string, string][] = [
  ["l:name", "Label, mit * und ? als Platzhalter (l:patrick-*)"],
  ["-l:name", "Label ausschließen"],
  ["@name", "Bearbeiter (@ich = du)"],
  ["s:600", "Story, per Nummer oder Titel"],
  ["t:Story", "Vorgangstyp, -t:Epic schließt aus"],
  ["z:Done", "Zustand (ohne Emoji) – z:offen, z:arbeit, z:fertig für die Gruppe"],
  ["sc:", "Sandcastle arbeitet gerade daran (sc:eingereiht: auch wartend)"],
  ["pr:gemergt", "Pull Request: gemergt (nur Bau-PRs, Doku-PRs zählen nicht), offen, entwurf, rot (CI), keiner"],
  ["live:", "In einem Release ausgeliefert (live:v2.0* nach Version, -live: noch nicht)"],
  ["main:", "Arbeit ist in main, auch ausgeliefert (main:teilweise: nur teilweise, -main: nicht in main)"],
  ["#612", "Ticketnummer"],
  ["drift:", "Nur Tickets mit Abweichung (drift:done: JIRA Done, aber nicht in main)"],
  ["( )", "Gruppieren"],
  ["ODER  |", "oder – Leerzeichen bedeutet UND"],
  ["NICHT  -", "verneint Begriff oder Gruppe"],
];
const EXAMPLES = ["-(l:patrick-*)", "(l:shop ODER l:kasse) -t:Epic", "z:Done -sc: -(l:patrick-*)"];

const helpPop = h(
  "div",
  { class: "qf-pop qf-help-pop", role: "dialog", "aria-label": "Filtersyntax", hidden: true },
  h("div", { class: "qf-pop-head" }, "Filtersyntax"),
  h("dl", { class: "qf-syntax" }, ...SYNTAX.flatMap(([key, text]) => [h("dt", { class: "mono" }, key), h("dd", {}, text)])),
  h("div", { class: "qf-pop-title" }, "Beispiele"),
  ...EXAMPLES.map((ex) =>
    h(
      "button",
      {
        class: "qf-example mono",
        title: "Als Filter setzen",
        onclick: () => {
          setQuery(ex);
          closePop();
        },
      },
      ex,
    ),
  ),
  h("p", { class: "muted qf-pop-note" }, "Chip anklicken schaltet ihn aus und wieder an, × löscht ihn."),
);
const helpBtn = h("button", { class: "qf-help", title: "Filtersyntax", "aria-label": "Filtersyntax", "aria-haspopup": "dialog", "aria-expanded": "false" }, "?");
helpBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  togglePop(helpPop, helpBtn);
});

interface SavedFilter {
  name: string;
  query: string;
}

const savedAll = () => prefGet<Record<string, SavedFilter[]>>("savedFilters") ?? {};
const savedList = () => savedAll()[state.slug] ?? [];

function storeSaved(list: SavedFilter[]): void {
  prefSet("savedFilters", { ...savedAll(), [state.slug]: list });
}

const savedBtn = h("button", { class: "btn", "aria-haspopup": "menu", "aria-expanded": "false", title: "Gespeicherte Filter" }, "Filter ▾");
const savedPop = h("div", { class: "qf-pop qf-saved", role: "menu", "aria-label": "Gespeicherte Filter", hidden: true });
let naming = false;

function renderSaved(): void {
  const list = savedList();
  const query = state.query;
  let head: HTMLElement;
  if (naming) {
    const name = h("input", { class: "grow", placeholder: "Name", "aria-label": "Name des Filters", maxlength: 60 });
    const save = () => {
      const n = name.value.trim();
      if (!n) return name.focus();
      storeSaved([...list.filter((f) => f.name.toLowerCase() !== n.toLowerCase()), { name: n, query }]);
      naming = false;
      renderSaved();
      toast(`Filter „${n}“ gespeichert`, "info");
    };
    name.addEventListener("keydown", (e) => {
      if (e.key === "Enter") save();
    });
    head = h(
      "div",
      { class: "qf-saved-name" },
      name,
      h("button", { class: "btn small primary", onclick: save }, "Speichern"),
      h("button", { class: "btn small ghost", onclick: () => { naming = false; renderSaved(); } }, "Abbrechen"),
    );
    queueMicrotask(() => name.focus());
  } else
    head = h(
      "button",
      {
        class: "qf-item",
        role: "menuitem",
        disabled: !query || !state.slug,
        title: query ? query : "Erst einen Filter eingeben",
        onclick: () => {
          naming = true;
          renderSaved();
        },
      },
      "Aktuellen Filter speichern …",
    );
  const copyCurrent = h(
    "button",
    {
      class: "qf-item",
      role: "menuitem",
      disabled: !shareable(query).text,
      title: "Den aktiven Filter als Text kopieren – zum Teilen oder Einfügen ins Filterfeld",
      onclick: () => {
        copyFilter(query);
        closePop();
      },
    },
    "Aktuellen Filter kopieren",
  );
  fill(
    savedPop,
    head,
    naming ? null : copyCurrent,
    h("div", { class: "qf-pop-title" }, "Gespeicherte Filter"),
    list.length ? null : h("p", { class: "muted qf-pop-note" }, "Noch keine gespeicherten Filter."),
    ...list.map((f) =>
      h(
        "div",
        { class: `qf-saved-row${f.query === query ? " on" : ""}` },
        h(
          "button",
          {
            class: "qf-item",
            role: "menuitem",
            title: f.query,
            onclick: () => {
              setQuery(f.query);
              closePop();
            },
          },
          h("span", {}, f.name),
          h("span", { class: "muted mono" }, f.query),
        ),
        h("button", { class: "qf-trash", "aria-label": `${f.name} kopieren`, title: "Kopieren", onclick: () => copyFilter(f.query) }, icon(COPY)),
        h("button", { class: "qf-trash", "aria-label": `${f.name} löschen`, title: "Löschen", onclick: () => { storeSaved(list.filter((x) => x !== f)); renderSaved(); } }, icon(TRASH)),
      ),
    ),
  );
}

savedBtn.addEventListener("click", () => {
  naming = false;
  renderSaved();
  togglePop(savedPop, savedBtn);
});

async function copyJira(visibleKeys: (string | null)[], visibleCount: number): Promise<void> {
  const p = derive().project;
  if (!p?.jira.baseUrl) return;
  const link = jiraLink(p.jira, visibleKeys);
  if (!link) {
    toast("Keines der sichtbaren Tickets hat einen JIRA-Schlüssel.", "info");
    return;
  }
  const missing = visibleCount - link.keys.length;
  // in Tickets labels and assignees are JIRA's own: nothing is filtered on GitHub only
  const used = currentTerms().flatMap((t) => (t.off ? [] : tokensOf(t.expr)));
  const gh = state.mode === "tickets" ? [] : githubOnly(used).map(tokenText);
  const extra = [
    missing > 0 ? `${missing} ohne JIRA-Schlüssel fehlen` : "",
    gh.length ? `nur in GitHub gefiltert: ${gh.join(" ")}` : "",
  ].filter(Boolean);
  const msg = `Link kopiert – ${link.keys.length} ${link.keys.length === 1 ? "Ticket" : "Tickets"}${extra.length ? ` (${extra.join("; ")})` : ""}`;
  if (await copyText(link.url)) {
    fallback.hidden = true;
    toast(msg, "info");
  } else {
    // no clipboard at all: show the link selected for manual copying
    const field = h("input", { class: "grow mono", readonly: true, value: link.url });
    fill(fallback, field, h("button", { class: "btn", onclick: () => { fallback.hidden = true; } }, "Schließen"));
    fallback.hidden = false;
    field.select();
  }
}

/** Built once; `update` refreshes chips, quick row and the JIRA button after every render. */
export function filterBar(getVisible: () => { keys: (string | null)[]; count: number }, extra: HTMLElement[]) {
  jiraBtn.addEventListener("click", () => {
    const v = getVisible();
    copyJira(v.keys, v.count);
  });
  const el = h(
    "div",
    { class: "qf" },
    h(
      "div",
      { class: "qf-row" },
      // a <div>, not a <label>: a label forwards clicks to its first button – the first chip's × (and suggestions)
      h(
        "div",
        { class: "qf-box", onclick: (e: Event) => { if (!(e.target as Element).closest("button, .qf-pop")) input.focus(); } },
        h("span", { class: "qf-icon", "aria-hidden": "true" }, "⌕"),
        chipsEl,
        input,
        clearBtn,
        helpBtn,
        dropdown,
        helpPop,
      ),
      h("div", { class: "qf-menu" }, savedBtn, savedPop),
      jiraBtn,
      ...extra,
    ),
    quick,
    fallback,
  );
  return {
    el,
    update() {
      const p = derive().project;
      jiraBtn.disabled = !p?.jira.baseUrl;
      jiraBtn.title = p?.jira.baseUrl ? "JQL mit den JIRA-Schlüsseln aller sichtbaren Tickets kopieren" : "Für dieses Projekt ist keine JIRA-Adresse eingerichtet";
      renderQuick();
    },
  };
}
