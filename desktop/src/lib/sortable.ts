// Drag & drop for a tab strip, with pointer events (WKWebView's HTML5 drag & drop is unreliable). Children
// carry `data-sort-id`; several children with the same id (a split tab's panes) move together. A press only
// becomes a drag after a few pixels, so clicks, double-clicks and middle clicks stay what they were. While
// dragging, the dragged tab is faded, a marker shows where it lands and the strip scrolls at its edges.
export interface SortableOptions {
  /** `id` dropped in front of `before` (null: at the end) */
  onMove: (id: string, before: string | null) => void;
}

const THRESHOLD = 5;
const EDGE = 28;

export function sortable(node: HTMLElement, options: SortableOptions) {
  let opts = options;
  const marker = document.createElement("div");
  marker.style.cssText =
    "position:absolute;top:3px;bottom:2px;width:2px;border-radius:1px;background:var(--accent);pointer-events:none;display:none;z-index:3";

  let press: { id: string; x: number; pointer: number } | null = null;
  let dragging = false;
  let lastX = 0;
  let before: string | null = null;
  /** dropping now changes the order */
  let lands = false;
  let frame = 0;

  const items = (id: string) => [...node.querySelectorAll<HTMLElement>(`[data-sort-id="${CSS.escape(id)}"]`)];
  /** every sort id in screen order with its extent */
  function slots() {
    const out = new Map<string, { left: number; right: number }>();
    for (const el of node.querySelectorAll<HTMLElement>("[data-sort-id]")) {
      const r = el.getBoundingClientRect();
      const s = out.get(el.dataset.sortId!);
      out.set(el.dataset.sortId!, s ? { left: Math.min(s.left, r.left), right: Math.max(s.right, r.right) } : { left: r.left, right: r.right });
    }
    return [...out].map(([id, s]) => ({ id, ...s }));
  }

  function place() {
    const list = slots();
    const i = list.findIndex((s) => lastX < (s.left + s.right) / 2);
    before = i < 0 ? null : list[i]!.id;
    // dropping right next to where it is changes nothing: no marker
    const at = list.findIndex((s) => s.id === press?.id);
    lands = !(before === press?.id || (i < 0 ? at === list.length - 1 : i === at + 1));
    const box = node.getBoundingClientRect();
    const x = i < 0 ? list.at(-1)?.right ?? box.left : list[i]!.left;
    marker.style.display = lands ? "block" : "none";
    marker.style.left = `${Math.max(0, x - box.left + node.scrollLeft - 1)}px`;
  }

  function tick() {
    const box = node.getBoundingClientRect();
    if (lastX < box.left + EDGE) node.scrollLeft -= 8;
    else if (lastX > box.right - EDGE) node.scrollLeft += 8;
    place();
    frame = requestAnimationFrame(tick);
  }

  function onDown(e: PointerEvent) {
    if (e.button !== 0 || (e.target as HTMLElement).closest("input, textarea")) return;
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-sort-id]");
    if (!el || !node.contains(el)) return;
    press = { id: el.dataset.sortId!, x: e.clientX, pointer: e.pointerId };
  }

  function onMove(e: PointerEvent) {
    if (!press || e.pointerId !== press.pointer) return;
    // released outside without a drag: no press any more
    if (!(e.buttons & 1)) return void (press = null);
    lastX = e.clientX;
    if (!dragging) {
      if (Math.abs(e.clientX - press.x) < THRESHOLD) return;
      dragging = true;
      node.setPointerCapture(e.pointerId);
      // attached only now: Svelte may clear the strip's children when its list runs empty
      node.append(marker);
      for (const el of items(press.id)) el.style.opacity = "0.45";
      document.body.style.userSelect = "none";
      document.body.style.cursor = "grabbing";
      frame = requestAnimationFrame(tick);
    }
    e.preventDefault();
  }

  function end() {
    const id = press?.id;
    press = null;
    if (!dragging || !id) return;
    dragging = false;
    cancelAnimationFrame(frame);
    marker.remove();
    for (const el of items(id)) el.style.opacity = "";
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
    // the click that follows a drag is not a click on the tab
    const swallow = (ev: MouseEvent) => (ev.stopPropagation(), ev.preventDefault());
    window.addEventListener("click", swallow, { capture: true, once: true });
    setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
  }

  function onUp(e: PointerEvent) {
    if (!press || e.pointerId !== press.pointer) return;
    if (!dragging) return void (press = null);
    lastX = e.clientX;
    place();
    const id = press.id;
    const drop = lands ? before : undefined;
    end();
    if (drop !== undefined) opts.onMove(id, drop);
  }
  const onKey = (e: KeyboardEvent) => e.key === "Escape" && dragging && end();

  node.addEventListener("pointerdown", onDown);
  node.addEventListener("pointermove", onMove);
  node.addEventListener("pointerup", onUp);
  node.addEventListener("pointercancel", end);
  window.addEventListener("keydown", onKey);
  return {
    update(next: SortableOptions) {
      opts = next;
    },
    destroy() {
      end();
      marker.remove();
      node.removeEventListener("pointerdown", onDown);
      node.removeEventListener("pointermove", onMove);
      node.removeEventListener("pointerup", onUp);
      node.removeEventListener("pointercancel", end);
      window.removeEventListener("keydown", onKey);
    },
  };
}
