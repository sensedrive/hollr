<script lang="ts">
  // Right-click menu (like the iOS context menus on cards and rows).
  import { onMount } from "svelte";
  import type { MenuItem } from "./util";

  let { x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void } = $props();

  let el = $state<HTMLDivElement>();
  let pos = $state({ left: 0, top: 0 });

  onMount(() => {
    const r = el!.getBoundingClientRect();
    pos = { left: Math.min(x, innerWidth - r.width - 8), top: Math.min(y, innerHeight - r.height - 8) };
    el!.querySelector<HTMLButtonElement>("button")?.focus();
  });

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const buttons = [...el!.querySelectorAll<HTMLButtonElement>("button")];
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    buttons[(i + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus();
  }
</script>

<svelte:window onkeydown={onKey} onblur={onClose} />

<div class="shield" role="presentation" onclick={onClose} oncontextmenu={(e) => { e.preventDefault(); onClose(); }}></div>
<div class="menu" role="menu" bind:this={el} style="left:{pos.left}px; top:{pos.top}px">
  {#each items as item}
    <button role="menuitem" class:danger={item.danger} onclick={() => { onClose(); item.action(); }}>
      <span class="ico">{item.icon ?? ""}</span>{item.label}
    </button>
  {/each}
</div>

<style>
  .shield { position: fixed; inset: 0; z-index: 20; }
  .menu { position: fixed; z-index: 21; min-width: 200px; background: var(--side); border: 1px solid var(--border); border-radius: 10px;
    padding: 4px; box-shadow: 0 12px 32px rgba(0, 0, 0, .35); display: grid; }
  button { all: unset; cursor: pointer; display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-radius: 6px; font-size: 13px; }
  button:hover, button:focus-visible { background: color-mix(in srgb, var(--accent) 22%, transparent); }
  .danger { color: var(--red); }
  .ico { width: 14px; text-align: center; color: var(--muted); }
  .danger .ico { color: var(--red); }
</style>
