<script lang="ts">
  // Browse the server's folders (home and below) and pick one (iOS FolderPicker, `hollr gate dirs`).
  import { t } from "../i18n";
  import { dirs, errText, type DirListing } from "../serverapi";
  import Modal from "./Modal.svelte";

  let { server, start = "~", allowNew = true, onPick, onClose }: {
    server: string; start?: string; allowNew?: boolean; onPick: (path: string) => void; onClose: () => void;
  } = $props();

  // svelte-ignore state_referenced_locally
  let path = $state(start.trim().replace(/\/+$/, "") || "~");
  let listing = $state<DirListing | null>(null);
  let error = $state("");
  let filter = $state("");
  let newName = $state("");
  let filterEl = $state<HTMLInputElement>();

  const shown = $derived.by(() => {
    const all = listing?.dirs ?? [];
    const f = filter.trim().toLowerCase();
    return f ? all.filter((d) => d.name.toLowerCase().includes(f)) : all;
  });

  async function load(target: string) {
    filter = "";
    try {
      const r = await dirs(server, target);
      if ((r as { error?: string }).error) throw new Error((r as { error?: string }).error);
      listing = r;
      path = r.path;
      error = "";
      filterEl?.focus();
    } catch (e) {
      // a folder typed in the field may not exist yet: show home instead
      if (target !== "~" && !listing) return load("~");
      error = errText(e);
    }
  }
  // svelte-ignore state_referenced_locally
  load(path);

  function pick(chosen: string) {
    onPick(chosen);
    onClose();
  }

  function create() {
    const name = newName.trim().replaceAll("/", "-");
    if (name) pick(`${listing?.path ?? path}/${name}`);
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); }
    else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); if (listing) pick(listing.path); }
    else if (e.key === "Enter" && shown.length === 1) { e.preventDefault(); load(shown[0]!.path); }
    else if (e.key === "Backspace" && !filter && listing?.parent) { e.preventDefault(); load(listing.parent); }
  }
</script>

<svelte:window onkeydown={(e) => e.key === "Escape" && onKey(e)} />

<Modal title={t("Ordner wählen")} {onClose}>
  <div class="bar">
    {#if listing?.parent}
      <button class="btn up" title={t("Übergeordneter Ordner")} onclick={() => load(listing!.parent!)}>↑</button>
    {/if}
    <span class="mono cur ellipsis" title={listing?.path ?? path}>{listing?.path ?? path}</span>
    {#if listing?.repo}<span class="repo" title="git">⑂</span>{/if}
  </div>
  <!-- svelte-ignore a11y_autofocus -->
  <input bind:this={filterEl} placeholder={t("Ordner filtern")} bind:value={filter} autofocus autocomplete="off" spellcheck="false"
    onkeydown={onKey} />

  {#if listing?.places.length}
    <div class="section">{t("Projekt-Orte")}</div>
    <div class="places">
      {#each listing.places as place (place)}
        <button class="pill mono" onclick={() => load(place)}>★ {place}</button>
      {/each}
    </div>
  {/if}
  {#if error}<div class="err">{error}</div>{/if}

  <div class="section">{t("Ordner")}</div>
  <div class="list">
    {#if !listing && !error}
      {#each Array(6) as _, i (i)}<div class="item"><div class="skeleton" style="height: 14px; width: {40 + ((i * 17) % 40)}%"></div></div>{/each}
    {:else if !shown.length}
      <div class="item muted">{filter ? t("Nichts gefunden.") : t("Keine Unterordner.")}</div>
    {/if}
    {#each shown as d (d.path)}
      <div class="item">
        <button class="open" onclick={() => load(d.path)}>
          <span class="ico" class:git={d.repo}>{d.repo ? "⑂" : "▢"}</span>
          <span class="grow ellipsis">{d.name}{#if d.branch}<span class="mono small muted"> · {d.branch}</span>{/if}</span>
          <span class="muted">›</span>
        </button>
        <button class="btn small choose" onclick={() => pick(d.path)}>{t("Wählen")}</button>
      </div>
    {/each}
  </div>
  <div class="dim small">{t("Klick öffnet den Ordner, „Wählen“ übernimmt ihn direkt. Git-Repos sind markiert.")}</div>
  {#if allowNew}
    <div class="newrow">
      <input class="grow" placeholder={t("Neuer Unterordner")} bind:value={newName} autocomplete="off" spellcheck="false"
        onkeydown={(e) => { if (e.key === "Enter") { e.preventDefault(); create(); } else if (e.key === "Escape") onKey(e); }} />
      <button class="btn" disabled={!newName.trim()} onclick={create}>{t("Anlegen")}</button>
    </div>
    <div class="dim small">{t("Wird beim Anlegen des Space erstellt.")}</div>
  {/if}

  <div class="buttons">
    <span class="grow"></span>
    <button class="btn" onclick={onClose}>{t("Abbrechen")}</button>
    <button class="btn primary" disabled={!listing} onclick={() => listing && pick(listing.path)}>{t("Diesen wählen")}</button>
  </div>
</Modal>

<style>
  .bar { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .up { padding: 3px 10px; flex: none; }
  .cur { min-width: 0; }
  .repo, .ico.git { color: var(--accent); }
  .section { margin: 4px 0 -6px; }
  .places { display: flex; flex-wrap: wrap; gap: 6px; }
  .places .pill { cursor: pointer; border: none; font: inherit; font-size: 12px; }
  .places .pill:hover { color: var(--accent); }
  .list { border: 1px solid var(--border); border-radius: 10px; max-height: 36vh; overflow-y: auto; }
  .item { display: flex; align-items: center; gap: 6px; padding: 2px 8px 2px 2px; border-bottom: 1px solid var(--border); min-height: 32px; }
  .item:last-child { border-bottom: none; }
  .item.muted, .item:has(.skeleton) { padding: 8px 12px; }
  .open { all: unset; cursor: pointer; flex: 1; min-width: 0; display: flex; align-items: center; gap: 10px; padding: 6px 10px; border-radius: 8px; }
  .open:hover, .open:focus-visible { background: color-mix(in srgb, var(--fg) 6%, transparent); }
  .ico { width: 18px; text-align: center; color: var(--muted); }
  .choose { opacity: 0; padding: 2px 8px; }
  .item:hover .choose, .choose:focus-visible { opacity: 1; }
  .newrow { display: flex; gap: 8px; }
  .buttons { display: flex; align-items: center; gap: 8px; }
</style>
