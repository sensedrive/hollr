<script lang="ts">
  import Icon from "$lib/components/git/Icon.svelte";
  // "Woran ich arbeite": one project (repo/space) with its sessions – status, branch, the current step or last
  // words, TODO progress and last activity, so a glance is enough to be back in context. Quick actions on hover.
  import { identityColor } from "$lib/dashboard";
  import { statusLabel, t } from "$lib/i18n";
  import type { AgentOpen, PaneRef } from "$lib/store.svelte";
  import type { WorkRow } from "./context.svelte";
  import { badge, refTitle, relTime, statusColor } from "./util";

  let { name, server, rows, selectedId, onOpen, onSelect, onMenu }: {
    name: string;
    /** server label, when several servers are paired */
    server?: string;
    rows: WorkRow[];
    selectedId?: string;
    onOpen: (r: PaneRef, open?: AgentOpen, url?: string) => void;
    onSelect: (r: PaneRef) => void;
    onMenu: (e: MouseEvent, r: PaneRef) => void;
  } = $props();

  const counts = $derived.by(() => {
    const n = (s: string) => rows.filter((r) => r.ref.pane.status === s).length;
    return [
      [n("working"), t("{n} arbeitet", { n: n("working") }), "var(--purple)"],
      [n("blocked"), t("{n} wartet", { n: n("blocked") }), "var(--orange)"],
      [n("done"), t("{n} fertig", { n: n("done") }), "var(--green)"],
    ].filter(([c]) => c) as [number, string, string][];
  });
</script>

