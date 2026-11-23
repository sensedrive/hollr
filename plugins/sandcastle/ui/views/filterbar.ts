/**
 * Quick filter above the board: committed tokens as chips, the word being typed in the input, autocomplete from
 * the cached labels/assignees/stories, and a row of frequent labels/assignees to toggle with one tap.
 * `/` focuses, Tab completes, Backspace on an empty input drops the last chip, Esc clears.
 */
import { copyText, fill, h } from "../dom";
import { derive } from "../derive";
import { type Suggestion, serialize, suggest, type Token, tokenize, tokenText, writeHash } from "../filter";
import { githubOnly, jiraLink } from "../jira";
import { hooks, prefSet, state, toast } from "../state";

let committed: Token[] = [];
let active = 0;
let suggestions: Suggestion[] = [];

const input = h("input", {
  class: "qf-input",
  type: "search",
  placeholder: "Filtern: l:label  @person  s:story  #nr  Text …   ( / )",
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

/** The tokens in effect: chips plus whatever is in the input. */
export const currentTokens = () => [...committed, ...tokenize(input.value)];

/** What the board filters by: like currentTokens, the word under the cursor matching by prefix. */
export function filterTokens(): Token[] {
  const typed = tokenize(input.value);
  const last = typed[typed.length - 1];
  if (last) typed[typed.length - 1] = { ...last, partial: true };
  return [...committed, ...typed];
}

function apply(): void {
  state.query = serialize(currentTokens());
  prefSet("filter", state.query);
  history.replaceState(null, "", location.pathname + location.search + writeHash(state.query));
  hooks.render();
}

function commit(): void {
  committed = [...committed, ...tokenize(input.value)];
  input.value = "";
  renderChips();
  closeSuggest();
  apply();
}

/** Sets the whole query (from the hash on start, or a quick-chip toggle). */
export function setQuery(q: string): void {
  committed = tokenize(q);
  input.value = "";
  renderChips();
  apply();
}

function toggle(text: string): void {
  const has = committed.some((t) => tokenText(t) === text);
  committed = has ? committed.filter((t) => tokenText(t) !== text) : [...committed, ...tokenize(text)];
  renderChips();
  apply();
}

function renderChips(): void {
  fill(
    chipsEl,
    ...committed.map((t, i) =>
      h(
        "span",
        { class: `chip qf-chip k-${t.kind}` },
        tokenText(t),
        h(
          "button",
          {
            class: "chip-x",
            "aria-label": `${tokenText(t)} entfernen`,
            onclick: () => {
              committed = committed.filter((_, j) => j !== i);
              renderChips();
              apply();
            },
          },
          "×",
        ),
      ),
    ),
  );
  renderQuick();
}

function lastWord(): string {
  return input.value.match(/(\S*)$/)?.[1] ?? "";
}

function openSuggest(): void {
  const b = state.board;
  const p = derive().project;
  const hidden = new Set([p?.labels.queue, p?.labels.story, p?.labels.grill]);
  suggestions = b
    ? suggest(lastWord(), {
        labels: b.labels.map((l) => l.name).filter((l) => !hidden.has(l)),
        assignees: b.assignees,
        stories: b.stories,
      })
    : [];
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

function take(s: Suggestion): void {
  input.value = `${input.value.slice(0, input.value.length - lastWord().length)}${s.text}`;
  commit();
  input.focus();
}

input.addEventListener("input", () => {
  // a finished word (space typed) becomes a chip
  if (/\s$/.test(input.value) && input.value.trim() && !/"[^"]*$/.test(input.value)) commit();
  else {
    openSuggest();
    apply();
  }
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
    else commit();
  } else if (e.key === "Backspace" && !input.value && committed.length) {
    committed = committed.slice(0, -1);
    renderChips();
    apply();
  } else if (e.key === "Escape") {
    e.stopPropagation();
    committed = [];
    input.value = "";
    renderChips();
    closeSuggest();
    apply();
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

/** Frequent labels and assignees of the open tickets, for one-tap toggles on touch. */
function renderQuick(): void {
  const b = state.board;
  const p = derive().project;
  if (!b || !p) {
    fill(quick);
    return;
  }
  const hidden = new Set([p.labels.queue, p.labels.story, p.labels.grill]);
  const labelCount = new Map<string, number>();
  const userCount = new Map<string, number>();
  for (const i of b.issues) {
    if (i.state !== "open") continue;
    for (const l of i.labels) if (!hidden.has(l)) labelCount.set(l, (labelCount.get(l) ?? 0) + 1);
    for (const a of i.assignees) userCount.set(a, (userCount.get(a) ?? 0) + 1);
  }
  const top = (m: Map<string, number>, n: number) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k);
  const opts = [
    ...(b.viewer ? ["@ich"] : []),
    ...top(labelCount, 7).map((l) => tokenText({ kind: "label", value: l })),
    ...top(userCount, 4).map((u) => `@${u}`),
  ];
  const on = new Set(committed.map(tokenText));
  fill(quick, ...opts.map((o) => h("button", { class: `qchip${on.has(o) ? " on" : ""}`, title: o, onclick: () => toggle(o) }, o.replace(/^l:"?|"$/g, ""))));
}

async function copyJira(visibleKeys: (string | null)[], visibleCount: number): Promise<void> {
  const p = derive().project;
  if (!p?.jira.baseUrl) return;
  const link = jiraLink(p.jira, visibleKeys);
  if (!link) {
    toast("Keines der sichtbaren Tickets hat einen JIRA-Schlüssel.", "info");
    return;
  }
  const missing = visibleCount - link.keys.length;
  const gh = githubOnly(currentTokens()).map(tokenText);
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
    h("div", { class: "qf-row" }, h("label", { class: "qf-box" }, h("span", { class: "qf-icon", "aria-hidden": "true" }, "⌕"), chipsEl, input, dropdown), jiraBtn, ...extra),
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
