<script lang="ts">
  // Server check (iOS ServerInfoView): load, memory, disks, processes and whether the setup is correct.
  import { onDestroy } from "svelte";
  import { t } from "$lib/i18n";
  import { app, back, go, serverById } from "$lib/store.svelte";
  import * as sapi from "$lib/serverapi";
  import type { ProcessInfo, ServerInfo, ServerTool } from "$lib/serverapi";

  let { server }: { server: string } = $props();

  const srv = $derived(serverById(server));
  let info = $state<ServerInfo | null>(null);
  let tools = $state<ServerTool[] | null>(null);
  let error = $state("");
  let loading = $state(false);
  let onlyStack = $state(false);
  let search = $state("");
  let sortKey = $state<"cpu" | "rssMb" | "name" | "pid" | "user">("cpu");
  let sortDesc = $state(true);
  let expanded = $state<Record<number, boolean>>({});
  let copied = $state("");

  async function load() {
    const s = server;
    loading = true;
    try {
      const r = await sapi.sysinfo(s);
      if (s !== server) return;
      info = r;
      error = "";
    } catch (e) {
      if (s === server) error = sapi.errText(e);
    } finally {
      loading = false;
    }
  }

  async function loadTools() {
    const s = server;
    try {
      const r = await sapi.tools(s);
      if (s === server) tools = r;
    } catch {}
  }

  // poll every 5 s like iOS; a new generation (server switched, view closed) stops the old loop
  let timer: ReturnType<typeof setTimeout> | undefined;
  let gen = 0;
  async function loop(g: number) {
    await load();
    if (g === gen) timer = setTimeout(() => loop(g), 5000);
  }
  $effect(() => {
    void server;
    const g = ++gen;
    info = null;
    tools = null;
    error = "";
    clearTimeout(timer);
    loop(g);
    loadTools();
  });
  onDestroy(() => {
    gen++;
    clearTimeout(timer);
  });

  const failed = $derived(info?.checks.filter((c) => !c.ok).length ?? 0);

  const procs = $derived.by(() => {
    if (!info) return [] as ProcessInfo[];
    const q = search.trim().toLowerCase();
    const list = info.processes.filter(
      (p) => (!onlyStack || p.stack) && (!q || p.command.toLowerCase().includes(q) || p.name.toLowerCase().includes(q)),
    );
    const k = sortKey;
    const dir = sortDesc ? -1 : 1;
    return [...list].sort((a, b) => {
      const x = a[k];
      const y = b[k];
      const c = typeof x === "string" ? x.localeCompare(String(y)) : (x as number) - (y as number);
      return c * dir;
    });
  });

  function sortBy(k: typeof sortKey) {
    if (sortKey === k) sortDesc = !sortDesc;
    else {
      sortKey = k;
      sortDesc = k === "cpu" || k === "rssMb";
    }
  }

  const arrow = (k: typeof sortKey) => (sortKey === k ? (sortDesc ? " ↓" : " ↑") : "");
  const meterColor = (v: number) => (v > 0.9 ? "var(--red)" : v > 0.7 ? "var(--orange)" : "var(--green)");

  const meters = $derived.by(() => {
    if (!info) return [];
    const m = info.memory;
    const out = [
      {
        title: "CPU",
        value: (info.cpu ?? 0) / 100,
        label: info.cpu !== undefined
          ? t("{cpu} % · {cores} Kerne", { cpu: Math.round(info.cpu), cores: info.cores })
          : t("{cores} Kerne", { cores: info.cores }),
      },
      {
        title: t("Last"),
        value: (info.load[0] ?? 0) / Math.max(info.cores, 1),
        label: info.load.map((v) => sapi.num(v, 2)).join(" · "),
      },
      { title: "RAM", value: m.used / Math.max(m.total, 1), label: `${sapi.bytes(m.used)} / ${sapi.bytes(m.total)}` },
    ];
    if (m.swapTotal > 0)
      out.push({ title: "Swap", value: m.swapUsed / m.swapTotal, label: `${sapi.bytes(m.swapUsed)} / ${sapi.bytes(m.swapTotal)}` });
    for (const d of info.disks)
      out.push({ title: d.mount, value: d.used / Math.max(d.total, 1), label: `${sapi.bytes(d.used)} / ${sapi.bytes(d.total)}` });
    return out;
  });

  async function copyFix(fix: string) {
    if (await sapi.copy(fix)) {
      copied = fix;
      setTimeout(() => copied === fix && (copied = ""), 1800);
    }
  }
