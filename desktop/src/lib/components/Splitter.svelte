<script lang="ts">
  // Drag handle between two areas: resizes the one before it (width for "x", height for "y").
  // Pointer capture while dragging, clamped to [min, max]; double-click resets; onDone stores the result.
  import { clamp } from "../layoutPrefs";
  import { t } from "../i18n";

  let { axis = "x", size, min, max, onSize, onDone, onReset, label = "" }: {
    axis?: "x" | "y"; size: number; min: number; max: number;
    onSize: (v: number) => void; onDone: () => void; onReset: () => void; label?: string;
  } = $props();

  let dragging = $state(false);

  function start(e: PointerEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    const from = axis === "x" ? e.clientX : e.clientY;
    const start = size;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    dragging = true;
    const move = (ev: PointerEvent) => onSize(clamp(start + (axis === "x" ? ev.clientX : ev.clientY) - from, min, max));
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      dragging = false;
      onDone();
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  }
</script>

<div class="splitter {axis}" class:dragging role="separator" aria-orientation={axis === "x" ? "vertical" : "horizontal"}
  aria-label={label || undefined} aria-valuenow={size} aria-valuemin={min} aria-valuemax={max}
  title={t("Ziehen: Größe ändern · Doppelklick: zurücksetzen")} onpointerdown={start} ondblclick={onReset}></div>

<style>
  .splitter { flex: none; position: relative; z-index: 3; touch-action: none; }
  .splitter.x { width: 7px; margin: 0 -3px; cursor: col-resize; }
  .splitter.y { height: 7px; margin: -3px 0; cursor: row-resize; }
  .splitter::after { content: ""; position: absolute; background: var(--border); transition: background .12s; }
  .splitter.x::after { top: 0; bottom: 0; left: 3px; width: 1px; }
  .splitter.y::after { left: 0; right: 0; top: 3px; height: 1px; }
  .splitter:hover::after, .splitter.dragging::after { background: var(--accent); }
  .splitter.x:hover::after, .splitter.x.dragging::after { left: 2px; width: 3px; }
  .splitter.y:hover::after, .splitter.y.dragging::after { top: 2px; height: 3px; }
</style>