<div class="project">
  <div class="phead" style:--p={identityColor(name)}>
    <span class="pname ellipsis">{name}</span>
    {#if server}<span class="dim small">{server}</span>{/if}
    <span class="grow"></span>
    {#each counts as [, label, color]}<span class="small" style:color>{label}</span>{/each}
  </div>
  {#each rows as w (w.ref.id)}
    {@const r = w.ref}
    {@const b = badge(r.pane.agent)}
    {@const running = r.pane.status === "working"}
    {@const line = running ? (w.ctx?.step ?? w.ctx?.last) : (w.ctx?.last ?? w.ctx?.step)}
    <div class="wrow" class:sel={selectedId === r.id} data-fid="w:{r.id}">
      <button class="main" data-nav onclick={() => onOpen(r)} onfocus={() => onSelect(r)}
        oncontextmenu={(e) => { e.preventDefault(); onMenu(e, r); }} title="{t('Chat öffnen')} (↩)">
        <span class="badge" style:color={b.color}>{b.short}</span>
        <span class="body">
          <span class="top">
            <span class="dot" class:pulse={running} style:background={statusColor(r.pane.status)}></span>
            <span class="name ellipsis">{refTitle(r)}</span>
            {#if w.ctx?.title && w.ctx.title !== refTitle(r)}<span class="sub ellipsis">{w.ctx.title}</span>{/if}
            {#if w.project.branch}<span class="branch mono ellipsis"><Icon name="⑂" size={15} /> {w.project.branch}{#if w.project.worktree} <Icon name="⧉" size={15} />{/if}</span>{/if}
          </span>
          <span class="line ellipsis">
            <span style:color={statusColor(r.pane.status)}>{r.pane.agent ? statusLabel(r.pane.status) : t("Terminal")}</span>
            {#if line}<span class="muted"> · {running && w.ctx?.step ? "▸ " : ""}{line}</span>{/if}
          </span>
        </span>
        <span class="meta">
          {#if w.ctx?.todo}
            {@const td = w.ctx.todo}
            <span class="todo" title={td.current ?? ""}><span class="bar"><span style:width="{(td.done / td.total) * 100}%"></span></span>{td.done}/{td.total}</span>
          {/if}
          {#if w.changed}<span class="dim" title={new Date(w.changed).toLocaleString()}>{relTime(w.changed)}</span>{/if}
        </span>
      </button>
      <div class="acts">
        <button title="{t('Terminal öffnen')} (T)" aria-label={t("Terminal öffnen")} onclick={() => onOpen(r, "terminal")}><Icon name="terminal" size={14} /></button>
        <button title="{t('Git & Dateien')} (G)" aria-label={t("Git & Dateien")} onclick={() => onOpen(r, "git")}><Icon name="⑂" size={15} /></button>
        {#each w.ports.slice(0, 1) as p (p.port)}
          <button title="{t('Im Browser öffnen')} :{p.port}" onclick={() => onOpen(r, "browser", `http://localhost:${p.port}`)}><Icon name="◍" size={15} /></button>
        {/each}
        <button title={t("Mehr …")} aria-label={t("Mehr …")} onclick={(e) => onMenu(e, r)}>⋯</button>
      </div>
    </div>
  {/each}
</div>

<style>
  .project { display: grid; gap: 2px; padding: 10px; border-radius: 16px; background: var(--card); border: 1px solid var(--border); }
  .phead { display: flex; align-items: center; gap: 8px; padding: 2px 6px 6px; min-width: 0; }
  .phead::before { content: ""; width: 4px; height: 15px; border-radius: 2px; background: var(--p); flex: none; }
  .pname { font-weight: 650; flex: none; max-width: 60%; }
  .phead > .small { white-space: nowrap; }
  .phead > .dim { overflow: hidden; text-overflow: ellipsis; min-width: 0; flex: 0 1 auto; }
  .wrow { position: relative; border-radius: 10px; }
  .wrow:hover, .wrow.sel { background: color-mix(in srgb, var(--fg) 5%, transparent); }
  .wrow.sel { box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 60%, transparent); }
  .main { all: unset; box-sizing: border-box; cursor: pointer; display: flex; align-items: center; gap: 10px; width: 100%; padding: 7px 8px; border-radius: 10px; }
  .main:focus-visible { outline: 2px solid var(--accent); }
  .badge { flex: none; width: 28px; height: 28px; display: grid; place-items: center; border-radius: 8px; font: 700 10px var(--mono);
    background: color-mix(in srgb, currentColor 14%, transparent); }
  .body { flex: 1; min-width: 0; display: grid; gap: 2px; }
  .top { display: flex; align-items: center; gap: 7px; min-width: 0; }
  .dot { width: 7px; height: 7px; border-radius: 50%; flex: none; }
  .pulse { animation: pulse 1.6s ease-in-out infinite; }
  @keyframes pulse { 50% { opacity: .35; } }
  .name { font-weight: 600; font-size: 13px; flex: none; max-width: 45%; }
  .sub { font-size: 12px; color: var(--muted); min-width: 0; }
  .branch { font-size: 11px; color: var(--muted); margin-left: auto; flex: none; max-width: 40%; }
  .line { font-size: 12px; }
  .meta { flex: none; display: flex; flex-direction: column; align-items: flex-end; gap: 3px; font-size: 11px; font-variant-numeric: tabular-nums; }
  .todo { display: inline-flex; align-items: center; gap: 5px; color: var(--muted); }
  .bar { width: 44px; height: 4px; border-radius: 99px; background: color-mix(in srgb, var(--fg) 10%, transparent); overflow: hidden; }
  .bar span { display: block; height: 100%; background: var(--green); }
  .acts { position: absolute; right: 8px; top: 50%; transform: translateY(-50%); display: flex; gap: 4px; opacity: 0; transition: opacity .12s; }
  .wrow:hover .acts, .wrow.sel .acts, .acts:focus-within { opacity: 1; }
  .wrow:hover .meta, .wrow.sel .meta { visibility: hidden; }
  .acts button { all: unset; cursor: pointer; min-width: 24px; height: 24px; padding: 0 4px; box-sizing: border-box; display: grid; place-items: center;
    border-radius: 7px; font-size: 11px; background: var(--side); border: 1px solid var(--border); color: var(--muted); }
  .acts button:hover { color: var(--fg); border-color: var(--accent); }
  .grow { flex: 1; }
</style>
