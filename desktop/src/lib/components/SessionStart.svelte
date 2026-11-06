<script lang="ts">
  // The start of a fresh session instead of an empty chat (MagicFink hollr-desktop v12 „SessionStart“): who runs
  // (mark, name, version), what's known (model · thinking, context, folder, branch), MCP in one line (failures
  // folded), an announced update with one action (the server's tools: `omp update`), first steps for the composer
  // and the agent's own tip. `loading`: the agent is still starting – only what Hollr knows shows, for a few seconds.
  import { onDestroy } from "svelte";
  import type { Timeline } from "../api";
  import { lang, t } from "../i18n";
  import { shortPath } from "../agent";
  import { contextShare, firstSteps } from "../sessionStart";
  import * as sapi from "../serverapi";
  import { go } from "../store.svelte";
  import Icon from "./git/Icon.svelte";

  let { server, agent, cwd, timeline, loading, live = false, onSuggest }: {
    server: string;
    agent: "omp" | "claude";
    cwd: string;
    timeline: Timeline | null;
    loading: boolean;
    /** omp's /live works here: without a tip of its own, the start says how to talk to it */
    live?: boolean;
    /** a first step was picked: into the composer, not sent */
    onSuggest: (text: string) => void;
  } = $props();

  const uid = $props.id();
  const name = $derived(agent === "omp" ? "omp" : "Claude Code");
  const start = $derived(timeline?.start);
  const line = $derived(timeline?.line);
  const model = $derived(line?.model ?? start?.model ?? timeline?.model);
  const LEVELS: Record<string, string> = {
    minimal: "minimal", low: "niedrig", medium: "mittel", high: "hoch", xhigh: "sehr hoch", max: "maximal",
  };
  const level = $derived(line?.thinking ?? start?.effort);
  const levelText = $derived(level ? t(agent === "omp" ? "Thinking {level}" : "Effort {level}", { level: t(LEVELS[level] ?? level) }) : "");
  const ctx = $derived(contextShare(line?.context));
  const pct = $derived(ctx ? new Intl.NumberFormat(lang() === "de" ? "de-DE" : "en-US", { maximumFractionDigits: 1 }).format(ctx.pct) : "");
  const mcp = $derived(start?.mcp);
  const failed = $derived(mcp ? Math.max(mcp.failed.length, mcp.failedCount ?? 0) : 0);
  const hasDetail = $derived(!!mcp && (mcp.failed.length > 0 || mcp.connected.length + mcp.pending.length > 0));
  const steps = $derived(firstSteps(line).map((s) => t(s.text, s.vars)));
  let open = $state(false);

  // ------------------------------------------------------------ update (the server's tools, like Werkzeuge)
  let updating = $state<"" | "running" | "done" | "failed">("");
  let updateError = $state("");
  let destroyed = false;
  onDestroy(() => (destroyed = true));
  async function update() {
    updating = "running";
    updateError = "";
    try {
      let tools = await sapi.tools(server, { run: agent });
      // at most ~5 min, polled like the tools page while something installs
      for (let i = 0; i < 150 && !destroyed; i++) {
        const tool = tools.find((x) => x.name === agent);
        if (tool && !tool.running) {
          updating = tool.exit === 0 ? "done" : "failed";
          if (tool.exit !== 0) updateError = tool.log?.split("\n").at(-1) ?? "";
          return;
        }
        await new Promise((r) => setTimeout(r, 2000));
        tools = await sapi.tools(server);
      }
      if (!destroyed) updating = "failed";
    } catch (e) {
      updating = "failed";
      updateError = sapi.errText(e);
    }
  }
</script>

