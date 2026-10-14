<script lang="ts">
  // Settings (iOS SettingsView) with a sub-navigation: general, design, servers, release notes, about.
  import { t } from "$lib/i18n";
  import { hasUnseen } from "$lib/releaseNotes";
  import { go, type Route } from "$lib/store.svelte";
  import About from "./settings/About.svelte";
  import Design from "./settings/Design.svelte";
  import General from "./settings/General.svelte";
  import Notes from "./settings/Notes.svelte";
  import Servers from "./settings/Servers.svelte";

  type Page = Extract<Route, { view: "settings" }>["page"];
  let { page }: { page?: Page } = $props();

  const PAGES: { page: Page; label: string; icon: string }[] = [
    { page: undefined, label: "Allgemein", icon: "⚙" },
    { page: "design", label: "Design", icon: "◐" },
    { page: "servers", label: "Server & Geräte", icon: "▤" },
    { page: "notes", label: "Neuigkeiten", icon: "✦" },
    { page: "about", label: "Über", icon: "ⓘ" },
  ];
</script>

<div class="wrap">
  <nav>
    <h1>{t("Einstellungen")}</h1>
    {#each PAGES as p (p.label)}
      <button class="item" class:active={page === p.page} onclick={() => go(p.page ? { view: "settings", page: p.page } : { view: "settings" })}>
        <span class="ico">{p.icon}</span>
        <span class="grow">{t(p.label)}</span>
        {#if p.page === "notes" && hasUnseen()}<span class="badge">{t("Neu")}</span>{/if}
      </button>
    {/each}
  </nav>
  <div class="content">
    {#if page === "design"}
      <Design />
    {:else if page === "servers"}
      <Servers />
    {:else if page === "notes"}
      <Notes />
    {:else if page === "about"}
      <About />
    {:else}
      <General />
    {/if}
  </div>
</div>

<style>
  .wrap { display: grid; grid-template-columns: 210px 1fr; height: 100%; min-height: 0; }
  nav { border-right: 1px solid var(--border); padding: 22px 10px; display: flex; flex-direction: column; gap: 2px; overflow-y: auto; }
  h1 { font-size: 22px; font-weight: 650; margin: 0 8px 14px; }
  .item { all: unset; cursor: pointer; display: flex; align-items: center; gap: 9px; padding: 6px 10px; border-radius: 8px; color: var(--muted); }
  .item:hover { background: var(--card); color: var(--fg); }
  .item.active { background: color-mix(in srgb, var(--accent) 20%, transparent); color: var(--fg); }
  .ico { width: 16px; text-align: center; font-size: 13px; }
  .badge { font-size: 11px; font-weight: 600; padding: 1px 8px; border-radius: 99px; background: var(--accent); color: #fff; }
  .content { min-width: 0; min-height: 0; overflow: hidden; }
  .content :global(.page > *) { max-width: 820px; }
</style>
