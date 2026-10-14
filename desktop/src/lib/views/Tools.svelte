<script lang="ts">
  // Install / update herdr, omp, Claude Code, Codex and the Hollr server (iOS ToolsView, `tools` gate).
  import { onDestroy } from "svelte";
  import { t } from "$lib/i18n";
  import { back, go, serverById } from "$lib/store.svelte";
  import * as sapi from "$lib/serverapi";
  import type { ServerTool } from "$lib/serverapi";

  let { server }: { server: string } = $props();

  const srv = $derived(serverById(server));
  let tools = $state<ServerTool[] | null>(null);
  let error = $state("");
  let checking = $state(false);
  let starting = $state<Record<string, boolean>>({});
  let openLogs = $state<Record<string, boolean>>({});
  let confirmReinstall = $state("");

  const anyRunning = $derived(tools?.some((x) => x.running) ?? false);

  async function load() {
    const s = server;
    try {
      const r = await sapi.tools(s);
      if (s !== server) return;
      tools = r;
      error = "";
    } catch (e) {
      if (s === server) error = sapi.errText(e);
    }
  }

  async function check() {
    checking = true;
    try {
      tools = await sapi.tools(server, { check: true });
      error = "";
    } catch (e) {
      error = sapi.errText(e);
    }
    checking = false;
  }

  async function run(name: string) {
    confirmReinstall = "";
    starting[name] = true;
    try {
      tools = await sapi.tools(server, { run: name });
      error = "";
      schedule(true);
    } catch (e) {
      error = sapi.errText(e);
    }
    starting[name] = false;
  }

  // poll while something is installing (2 s), otherwise every 15 s – like iOS
  let timer: ReturnType<typeof setTimeout> | undefined;
  let gen = 0;
  function schedule(fast = anyRunning) {
    clearTimeout(timer);
    const g = gen;
    timer = setTimeout(async () => {
      await load();
      if (g === gen) schedule();
    }, fast ? 2000 : 15000);
  }
  $effect(() => {
    void server;
    const g = ++gen;
    tools = null;
    error = "";
    load().then(() => g === gen && schedule());
  });
  onDestroy(() => {
    gen++;
    clearTimeout(timer);
  });

  let logEls: Record<string, HTMLElement | undefined> = {};
  // keep a running log scrolled to the end
  $effect(() => {
    for (const tool of tools ?? []) {
      void tool.log;
      const el = logEls[tool.name];
      if (el && tool.running) queueMicrotask(() => (el.scrollTop = el.scrollHeight));
    }
  });
</script>

<div class="page">
  <div class="page-head">
    <button class="btn" onclick={back} title={t("Zurück")}>‹</button>
    <h1>{t("Werkzeuge auf {server}", { server: srv?.label ?? server })}</h1>
    <button class="btn" onclick={() => go({ view: "serverinfo", server })}>{t("Server-Info")}</button>
    <button class="btn" onclick={check} disabled={checking || !tools}>{checking ? t("Suche …") : t("Nach Updates suchen")}</button>
  </div>

  {#if error}<div class="card warn">⚠ {error}</div>{/if}

  <div class="rows">
    {#if tools}
      {#each tools as tool (tool.name)}
        {@const open = tool.running || !!openLogs[tool.name]}
        <div class="tool">
          <div class="top">
            <div class="grow">
              <div class="title">{tool.title}</div>
              <div class="ver mono small">
                <span>{tool.installed ? (tool.version ?? t("installiert")) : t("nicht installiert")}</span>
                {#if tool.latest && (tool.updateAvailable || !tool.installed)}
                  <span>→</span><span class="target">{tool.latest}</span>
                {/if}
              </div>
            </div>
            {#if tool.running || starting[tool.name]}
              <span class="pill running">{tool.installed ? t("Aktualisiere …") : t("Installiere …")}</span>
            {:else if !tool.installed}
              <button class="btn primary" onclick={() => run(tool.name)}>
                {tool.latest ? t("{version} installieren", { version: tool.latest }) : t("Installieren")}
              </button>
            {:else if tool.updateAvailable}
              <button class="btn primary" onclick={() => run(tool.name)}>
                {tool.latest ? t("Auf {version} aktualisieren", { version: tool.latest }) : t("Aktualisieren")}
              </button>
            {:else if confirmReinstall === tool.name}
              <button class="btn" onclick={() => (confirmReinstall = "")}>{t("Abbrechen")}</button>
              <button class="btn primary" onclick={() => run(tool.name)}>{t("Trotzdem neu installieren")}</button>
            {:else}
              <span class="current">✓ {t("Aktuell")}</span>
              <button class="btn small" title={t("Trotzdem neu installieren")} onclick={() => (confirmReinstall = tool.name)}>↻</button>
            {/if}
          </div>
          {#if tool.running}
            <div class="skeleton progress"></div>
          {/if}
          {#if tool.exit !== undefined && tool.exit !== null && !tool.running}
            <div class="small" class:ok={tool.exit === 0} class:bad={tool.exit !== 0}>
              {tool.exit === 0 ? `✓ ${t("Fertig")}` : `✕ ${t("Fehlgeschlagen (Exit {exit})", { exit: tool.exit })}`}
            </div>
          {/if}
          {#if tool.log}
            {#if open}
              <pre class="log mono" class:live={tool.running} bind:this={logEls[tool.name]}>{tool.log}</pre>
            {/if}
            {#if !tool.running}
              <button class="link small" onclick={() => (openLogs[tool.name] = !open)}>
                {open ? t("Protokoll ausblenden") : t("Protokoll anzeigen")}
              </button>
            {/if}
          {/if}
        </div>
      {/each}
    {:else if !error}
      {#each Array(5) as _, i (i)}
        <div class="tool">
          <div class="top">
            <div class="grow" style="display: grid; gap: 6px">
              <div class="skeleton" style="height: 16px; width: 30%"></div>
              <div class="skeleton" style="height: 12px; width: 20%"></div>
            </div>
            <div class="skeleton" style="height: 28px; width: 100px"></div>
          </div>
        </div>
      {/each}
    {/if}
  </div>
  <p class="dim small">
    {t("Installiert und aktualisiert im Hintergrund auf dem Server – läuft weiter, auch wenn du die App schließt.")}
  </p>
</div>

<style>
  .warn { color: var(--orange); margin-bottom: 12px; }
  .tool { padding: 12px 14px; display: grid; gap: 8px; }
  .top { display: flex; align-items: center; gap: 10px; }
  .title { font-weight: 550; }
  .ver { display: flex; gap: 6px; color: var(--muted); }
  .target { color: var(--accent); }
  .current { color: var(--green); font-size: 13px; }
  .btn.small { padding: 2px 8px; }
  .running { color: var(--purple); }
  .progress { height: 4px; }
  .ok { color: var(--green); }
  .bad { color: var(--red); }
  .log { margin: 0; font-size: 11px; color: var(--muted); background: color-mix(in srgb, var(--fg) 5%, transparent);
    border-radius: 8px; padding: 8px 10px; max-height: 320px; overflow: auto; white-space: pre-wrap; word-break: break-all; user-select: text; }
  .log.live { max-height: 140px; }
  .link { all: unset; cursor: pointer; color: var(--accent); justify-self: start; }
  .link:hover { text-decoration: underline; }
  p { margin-top: 12px; }
</style>