<section class="sstart" class:loading aria-label={t("Neue Sitzung mit {agent}", { agent: name })} aria-busy={loading}>
  <header class="id">
    <span class="mark">
      {#if agent === "omp"}
        <!-- omp's pixel π (its terminal logo) in its own colours -->
        <svg viewBox="0 0 12 10" width="30" height="25" aria-hidden="true">
          <defs>
            <linearGradient id="omp-{uid}" x1="0" y1="0" x2="0" y2="10" gradientUnits="userSpaceOnUse">
              <stop offset="0" style:stop-color="var(--pink)" />
              <stop offset="0.45" style:stop-color="var(--purple)" />
              <stop offset="1" style:stop-color="var(--blue)" />
            </linearGradient>
          </defs>
          <g fill="url(#omp-{uid})">
            <rect x="0" y="0" width="12" height="2" />
            <rect x="3" y="2" width="2" height="4" />
            <rect x="3" y="6" width="2" height="2" opacity="0.45" />
            <rect x="7" y="2" width="2" height="8" />
          </g>
        </svg>
      {:else}
        <!-- Claude Code's pixel creature from its banner -->
        <svg viewBox="0 0 12 8" width="30" height="20" aria-hidden="true">
          <g class="claude">
            <rect x="2" y="0" width="8" height="5" /><rect x="0" y="2" width="2" height="2" /><rect x="10" y="2" width="2" height="2" />
            <rect x="2.5" y="5" width="1" height="2" /><rect x="4.5" y="5" width="1" height="2" />
            <rect x="6.5" y="5" width="1" height="2" /><rect x="8.5" y="5" width="1" height="2" />
          </g>
          <g class="eyes"><rect x="4" y="1.5" width="1" height="1.5" /><rect x="7" y="1.5" width="1" height="1.5" /></g>
        </svg>
      {/if}
    </span>
    <div class="who">
      <h2 class="name">{name}{#if start?.version}<span class="ver">v{start.version}</span>{/if}</h2>
      <p class="sub">
        {#if loading}
          <Icon name="loader" size={12} spin /> {t("{agent} startet …", { agent: name })}
        {:else}
          <span class="ready"></span> {t("Neue Sitzung · bereit")}{#if start?.plan}<span class="dim">&nbsp;· {start.plan}</span>{/if}
        {/if}
      </p>
    </div>
  </header>

  <dl class="facts">
    <div class="fact">
      <dt>{t("Modell")}</dt>
      <dd>
        {#if model}{model}{#if levelText}<span class="muted">&nbsp;· {levelText}</span>{/if}
        {:else if loading}<span class="skeleton sk" style:width="62%"></span>
        {:else}<span class="muted">–</span>{/if}
      </dd>
    </div>
    <div class="fact">
      <dt>{t("Kontext")}</dt>
      <dd>
        {#if ctx}{pct} %&nbsp;<span class="muted">{t("von {n}", { n: ctx.window })}</span>
          <span class="bar" aria-hidden="true"><span style:width="{Math.max(2, Math.min(100, ctx.pct))}%"></span></span>
        {:else if loading}<span class="skeleton sk" style:width="44%"></span>
        {:else}<span class="muted">{t("noch leer")}</span>{/if}
      </dd>
    </div>
    {#if cwd}
      <div class="fact">
        <dt>{t("Ordner")}</dt>
        <dd class="mono path" title={cwd}><span>{shortPath(cwd)}</span></dd>
      </div>
    {/if}
    {#if line?.branch}
      <div class="fact">
        <dt>Branch</dt>
        <dd>
          <Icon name="branch" size={13} />&nbsp;<span class="mono">{line.branch}</span>
          {#if line.dirty}<span class="dirty">{line.dirty === 1 ? t("1 offene Änderung") : t("{n} offene Änderungen", { n: line.dirty })}</span>
          {:else}<span class="muted">&nbsp;· {t("sauber")}</span>{/if}
        </dd>
      </div>
    {/if}
  </dl>

  {#if !loading && mcp}
    <div class="conn" class:bad={failed > 0}>
      <button class="head" aria-expanded={hasDetail ? open : undefined} disabled={!hasDetail} onclick={() => (open = !open)}>
        <Icon name="server" size={14} />
        <span class="label">MCP</span>
        {#if mcp.connected.length}<span class="pill ok"><span class="dot"></span>{t("{n} verbunden", { n: mcp.connected.length })}</span>{/if}
        {#if failed}<span class="pill bad"><span class="dot"></span>{t("{n} fehlgeschlagen", { n: failed })}</span>{/if}
        {#if mcp.pending.length}<span class="pill wait"><Icon name="loader" size={11} spin />{t("{n} verbindet", { n: mcp.pending.length })}</span>{/if}
        <span class="grow"></span>
        {#if hasDetail}<span class="more">{open ? t("Weniger") : t("Details")}<Icon name={open ? "chevronD" : "chevronR"} size={13} /></span>{/if}
      </button>
      {#if open && hasDetail}
        <ul>
          {#each mcp.failed as f (f.name)}
            <li class="bad">
              <span class="srv"><span class="dot"></span>{f.name}</span>
              {#if f.error}<code class="err">{f.error}</code>{/if}
              {#if f.config}<span class="cfg mono" title={f.config}>{t("aus {file}", { file: f.config })}</span>{/if}
            </li>
          {/each}
          {#if mcp.connected.length}<li class="ok"><span class="srv"><span class="dot"></span>{mcp.connected.join(", ")}</span></li>{/if}
          {#if mcp.pending.length}<li class="wait"><span class="srv"><span class="dot"></span>{t("{names} – verbindet noch", { names: mcp.pending.join(", ") })}</span></li>{/if}
        </ul>
      {/if}
      {#if failed && !mcp.failed.length}
        <p class="hint">{t("Details zeigt /mcp im Terminal.")}</p>
      {/if}
    </div>
  {/if}

  {#if !loading && start?.update}
    <div class="update">
      <Icon name={updating === "done" ? "check" : "download"} size={15} />
      <span class="grow">
        {#if updating === "done"}
          <b>{t("{agent} {version} ist installiert", { agent: name, version: start.update })}</b><span class="muted"> · {t("gilt ab der nächsten Sitzung")}</span>
        {:else if updating === "failed"}
          <b>{t("Update fehlgeschlagen")}</b>{#if updateError}<span class="muted"> · {updateError}</span>{/if}
        {:else}
          <b>{name} {start.update}</b> {t("ist verfügbar")}<span class="muted"> · {t("gilt ab der nächsten Sitzung")}</span>
        {/if}
      </span>
      {#if updating === "failed"}
        <button class="btn small" onclick={() => go({ view: "tools", server })}>{t("Werkzeuge …")}</button>
      {:else if updating !== "done"}
        <button class="btn small" disabled={updating === "running"} onclick={update}>
          <Icon name={updating === "running" ? "loader" : "download"} size={13} spin={updating === "running"} />
          {updating === "running" ? t("Aktualisiert …") : t("Jetzt aktualisieren")}
        </button>
      {/if}
    </div>
  {/if}

  {#if !loading}
    <div class="next">
      <ul class="steps" aria-label={t("Erste Schritte")}>
        {#each steps as s (s)}
          <li><button onclick={() => onSuggest(s)}><Icon name="corner" size={13} /><span>{s}</span></button></li>
        {/each}
      </ul>
      {#if start?.tip}
        <p class="tip"><Icon name="sparkle" size={13} /><span><span class="muted">{t("Tipp von {agent}:", { agent: name })}</span> {start.tip}</span></p>
      {:else if live}
        <p class="tip"><Icon name="activity" size={13} /><span><span class="muted">{t("Klicke auf „Live“ und sprich mit omp.")}</span> {t("Was du sagst, landet direkt in dieser Session – wie /live am Rechner.")}</span></p>
      {/if}
    </div>
  {:else}
    <p class="hint">{t("Modell, Verbindungen und Hinweise erscheinen, sobald {agent} bereit ist.", { agent: name })}</p>
  {/if}
</section>

<style>
  .sstart { display: flex; flex-direction: column; gap: 16px; width: 100%; max-width: 640px; margin: 0 auto; padding: 8vh 0 16px; }
  .id { display: flex; align-items: center; gap: 14px; }
  .mark { flex: none; width: 52px; height: 52px; border-radius: 14px; display: grid; place-items: center; background: var(--raised);
    border: 1px solid color-mix(in srgb, var(--fg) 8%, transparent); }
  .mark svg { display: block; shape-rendering: crispEdges; }
  .loading .mark { animation: breathe 1.8s ease-in-out infinite; }
  @keyframes breathe { 50% { opacity: .55; } }
  @media (prefers-reduced-motion: reduce) { .loading .mark { animation: none; } }
  .claude { fill: var(--pink); }
  .eyes { fill: var(--raised); }
  .who { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .name { margin: 0; font-size: 22px; font-weight: 650; line-height: 1.2; display: flex; align-items: baseline; gap: 10px; }
  .ver { font: 400 12px var(--mono); color: var(--muted); }
  .sub { margin: 0; font-size: 13px; color: var(--muted); display: flex; align-items: center; gap: 6px; }
  .ready { width: 7px; height: 7px; border-radius: 50%; background: var(--green); }

  .facts { margin: 0; display: grid; grid-template-columns: 1fr 1fr; gap: 1px; border-radius: 12px; overflow: hidden;
    border: 1px solid var(--border); background: var(--border); }
  .fact { background: var(--card); padding: 10px 14px; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
  dt { font-size: 11px; color: var(--dim); text-transform: uppercase; letter-spacing: .05em; }
  dd { margin: 0; font-size: 13.5px; min-height: 20px; display: flex; align-items: center; white-space: nowrap; overflow: hidden; }
  dd .mono, .path { font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; }
  /* a long folder keeps its end: cut at the start */
  dd.path { display: block; direction: rtl; text-align: left; line-height: 20px; }
  dd.path span { direction: ltr; unicode-bidi: isolate; }
  .dirty { margin-left: 8px; font-size: 12px; color: var(--orange); }
  .bar { flex: 1; max-width: 80px; height: 4px; margin-left: 8px; border-radius: 99px; overflow: hidden;
    background: color-mix(in srgb, var(--fg) 10%, transparent); }
  .bar span { display: block; height: 100%; border-radius: inherit; background: var(--accent); }
  .sk { display: block; height: 12px; border-radius: 6px; }

  .conn { border: 1px solid var(--border); border-radius: 12px; background: var(--card); }
  .conn.bad { border-color: color-mix(in srgb, var(--red) 30%, var(--border)); }
  .head { all: unset; box-sizing: border-box; width: 100%; display: flex; align-items: center; flex-wrap: wrap; gap: 4px 10px; padding: 9px 14px;
    font-size: 13px; color: var(--muted); cursor: pointer; border-radius: inherit; }
  .head:disabled { cursor: default; }
  .head:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  .label { color: var(--fg); font-weight: 500; }
  .pill { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; white-space: nowrap; }
  .pill.bad { color: var(--red); }
  .dot { flex: none; width: 6px; height: 6px; border-radius: 50%; background: var(--dim); }
  .ok .dot { background: var(--green); }
  .bad .dot { background: var(--red); }
  .grow { flex: 1; min-width: 0; }
  .more { display: inline-flex; align-items: center; gap: 2px; font-size: 12px; color: var(--dim); }
  .head:not(:disabled):hover .more { color: var(--fg); }
  ul { list-style: none; margin: 0; padding: 0; }
  .conn ul { padding: 10px 14px 12px; display: flex; flex-direction: column; gap: 10px; border-top: 1px solid var(--border); }
  .conn li { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
  .srv { display: flex; align-items: center; gap: 8px; font-size: 13px; }
  .err { font: 12px/1.5 var(--mono); color: var(--muted); background: var(--raised); border-radius: 6px; padding: 6px 8px; margin-left: 14px;
    white-space: pre-wrap; overflow-wrap: anywhere; user-select: text; }
  .cfg { margin-left: 14px; font-size: 11.5px; color: var(--dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .hint { margin: 0; padding: 0 14px 10px; font-size: 12px; color: var(--dim); }
  .sstart > .hint { padding: 0; }

  .update { display: flex; align-items: center; gap: 10px; padding: 8px 8px 8px 14px; border-radius: 12px; font-size: 13px; color: var(--orange);
    background: var(--card); border: 1px solid var(--border); }
  .update .grow { color: var(--fg); }
  .update .btn { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; padding: 4px 10px; white-space: nowrap; }

  .next { display: flex; flex-direction: column; gap: 12px; margin-top: 8px; }
  .steps { display: flex; flex-direction: column; gap: 2px; }
  .steps button { all: unset; box-sizing: border-box; width: 100%; display: flex; align-items: center; gap: 10px; padding: 7px 10px; border-radius: 8px;
    font-size: 13.5px; color: var(--muted); cursor: pointer; }
  .steps button :global(.icon) { color: var(--dim); }
  .steps button:hover { background: var(--card); color: var(--fg); }
  .steps button:focus-visible { outline: 2px solid var(--accent); }
  .tip { margin: 0; display: flex; gap: 10px; padding: 0 10px; font-size: 12px; line-height: 1.5; color: var(--dim); }
  .tip :global(.icon) { margin-top: 2px; color: var(--purple); }

  @media (max-width: 640px) {
    .sstart { padding-top: 24px; }
    .facts { grid-template-columns: 1fr; }
    .update { flex-wrap: wrap; }
  }
</style>
