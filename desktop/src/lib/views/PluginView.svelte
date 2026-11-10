<script lang="ts">
  // A plugin's web UI (iOS PluginView): started on the server by the `plugins` gate, shown through an SSH tunnel
  // (BrowserPanel's pattern). The token stays in the URL fragment; external links come as postMessage.
  import { onDestroy, onMount } from "svelte";
  import { openUrl } from "@tauri-apps/plugin-opener";
  import Icon from "$lib/components/git/Icon.svelte";
  import * as api from "$lib/api";
  import { viaTunnel } from "$lib/agent";
  import { t } from "$lib/i18n";
  import { back, serverById } from "$lib/store.svelte";
  import { errText } from "$lib/serverapi";
  import { listPlugins, openPlugin } from "$lib/plugins";

  let { server, id }: { server: string; id: string } = $props();

  let src = $state("");
  let error = $state("");
  let loading = $state(false);
  let listed = $state<string>();
  const name = $derived(listed ?? id);
  let frame = $state<HTMLIFrameElement>();
  let tunnel: number | undefined;
  let destroyed = false;

  async function open() {
    loading = true;
    error = "";
    try {
      const { port, url } = await openPlugin(server, id);
      const local = await api.tunnelOpen(server, port);
      if (destroyed) {
        api.tunnelClose(local).catch(() => {});
        return;
      }
      if (tunnel !== undefined && tunnel !== local) api.tunnelClose(tunnel).catch(() => {});
      tunnel = local;
      // a new object each time: the same address reloads too
      src = "";
      queueMicrotask(() => (src = viaTunnel(new URL(url), local)));
    } catch (e) {
      error = errText(e);
    }
    loading = false;
  }

  /** links to public pages, asked for by the plugin page (it can't open windows from the sandboxed frame) */
  function onMessage(e: MessageEvent) {
    if (!frame || e.source !== frame.contentWindow) return;
    const data = e.data as { type?: unknown; url?: unknown } | null;
    if (data?.type !== "hollr-open-url" || typeof data.url !== "string" || !/^https?:\/\//i.test(data.url)) return;
    openUrl(data.url).catch((err) => (error = errText(err)));
  }

  onMount(() => {
    window.addEventListener("message", onMessage);
    open();
    listPlugins(server)
      .then((list) => (listed = list.find((p) => p.id === id)?.name))
      .catch(() => {});
  });

  onDestroy(() => {
    destroyed = true;
    window.removeEventListener("message", onMessage);
    if (tunnel !== undefined) api.tunnelClose(tunnel).catch(() => {});
  });
</script>

<div class="plugin">
  <div class="bar">
    <button class="ib" title={t("Zurück")} onclick={back}>‹</button>
    <span class="title">{name}</span>
    <span class="srv">{serverById(server)?.label ?? server}</span>
    <button class="ib" title={t("Neu laden")} disabled={loading} onclick={open}><Icon name="↻" size={15} /></button>
  </div>
  {#if error}
    <div class="failed">
      <Icon name="⚠" size={18} />
      <p>{t("Plugin nicht erreichbar")}</p>
      <p class="small">{error}</p>
      <button class="btn primary" onclick={open} disabled={loading}>{t("Erneut versuchen")}</button>
    </div>
  {:else if src}
    <iframe bind:this={frame} title={name} {src}
      sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"></iframe>
  {:else}
    <div class="progress"></div>
  {/if}
</div>

<style>
  .plugin { display: flex; flex-direction: column; height: 100%; min-height: 0; background: var(--bg); }
  .bar { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-bottom: 1px solid var(--border); }
  .title { font-weight: 600; }
  .srv { flex: 1; color: var(--dim); font-size: 12px; }
  .ib { all: unset; cursor: pointer; width: 28px; height: 28px; display: grid; place-items: center; border-radius: 7px; color: var(--muted); font-size: 16px; flex: none; }
  .ib:hover:not(:disabled) { background: var(--card); color: var(--fg); }
  .ib:disabled { opacity: 0.35; cursor: default; }
  iframe { flex: 1; min-height: 0; width: 100%; border: 0; background: var(--bg); }
  .failed { flex: 1; display: grid; place-content: center; justify-items: center; gap: 6px; color: var(--muted); text-align: center; padding: 24px; }
  .failed p { margin: 0; max-width: 460px; }
  .small { font-size: 12px; color: var(--dim); white-space: pre-wrap; }
  .progress { height: 2px; background: linear-gradient(90deg, transparent, var(--accent), transparent); background-size: 50% 100%;
    background-repeat: no-repeat; animation: slide 1s linear infinite; }
  @keyframes slide { from { background-position: -50% 0; } to { background-position: 150% 0; } }
</style>
