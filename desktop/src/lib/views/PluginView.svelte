<script lang="ts">
  // A plugin's web UI (iOS PluginView): started on the server by the `plugins` gate, shown through an SSH tunnel
  // (BrowserPanel's pattern). The token stays in the URL fragment; external links come as postMessage.
  import { onDestroy, onMount } from "svelte";
  import { openUrl } from "@tauri-apps/plugin-opener";
  import Icon from "$lib/components/git/Icon.svelte";
  import * as api from "$lib/api";
  import { viaTunnel } from "$lib/agent";
  import { t } from "$lib/i18n";
  import { app, go, serverById } from "$lib/store.svelte";
  import { parseHostRequest, readTheme, reopenGate, type HostReply } from "$lib/pluginHost";
  import { errText } from "$lib/serverapi";
  import { isPinned, listPlugins, openPlugin, togglePin } from "$lib/plugins";

  /** `open`: board ticket (`<KEY>:<n>` / `:<n>`) – fragment `open=` on the first load, an `open` event once the page is up;
   *  `repo` (`owner/name`) goes with it for an issue number; a new `ask` tells the page again (same ticket, panel closed) */
  let { server, id, open: ticket, repo, ask }: { server: string; id: string; open?: string; repo?: string; ask?: number } = $props();

  let src = $state("");
  let error = $state("");
  let loading = $state(false);
  let listed = $state<string>();
  /** the manifest's host.gate allowlist; empty until the list arrives, so gate requests are refused meanwhile */
  let allowed: string[] = [];
  const name = $derived(listed ?? id);
  let frame = $state<HTMLIFrameElement>();
  let tunnel: number | undefined;
  let destroyed = false;
  /** the ticket (and repo) the page was last told about (fragment or event) */
  let told: string | undefined;
  const asked = $derived(ticket ? `${ticket}|${repo ?? ""}|${ask ?? ""}` : undefined);

  const mayReopen = reopenGate();

  async function open() {
    loading = true;
    error = "";
    try {
      const { port, url } = await openPlugin(server, id);
      const local = await api.tunnelOpen(server, port);
      const target = new URL(url);
      if (ticket && told === undefined) {
        target.hash += `&open=${encodeURIComponent(ticket)}`;
        if (repo) target.hash += `&repo=${encodeURIComponent(repo)}`;
        told = asked;
      }
      if (destroyed) {
        api.tunnelClose(local).catch(() => {});
        return;
      }
      if (tunnel !== undefined && tunnel !== local) api.tunnelClose(tunnel).catch(() => {});
      tunnel = local;
      // a new object each time: the same address reloads too
      src = "";
      queueMicrotask(() => (src = viaTunnel(target, local)));
    } catch (e) {
      error = errText(e);
    }
    loading = false;
  }

  // a new ticket while the page is already shown: tell it instead of reloading
  $effect(() => {
    const next = asked;
    if (!next || !ticket || !src || next === told) return;
    told = next;
    frame?.contentWindow?.postMessage({ hollr: 1, event: "open", data: repo ? { ticket, repo } : { ticket } }, "*");
  });

  /** links to public pages, asked for by the plugin page (it can't open windows from the sandboxed frame) */
  function onMessage(e: MessageEvent) {
    if (!frame || e.source !== frame.contentWindow) return;
    const req = parseHostRequest(e.data, allowed);
    if (req) {
      handleHost(req);
      return;
    }
    const data = e.data as { type?: unknown; url?: unknown } | null;
    if (data?.type === "hollr-key") {
      replayKey(e.data as Record<string, unknown>);
      return;
    }
    if (data?.type !== "hollr-open-url" || typeof data.url !== "string" || !/^https?:\/\//i.test(data.url)) return;
    openUrl(data.url).catch((err) => (error = errText(err)));
  }

  /** a ⌘/Ctrl shortcut typed while the plugin page had the focus: Hollr's own handlers (⌘K, ⌘1 …) get it as a
   *  keydown on the window, like any key typed outside the frame */
  function replayKey(k: Record<string, unknown>) {
    if (typeof k.key !== "string" || !(k.metaKey || k.ctrlKey)) return;
    window.dispatchEvent(new KeyboardEvent("keydown", {
      key: k.key, code: typeof k.code === "string" ? k.code : "", metaKey: !!k.metaKey, ctrlKey: !!k.ctrlKey,
      shiftKey: !!k.shiftKey, altKey: !!k.altKey, bubbles: true, cancelable: true,
    }));
  }

  function reply(r: HostReply) {
    frame?.contentWindow?.postMessage(r, "*");
  }

  /** the palette theme.ts wrote on <html>; the page mirrors it so it looks like the rest of Hollr */
  function currentTheme() {
    const root = document.documentElement;
    const style = getComputedStyle(root);
    return readTheme((v) => style.getPropertyValue(v), root.dataset.theme !== "light");
  }

  // theme switches (settings, or the system going dark/light) reach an open plugin page at once
  const themeWatch = new MutationObserver(() => {
    frame?.contentWindow?.postMessage({ hollr: 1, event: "theme", data: currentTheme() }, "*");
  });

  /** relay (contract B); gate calls run in parallel, each answered by its id */
  async function handleHost(req: NonNullable<ReturnType<typeof parseHostRequest>>) {
    if (req.type === "reopen") {
      if (!loading && mayReopen(Date.now())) open();
      return;
    }
    if (req.type === "open-session") {
      if (serverById(req.server)) go({ view: "agent", server: req.server, pane: req.pane });
      return;
    }
    if (req.type === "reject") return reply({ hollr: 1, id: req.id, ok: false, error: req.error });
    if (req.type === "theme") return reply({ hollr: 1, id: req.id, ok: true, data: currentTheme() });
    if (req.type === "servers") {
      const data = app.servers.map((s) => ({ id: s.id, label: s.label, self: s.id === server, online: !app.errors[s.id] }));
      return reply({ hollr: 1, id: req.id, ok: true, data });
    }
    if (!serverById(req.server)) return reply({ hollr: 1, id: req.id, ok: false, error: "Unbekannter Server" });
    try {
      reply({ hollr: 1, id: req.id, ok: true, data: await api.gate(req.server, req.command, req.stdin) });
    } catch (err) {
      reply({ hollr: 1, id: req.id, ok: false, error: errText(err) });
    }
  }

  onMount(() => {
    window.addEventListener("message", onMessage);
    themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "data-theme"] });
    open();
    listPlugins(server)
      .then((list) => {
        const p = list.find((p) => p.id === id);
        listed = p?.name;
        allowed = p?.host?.gate ?? [];
      })
      .catch(() => {});
  });

  onDestroy(() => {
    destroyed = true;
    window.removeEventListener("message", onMessage);
    themeWatch.disconnect();
    if (tunnel !== undefined) api.tunnelClose(tunnel).catch(() => {});
  });
