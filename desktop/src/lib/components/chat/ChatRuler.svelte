<script lang="ts">
  // The chat's overview at its right edge (VS Code's minimap, structural): every item as a bar in its colour and
  // proportional to its height – your prompts, answers, thinking, tool cards, errors, questions – the visible part
  // as a box, find hits as marks (the current one stronger). Click or drag to scroll, click a mark to go to that hit.
  // Measured from the rendered items (offsets, throttled on resize), never per frame: cheap with thousands of items.
  import { untrack } from "svelte";
  import { markerAt, markerRows, rulerBars, rulerScale, scrollForRuler, viewportBox, type OvBlock, type OvKind, type RulerFrame } from "../../chatFind";
  import { t } from "../../i18n";
  import type { JumpNote } from "../../jumpNotes.svelte";

  let { scroller, root, matches, current, onPick, notes = [], onNote, onNoteMenu }: {
    scroller: HTMLElement;
    /** jump notes: their block highlighted in the ruler, a click scrolls there */
    notes?: JumpNote[];
    onNote?: (note: JumpNote) => void;
    onNoteMenu?: (note: JumpNote, x: number, y: number) => void;
    /** the chat's item list (TimelineView's `.tl`, positioned): items are its children with `data-ov` */
    root: HTMLElement;
    matches: Range[];
    current: number;
    onPick: (match: number) => void;
  } = $props();

  let el: HTMLDivElement | undefined = $state();
  let frame = $state<RulerFrame>({ content: 0, viewport: 0, ruler: 0 });
  let blocks = $state.raw<OvBlock[]>([]);
  let tops = $state.raw<number[]>([]);
  let scrollTop = $state(0);
  /** content px of each note's block (its message, else the place it was made) */
  let noteBlocks = $state.raw<{ note: JumpNote; top: number; height: number }[]>([]);
  let dragging = $state(false);

  const bars = $derived(rulerBars(blocks, frame));
  const marks = $derived(markerRows(tops, frame));
  const box = $derived(viewportBox(frame, scrollTop));
  const currentY = $derived(current >= 0 && tops[current] !== undefined ? tops[current]! * rulerScale(frame) : undefined);

  /** the chat item whose text holds `text` (a note made in the terminal: same words, other layout) */
  function findByText(list: HTMLElement, text: string): HTMLElement | null {
    const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
    const want = norm(text).slice(0, 60);
    if (want.length < 6) return null;
    for (const el of list.querySelectorAll<HTMLElement>("[data-item]")) if (norm(el.textContent ?? "").includes(want)) return el;
    return null;
  }

  function measure() {
    if (!el) return;
    const view = scroller.getBoundingClientRect();
    const toContent = scroller.scrollTop - view.top;
    // the items' offsets are relative to the list – where the list starts in the scrolled content
    const base = root.getBoundingClientRect().top + toContent;
    const out: OvBlock[] = [];
    for (const c of root.children) {
      const kind = (c as HTMLElement).dataset?.ov as OvKind | undefined;
      if (kind) out.push({ top: base + (c as HTMLElement).offsetTop, height: (c as HTMLElement).offsetHeight, kind });
    }
    blocks = out;
    tops = matches.map((r) => r.getBoundingClientRect().top + toContent);
    noteBlocks = notes.flatMap((note) => {
      const item = note.itemId ? root.querySelector<HTMLElement>(`[data-item="${CSS.escape(note.itemId)}"]`) : null;
      if (item) return [{ note, top: item.getBoundingClientRect().top + toContent, height: item.offsetHeight }];
      if (note.scrollY !== undefined) return [{ note, top: note.scrollY + scroller.clientHeight / 3, height: 24 }];
      const words = note.text ?? (note.termRow !== undefined ? note.label : undefined);
      const hit = words ? findByText(root, words) : null;
      if (hit) return [{ note, top: hit.getBoundingClientRect().top + toContent, height: hit.offsetHeight }];
      return [];
    });
    frame = { content: scroller.scrollHeight, viewport: scroller.clientHeight, ruler: el.clientHeight };
    scrollTop = scroller.scrollTop;
  }

  // streaming makes the list resize many times a second: measure at most every 150 ms (and once at the end)
  let timer: ReturnType<typeof setTimeout> | undefined;
  function schedule() {
    if (timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      measure();
    }, 150);
  }

  $effect(() => {
    if (!el) return;
    const ro = new ResizeObserver(schedule);
    ro.observe(root);
    ro.observe(scroller);
    ro.observe(el);
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => (scrollTop = scroller.scrollTop));
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    untrack(measure);
    return () => {
      ro.disconnect();
      scroller.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(raf);
      clearTimeout(timer);
      timer = undefined;
    };
  });
  // notes added or removed: measure again
  $effect(() => {
    void notes;
    untrack(schedule);
  });
  // new hits: their marks (the list may not resize – a highlight changes no layout)
  $effect(() => {
    // closing the find bar clears its marks at once, not with the next measure
    if (!matches.length) tops = [];
    untrack(schedule);
  });

  function down(e: PointerEvent) {
    if (e.button !== 0 || !el) return;
    const y = e.clientY - el.getBoundingClientRect().top;
    const hit = markerAt(marks, y);
    if (hit !== undefined) {
      onPick(hit);
      return;
    }
    // outside the box: jump there first, then the drag moves the view like the box
    if (y < box.y || y > box.y + box.h) scroller.scrollTop = scrollForRuler(frame, y);
    const startY = e.clientY;
    const startTop = scroller.scrollTop;
    const scale = rulerScale(frame);
    el.setPointerCapture(e.pointerId);
    dragging = true;
    const move = (m: PointerEvent) => (scroller.scrollTop = startTop + (m.clientY - startY) / scale);
    const up = () => {
      dragging = false;
      el?.removeEventListener("pointermove", move);
      el?.removeEventListener("pointerup", up);
      el?.removeEventListener("pointercancel", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    e.preventDefault();
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions (a pointer shortcut; the chat scrolls by keyboard itself) -->
<div class="ruler" class:dragging bind:this={el} title={t("Übersicht – klicken oder ziehen zum Scrollen")} aria-hidden="true"
  onpointerdown={down} onwheel={(e) => scroller.scrollBy({ top: e.deltaY })}>
  {#each bars as b, i (i)}<div class="bar {b.kind}" style:top="{b.y}px" style:height="{b.h}px"></div>{/each}
  <div class="view" style:top="{box.y}px" style:height="{box.h}px"></div>
  {#each marks as m (m.index)}<div class="mark" style:top="{m.y}px"></div>{/each}
  {#if currentY !== undefined}<div class="mark cur" style:top="{currentY}px"></div>{/if}
  {#each noteBlocks as b (b.note.id)}
    <button class="note" style:top="{b.top * rulerScale(frame)}px" style:height="{Math.max(5, b.height * rulerScale(frame))}px" aria-label={b.note.label}
      onpointerdown={(e) => e.stopPropagation()} onclick={() => onNote?.(b.note)}
      oncontextmenu={(e) => { e.preventDefault(); onNoteMenu?.(b.note, e.clientX, e.clientY); }}>
      <span class="tip"><b>◆ {b.note.label}</b><i>{t("Klick: hinspringen · Rechtsklick: bearbeiten")}</i></span></button>
  {/each}
</div>

<style>
  /* the chat's own layout in miniature: your prompts and answers wide, tool cards indented, thinking narrow – all
     left of a 12px lane on the right edge that only the find hits use (VS Code's overview ruler) */
  .ruler { position: absolute; top: 0; right: 0; bottom: 0; width: var(--ruler-w); pointer-events: auto; cursor: pointer; user-select: none; touch-action: none;
    border-left: 1px solid color-mix(in srgb, var(--border) 55%, transparent); background: color-mix(in srgb, var(--bg) 60%, transparent); }
  .bar { position: absolute; border-radius: 1px; }
  .bar.user { left: 14px; right: 14px; background: color-mix(in srgb, var(--orange) 70%, transparent); }
  .bar.agent { left: 4px; right: 20px; background: color-mix(in srgb, var(--fg) 45%, transparent); }
  .bar.think { left: 4px; right: 30px; background: color-mix(in srgb, var(--purple) 45%, transparent); }
  .bar.tool { left: 8px; right: 22px; background: color-mix(in srgb, var(--muted) 24%, transparent); }
  .bar.err { left: 8px; right: 22px; background: color-mix(in srgb, var(--red) 70%, transparent); }
  .bar.ask { left: 4px; right: 14px; background: color-mix(in srgb, var(--yellow) 55%, transparent); }
  .bar.info { left: 18px; right: 26px; background: color-mix(in srgb, var(--dim) 45%, transparent); }
  .view { position: absolute; left: 0; right: 0; min-height: 2px; background: color-mix(in srgb, var(--fg) 14%, transparent);
    border-block: 1px solid color-mix(in srgb, var(--fg) 38%, transparent); }
  .ruler:hover .view, .dragging .view { background: color-mix(in srgb, var(--fg) 20%, transparent); }
  /* hits: a lane on the right edge like VS Code's overview ruler; the current one across the whole width */
  .mark { position: absolute; right: 1px; width: 12px; height: 2px; margin-top: -1px; border-radius: 1px; background: var(--yellow); }
  /* a jump note: its block lit across the whole width */
  .note { all: unset; position: absolute; left: 0; right: 0; cursor: pointer; border-radius: 2px;
    background: color-mix(in srgb, var(--orange) 45%, transparent); border-block: 2px solid var(--orange); box-sizing: border-box; }
  .note:hover { background: color-mix(in srgb, var(--orange) 65%, transparent); }
  .mark.cur { left: 1px; right: 1px; width: auto; height: 3px; background: var(--orange); box-shadow: 0 0 0 1px var(--bg); }
  .tip { display: none; position: absolute; right: calc(100% + 8px); top: 0; z-index: 10; width: max-content; max-width: 320px;
    padding: 7px 10px; border-radius: 9px; background: var(--side); border: 1px solid color-mix(in srgb, var(--orange) 55%, var(--border));
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35); text-align: left; pointer-events: none; }
  .tip b { display: block; font-size: 12.5px; font-weight: 600; color: var(--fg); white-space: normal; }
  .tip i { display: block; margin-top: 3px; font-size: 11px; font-style: normal; color: var(--dim); }
  .note:hover .tip { display: block; }
</style>
