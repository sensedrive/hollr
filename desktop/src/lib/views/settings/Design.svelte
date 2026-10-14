<script lang="ts">
  // Settings → Design (iOS DesignSettingsView): fixed palette, or dark/light following the system.
  import { t } from "$lib/i18n";
  import { settings } from "$lib/settings.svelte";
  import { DARK, LIGHT, preview, type Palette } from "$lib/theme";

  const checked = (p: Palette) =>
    settings.followSystem ? (p.dark ? settings.darkTheme : settings.lightTheme) === p.name : settings.theme === p.name;

  function pick(p: Palette) {
    if (settings.followSystem) {
      if (p.dark) settings.darkTheme = p.name;
      else settings.lightTheme = p.name;
    } else settings.theme = p.name;
  }
</script>

<div class="page">
  <h1>{t("Design")}</h1>

  <div class="section">{t("Automatisch")}</div>
  <div class="rows">
    <label class="row">
      <span class="grow">{t("System folgen")}</span>
      <input type="checkbox" class="toggle" bind:checked={settings.followSystem} />
    </label>
    {#if settings.followSystem}
      <div class="row"><span class="grow">{t("Dunkles Design")}</span><span class="muted">{settings.darkTheme}</span></div>
      <div class="row"><span class="grow">{t("Helles Design")}</span><span class="muted">{settings.lightTheme}</span></div>
    {/if}
  </div>
  <p class="foot">
    {settings.followSystem
      ? t("Wechselt mit dem Hell-/Dunkelmodus des Systems. Unten je ein dunkles und ein helles Design wählen.")
      : t("Ein festes Design – oder „System folgen“ für hell am Tag und dunkel in der Nacht.")}
  </p>

  {#each [{ title: "Dunkel", list: DARK }, { title: "Hell", list: LIGHT }] as group (group.title)}
    <div class="section">{t(group.title)}</div>
    <div class="rows">
      {#each group.list as p (p.name)}
        <button class="row" onclick={() => pick(p)} aria-pressed={checked(p)}>
          <span class="grow">{p.name}</span>
          <span class="dots">
            {#each preview(p) as c, i (i)}<span class="dot" style:background={c}></span>{/each}
          </span>
          <span class="check" class:on={checked(p)}>✓</span>
        </button>
      {/each}
    </div>
  {/each}
</div>

<style>
  .foot { color: var(--dim); font-size: 12px; margin: 6px 4px 0; }
  label.row { cursor: pointer; }
  .dots { display: inline-flex; gap: 4px; }
  .dot { width: 14px; height: 14px; border-radius: 50%; box-shadow: inset 0 0 0 0.5px color-mix(in srgb, var(--fg) 25%, transparent); }
  .check { width: 24px; text-align: center; color: var(--accent); opacity: 0; font-weight: 700; }
  .check.on { opacity: 1; }
</style>
