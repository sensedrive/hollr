<script lang="ts">
  // The open question from ask.svelte.ts (confirm / prompt / alert) as an app dialog.
  import { asking } from "$lib/ask.svelte";
  import { t } from "$lib/i18n";
  import Modal from "./Modal.svelte";

  let value = $state("");
  $effect(() => {
    value = asking.q?.value ?? "";
  });
  function done(v: string | boolean | null) {
    const q = asking.q;
    asking.q = null;
    q?.resolve(v);
  }
  const focus = (node: HTMLInputElement) => {
    setTimeout(() => (node.focus(), node.select()), 0);
  };
</script>

{#if asking.q}
  {@const q = asking.q}
  <Modal title={q.title} tone={q.danger ? "danger" : "default"} place="center" width={440}
    onClose={() => done(q.kind === "prompt" ? null : false)}>
    {#if q.text}<p class="text">{q.text}</p>{/if}
    {#if q.kind === "prompt"}
      <input bind:value use:focus onkeydown={(e) => e.key === "Enter" && done(value)} />
    {/if}
    <div class="buttons">
      {#if q.kind !== "alert"}<button class="btn" onclick={() => done(q.kind === "prompt" ? null : false)}>{t("Abbrechen")}</button>{/if}
      <button class="btn" class:primary={!q.danger} class:danger={q.danger} onclick={() => done(q.kind === "prompt" ? value : true)}>
        {q.ok ?? (q.kind === "alert" ? "OK" : t("OK"))}
      </button>
    </div>
  </Modal>
{/if}

<style>
  .text { margin: 0; white-space: pre-wrap; color: var(--muted); }
  .buttons { display: flex; justify-content: flex-end; gap: 8px; }
</style>
