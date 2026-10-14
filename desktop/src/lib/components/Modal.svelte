<script lang="ts">
  import type { Snippet } from "svelte";
  let { title, onClose, children }: { title: string; onClose: () => void; children: Snippet } = $props();
</script>

<div class="backdrop" role="presentation" onclick={(e) => e.target === e.currentTarget && onClose()}>
  <div class="modal" role="dialog" aria-label={title}>
    <h2>{title}</h2>
    {@render children()}
  </div>
</div>

<style>
  .backdrop { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.5); display: grid; place-items: center; z-index: 10; }
  .modal { background: var(--side); border: 1px solid var(--border); border-radius: 14px; padding: 20px; width: min(560px, 92vw);
    max-height: 86vh; overflow: auto; display: flex; flex-direction: column; gap: 12px; }
  h2 { margin: 0; font-size: 17px; }
</style>
