<script lang="ts">
  // The chat's find bar (⌘F): search the loaded chat, all hits highlighted, the current one stronger, ↑/↓ (Enter /
  // ⇧Enter, ⌘G / ⇧⌘G) walk them. The data (chatFind.ts) says which items may hold a hit and which folded cards to
  // open; their rendered text is what is counted and highlighted – via the CSS Custom Highlight API, so Svelte's
  // text nodes stay untouched (wrapping hits in <mark> would split the nodes Svelte updates); webviews without it
  // get boxes drawn over the hits instead.
  import { tick } from "svelte";
  import { matcher, matchSpans, unitHits, type FindScope, type FindUnit } from "../../chatFind";
  import { t } from "../../i18n";

  let { scroller, root, marks, units, reveal = $bindable(), matches = $bindable(), current = $bindable(), onFinding }: {
    scroller: HTMLElement;
    /** the chat's item list (TimelineView's `.tl`): items are its children with `data-find` */
    root: HTMLElement;
    /** a layer in `root` for the fallback boxes */
    marks: HTMLElement;
    units: FindUnit[];
    /** unit keys forced open (folded cards with a hit) */
    reveal: Set<string>;
    /** the hits in document order */
    matches: Range[];
    current: number;
    /** the bar opened / closed (the host stops sticking to the bottom meanwhile) */
    onFinding?: (open: boolean) => void;
  } = $props();

  /** more hits are not collected – the count shows "5000+" */
  const MAX = 5000;
  /** text in these isn't chat content (times, line numbers, buttons, tree lines) */
  const SKIP = ".stamp, .acts, .codebar, .no, .tree, .sign, .more, .th-head, [aria-hidden='true'], button:not(.thinking)";
  /** text nodes under one of these join into one searchable run (code split into highlight spans still matches) */
  const BLOCK = "p, li, pre, td, th, h1, h2, h3, h4, h5, h6, blockquote, div, button";
  /** the bar floats over the chat's top: a hit under it counts as hidden */
  const TOP_MARGIN = 56;
  const highlights = typeof CSS !== "undefined" && "highlights" in CSS ? CSS.highlights : undefined;
  const mod = navigator.platform.includes("Mac") ? "⌘" : "Ctrl+";

  let isOpen = $state(false);
  let query = $state("");
  /** the query searched – `query` a moment later, so typing doesn't search every keystroke in a long chat */
  let q = $state("");
  let caseSensitive = $state(false);
  let scope = $state<FindScope>("all");
  let input: HTMLInputElement | undefined = $state();
  let bar: HTMLDivElement | undefined = $state();
  /** which item each match is in (to keep the current one when the chat changes) */
  let owners: string[] = [];
  /** after closing: the current hit's cards stay open, so the chat doesn't fold away under you */
  let kept = $state.raw(new Set<string>());

  $effect(() => {
    const v = query;
    const id = setTimeout(() => (q = v), v ? 120 : 0);
    return () => clearTimeout(id);
  });

  const hits = $derived(isOpen && q ? unitHits(units, q, { caseSensitive, scope }) : undefined);
  $effect(() => {
    reveal = hits?.reveal ?? kept;
  });

  // ---- collecting the hits from the rendered chat

  /** Every hit of `re` in `el`'s visible text, in document order. */
  function rangesIn(el: HTMLElement, re: RegExp, out: Range[], owner: string) {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.parentElement?.closest(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    let nodes: Text[] = [];
    let starts: number[] = [];
    let text = "";
    let block: Element | null = null;
    const flush = () => {
      let i = 0;
      for (const [s, e] of matchSpans(text, re)) {
        if (out.length >= MAX) break;
        while (i + 1 < nodes.length && starts[i + 1]! <= s) i++;
        let j = i;
        while (j + 1 < nodes.length && starts[j + 1]! < e) j++;
        const r = document.createRange();
        r.setStart(nodes[i]!, s - starts[i]!);
        r.setEnd(nodes[j]!, e - starts[j]!);
        out.push(r);
        owners.push(owner);
      }
      nodes = [];
      starts = [];
      text = "";
    };
    for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
      const b = n.parentElement?.closest(BLOCK) ?? null;
      if (b !== block) {
        flush();
        block = b;
      }
      starts.push(text.length);
      nodes.push(n);
      text += n.data;
    }
    flush();
  }

  /** Collects the hits; `fresh` (a new query) picks the first one from the top of the view, else the current
   *  hit stays the same one (new messages, a card toggled). */
  function collect(re: RegExp, items: Set<string>, fresh: boolean) {
    const was = current >= 0 ? { owner: owners[current], nth: current - owners.indexOf(owners[current]!) } : undefined;
    const byId = new Map<string, HTMLElement>();
    for (const el of root.children) if (el instanceof HTMLElement && el.dataset.find) byId.set(el.dataset.find, el);
    const found: Range[] = [];
    owners = [];
    for (const id of items) {
      const el = byId.get(id);
      if (el) rangesIn(el, re, found, id);
      if (found.length >= MAX) break;
    }
    matches = found;
    if (!found.length) current = -1;
    else if (fresh) {
      current = firstFromTop(found);
      paint();
      bring(found[current]!);
      return;
    } else if (was) {
      const first = owners.indexOf(was.owner!);
      current = first < 0 ? Math.min(current, found.length - 1) : Math.min(first + was.nth, owners.lastIndexOf(was.owner!));
    } else current = 0;
    paint();
  }

  /** The first hit at or below the view's top (binary search – hits are in document order). */
  function firstFromTop(found: Range[]): number {
    const top = scroller.getBoundingClientRect().top + TOP_MARGIN;
    let lo = 0;
    let hi = found.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (found[mid]!.getBoundingClientRect().bottom < top) lo = mid + 1;
      else hi = mid;
    }
    return lo < found.length ? lo : 0;
  }

  let lastKey = "";
  $effect(() => {
    if (!hits) {
      matches = [];
      current = -1;
      owners = [];
      clearPaint();
      return;
    }
    const re = matcher(q, caseSensitive)!;
    const items = hits.items;
    // the same search again = the chat changed under it, not a new query: no jump
    const key = `${q}\u0000${caseSensitive}\u0000${scope}`;
    const fresh = key !== lastKey;
    lastKey = key;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // the cards opened for this query render first
    void tick().then(() => !stopped && collect(re, items, fresh));
    // streamed messages, a card folded by hand: collect again (not our own fallback boxes)
    const mo = new MutationObserver((recs) => {
      if (recs.every((r) => marks.contains(r.target))) return;
      clearTimeout(timer);
      timer = setTimeout(() => collect(re, items, false), 150);
    });
    mo.observe(root, { childList: true, subtree: true, characterData: true });
    return () => {
      stopped = true;
      clearTimeout(timer);
      mo.disconnect();
    };
  });

  // ---- painting

  function clearPaint() {
    highlights?.delete("chat-find");
    highlights?.delete("chat-find-current");
    marks.replaceChildren();
  }

  function paint() {
    if (highlights) {
      const all = new Highlight();
      for (const r of matches) all.add(r);
      highlights.set("chat-find", all);
      const cur = matches[current];
      if (cur) highlights.set("chat-find-current", new Highlight(cur));
      else highlights.delete("chat-find-current");
      return;
    }
    // no Highlight API: boxes over the hits in a layer that scrolls with the chat
    const base = root.getBoundingClientRect();
    const boxes: HTMLElement[] = [];
    matches.forEach((r, i) => {
      for (const rect of r.getClientRects()) {
        const b = document.createElement("div");
        if (i === current) b.className = "cur";
        b.style.cssText = `left:${rect.left - base.left}px;top:${rect.top - base.top}px;width:${rect.width}px;height:${rect.height}px`;
        boxes.push(b);
      }
    });
    marks.replaceChildren(...boxes);
  }

  // the fallback boxes follow the layout (window width, images loading)
  $effect(() => {
    if (highlights || !hits) return;
    const ro = new ResizeObserver(() => paint());
    ro.observe(root);
    return () => ro.disconnect();
  });

  // ---- navigating

  /** Scrolls a hit into view (a third from the top) unless it is already there. */
  function bring(r: Range) {
    const rect = r.getBoundingClientRect();
    const box = scroller.getBoundingClientRect();
    if (rect.top >= box.top + TOP_MARGIN && rect.bottom <= box.bottom - 24) return;
    const top = scroller.scrollTop + rect.top - box.top - scroller.clientHeight / 3;
    scroller.scrollTo({ top, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }

  /** Makes hit `i` the current one and shows it (also the ruler's marker clicks). */
  export function show(i: number) {
    const r = matches[i];
    if (!r) return;
    current = i;
    paint();
    bring(r);
  }

  function step(by: 1 | -1) {
    if (!matches.length) return;
    show((current + by + matches.length) % matches.length);
  }

  /** Opens the bar (⌘F, the ⋯ menu); a short selection in the chat becomes the query. */
  export async function open() {
    const sel = window.getSelection();
    const picked = sel && !sel.isCollapsed && root.contains(sel.anchorNode) ? sel.toString().trim() : "";
    if (picked && picked.length <= 200 && !picked.includes("\n")) query = picked;
    if (!isOpen) {
      isOpen = true;
      onFinding?.(true);
    }
    await tick();
    input?.focus();
    input?.select();
  }

  function close() {
    // the current hit's cards stay open and its item where it is on screen – the rest folds back
    const item = owners[current];
    kept = new Set(item && hits ? units.filter((u) => u.item === item && hits.reveal.has(u.key)).map((u) => u.key) : []);
    const el = item ? [...root.children].find((c) => c instanceof HTMLElement && c.dataset.find === item) : undefined;
    const before = el?.getBoundingClientRect().top;
    isOpen = false;
    onFinding?.(false);
    void tick().then(() => {
      if (el && before !== undefined && el.isConnected) scroller.scrollTop += el.getBoundingClientRect().top - before;
    });
  }

  function onKey(e: KeyboardEvent) {
    const m = e.metaKey || e.ctrlKey;
    if (m && !e.altKey && !e.shiftKey && e.code === "KeyF") {
      // a dialog (model picker …) has its own search field
      if (document.querySelector('[role="dialog"]')) return;
      e.preventDefault();
      e.stopPropagation();
      void open();
    } else if (m && !e.altKey && e.code === "KeyG" && (isOpen || (!e.shiftKey && query))) {
      // ⇧⌘G is the Git panel while the bar is closed
      e.preventDefault();
      e.stopPropagation();
      if (!isOpen) void open();
      step(e.shiftKey ? -1 : 1);
    } else if (e.key === "Escape" && isOpen) {
      // from the bar or the chat – not from the composer, whose Esc is its own
      const a = document.activeElement;
      if (a && a !== document.body && !bar?.contains(a) && !scroller.contains(a)) return;
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  }
  // capture: before the session view's shortcuts (⇧⌘G Git panel, Esc leaves zen)
  $effect(() => {
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });
  $effect(() => () => {
    clearPaint();
    if (isOpen) onFinding?.(false);
  });

  const SCOPES: Record<FindScope, { label: string; title: string }> = {
    all: { label: "Alle", title: "Sucht im ganzen Chat" },
    user: { label: "Meine", title: "Sucht nur in deinen Nachrichten" },
    agent: { label: "Antworten", title: "Sucht nur in den Antworten des Agents" },
  };
  const NEXT: Record<FindScope, FindScope> = { all: "user", user: "agent", agent: "all" };
</script>

{#if isOpen}
  <div class="find" bind:this={bar} role="search">
    <input bind:this={input} bind:value={query} placeholder={t("Im Chat suchen")} spellcheck="false" aria-label={t("Im Chat suchen")}
      onkeydown={(e) => { if (e.key === "Enter") { e.preventDefault(); step(e.shiftKey ? -1 : 1); } }} />
    <span class="count" class:none={!!q && !matches.length}>
      {#if !q}&nbsp;{:else if !matches.length}{t("Keine Treffer")}{:else}{current + 1} / {matches.length}{matches.length >= MAX ? "+" : ""}{/if}
    </span>
    <button class="fb" title={`${t("Vorheriger Treffer")} (⇧Enter, ${mod}⇧G)`} disabled={!matches.length} onclick={() => step(-1)}>↑</button>
    <button class="fb" title={`${t("Nächster Treffer")} (Enter, ${mod}G)`} disabled={!matches.length} onclick={() => step(1)}>↓</button>
    <button class="fb tog" class:on={caseSensitive} aria-pressed={caseSensitive} title={t("Groß-/Kleinschreibung beachten")}
      onclick={() => (caseSensitive = !caseSensitive)}>Aa</button>
    <button class="fb tog scope" class:on={scope !== "all"} title={t(SCOPES[scope].title)} onclick={() => (scope = NEXT[scope])}>{t(SCOPES[scope].label)}</button>
    <button class="fb" title={`${t("Suche schließen")} (Esc)`} onclick={close}>✕</button>
  </div>
{/if}

<style>
  .find { position: absolute; top: 8px; right: calc(var(--ruler-w, 0px) + 14px); z-index: 4; pointer-events: auto; display: flex; align-items: center; gap: 2px;
    padding: 4px 4px 4px 6px; background: var(--side); border: 1px solid var(--border); border-radius: 10px; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3); }
  @media (prefers-reduced-motion: no-preference) {
    .find { animation: drop 0.12s ease-out; }
  }
  @keyframes drop { from { opacity: 0; transform: translateY(-4px); } }
  input { width: 200px; border: 0; outline: 0; background: transparent; color: var(--fg); font: inherit; font-size: 13px; padding: 3px 4px; }
  .count { min-width: 64px; text-align: right; padding: 0 6px; font-size: 11.5px; color: var(--muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .count.none { color: var(--red); }
  .fb { all: unset; cursor: pointer; min-width: 22px; height: 22px; padding: 0 4px; box-sizing: border-box; display: grid; place-items: center; border-radius: 6px;
    font-size: 12px; color: var(--muted); }
  .fb:hover:not(:disabled) { background: color-mix(in srgb, var(--fg) 9%, transparent); color: var(--fg); }
  .fb:disabled { opacity: 0.4; cursor: default; }
  .fb:focus-visible { outline: 1px solid var(--accent); }
  .tog.on { color: var(--fg); background: color-mix(in srgb, var(--accent) 24%, transparent); }
  .scope { font-size: 11px; padding: 0 6px; }

  :global(::highlight(chat-find)) { background-color: color-mix(in srgb, var(--yellow) 38%, transparent); }
  :global(::highlight(chat-find-current)) { background-color: var(--orange); color: var(--bg); }
  /* fallback without the Highlight API: tinted boxes over the hits (the layer lets clicks through) */
  :global(.findmarks > div) { position: absolute; border-radius: 2px; background: color-mix(in srgb, var(--yellow) 38%, transparent); }
  :global(.findmarks > div.cur) { background: color-mix(in srgb, var(--orange) 70%, transparent); }
</style>