</script>

<div class="plugin">
  <div class="bar">
    <button class="ib" title={t("Zurück")} onclick={() => go({ view: "plugins" })}>‹</button>
    <span class="title">{name}</span>
    <span class="srv">{serverById(server)?.label ?? server}</span>
    <button class="ib" class:pinned={isPinned(server, id)} title={isPinned(server, id) ? t("Aus der Navigation lösen") : t("In der Navigation anpinnen")}
      aria-pressed={isPinned(server, id)} onclick={() => togglePin(server, id, name)}><Icon name="pin" size={15} /></button>
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
  .ib.pinned { color: var(--accent); }
  iframe { flex: 1; min-height: 0; width: 100%; border: 0; background: var(--bg); }
  .failed { flex: 1; display: grid; place-content: center; justify-items: center; gap: 6px; color: var(--muted); text-align: center; padding: 24px; }
  .failed p { margin: 0; max-width: 460px; }
  .small { font-size: 12px; color: var(--dim); white-space: pre-wrap; }
  .progress { height: 2px; background: linear-gradient(90deg, transparent, var(--accent), transparent); background-size: 50% 100%;
    background-repeat: no-repeat; animation: slide 1s linear infinite; }
  @keyframes slide { from { background-position: -50% 0; } to { background-position: 150% 0; } }
</style>
