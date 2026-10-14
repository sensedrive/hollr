<script lang="ts">
  // Settings → Neuigkeiten (iOS ReleaseNotesView). Opening the page marks the notes as seen.
  import { onMount } from "svelte";
  import { getVersion } from "@tauri-apps/api/app";
  import { t } from "$lib/i18n";
  import { markSeen, NOTES } from "$lib/releaseNotes";

  let installed = $state("");
  onMount(() => {
    markSeen();
    getVersion().then((v) => (installed = v), () => {});
  });
  // "0.16.0" belongs to the note "0.16"
  const isInstalled = (version: string) => !!installed && (installed === version || installed.startsWith(`${version}.`));
</script>

<div class="page">
  <h1>{t("Neuigkeiten")}</h1>
  {#each NOTES as note (note.build)}
    <div class="section head">
      <span>{note.build === 1 ? t("Anfang") : t("Version {version}", { version: note.version })}</span>
      {#if isInstalled(note.version)}<span class="inst">{t("installiert")}</span>{/if}
      <span class="grow"></span>
      <span>{note.date === "Oktober 2026" ? t("Oktober 2026") : note.date}</span>
    </div>
    <div class="rows">
      {#each note.items as item, i (i)}
        <div class="row"><span class="ico">{item.icon}</span><span class="grow">{t(item.text)}</span></div>
      {/each}
    </div>
  {/each}
</div>

<style>
  .head { display: flex; align-items: center; gap: 8px; }
  .inst { text-transform: none; letter-spacing: 0; font-size: 11px; font-weight: 600; padding: 1px 6px; border-radius: 99px;
    background: color-mix(in srgb, var(--accent) 25%, transparent); color: var(--fg); }
  .ico { width: 22px; text-align: center; color: var(--accent); flex: none; }
</style>
