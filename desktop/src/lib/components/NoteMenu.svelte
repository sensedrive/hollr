<script lang="ts">
  // Right-click on a jump note's band in the overview: jump, edit its text, remove it.
  import type { JumpNote } from "$lib/jumpNotes.svelte";
  import { t } from "$lib/i18n";

  let { note, x, y, onJump, onEdit, onRemove, onClose }: {
    note: JumpNote; x: number; y: number;
    onJump: () => void; onEdit: () => void; onRemove: () => void; onClose: () => void;
  } = $props();
</script>

<!-- Esc closes the menu – before AgentView's window listener takes it for leaving zen, and before the terminal gets it -->
<svelte:window onkeydowncapture={(e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); } }} />

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="backdrop" onclick={onClose} oncontextmenu={(e) => { e.preventDefault(); onClose(); }}>
  <div class="menu" style:left="{Math.min(x, innerWidth - 220)}px" style:top="{Math.min(y, innerHeight - 140)}px"
    onclick={(e) => e.stopPropagation()} role="menu" tabindex="-1">
    <div class="label">{note.label}</div>
    <button onclick={() => { onJump(); onClose(); }}>{t("Springen")}</button>
    <button onclick={() => { onEdit(); onClose(); }}>{t("Text bearbeiten …")}</button>
    <button class="danger" onclick={() => { onRemove(); onClose(); }}>{t("Entfernen")}</button>
  </div>
</div>

<style>
  .backdrop { position: fixed; inset: 0; z-index: 40; }
  .menu { position: fixed; min-width: 200px; background: var(--side); border: 1px solid var(--border); border-radius: 10px;
    padding: 6px; box-shadow: 0 10px 28px rgba(0, 0, 0, 0.35); display: flex; flex-direction: column; gap: 2px; }
  .label { font-size: 12px; color: var(--muted); padding: 4px 8px 6px; border-bottom: 1px solid var(--border); margin-bottom: 2px;
    max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  button { all: unset; cursor: pointer; padding: 6px 8px; border-radius: 6px; font-size: 13px; }
  button:hover { background: color-mix(in srgb, var(--accent) 14%, transparent); }
  .danger { color: var(--red); }
</style>
