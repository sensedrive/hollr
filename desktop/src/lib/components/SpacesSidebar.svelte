<script lang="ts">
  // Sidebar like herdr's "spaces" list, for every paired server: repos with their branch, worktrees nested
  // below (├─ / └─, foldable), plain workspaces standalone. One status dot per space from its sessions.
  // A click jumps straight into the session that needs you most; ✕ / right-click hides a space here and on the
  // dashboard (it comes back by itself as soon as it needs you). 〰 shows where a live call runs.
  import { onMount } from "svelte";
  import { t } from "$lib/i18n";
  import { allPanes, app, dialogs, go, nav, refreshSpaces, tabName, type PaneRef } from "$lib/store.svelte";
  import ContextMenu from "$lib/views/dashboard/ContextMenu.svelte";
  import { statusRank, type MenuItem } from "$lib/views/dashboard/util";
  import { groupSpaces, type FullSpace } from "$lib/views/spaces/spaces";
  import LiveMark from "./LiveMark.svelte";
  import { hiddenSpaces } from "$lib/hiddenSpaces.svelte";
  import { currentServer } from "$lib/currentServer.svelte";

  const FOLDED = "hollr.sidebar.folded";
  const loadSet = (key: string) => {
    try {
      return new Set<string>(JSON.parse(localStorage.getItem(key) ?? "[]"));
    } catch {
      return new Set<string>();
    }
  };
  let folded = $state(loadSet(FOLDED));
  const persist = (key: string, set: Set<string>) => {
    try {
      localStorage.setItem(key, JSON.stringify([...set]));
    } catch {}
  };
  function toggle(set: Set<string>, key: string, id: string, on: boolean) {
    const next = new Set(set);
    if (on) next.add(id);
    else next.delete(id);
    persist(key, next);
    return next;
  }

  onMount(() => {
    // pushed changes refresh spaces right away (listenFeeds); this is the safety net for servers without a feed
    const timer = setInterval(() => {
      if (app.servers.some((s) => !app.live[s.id])) refreshSpaces();
    }, 10_000);
    return () => clearInterval(timer);
  });

  /** the space's sessions, the one that needs you first */
  const panesOf = (server: string, ws: string) =>
    allPanes(server).filter((r) => r.workspace.id === ws).sort((a, b) => statusRank(a) - statusRank(b));

  /** live status from the sessions (fresher than the space list), else what the server reported */
  function statusOf(server: string, sp: FullSpace): string {
    const panes = panesOf(server, sp.id);
    for (const s of ["blocked", "working", "done", "idle"]) if (panes.some((r) => r.pane.status === s)) return s;
    return sp.status ?? "unknown";
  }

  // only the current remote (the server tabs above switch it)
  const sections = $derived(
    app.servers.filter((s) => s.id === currentServer()).map((s) => {
      const spaces = (app.spaces[s.id] ?? []) as FullSpace[];
      // hidden ones (also off the dashboard) stay away until they need you
      const visible = spaces.filter((sp) => !hiddenSpaces.has(s.id, sp.id) || statusOf(s.id, sp) === "blocked");
      return { server: s, loaded: app.spaces[s.id] !== undefined, groups: groupSpaces(visible) };
    }),
  );

  const currentWs = $derived.by(() => {
    const r = nav.route;
    if (r.view === "space") return `${r.server}|${r.ws}`;
    if (r.view === "agent") {
      const ref = allPanes(r.server).find((p) => p.pane.pane === r.pane);
      return ref ? `${r.server}|${ref.workspace.id}` : "";
    }
    return "";
  });

  function open(server: string, sp: FullSpace) {
    const first = panesOf(server, sp.id)[0];
    if (first) go({ view: "agent", server, pane: first.pane.pane });
    else go({ view: "space", server, ws: sp.id });
  }

  let menu = $state<{ x: number; y: number; items: MenuItem[] } | null>(null);
  function rowMenu(e: MouseEvent, server: string, sp: FullSpace) {
    e.preventDefault();
    const sessions: MenuItem[] = panesOf(server, sp.id).map((r: PaneRef) => ({
      label: `${tabName(r.tab.label, r.workspace.label)} · ${r.pane.agent ?? t("Terminal")}`,
      icon: r.pane.agent ? "↗" : ">_",
      action: () => go({ view: "agent", server, pane: r.pane.pane }),
    }));
    menu = {
      x: e.clientX, y: e.clientY,
      items: [
        ...sessions,
        { label: t("Space öffnen"), icon: "❒", action: () => go({ view: "space", server, ws: sp.id }) },
        { label: t("Neue Sitzung hier"), icon: "＋", action: () => (dialogs.newSession = { server, ws: sp.id }) },
        { label: t("Aus der Liste nehmen"), icon: "◌", action: () => hiddenSpaces.hide(server, sp.id) },
      ],
    };
  }

  const hiddenCount = $derived(
    ((app.spaces[currentServer()] ?? []) as FullSpace[]).filter((sp) => hiddenSpaces.has(currentServer(), sp.id)).length,
  );
</script>

