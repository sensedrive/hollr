<script lang="ts">
  // ⌘K: one search over every session (all servers, the ones that need you first), the current server's spaces
  // and the app's commands with their shortcuts – it replaces the long ⋯ menu as the place to find things, and
  // keeps the old "Agents" and "Spaces" lists reachable. Every typed word has to match (palette.ts). ↑↓ / Tab
  // choose, ↩ runs, Esc closes.
  import { tick } from "svelte";
  import { statusLabel, t } from "$lib/i18n";
  import { allPanes, app, dialogs, go, tabName } from "$lib/store.svelte";
  import { currentServer } from "$lib/currentServer.svelte";
  import { statusRank } from "$lib/views/dashboard/util";
  import { matchItems } from "$lib/palette";
  import type { FullSpace } from "$lib/views/spaces/spaces";
  import Icon from "./git/Icon.svelte";

  let { onClose }: { onClose: () => void } = $props();

  type Item = { id: string; label: string; sub?: string; icon?: string; status?: string; kbd?: string; run: () => void };
  const mod = navigator.platform.toLowerCase().includes("mac") ? "⌘" : "Ctrl+";

  const sessions = $derived(
    app.servers.flatMap((s) => allPanes(s.id)).filter((r) => r.pane.agent || r.pane.status !== "unknown")
      .sort((a, b) => statusRank(a) - statusRank(b))
      .map((r): Item => ({
        id: `s:${r.id}`, label: tabName(r.tab.label, r.workspace.label), status: r.pane.status,
        sub: [r.workspace.label, r.server.label, r.pane.agent ? statusLabel(r.pane.status) : t("Terminal")].join(" · "),
        run: () => go({ view: "agent", server: r.server.id, pane: r.pane.pane }),
      })),
  );
  const spaces = $derived(
    ((app.spaces[currentServer()] ?? []) as FullSpace[]).map((sp): Item => ({
      id: `w:${sp.id}`, label: sp.label, icon: "space", sub: [app.servers.find((s) => s.id === currentServer())?.label, sp.git?.branch].filter(Boolean).join(" · "),
      run: () => go({ view: "space", server: currentServer(), ws: sp.id }),
    })),
  );
  const commands = $derived<Item[]>([
    { id: "c:new", label: t("Neue Sitzung"), icon: "plus", kbd: `${mod}N`, run: () => (dialogs.newSession = {}) },
    { id: "c:dash", label: t("Übersicht"), icon: "grid", kbd: `${mod}1`, run: () => go({ view: "dashboard" }) },
    // the server's page; ⌘⌥1…9 switches to the server itself (its last session), so no shortcut here
    ...app.servers.map((s): Item => ({
      id: `c:srv:${s.id}`, label: t("Server-Info: {server}", { server: s.label }), icon: "server",
      run: () => go({ view: "serverinfo", server: s.id }),
    })),
    { id: "c:agents", label: t("Alle Agents"), icon: "list", run: () => go({ view: "agents" }) },
    { id: "c:spaces", label: t("Alle Spaces"), icon: "space", run: () => go({ view: "spaces" }) },
    { id: "c:newspace", label: t("Neuer Space"), icon: "plus", run: () => (dialogs.newSpace = {}) },
    { id: "c:pair", label: t("Server koppeln"), icon: "plus", run: () => (dialogs.pair = true) },
    { id: "c:settings", label: t("Einstellungen"), icon: "sliders", kbd: `${mod},`, run: () => go({ view: "settings" }) },
  ]);

  let query = $state("");
  let sel = $state(0);
  let input = $state<HTMLInputElement>();
  $effect(() => void tick().then(() => input?.focus()));

  const groups = $derived.by(() => {
    const q = query.trim();
    return [
      { title: t("Sitzungen"), items: matchItems(sessions, q).slice(0, q ? 12 : 6) },
      { title: t("Spaces"), items: matchItems(spaces, q).slice(0, q ? 8 : 4) },
      { title: t("Befehle"), items: matchItems(commands, q) },
    ].filter((g) => g.items.length);
  });
  const flat = $derived(groups.flatMap((g) => g.items));
  $effect(() => {
    void query;
    sel = 0;
  });
  // the chosen row stays in sight while ↑↓ walk past the list's edge
  let list = $state<HTMLElement>();
  $effect(() => {
    const id = flat[sel]?.id;
    if (id) list?.querySelector(`[id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "nearest" });
  });
  // back to where the palette was opened from (the composer, the terminal …)
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  $effect(() => () => {
    void tick().then(() => {
      if (opener?.isConnected && (!document.activeElement || document.activeElement === document.body)) opener.focus({ preventScroll: true });
    });
  });

  function run(i: Item | undefined) {
    if (!i) return;
    onClose();
    i.run();
  }
  function onKey(e: KeyboardEvent) {
    const down = e.key === "ArrowDown" || (e.key === "Tab" && !e.shiftKey);
    const up = e.key === "ArrowUp" || (e.key === "Tab" && e.shiftKey);
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); }
    // Tab walks the list too – focus stays in the search field, never behind the overlay
    else if (down) { e.preventDefault(); sel = Math.min(flat.length - 1, sel + 1); }
    else if (up) { e.preventDefault(); sel = Math.max(0, sel - 1); }
    else if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); run(flat[Math.min(sel, flat.length - 1)]); }
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="overlay" onclick={onClose}>
  <div class="box" role="dialog" aria-modal="true" aria-label={t("Befehle")} tabindex="-1" onclick={(e) => e.stopPropagation()} onkeydown={onKey}>
    <div class="head">
      <Icon name="find" size={17} />
      <input bind:this={input} bind:value={query} placeholder={t("Sitzung, Space oder Befehl …")} aria-label={t("Suchen …")}
        role="combobox" aria-expanded="true" aria-controls="palette-list" aria-activedescendant={flat[sel]?.id} />
      <kbd>Esc</kbd>
    </div>
    <div class="list" id="palette-list" role="listbox" bind:this={list}>
      {#if !flat.length}<div class="empty">{t("Nichts gefunden")}</div>{/if}
      {#each groups as g (g.title)}
        <div class="group">{g.title}</div>
        {#each g.items as i (i.id)}
          {@const n = flat.indexOf(i)}
          <button class="item" id={i.id} role="option" tabindex="-1" aria-selected={n === sel} onmousemove={() => (sel = n)} onclick={() => run(i)}>
            <span class="ico">{#if i.status}<span class="dot {i.status}"></span>{:else if i.icon}<Icon name={i.icon} size={15} />{/if}</span>
            <span class="label">{i.label}</span>
            <span class="sub">{i.sub ?? ""}</span>
            {#if i.kbd}<kbd>{i.kbd}</kbd>{/if}
          </button>
        {/each}
      {/each}
    </div>
    <div class="foot">{t("↑↓ wählen · ↩ öffnen · Esc schließen")}</div>
  </div>
</div>

<style>
  .overlay { position: fixed; inset: 0; z-index: 60; display: flex; justify-content: center; align-items: flex-start; padding-top: 12vh;
    background: rgba(0, 0, 0, 0.45); }
  .box { width: min(620px, calc(100% - 32px)); max-height: 70vh; display: flex; flex-direction: column; overflow: hidden; outline: none;
    background: var(--side); border: 1px solid var(--border); border-radius: 14px; box-shadow: 0 12px 34px rgba(0, 0, 0, 0.38); }
  .head { display: flex; align-items: center; gap: 10px; padding: 12px 14px; border-bottom: 1px solid var(--border); color: var(--dim); }
  .head input { all: unset; flex: 1; min-width: 0; font-size: 15px; color: var(--fg); }
  .head input::placeholder { color: var(--dim); }
  kbd { font: 600 11px var(--mono); padding: 1px 6px; border-radius: 5px; border: 1px solid var(--border); background: var(--raised); color: var(--muted); white-space: nowrap; }
  .list { overflow-y: auto; padding: 6px; }
  .group { padding: 10px 10px 4px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.07em; color: var(--dim); }
  .item { all: unset; box-sizing: border-box; cursor: pointer; display: flex; align-items: center; gap: 10px; width: 100%; padding: 8px 10px;
    border-radius: 8px; font-size: 13.5px; }
  .item[aria-selected="true"] { background: color-mix(in srgb, var(--accent) 16%, transparent); }
  .ico { width: 16px; display: grid; place-items: center; color: var(--muted); flex: none; }
  .dot { width: 7px; height: 7px; border-radius: 50%; box-sizing: border-box; border: 1.5px solid var(--dim); }
  .dot.working { background: var(--purple); border-color: var(--purple); }
  .dot.blocked { background: var(--orange); border-color: var(--orange); }
  .dot.done { background: var(--accent); border-color: var(--accent); }
  .dot.unknown { width: 4px; height: 4px; border: none; background: var(--dim); }
  .label { flex: none; max-width: 55%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .sub { flex: 1; min-width: 0; color: var(--dim); font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .empty { padding: 20px; text-align: center; color: var(--dim); font-size: 13px; }
  .foot { padding: 8px 14px; border-top: 1px solid var(--border); font-size: 11.5px; color: var(--dim); }
</style>
