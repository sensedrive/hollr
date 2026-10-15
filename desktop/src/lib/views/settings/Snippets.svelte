<script lang="ts">
  // Settings → general: the prompt snippets above the composer (add, remove, reorder).
  import { t } from "$lib/i18n";
  import { snippets } from "$lib/snippets.svelte";

  let draft = $state("");

  function add() {
    snippets.add(draft);
    draft = "";
  }
</script>

<div class="section">{t("Prompt-Bausteine")}</div>
<div class="rows">
  {#each snippets.list as s, i (s)}
    <div class="row">
      <span class="grow text">{s}</span>
      <button class="ic" disabled={i === 0} onclick={() => snippets.move(i, -1)} title={t("Nach oben")} aria-label={t("Nach oben")}>↑</button>
      <button class="ic" disabled={i === snippets.list.length - 1} onclick={() => snippets.move(i, 1)} title={t("Nach unten")} aria-label={t("Nach unten")}>↓</button>
      <button class="ic del" onclick={() => snippets.remove(i)} title={t("Entfernen")} aria-label={t("Entfernen")}>✕</button>
    </div>
  {:else}
    <div class="row small muted">{t("Keine Bausteine.")}</div>
  {/each}
  <form class="row" onsubmit={(e) => { e.preventDefault(); add(); }}>
    <input class="grow" bind:value={draft} placeholder={t("Neuer Baustein …")} />
    <button class="btn" type="submit" disabled={!draft.trim()}>{t("Hinzufügen")}</button>
  </form>
</div>
<p class="foot">
  {t("Erscheinen als Chips über dem Eingabefeld; ein Klick fügt den Text an der Schreibmarke ein.")}
  <button class="reset" onclick={() => snippets.reset()}>{t("Standard wiederherstellen")}</button>
</p>

<style>
  .text { white-space: pre-wrap; overflow-wrap: anywhere; }
  .ic { all: unset; cursor: pointer; width: 24px; height: 24px; display: grid; place-items: center; border-radius: 6px; color: var(--muted); }
  .ic:hover:not(:disabled) { background: color-mix(in srgb, var(--fg) 8%, transparent); color: var(--fg); }
  .ic:disabled { opacity: .3; cursor: default; }
  .ic.del:hover { color: var(--red); }
  form input { padding: 6px 10px; border-radius: 8px; }
  .foot { color: var(--dim); font-size: 12px; margin: 6px 4px 0; }
  .reset { all: unset; cursor: pointer; color: var(--accent); margin-left: 6px; }
  .reset:hover { text-decoration: underline; }
</style>
