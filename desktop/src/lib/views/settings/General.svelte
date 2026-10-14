<script lang="ts">
  // Settings → general: zoom, app language, notifications, shells, shortcuts to design / servers / notes.
  import { onMount } from "svelte";
  import { t } from "$lib/i18n";
  import { hasUnseen } from "$lib/releaseNotes";
  import { settings } from "$lib/settings.svelte";
  import { app, go } from "$lib/store.svelte";
  import { checkPermission, ensurePermission, KINDS, notify, notifyKinds, permission } from "./notify.svelte";

  // the ten iOS TextScale steps, mapped onto the desktop zoom factor 0.7 … 1.6
  const STEPS = ["Winzig", "Sehr klein", "Klein", "Standard", "Groß", "Sehr groß", "Riesig", "XL 1", "XL 2", "XL 3"];
  const index = $derived(Math.min(STEPS.length - 1, Math.max(0, Math.round((settings.zoom - 0.7) * 10))));
  const setIndex = (i: number) => (settings.zoom = Math.round((0.7 + i * 0.1) * 100) / 100);
  const mod = navigator.platform.toLowerCase().includes("mac") ? "⌘" : "Ctrl+";

  const LANGS = [
    { value: "system", label: "System" },
    { value: "de", label: "Deutsch" },
    { value: "en", label: "English" },
  ];

  const themeLabel = $derived(settings.followSystem ? t("Automatisch") : settings.theme);

  let testResult = $state("");
  onMount(() => {
    checkPermission();
  });

  async function setNotify(on: boolean) {
    settings.notify = on;
    if (on) await ensurePermission();
  }

  async function test() {
    testResult = "";
    const ok = await notify("Hollr", t("Test-Mitteilung – Mitteilungen funktionieren."));
    testResult = ok ? t("Gesendet.") : t("Mitteilungen sind im System nicht erlaubt.");
  }
</script>

<div class="page">
  <h1>{t("Allgemein")}</h1>

  <div class="section">{t("Ansicht")}</div>
  <div class="card zoom">
    <div class="row0">
      <span class="grow">{t("Ansicht skalieren")}</span>
      <span class="muted">{t(STEPS[index] ?? "Standard")} · {Math.round(settings.zoom * 100)} %</span>
    </div>
    <div class="row0">
      <span class="aa small">A</span>
      <input class="grow" type="range" min="0" max={STEPS.length - 1} step="1" value={index}
        oninput={(e) => setIndex(Number(e.currentTarget.value))} aria-label={t("Ansicht skalieren")} />
      <span class="aa big">A</span>
      <button class="btn" disabled={settings.zoom === 1} onclick={() => (settings.zoom = 1)}>{t("Zurücksetzen")}</button>
    </div>
  </div>
  <p class="foot">{t("Skaliert die ganze App. Auch mit {mod}+ / {mod}− / {mod}0.", { mod })}</p>

  <div class="rows">
    <button class="row" onclick={() => go({ view: "settings", page: "design" })}>
      <span class="grow">{t("Design")}</span><span class="muted">{themeLabel}</span><span class="chev">›</span>
    </button>
  </div>

  <div class="section">{t("App-Sprache")}</div>
  <div class="card">
    <div class="seg">
      {#each LANGS as l (l.value)}
        <button class:on={settings.lang === l.value} onclick={() => (settings.lang = l.value)}>
          {l.value === "system" ? t("Wie System") : l.label}
        </button>
      {/each}
    </div>
  </div>
  <p class="foot">{t("Deutsch oder Englisch – unabhängig von der Systemsprache. Der Server antwortet in derselben Sprache.")}</p>

  <div class="section">{t("Mitteilungen")}</div>
  <div class="rows">
    <label class="row">
      <span class="grow">{t("Mitteilungen")}</span>
      <input type="checkbox" class="toggle" checked={settings.notify} onchange={(e) => setNotify(e.currentTarget.checked)} />
    </label>
    {#if settings.notify}
      {#if permission.state === "denied"}
        <div class="row small warn">{t("Mitteilungen sind im System nicht erlaubt. In den Systemeinstellungen für Hollr erlauben.")}</div>
      {/if}
      {#each KINDS as k (k.kind)}
        <label class="row">
          <span class="grow sub">{t(k.title)}</span>
          <input type="checkbox" class="toggle" bind:checked={notifyKinds[k.kind]} />
        </label>
      {/each}
      <div class="row">
        <button class="btn" onclick={test}>{t("Test-Mitteilung senden")}</button>
        {#if testResult}<span class="small muted">{testResult}</span>{/if}
      </div>
    {/if}
  </div>
  <p class="foot">{t("Hollr meldet sich auf diesem Computer, wenn ein Agent auf dich wartet, fertig ist oder mit einem Fehler stoppt – solange die App läuft. Die Sitzung, die du gerade ansiehst, bleibt still.")}</p>

  <div class="section">{t("Sitzungen")}</div>
  <div class="rows">
    <label class="row">
      <span class="grow">{t("Shells anzeigen")}</span>
      <input type="checkbox" class="toggle" bind:checked={settings.showShells} />
    </label>
  </div>
  <p class="foot">{t("Zeigt auch Terminals ohne Agent in den Listen.")}</p>

  <div class="section">{t("Mehr")}</div>
  <div class="rows">
    <button class="row" onclick={() => go({ view: "settings", page: "servers" })}>
      <span class="grow">{t("Server & Geräte")}</span><span class="muted">{app.servers.length}</span><span class="chev">›</span>
    </button>
    <button class="row" onclick={() => go({ view: "settings", page: "notes" })}>
      <span class="grow">{t("Neuigkeiten")}</span>
      {#if hasUnseen()}<span class="badge">{t("Neu")}</span>{/if}
      <span class="chev">›</span>
    </button>
    <button class="row" onclick={() => go({ view: "settings", page: "about" })}>
      <span class="grow">{t("Über")}</span><span class="chev">›</span>
    </button>
  </div>
</div>

<style>
  .zoom { display: grid; gap: 10px; }
  .row0 { display: flex; align-items: center; gap: 12px; }
  .aa { color: var(--muted); }
  .aa.small { font-size: 11px; }
  .aa.big { font-size: 18px; }
  input[type="range"] { padding: 0; border: 0; background: transparent; accent-color: var(--accent); }
  .foot { color: var(--dim); font-size: 12px; margin: 6px 4px 0; }
  .chev { color: var(--dim); font-size: 16px; }
  .sub { color: var(--muted); padding-left: 12px; }
  .warn { color: var(--orange); }
  label.row { cursor: pointer; }
  .seg { display: inline-flex; background: var(--raised); border: 1px solid var(--border); border-radius: 8px; padding: 2px; }
  .seg button { all: unset; cursor: pointer; padding: 4px 14px; border-radius: 6px; color: var(--muted); }
  .seg button.on { background: var(--card); color: var(--fg); box-shadow: 0 0 0 1px var(--border); }
  .badge { font-size: 11px; font-weight: 600; padding: 1px 8px; border-radius: 99px; background: var(--accent); color: #fff; }
</style>
