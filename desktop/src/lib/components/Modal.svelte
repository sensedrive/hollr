<script lang="ts" module>
  // the open dialogs, innermost last – Esc closes only the top one (a folder picker over "Neuer Space")
  let stack: symbol[] = [];
</script>

<script lang="ts">
  // The frame every dialog shares (design: Magic Fink "Dialog"): dimmed backdrop, a head with icon, title and ✕,
  // the content, and – when the last child is a button row (.buttons / .actions / .mbuttons) – a footer bar for it.
  // Esc, ✕ and a click beside it close it.
  import type { Snippet } from "svelte";
  import Icon from "./git/Icon.svelte";

  let { title, onClose, children, icon, tone = "default", width = 520, place = "top" }: {
    title: string; onClose: () => void; children: Snippet;
    icon?: string; tone?: "default" | "danger"; width?: number; place?: "top" | "center";
  } = $props();

  const me = Symbol("modal");
  $effect(() => {
    stack = [...stack, me];
    return () => { stack = stack.filter((s) => s !== me); };
  });
  function onKey(e: KeyboardEvent) {
    if (e.key !== "Escape" || e.defaultPrevented || stack[stack.length - 1] !== me) return;
    e.preventDefault();
    onClose();
  }
</script>

<svelte:window onkeydown={onKey} />

<div class="backdrop" class:center={place === "center"} role="presentation" onclick={(e) => e.target === e.currentTarget && onClose()}>
  <div class="modal" role="dialog" aria-modal="true" aria-label={title} style="--mw: {width}px">
    <div class="head">
      {#if icon}<span class="ico" class:danger={tone === "danger"}><Icon name={icon} size={15} /></span>{/if}
      <h2>{title}</h2>
      <button class="x" onclick={onClose} aria-label="Esc" title="Esc"><Icon name="x" size={14} /></button>
    </div>
    <div class="body">{@render children()}</div>
  </div>
</div>

<style>
  .backdrop { position: fixed; inset: 0; z-index: 50; display: grid; place-items: start center; padding: 12vh 16px 16px;
    background: rgba(0, 0, 0, 0.45); animation: fade 0.12s ease-out; }
  .backdrop.center { place-items: center; padding-top: 16px; }
  .modal { width: min(var(--mw), 100%); max-height: min(80vh, 760px); display: flex; flex-direction: column; overflow: hidden;
    background: var(--side); border: 1px solid var(--border); border-radius: 14px; box-shadow: 0 12px 34px rgba(0, 0, 0, 0.38);
    animation: rise 0.14s ease-out; }
  .head { display: flex; align-items: center; gap: 10px; padding: 14px 14px 12px 18px; flex: none; }
  .ico { width: 28px; height: 28px; flex: none; border-radius: 8px; display: grid; place-items: center;
    color: var(--accent); background: color-mix(in srgb, var(--accent) 14%, transparent); }
  .ico.danger { color: var(--red); background: color-mix(in srgb, var(--red) 14%, transparent); }
  h2 { flex: 1; min-width: 0; margin: 0; font-size: 15px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .x { all: unset; cursor: pointer; width: 28px; height: 28px; flex: none; display: grid; place-items: center; border-radius: 7px; color: var(--dim); }
  .x:hover { background: var(--card); color: var(--fg); }
  .x:focus-visible { outline: 2px solid var(--accent); }
  .body { min-height: 0; overflow-y: auto; padding: 2px 18px 16px; display: flex; flex-direction: column; gap: 12px; }
  /* the dialog's button row becomes the footer bar */
  .body > :global(:is(.buttons, .actions, .mbuttons):last-child) { position: sticky; bottom: -16px; margin: 4px -18px -16px; padding: 12px 18px;
    display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 8px; border-top: 1px solid var(--border);
    background: color-mix(in srgb, var(--side) 92%, var(--fg) 3%); }
  @keyframes fade { from { opacity: 0; } }
  @keyframes rise { from { opacity: 0; translate: 0 6px; } }
  @media (prefers-reduced-motion: reduce) { .backdrop, .modal { animation: none; } }
</style>
