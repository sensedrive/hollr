/**
 * Drag cards between columns and reorder them inside the Sandcastle column – mouse (pointer events, 5 px
 * threshold) and touch (long press 350 ms, moving 8 px before that scrolls instead). Cards carry
 * `data-card="<n>"`, columns `data-column="<column>"`, a column's card list `data-list`.
 * A drop calls `onDrop(n, column, before)`; `before` only for reordering inside `reorder` (else null).
 * Esc or letting go outside a column cancels; the click after a drag is swallowed (cf. desktop/src/lib/sortable.ts).
 */
import type { Column } from "./types";

export interface DragOptions {
  canDrag(n: number): boolean;
  onDrop(n: number, to: Column, before: number | null): void;
  /** the column whose order can be changed by dragging (the queue) */
  reorder?: Column;
}

interface Active {
  n: number;
  card: HTMLElement;
  clone: HTMLElement;
  from: Column;
  dx: number;
  dy: number;
  x: number;
  y: number;
  target: HTMLElement | null;
  before: number | null;
  frame: number;
}

let active: Active | null = null;

/** A drag is in progress (polling waits, the board doesn't re-render under the finger). */
export const dragging = () => active !== null;

const EDGE = 40;

export function enableDrag(root: HTMLElement, opts: DragOptions): () => void {
  const line = document.createElement("div");
  line.className = "drop-line";

  const columnOf = (el: Element | null) => el?.closest<HTMLElement>("[data-column]") ?? null;

  function start(card: HTMLElement, x: number, y: number) {
    const from = columnOf(card)?.dataset.column as Column | undefined;
    if (!from) return;
    const rect = card.getBoundingClientRect();
    const clone = card.cloneNode(true) as HTMLElement;
    clone.classList.add("drag-clone");
    clone.style.width = `${rect.width}px`;
    document.body.append(clone);
    card.classList.add("drag-source");
    document.body.classList.add("is-dragging");
    active = { n: Number(card.dataset.card), card, clone, from, dx: x - rect.left, dy: y - rect.top, x, y, target: null, before: null, frame: 0 };
    move(x, y);
    active.frame = requestAnimationFrame(autoscroll);
  }

  function move(x: number, y: number) {
    if (!active) return;
    active.x = x;
    active.y = y;
    active.clone.style.transform = `translate(${x - active.dx}px, ${y - active.dy}px)`;
    const under = document.elementFromPoint(x, y);
    const col = under && root.contains(under) ? columnOf(under) : null;
    if (col !== active.target) {
      active.target?.classList.remove("drop-target");
      col?.classList.add("drop-target");
      active.target = col;
    }
    active.before = null;
    line.remove();
    if (col && col.dataset.column === active.from && active.from === opts.reorder) {
      const list = col.querySelector<HTMLElement>("[data-list]") ?? col;
      const cards = [...list.querySelectorAll<HTMLElement>("[data-card]")].filter((c) => c !== active?.card);
      const next = cards.find((c) => {
        const r = c.getBoundingClientRect();
        return r.top + r.height / 2 > y;
      });
      active.before = next ? Number(next.dataset.card) : null;
      if (next) list.insertBefore(line, next);
      else list.append(line);
    }
  }

  /** Scrolls the column list and the board when the finger is near an edge. */
  function autoscroll() {
    if (!active) return;
    const { x, y } = active;
    const list = active.target?.querySelector<HTMLElement>("[data-list]");
    if (list) {
      const r = list.getBoundingClientRect();
      if (y < r.top + EDGE) list.scrollTop -= 10;
      else if (y > r.bottom - EDGE) list.scrollTop += 10;
    }
    if (x < EDGE) root.scrollLeft -= 12;
    else if (x > window.innerWidth - EDGE) root.scrollLeft += 12;
    if (y < EDGE) window.scrollBy(0, -10);
    else if (y > window.innerHeight - EDGE) window.scrollBy(0, 10);
    active.frame = requestAnimationFrame(autoscroll);
  }

  function end(drop: boolean) {
    const a = active;
    if (!a) return;
    active = null;
    cancelAnimationFrame(a.frame);
    a.clone.remove();
    line.remove();
    a.card.classList.remove("drag-source");
    a.target?.classList.remove("drop-target");
    document.body.classList.remove("is-dragging");
    // the click that follows the release must not open the card
    const swallow = (e: Event) => {
      e.stopPropagation();
      e.preventDefault();
    };
    window.addEventListener("click", swallow, { capture: true, once: true });
    setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 400);
    const to = a.target?.dataset.column as Column | undefined;
    if (!drop || !to) return;
    if (to !== a.from) opts.onDrop(a.n, to, null);
    else if (to === opts.reorder) {
      // dropped where it already was: nothing to do
      const next = a.card.nextElementSibling as HTMLElement | null;
      const current = next?.dataset.card ? Number(next.dataset.card) : null;
      if (current !== a.before) opts.onDrop(a.n, to, a.before);
    }
  }

  // ---- mouse / pen
  function onPointerDown(e: PointerEvent) {
    if (e.pointerType === "touch" || e.button !== 0) return;
    const card = (e.target as Element).closest<HTMLElement>("[data-card]");
    if (!card || !root.contains(card) || !opts.canDrag(Number(card.dataset.card))) return;
    const sx = e.clientX;
    const sy = e.clientY;
    // once cancelled (Esc) the gesture stays dead until the button goes up
    let started = false;
    const onMove = (ev: PointerEvent) => {
      if (!started && Math.hypot(ev.clientX - sx, ev.clientY - sy) > 5) {
        started = true;
        start(card, ev.clientX, ev.clientY);
      } else if (started) move(ev.clientX, ev.clientY);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      end(true);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  // ---- touch: long press, then the page must not scroll
  function onTouchStart(e: TouchEvent) {
    const t = e.touches[0];
    if (e.touches.length !== 1 || !t) return;
    const card = (e.target as Element).closest<HTMLElement>("[data-card]");
    if (!card || !root.contains(card) || !opts.canDrag(Number(card.dataset.card))) return;
    const sx = t.clientX;
    const sy = t.clientY;
    let lx = sx;
    let ly = sy;
    const timer = setTimeout(() => {
      navigator.vibrate?.(10);
      start(card, lx, ly);
    }, 350);
    const onMove = (ev: TouchEvent) => {
      const p = ev.touches[0];
      if (!p) return;
      lx = p.clientX;
      ly = p.clientY;
      if (active) {
        ev.preventDefault();
        move(lx, ly);
      } else if (Math.hypot(lx - sx, ly - sy) > 8) cleanup();
    };
    const onEnd = (ev: TouchEvent) => {
      cleanup();
      if (active) {
        ev.preventDefault();
        end(ev.type === "touchend");
      }
    };
    function cleanup() {
      clearTimeout(timer);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", onEnd);
      window.removeEventListener("touchcancel", onEnd);
    }
    window.addEventListener("touchmove", onMove, { passive: false });
    window.addEventListener("touchend", onEnd);
    window.addEventListener("touchcancel", onEnd);
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape" && active) end(false);
  }

  root.addEventListener("pointerdown", onPointerDown);
  root.addEventListener("touchstart", onTouchStart, { passive: true });
  window.addEventListener("keydown", onKey);
  return () => {
    root.removeEventListener("pointerdown", onPointerDown);
    root.removeEventListener("touchstart", onTouchStart);
    window.removeEventListener("keydown", onKey);
    end(false);
  };
}
