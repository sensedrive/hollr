<script lang="ts">
  import Sym from "$lib/components/Sym.svelte";
  // "Neu und praktisch" pager (iOS TipsTour): one tip per page, ← → or the dots to move, closing marks it seen.
  import { t } from "../i18n";
  import { markTourSeen, type Tip } from "../tips.svelte";
  import Modal from "./Modal.svelte";

  let { tips, onClose }: { tips: Tip[]; onClose: () => void } = $props();

  let page = $state(0);
  const tip = $derived(tips[page]);
  const last = $derived(page >= tips.length - 1);
  const mod = navigator.platform.toLowerCase().includes("mac") ? "⌘" : "Ctrl+";

  function close() {
    markTourSeen();
    onClose();
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") { e.preventDefault(); close(); }
    else if (e.key === "ArrowRight") { e.preventDefault(); page = Math.min(page + 1, tips.length - 1); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); page = Math.max(page - 1, 0); }
  }
</script>

<svelte:window onkeydown={onKey} />

<Modal title={t("Neu und praktisch")} onClose={close}>
  {#if tip}
    <div class="page">
      <div class="icon"><Sym g={tip.icon} size={26} /></div>
      <h3>{t(tip.title)}</h3>
      <p class="muted">{t(tip.text, { mod })}</p>
    </div>
  {/if}
  <div class="dots" role="tablist">
    {#each tips as tp, i (tp.id)}
      <button class="dot" class:on={i === page} role="tab" aria-selected={i === page} aria-label={t(tp.title)} onclick={() => (page = i)}></button>
    {/each}
  </div>
  <div class="buttons">
    <button class="btn" onclick={close}>{t("Fertig")}</button>
    <span class="grow"></span>
    {#if page > 0}<button class="btn" onclick={() => page--}>{t("Zurück")}</button>{/if}
    <button class="btn primary" onclick={() => (last ? close() : page++)}>{last ? t("Los geht’s") : t("Weiter")}</button>
  </div>
</Modal>

<style>
  .page { display: grid; justify-items: center; gap: 12px; text-align: center; padding: 18px 12px 6px; min-height: 230px; align-content: center; }
  .icon { width: 96px; height: 96px; display: grid; place-items: center; font-size: 44px; font-weight: 600; color: var(--accent);
    background: color-mix(in srgb, var(--accent) 12%, transparent); border-radius: 26px; }
  h3 { margin: 0; font-size: 20px; }
  p { margin: 0; max-width: 420px; line-height: 1.5; }
  .dots { display: flex; justify-content: center; gap: 7px; }
  .dot { all: unset; cursor: pointer; width: 7px; height: 7px; border-radius: 50%; background: color-mix(in srgb, var(--fg) 25%, transparent); }
  .dot.on { background: var(--accent); }
  .dot:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .buttons { display: flex; align-items: center; gap: 8px; }
</style>