<div class="tree">
  {#each sections as sec (sec.server.id)}
    <button class="server" data-server={sec.server.id} title={app.errors[sec.server.id] ?? t("Server-Info")} onclick={() => go({ view: "serverinfo", server: sec.server.id })}>
      <span class="conn" class:bad={!!app.errors[sec.server.id]}></span><span class="ellipsis">{sec.server.label}</span><LiveMark server={sec.server.id} />
    </button>
    {#if !sec.loaded}
      {#each [110, 80, 130] as w}<div class="skeleton" style="height:11px; width:{w}px; margin:7px 0 7px 22px"></div>{/each}
    {/if}
    {#each sec.groups as g (g.key)}
      {@const repo = g.spaces[0]!}
      {@const trees = g.spaces.slice(1)}
      {@const fkey = `${sec.server.id}|${repo.id}`}
      {@const open_ = !folded.has(fkey)}
      {#each open_ ? g.spaces : [repo] as sp, i (sp.id)}
        {@const st = statusOf(sec.server.id, sp)}
        {@const nested = i > 0}
        <div class="srow" class:sel={currentWs === `${sec.server.id}|${sp.id}`}>
          <button class="item" class:nested onclick={() => open(sec.server.id, sp)} oncontextmenu={(e) => rowMenu(e, sec.server.id, sp)}
            title={sp.root}>
            {#if nested}<span class="branchline">{i === trees.length ? "└─" : "├─"}</span>{/if}
            <span class="dot {st}"></span>
            <span class="text">
              <span class="name ellipsis">{sp.label}</span>
              {#if !nested && sp.git}
                <span class="git ellipsis">{sp.git.branch}{#if sp.git.dirty > 0}<span class="dirty"> *{sp.git.dirty}</span>{/if}{#if sp.git.ahead > 0}<span class="ahead"> ↑{sp.git.ahead}</span>{/if}{#if sp.git.behind > 0}<span class="behind"> ↓{sp.git.behind}</span>{/if}</span>
              {/if}
            </span>
            <LiveMark server={sec.server.id} ws={sp.id} />
          </button>
          {#if !nested && trees.length}
            <button class="fold" title={open_ ? t("Worktrees einklappen") : t("Worktrees zeigen")} aria-label={open_ ? t("Worktrees einklappen") : t("Worktrees zeigen")}
              onclick={() => (folded = toggle(folded, FOLDED, fkey, open_))}>{open_ ? "▾" : `▸ ${trees.length}`}</button>
          {/if}
          <button class="hide" title={t("Aus der Liste nehmen")} aria-label={t("Aus der Liste nehmen")}
            onclick={() => hiddenSpaces.hide(sec.server.id, sp.id)}>✕</button>
        </div>
      {/each}
    {/each}
  {/each}
  {#if hiddenCount}
    <button class="restore" onclick={() => hiddenSpaces.showAll(currentServer())}>
      {t("{n} ausgeblendet – alle zeigen", { n: hiddenCount })}
    </button>
  {/if}
</div>

{#if menu}
  <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => (menu = null)} />
{/if}

<style>
  .tree { font-family: var(--mono); font-size: 12.5px; padding: 2px 0 8px; }
  .server { all: unset; cursor: pointer; box-sizing: border-box; width: 100%; display: flex; align-items: center; gap: 7px; color: var(--muted);
    font-size: 10.5px; text-transform: uppercase; letter-spacing: .05em; padding: 12px 8px 4px; border-radius: 6px; }
  .server:hover { color: var(--fg); }
  .server:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  .conn { width: 6px; height: 6px; border-radius: 50%; background: var(--green); flex: none; }
  .conn.bad { background: var(--red); }
  .srow { position: relative; border-radius: 6px; }
  .srow:hover { background: color-mix(in srgb, var(--fg) 5%, transparent); }
  .srow.sel { background: color-mix(in srgb, var(--accent) 18%, transparent); }
  .srow.sel .name { font-weight: 700; color: var(--fg); }
  .item { all: unset; box-sizing: border-box; cursor: pointer; display: flex; align-items: flex-start; gap: 7px; width: 100%;
    padding: 2px 44px 2px 8px; min-width: 0; }
  .item:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; border-radius: 6px; }
  .item.nested { padding-left: 10px; gap: 5px; }
  .item :global(.live) { align-self: flex-start; margin-top: 1.5px; }
  .branchline { color: var(--border); flex: none; line-height: 18px; }
  .dot { width: 9px; height: 9px; border-radius: 50%; flex: none; margin-top: 4.5px; box-sizing: border-box;
    border: 1.5px solid var(--green); }
  .dot.working { background: var(--purple); border-color: var(--purple); }
  .dot.blocked { background: var(--orange); border-color: var(--orange); }
  .dot.done { background: var(--green); }
  /* herdr's "·": nothing known about it (no agent) */
  .dot.unknown { width: 4px; height: 4px; margin: 7px 2.5px 0; border: none; background: var(--dim); }
  .text { display: grid; min-width: 0; line-height: 18px; }
  .name { color: var(--fg); }
  .git { color: var(--dim); }
  .dirty, .ahead, .behind { margin-left: 6px; }
  .dirty { color: var(--orange); }
  .ahead { color: var(--green); }
  .behind { color: var(--red); }
  .fold, .hide { all: unset; cursor: pointer; position: absolute; top: 3px; height: 18px; display: grid; place-items: center;
    border-radius: 5px; color: var(--muted); font-size: 10px; }
  .fold { right: 26px; padding: 0 4px; color: var(--accent); }
  .hide { right: 4px; width: 18px; opacity: 0; }
  .srow:hover .hide, .hide:focus-visible { opacity: 1; }
  .hide:hover, .fold:hover { background: var(--border); color: var(--fg); }
  .ellipsis { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .restore { all: unset; cursor: pointer; display: block; margin: 10px 8px 0; font-size: 11px; color: var(--dim); }
  .restore:hover { color: var(--fg); }
</style>
