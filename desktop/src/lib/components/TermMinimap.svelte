<script lang="ts">
  // The terminal's overview at its right edge (like VS Code's minimap): every line of the scrollback as a bar,
  // as long as its text and in its first colour; the visible part as a box; jump notes as highlighted bands.
  // Click or drag scrolls there, a click on a band jumps to its note, right-click on it opens the note's menu.
  import type { JumpNote } from "$lib/jumpNotes.svelte";
  import { t } from "$lib/i18n";

  type MiniLine = [number, string | null];
  let { mini, notes, onScroll, onNote, onNoteMenu }: {
    mini: { total: number; top: number; rows: number; lines: MiniLine[] } | null;
    notes: JumpNote[];
    /** scroll so this line (from the top of the scrollback) is the first on screen */
    onScroll: (line: number) => void;
    onNote: (note: JumpNote) => void;
    onNoteMenu?: (note: JumpNote, x: number, y: number) => void;
  } = $props();

  let el: HTMLDivElement | undefined = $state();
  let canvas: HTMLCanvasElement | undefined = $state();
  let height = $state(0);
  let dragging = $state(false);

  /** the first line the map knows: herdr hands out the newest ~1000 lines, those fill the bar */
  const base = $derived(mini ? mini.total - mini.lines.length : 0);
  /** px per line: the known lines fit; a short scrollback keeps 3 px lines */
  const scale = $derived(mini && height ? Math.min(3, height / Math.max(1, mini.lines.length)) : 0);
  const yOf = (line: number) => (line - base) * scale;
  const box = $derived.by(() => {
    if (!mini) return { y: 0, h: 0, above: false };
    const y = yOf(mini.top);
    const h = Math.max(10, mini.rows * scale);
    // looking at older lines than the map knows: the box waits at the top edge
    return y < 0 ? { y: 0, h, above: true } : { y, h, above: false };
  });
  const bands = $derived(
    notes
      .filter((n) => n.termRow !== undefined)
      .map((n) => ({ note: n, y: Math.max(0, yOf(n.termRow ?? 0)), older: (n.termRow ?? 0) < base })),
  );

  $effect(() => {
    if (!el) return;
    const ro = new ResizeObserver(() => (height = el?.clientHeight ?? 0));
    ro.observe(el);
    height = el.clientHeight;
    return () => ro.disconnect();
  });

  $effect(() => {
    const c = canvas;
    const m = mini;
    if (!c || !m || !height) return;
    const dpr = devicePixelRatio || 1;
    const w = c.clientWidth;
    c.width = Math.round(w * dpr);
    c.height = Math.round(height * dpr);
    const g = c.getContext("2d");
    if (!g) return;
    g.scale(dpr, dpr);
    g.clearRect(0, 0, w, height);
    const fallback = getComputedStyle(c).color;
    const first = base;
    const lineH = Math.max(1, scale - (scale >= 2 ? 0.5 : 0));
    for (let i = 0; i < m.lines.length; i++) {
      const [len, color] = m.lines[i]!;
      if (!len) continue;
      g.fillStyle = color ?? fallback;
      g.globalAlpha = color ? 0.85 : 0.45;
      g.fillRect(4, (first + i - base) * scale, Math.max(1.5, Math.min(1, len / 160) * (w - 8)), lineH);
    }
    g.globalAlpha = 1;
  });

  const lineAt = (y: number) => (scale ? base + y / scale : 0);

  function down(e: PointerEvent) {
    if (e.button !== 0 || !el || !mini) return;
    const top = el.getBoundingClientRect().top;
    const y = e.clientY - top;
    const center = (yy: number) => onScroll(lineAt(yy) - mini!.rows / 2);
    const inBox = y >= box.y && y <= box.y + box.h;
    const grab = inBox ? y - box.y : box.h / 2;
    if (!inBox) center(y);
    el.setPointerCapture(e.pointerId);
    dragging = true;
    const move = (m: PointerEvent) => onScroll(lineAt(m.clientY - top - grab));
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

<!-- svelte-ignore a11y_no_static_element_interactions (pointer shortcut; the terminal scrolls by keyboard itself) -->
<div class="mini" class:dragging bind:this={el} title={t("Übersicht – klicken oder ziehen zum Scrollen")} onpointerdown={down}>
  <canvas bind:this={canvas}></canvas>
  {#if mini}<div class="view" class:above={box.above} style:top="{box.y}px" style:height="{box.h}px"></div>{/if}
  {#each bands as b (b.note.id)}
    <button class="band" class:older={b.older} style:top="{b.y}px" aria-label={b.note.label}
      onpointerdown={(e) => e.stopPropagation()}
      onclick={() => onNote(b.note)}
      oncontextmenu={(e) => { e.preventDefault(); onNoteMenu?.(b.note, e.clientX, e.clientY); }}>
      <span class="tip"><b>◆ {b.note.label}</b><i>{t("Klick: hinspringen · Rechtsklick: bearbeiten")}</i></span>
    </button>
  {/each}
</div>

<style>
  .mini { position: absolute; top: 0; right: 0; bottom: 0; width: 60px; cursor: pointer; user-select: none; touch-action: none;
    border-left: 1px solid color-mix(in srgb, var(--border) 55%, transparent); background: rgba(0, 0, 0, 0.18);
    color: #c5c8c6; }
  canvas { position: absolute; inset: 0; width: 100%; height: 100%; }
  .view { position: absolute; left: 0; right: 0; background: rgba(255, 255, 255, 0.1); border-block: 1px solid rgba(255, 255, 255, 0.35); }
  .mini:hover .view, .dragging .view { background: rgba(255, 255, 255, 0.16); }
  .band { all: unset; cursor: pointer; position: absolute; left: 0; right: 0; height: 6px; margin-top: -1px;
    background: color-mix(in srgb, var(--orange) 85%, transparent); box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.5); }
  .band:hover { height: 8px; background: var(--orange); }
  .band.older { opacity: 0.6; }
  .view.above { border-top-style: dashed; }
 /* the note's label: a card left of the bar */
  .tip { display: none; position: absolute; right: calc(100% + 8px); top: 50%; translate: 0 -50%; z-index: 10; width: max-content; max-width: 320px;
    padding: 7px 10px; border-radius: 9px; background: var(--side); border: 1px solid color-mix(in srgb, var(--orange) 55%, var(--border));
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35); text-align: left; pointer-events: none; }
  .tip b { display: block; font-size: 12.5px; font-weight: 600; color: var(--fg); white-space: normal; }
  .tip i { display: block; margin-top: 3px; font-size: 11px; font-style: normal; color: var(--dim); }
  .band:hover .tip { display: block; }
</style>