</script>

<div class="page">
  <div class="page-head">
    <button class="btn" onclick={back} title={t("Zurück")}>‹</button>
    <h1>{t("Server-Info")} · {srv?.label ?? server}</h1>
    <button class="btn" onclick={() => go({ view: "tools", server })}>{t("Werkzeuge")}</button>
    <button class="btn" onclick={load} disabled={loading}>{t("Neu laden")}</button>
  </div>

  {#if error}
    <div class="card warn">⚠ {error}</div>
  {/if}
  {#if app.errors[server] && !error}
    <div class="card warn small">⚠ {app.errors[server]}</div>
  {/if}

  {#if info}
    <div class="card hostcard">
      <div class="host">{info.host}</div>
      <div class="muted">{info.os} · {info.arch} · {info.user}</div>
      <div class="dim small">
        {t("Kernel {kernel} · läuft seit {uptime} · Hollr {hollr}", { kernel: info.kernel, uptime: sapi.duration(info.uptime), hollr: info.hollr })}
      </div>
      {#if tools}
        <div class="versions">
          {#each tools as tool (tool.name)}
            <span class="pill" class:upd={tool.updateAvailable} title={tool.title}>
              {tool.name} <span class="mono">{tool.installed ? (tool.version ?? t("installiert")) : "–"}</span>
              {#if tool.updateAvailable && tool.latest}<span class="mono">→ {tool.latest}</span>{/if}
            </span>
          {/each}
        </div>
      {/if}
    </div>
  {:else if !error}
    <div class="card hostcard">
      <div class="skeleton" style="height: 22px; width: 40%"></div>
      <div class="skeleton" style="height: 14px; width: 60%"></div>
      <div class="skeleton" style="height: 12px; width: 50%"></div>
    </div>
  {/if}

  <div class="section">{t("Auslastung")}</div>
  <div class="meters">
    {#if info}
      {#each meters as m (m.title)}
        <div class="card meter">
          <div class="mhead"><span class="ellipsis">{m.title}</span><span class="mono small muted">{m.label}</span></div>
          <div class="track"><div class="fill" style:width="{Math.max(2, Math.min(1, Math.max(0, m.value)) * 100)}%" style:background={meterColor(m.value)}></div></div>
        </div>
      {/each}
    {:else}
      {#each Array(4) as _, i (i)}
        <div class="card meter"><div class="skeleton" style="height: 14px; width: 70%"></div><div class="skeleton" style="height: 6px"></div></div>
      {/each}
    {/if}
  </div>

  <div class="section">
    {#if info}
      {failed === 0 ? t("Einrichtung · alles korrekt") : t("Einrichtung · {n} Problem(e)", { n: failed })}
    {:else}
      {t("Einrichtung")}
    {/if}
  </div>
  <div class="rows">
    {#if info}
      {#each info.checks as c (c.name)}
        <div class="row check">
          <span class="ico" class:ok={c.ok} class:bad={!c.ok}>{c.ok ? "✓" : "✕"}</span>
          <div class="grow">
            <div>{c.name}</div>
            <div class="small muted">{c.detail}</div>
            {#if !c.ok && c.fix}
              <button class="fix mono" title={t("Befehl kopieren")} onclick={() => copyFix(c.fix!)}>
                <span class="ellipsis">{c.fix}</span><span>{copied === c.fix ? "✓" : "⧉"}</span>
              </button>
            {/if}
          </div>
        </div>
      {/each}
    {:else}
      {#each Array(5) as _, i (i)}
        <div class="row"><div class="skeleton" style="height: 16px; width: {40 + ((i * 13) % 40)}%"></div></div>
      {/each}
    {/if}
  </div>

  <div class="section">{t("Prozesse · nach CPU")}</div>
  <div class="procbar">
    <div class="seg">
      <button class:on={!onlyStack} onclick={() => (onlyStack = false)}>{t("Alle")}</button>
      <button class:on={onlyStack} onclick={() => (onlyStack = true)}>{t("Hollr & Agents")}</button>
    </div>
    <input class="grow" type="search" placeholder={t("Prozess suchen")} bind:value={search} />
  </div>
  <div class="rows procs">
    <div class="phead">
      <button onclick={() => sortBy("name")}>{t("Name")}{arrow("name")}</button>
      <button onclick={() => sortBy("pid")}>PID{arrow("pid")}</button>
      <button onclick={() => sortBy("user")}>{t("Benutzer")}{arrow("user")}</button>
      <button class="num" onclick={() => sortBy("cpu")}>CPU{arrow("cpu")}</button>
      <button class="num" onclick={() => sortBy("rssMb")}>RAM{arrow("rssMb")}</button>
    </div>
    {#if info}
      {#each procs as p (p.pid)}
        <button class="prow" onclick={() => (expanded[p.pid] = !expanded[p.pid])}>
          <span class="pname ellipsis">{#if p.stack}<span class="stack"></span>{/if}{p.name}</span>
          <span class="mono small dim">{p.pid}</span>
          <span class="small muted ellipsis">{p.user}</span>
          <span class="mono small num" class:hot={p.cpu > 50}>{sapi.num(p.cpu)} %</span>
          <span class="mono small num muted">{p.rssMb} MB</span>
          {#if expanded[p.pid]}
            <span class="cmdline mono small">{p.command}</span>
          {/if}
        </button>
      {:else}
        <div class="row muted small">{t("Keine Prozesse gefunden.")}</div>
      {/each}
    {:else}
      {#each Array(8) as _, i (i)}
        <div class="row"><div class="skeleton" style="height: 14px; width: 100%"></div></div>
      {/each}
    {/if}
  </div>
</div>

<style>
  .warn { color: var(--orange); margin-bottom: 12px; }
  .hostcard { display: grid; gap: 4px; }
  .host { font-size: 18px; font-weight: 600; }
  .versions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
  .pill.upd { color: var(--accent); }
  .meters { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 10px; }
  .meter { display: grid; gap: 8px; }
  .mhead { display: flex; justify-content: space-between; gap: 10px; }
  .track { height: 6px; border-radius: 99px; background: color-mix(in srgb, var(--fg) 8%, transparent); overflow: hidden; }
  .fill { height: 100%; border-radius: 99px; transition: width .3s; }
  .check { align-items: flex-start; }
  .ico { width: 18px; text-align: center; font-weight: 700; }
  .ico.ok { color: var(--green); }
  .ico.bad { color: var(--red); }
  .fix { all: unset; cursor: pointer; display: flex; gap: 8px; max-width: 100%; margin-top: 4px; font-size: 12px; color: var(--accent);
    background: color-mix(in srgb, var(--fg) 6%, transparent); border-radius: 8px; padding: 4px 8px; box-sizing: border-box; }
  .fix:hover { background: color-mix(in srgb, var(--accent) 15%, transparent); }
  .procbar { display: flex; gap: 10px; align-items: center; margin-bottom: 8px; }
  .seg { display: inline-flex; background: var(--raised); border: 1px solid var(--border); border-radius: 8px; padding: 2px; flex: none; }
  .seg button { all: unset; cursor: pointer; padding: 3px 12px; border-radius: 6px; font-size: 12px; color: var(--muted); }
  .seg button.on { background: var(--card); color: var(--fg); box-shadow: 0 0 0 1px var(--border); }
  .procs { --cols: minmax(0, 1fr) 70px 110px 80px 80px; }
  .phead, .prow { display: grid; grid-template-columns: var(--cols); gap: 10px; padding: 6px 14px; align-items: center; }
  .phead button { all: unset; cursor: pointer; font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
  .phead button:hover { color: var(--fg); }
  .num { text-align: right; }
  .prow { all: unset; box-sizing: border-box; display: grid; grid-template-columns: var(--cols); gap: 10px; padding: 6px 14px; width: 100%; cursor: pointer; }
  .prow:hover { background: color-mix(in srgb, var(--fg) 5%, transparent); }
  .pname { display: flex; align-items: center; gap: 6px; }
  .stack { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); flex: none; }
  .hot { color: var(--orange); }
  .cmdline { grid-column: 1 / -1; color: var(--muted); white-space: pre-wrap; word-break: break-all; user-select: text; }
</style>
