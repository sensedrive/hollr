<script lang="ts">
  // The chat's overview at its right edge (VS Code's minimap, structural): every item as a bar in its colour and
  // proportional to its height – your prompts, answers, thinking, tool cards, errors, questions – the visible part
  // as a box, find hits as marks (the current one stronger). Click or drag to scroll, click a mark to go to that hit.
  // Measured from the rendered items (offsets, throttled on resize), never per frame: cheap with thousands of items.
  import { untrack } from "svelte";
  import { markerAt, markerRows, rulerBars, rulerScale, scrollForRuler, viewportBox, type OvBlock, type OvKind, type RulerFrame } from "../../chatFind";
  import { t } from "../../i18n";

  let { scroller, root, matches, current, onPick }: {
    scroller: HTMLElement;
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
  let dragging = $state(false);

  const bars = $derived(rulerBars(blocks, frame));
  const marks = $derived(markerRows(tops, frame));
  const box = $derived(viewportBox(frame, scrollTop));
  const currentY = $derived(current >= 0 && tops[current] !== undefined ? tops[current]! * rulerScale(frame) : undefined);

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
</div>

<style>
  /* the chat's own layout in miniature: your prompts and answers wide, tool cards indented, thinking narrow – all
     left of a 12px lane on the right edge that only the find hits use (VS Code's overview ruler) */
  .ruler { position: absolute; top: 0; right: 0; bottom: 0; width: var(--ruler-w); pointer-events: auto; cursor: pointer; user-select: none; touch-action: none;
    border-left: 1px solid color-mix(in srgb, var(--border) 55%, transparent); background: color-mix(in srgb, var(--bg) 60%, transparent); overflow: hidden; }
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
  .mark.cur { left: 1px; right: 1px; width: auto; height: 3px; background: var(--orange); box-shadow: 0 0 0 1px var(--bg); }
</style>
