<script lang="ts">
  // Small confirmation sheet (destructive actions: close a session, remove a server).
  import Modal from "$lib/components/Modal.svelte";
  import { t } from "$lib/i18n";

  let { title, message, confirmLabel, danger = true, onConfirm, onClose }: {
    title: string; message?: string; confirmLabel: string; danger?: boolean;
    onConfirm: () => void | Promise<void>; onClose: () => void;
  } = $props();

  let busy = $state(false);
  let error = $state("");

  async function run() {
    busy = true; error = "";
    try { await onConfirm(); } catch (e) { error = e instanceof Error ? e.message : String(e); }
    busy = false;
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") { e.preventDefault(); onClose(); }
    else if (e.key === "Enter" && !busy && !(e.target as HTMLElement).matches("button")) { e.preventDefault(); run(); }
  }
</script>

<svelte:window onkeydown={onKey} />

<Modal {title} {onClose}>
  {#if message}<div class="muted">{message}</div>{/if}
  {#if error}<div class="err">{error}</div>{/if}
  <div class="buttons">
    <button class="btn" onclick={onClose}>{t("Abbrechen")}</button>
    <button class="btn" class:primary={!danger} class:solid-danger={danger} disabled={busy} onclick={run}>{busy ? "…" : confirmLabel}</button>
  </div>
</Modal>

<style>
  .buttons { display: flex; justify-content: flex-end; gap: 8px; }
  .solid-danger { background: var(--red); border-color: var(--red); color: #fff; }
</style>
