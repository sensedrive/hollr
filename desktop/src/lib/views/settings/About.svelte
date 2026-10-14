<script lang="ts">
  // Settings → Über: version, source code, license.
  import { onMount } from "svelte";
  import { getTauriVersion, getVersion } from "@tauri-apps/api/app";
  import { openUrl } from "@tauri-apps/plugin-opener";
  import { t } from "$lib/i18n";

  const REPO = "https://github.com/sensedrive/hollr";
  let version = $state("");
  let tauri = $state("");

  onMount(() => {
    getVersion().then((v) => (version = v), () => (version = "?"));
    getTauriVersion().then((v) => (tauri = v), () => {});
  });

  const open = (url: string) => openUrl(url).catch(() => window.open(url, "_blank"));
</script>

<div class="page">
  <h1>{t("Über")}</h1>
  <div class="card hero">
    <div class="logo">Hollr</div>
    <div class="muted">{t("Deine Agents auf dem Server – per SSH, ohne Zusatzdienst.")}</div>
  </div>

  <div class="section">{t("App")}</div>
  <div class="rows">
    <div class="row">
      <span class="grow">{t("Version")}</span>
      {#if version}<span class="mono muted">{version}</span>{:else}<span class="skeleton" style="width: 60px; height: 14px"></span>{/if}
    </div>
    {#if tauri}
      <div class="row"><span class="grow">Tauri</span><span class="mono muted">{tauri}</span></div>
    {/if}
    <div class="row"><span class="grow">{t("Lizenz")}</span><span class="muted">MIT</span></div>
  </div>

  <div class="section">{t("Quellcode")}</div>
  <div class="rows">
    <button class="row" onclick={() => open(REPO)}>
      <span class="grow">GitHub · sensedrive/hollr</span><span class="muted">↗</span>
    </button>
    <button class="row" onclick={() => open(`${REPO}/issues`)}>
      <span class="grow">{t("Fehler melden oder Wunsch äußern")}</span><span class="muted">↗</span>
    </button>
  </div>
  <p class="foot">{t("Hollr ist Open Source (MIT) – github.com/sensedrive/hollr")}</p>
</div>

<style>
  .hero { display: grid; gap: 4px; padding: 18px; }
  .logo { font-size: 26px; font-weight: 700; letter-spacing: -.01em; }
  .foot { color: var(--dim); font-size: 12px; margin: 6px 4px 0; }
</style>
