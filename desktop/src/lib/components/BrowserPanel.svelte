<script lang="ts">
  // In-app browser (BrowserView.swift): web services on the server's localhost open through an SSH tunnel
  // (a local port on this computer → localhost:<port> on the server), public pages load directly.
  // Tunnels opened here are closed again when the panel goes away.
  import { onDestroy, untrack } from "svelte";
  import { openUrl } from "@tauri-apps/plugin-opener";
  import * as api from "../api";
  import { t } from "../i18n";
  import {
    displayUrl, isLoopback, portLabel, ports as loadPorts, recentUrls, rememberUrl, shortPath, urlFrom, urlPort, viaTunnel,
    type WebPort,
  } from "../agent";

  let { server, serverLabel, request, onClose }: {
    server: string;
    serverLabel: string;
    /** open this address (a new object each time, so the same URL can be requested twice) */
    request?: { url: string } | null;
    onClose: () => void;
  } = $props();

  let address = $state("");
  let current = $state<URL | null>(null);
  let src = $state("");
  let nonce = $state(0);
  let loading = $state(false);
  let error = $state("");
  let stack = $state<string[]>([]);
  let index = $state(-1);
  let ports = $state<WebPort[] | null>(null);
  let recent = $state(recentUrls());
  const tunnels = new Set<number>();
  /** remote port → local port of this panel's tunnels */
  const byRemote = new Map<number, number>();

  const tunneled = $derived(!!current && isLoopback(current));

  async function refreshPorts() {
    ports = null;
    try {
      ports = await loadPorts(server);
    } catch (e) {
      ports = [];
      error = e instanceof Error ? e.message : String(e);
    }
  }
  refreshPorts();

  async function local(remote: number): Promise<number> {
    const known = byRemote.get(remote);
    if (known) return known;
    const port = await api.tunnelOpen(server, remote);
    tunnels.add(port);
    byRemote.set(remote, port);
    return port;
  }

  async function show(url: URL, push = true) {
    error = "";
    current = url;
    address = displayUrl(url);
    rememberUrl(url.href);
    recent = recentUrls();
    if (push) {
      stack = [...stack.slice(0, index + 1), url.href];
      index = stack.length - 1;
    }
    loading = true;
    try {
      src = isLoopback(url) ? viaTunnel(url, await local(urlPort(url))) : url.href;
      nonce++;
    } catch (e) {
      loading = false;
      error = t("Verbindung zu {server} fehlgeschlagen: {e}", { server: serverLabel, e: e instanceof Error ? e.message : String(e) });
    }
  }

  export function open(input: string) {
    const url = urlFrom(input);
    if (url) show(url);
  }

  $effect(() => {
    const r = request;
    if (r?.url) untrack(() => open(r.url));
  });

  function go(delta: number) {
    const next = index + delta;
    const href = stack[next];
    if (!href) return;
    index = next;
    show(new URL(href), false);
  }

  const reload = () => current && show(current, false);
  function home() {
    current = null;
    src = "";
    address = "";
    error = "";
    refreshPorts();
  }

  async function external() {
    if (!current) return;
    try {
      await openUrl(isLoopback(current) ? viaTunnel(current, await local(urlPort(current))) : current.href);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  function onAddressKey(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      open(address);
    } else if (e.key === "Escape" && current) {
      address = displayUrl(current);
      (e.currentTarget as HTMLInputElement).blur();
    }
  }

  onDestroy(() => {
    for (const port of tunnels) api.tunnelClose(port).catch(() => {});
  });
</script>

<div class="browser">
  <div class="bar">
    <button class="ib" title={t("Zurück")} disabled={index <= 0} onclick={() => go(-1)}>‹</button>
    <button class="ib" title={t("Vor")} disabled={index >= stack.length - 1} onclick={() => go(1)}>›</button>
    <button class="ib" title={t("Neu laden")} disabled={!current} onclick={reload}>↻</button>
    <div class="addr" class:tunnel={tunneled}>
      {#if tunneled}<span class="via" title={t("Über {server}", { server: serverLabel })}>⇄</span>{/if}
      <input bind:value={address} placeholder={t("URL oder localhost:3000")} spellcheck="false" onkeydown={onAddressKey}
        onfocus={(e) => (e.currentTarget as HTMLInputElement).select()} />
    </div>
    <button class="ib" title={t("Startseite")} onclick={home}>⌂</button>
    <button class="ib" title={t("Im System-Browser öffnen")} disabled={!current} onclick={external}>↗</button>
    <button class="ib" title={t("Schließen")} onclick={onClose}>✕</button>
  </div>
  {#if loading}<div class="progress"></div>{/if}
  {#if error}<div class="error">⚠ {error}</div>{/if}

  {#if current && src}
    {#key nonce}
      <iframe title={address} {src} onload={() => (loading = false)}
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"></iframe>
    {/key}
    {#if !tunneled}<div class="hint">{t("Bleibt die Seite leer, verbietet sie die Einbettung – dann im System-Browser öffnen.")}</div>{/if}
  {:else}
    <div class="start">
      <div class="section">
        <span>{t("Auf {server}", { server: serverLabel })}</span>
        <button class="link" onclick={refreshPorts}>{t("Aktualisieren")}</button>
      </div>
      <div class="rows">
        {#if ports === null}
          {#each [0, 1] as _}<div class="row"><div class="skeleton" style="height:14px;width:60%"></div></div>{/each}
        {:else if !ports.length}
          <div class="row muted">{t("Gerade läuft dort kein Web-Dienst auf localhost.")}</div>
        {:else}
          {#each ports as p (p.port)}
            <button class="row" onclick={() => open(`http://localhost:${p.port}`)}>
              <div class="grow">
                <div class="ellipsis">{portLabel(p)}</div>
                <div class="small muted ellipsis">{[p.process, p.cwd && shortPath(p.cwd)].filter(Boolean).join(" · ")}</div>
              </div>
              <span class="port">:{p.port}</span>
            </button>
          {/each}
        {/if}
      </div>
      <div class="foot">{t("localhost-Adressen öffnet Hollr über die SSH-Verbindung zum Server.")}</div>
      {#if recent.length}
        <div class="section"><span>{t("Zuletzt")}</span></div>
        <div class="rows">
          {#each recent as url}
            <button class="row" onclick={() => open(url)}><span class="ellipsis grow">🌐 {url}</span></button>
          {/each}
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .browser { display: flex; flex-direction: column; height: 100%; min-height: 0; background: var(--bg); }
  .bar { display: flex; align-items: center; gap: 2px; padding: 8px 10px; border-bottom: 1px solid var(--border); }
  .ib { all: unset; cursor: pointer; width: 28px; height: 28px; display: grid; place-items: center; border-radius: 7px; color: var(--muted); font-size: 16px; flex: none; }
  .ib:hover:not(:disabled) { background: var(--card); color: var(--fg); }
  .ib:disabled { opacity: 0.35; cursor: default; }
  .addr { flex: 1; min-width: 0; display: flex; align-items: center; gap: 6px; background: color-mix(in srgb, var(--fg) 7%, transparent);
    border-radius: 999px; padding: 0 12px; margin: 0 4px; }
  .addr input { all: unset; flex: 1; min-width: 0; font-size: 12.5px; padding: 5px 0; color: var(--fg); }
  .addr.tunnel .via { color: var(--green); font-size: 12px; }
  .progress { height: 2px; background: linear-gradient(90deg, transparent, var(--accent), transparent); background-size: 50% 100%;
    background-repeat: no-repeat; animation: slide 1s linear infinite; }
  @keyframes slide { from { background-position: -50% 0; } to { background-position: 150% 0; } }
  .error { padding: 8px 12px; font-size: 12.5px; color: var(--yellow); background: color-mix(in srgb, var(--yellow) 12%, transparent); }
  iframe { flex: 1; min-height: 0; width: 100%; border: 0; background: #fff; }
  .hint { font-size: 11px; color: var(--dim); padding: 4px 12px; border-top: 1px solid var(--border); }
  .start { flex: 1; overflow-y: auto; padding: 4px 14px 20px; }
  .section { display: flex; justify-content: space-between; align-items: center; margin: 16px 2px 6px; color: var(--muted); font-size: 11px;
    text-transform: uppercase; letter-spacing: 0.05em; }
  .link { all: unset; cursor: pointer; color: var(--accent); text-transform: none; letter-spacing: 0; font-size: 12px; }
  .port { font-family: var(--mono); color: var(--green); font-size: 13px; }
  .foot { font-size: 11.5px; color: var(--dim); margin: 6px 2px 0; }
  .muted { color: var(--muted); }
</style>
