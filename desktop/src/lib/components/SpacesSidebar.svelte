<script lang="ts">
  import { alertAsk } from "$lib/ask.svelte";
  // Sidebar like herdr's "spaces" list, for every paired server: repos with their branch, worktrees nested
  // below (├─ / └─, foldable), plain workspaces standalone; spaces and worktrees reorder by dragging (kept per
  // computer). One status dot per space from its sessions.
  // A click jumps straight into the session that needs you most; ✕ closes the space in herdr (tabs and agents end).
  // „Verstecken“ takes it off the list only; restore with the link below. 〰 shows where a live call runs. A space whose
  // folder is gone (a worktree removed outside herdr) says so and offers closing.
  import { onMount, tick } from "svelte";
  import { statusLabel, t } from "$lib/i18n";
  import Icon from "./git/Icon.svelte";
  import { allPanes, app, dialogs, findPane, go, lastTabRoute, nav, pollSpaces, refresh, refreshSpaces } from "$lib/store.svelte";
  import ContextMenu from "$lib/views/dashboard/ContextMenu.svelte";
  import { statusRank, type MenuItem } from "$lib/views/dashboard/util";
  import { ejectSpace, groupSpaces, space, type FullSpace } from "$lib/views/spaces/spaces";
  import CloseSpaceDialog from "$lib/views/spaces/CloseSpaceDialog.svelte";
  import OpenWorktree from "./OpenWorktree.svelte";
  import LiveMark from "./LiveMark.svelte";
  import { hiddenSpaces } from "$lib/hiddenSpaces.svelte";
  import { sortable } from "$lib/sortable";
  import { dotStatus, markUnread, resultSeen } from "$lib/inbox.svelte";
  import { currentServer } from "$lib/currentServer.svelte";

  const FOLDED = "hollr.sidebar.folded";
  const WTORDER = "hollr.sidebar.wtorder";
  /** dragged order of the spaces (repo groups and standalone spaces) per server */
  const ORDER = "hollr.sidebar.order";
  const loadSet = (key: string) => {
    try {
      return new Set<string>(JSON.parse(localStorage.getItem(key) ?? "[]"));
    } catch {
      return new Set<string>();
    }
  };
  let folded = $state(loadSet(FOLDED));
  let wtOrder = $state<Record<string, string[]>>({});
  try {
    const raw = JSON.parse(localStorage.getItem(WTORDER) ?? "{}");
    wtOrder = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch {
    wtOrder = {};
  }
  /** dragged order within one repo group; unknown ids stay at the end, then by label */
  function sortTrees(key: string, trees: FullSpace[]) {
    const rank = new Map((wtOrder[key] ?? []).map((id, i) => [id, i]));
    return [...trees].sort((a, b) => (rank.get(a.id) ?? 9999) - (rank.get(b.id) ?? 9999) || a.label.localeCompare(b.label));
  }
  function saveOrder(key: string, ids: string[]) {
    wtOrder = { ...wtOrder, [key]: ids };
    try {
      localStorage.setItem(WTORDER, JSON.stringify(wtOrder));
    } catch {
      /* private mode: order lasts this session only */
    }
  }
  let order = $state<Record<string, string[]>>({});
  try {
    const raw = JSON.parse(localStorage.getItem(ORDER) ?? "{}");
    order = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch {
    order = {};
  }
  /** groups in the dragged order; ones never dragged keep the server's order behind them */
  function sortGroups<G extends { spaces: FullSpace[] }>(server: string, groups: G[]): G[] {
    const rank = new Map((order[server] ?? []).map((id, i) => [id, i]));
    return groups
      .map((g, i) => ({ g, i }))
      .sort((a, b) => (rank.get(a.g.spaces[0]!.id) ?? 1e6 + a.i) - (rank.get(b.g.spaces[0]!.id) ?? 1e6 + b.i))
      .map(({ g }) => g);
  }
  function reorderGroups(server: string, id: string, before: string | null) {
    const sec = sections.find((s) => s.server.id === server);
    if (!sec) return;
    const ids = sec.groups.map((g) => g.spaces[0]!.id);
    const from = ids.indexOf(id);
    if (from < 0) return;
    ids.splice(from, 1);
    const to = before == null ? ids.length : ids.indexOf(before);
    if (to < 0) return;
    ids.splice(to, 0, id);
    order = { ...order, [server]: ids };
    try {
      localStorage.setItem(ORDER, JSON.stringify(order));
    } catch {}
  }

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
    // pushed changes refresh spaces right away (listenFeeds, incl. the server's git watch); this is the safety
    // net (a server without a live feed, a change the watch missed)
    const timer = setInterval(pollSpaces, 10_000);
    return () => clearInterval(timer);
  });

  /** the space's sessions, the one that needs you first */
  const panesOf = (server: string, ws: string) =>
    allPanes(server).filter((r) => r.workspace.id === ws).sort((a, b) => statusRank(a) - statusRank(b));

  /** live status from the sessions (fresher than the space list), else what the server reported */
  function statusOf(server: string, sp: FullSpace): string {
    const panes = panesOf(server, sp.id);
    for (const s of ["blocked", "working", "done", "idle"])
      if (panes.some((r) => dotStatus(r.id, r.pane.status) === s)) return s;
    const reported = sp.status ?? "unknown";
    if (reported === "done" && panes.length && panes.every((r) => r.pane.status !== "done" || resultSeen(r.id))) return "idle";
    return reported;
  }

  // only the current remote (the server tabs above switch it)
  const sections = $derived(
    app.servers.filter((s) => s.id === currentServer()).map((s) => {
      const spaces = (app.spaces[s.id] ?? []) as FullSpace[];
      // hidden ones (also off the dashboard) stay away until they need you
      const visible = spaces.filter((sp) => !hiddenSpaces.has(s.id, sp.id) || statusOf(s.id, sp) === "blocked");
      return { server: s, loaded: app.spaces[s.id] !== undefined, groups: sortGroups(s.id, groupSpaces(visible)) };
    }),
  );

  /** drop a worktree in front of `before` (null: end of its own repo group) */
  function reorder(id: string, before: string | null) {
    for (const sec of sections) {
      for (const g of sec.groups) {
        const repo = g.spaces[0];
        if (!repo) continue;
        const key = `${sec.server.id}|${repo.id}`;
        const trees = sortTrees(key, g.spaces.slice(1));
        if (!trees.some((t) => t.id === id)) continue;
        const ids = trees.map((t) => t.id);
        const from = ids.indexOf(id);
        ids.splice(from, 1);
        const to = before == null ? ids.length : ids.indexOf(before);
        if (to < 0) return;
        ids.splice(to, 0, id);
        saveOrder(key, ids);
        return;
      }
    }
  }

  const currentWs = $derived.by(() => {
    const r = nav.route;
    if (r.view === "space") return `${r.server}|${r.ws}`;
    if (r.view === "agent") {
      const ref = allPanes(r.server).find((p) => p.pane.pane === r.pane);
      return ref ? `${r.server}|${ref.workspace.id}` : "";
    }
    return "";
  });

  // one click waits a moment, so a double click can open the space itself instead
  let clickTimer: ReturnType<typeof setTimeout> | undefined;
  function onRowClick(server: string, sp: FullSpace) {
    clearTimeout(clickTimer);
    clickTimer = setTimeout(() => open(server, sp), 220);
  }
  function onRowDblClick(server: string, sp: FullSpace) {
    clearTimeout(clickTimer);
    go({ view: "space", server, ws: sp.id });
  }

  /** back to the tab selected there last; a space never visited opens the session that needs you first */
  function open(server: string, sp: FullSpace) {
    if (sp.missing) return go({ view: "space", server, ws: sp.id });
    const last = lastTabRoute(server, sp.id);
    if (last) return go(last);
    const first = panesOf(server, sp.id)[0];
    if (first) go({ view: "agent", server, pane: first.pane.pane });
    else go({ view: "space", server, ws: sp.id });
  }

  // ---- a space whose folder is gone: closed from here (the dialog lists what goes with it)
  let closing = $state<{ server: string; space: FullSpace } | null>(null);

  let menu = $state<{ x: number; y: number; items: MenuItem[] } | null>(null);
  function rowMenu(e: MouseEvent, server: string, sp: FullSpace) {
    e.preventDefault();
    const spaces = (app.spaces[server] ?? []) as FullSpace[];
    const main = sp.isWorktree ? spaces.find((s) => !s.isWorktree && !!s.repo && s.repo === sp.repo) : sp;
    const trees = main ? spaces.filter((s) => s.isWorktree && !!s.repo && s.repo === main.repo) : [];
    const fkey = main ? `${server}|${main.id}` : "";
    menu = {
      x: e.clientX, y: e.clientY,
      items: [
        ...(sp.missing ? [{ label: t("Ordner fehlt – schließen …"), icon: "✕", danger: true, action: () => (closing = { server, space: sp }) }] : []),
        // open and work
        ...(sp.missing ? [] : [{ label: t("Neues Terminal hier"), icon: "＋", action: () => (dialogs.newSession = { server, ws: sp.id }) }]),
        { label: t("Space öffnen"), icon: "❒", action: () => go({ view: "space", server, ws: sp.id }) },
        ...(repoOf(server, sp) ? [{ label: t("Neuer Worktree …"), icon: "⑂", action: () => { const hit = repoOf(server, sp)!; wt = { x: e.clientX, y: e.clientY, server, ws: hit.ws, base: hit.base, label: sp.label }; branch = ""; wtErr = ""; } }] : []),
        ...(sp.git && !sp.missing && main ? [{ label: t("Worktree öffnen …"), icon: "❒", action: () => (picker = { server, ws: main.id }) }] : []),
        // view
        { sep: true, label: t("Umbenennen …"), icon: "✎", action: () => { ren = { x: e.clientX, y: e.clientY, server, ws: sp.id }; name = sp.label; renErr = ""; } },
        ...(trees.length && !sp.isWorktree ? [{ label: folded.has(fkey) ? t("Worktrees zeigen") : t("Worktrees einklappen"), icon: folded.has(fkey) ? "▸" : "▾", action: () => (folded = toggle(folded, FOLDED, fkey, !folded.has(fkey))) }] : []),
        ...(panesOf(server, sp.id).length ? [{ label: t("Als ungelesen markieren"), icon: "●", action: () => markUnread(panesOf(server, sp.id).map((r) => r.id)) }] : []),
        { label: t("Space ausblenden"), hint: t("läuft weiter, unten wieder einblenden"), icon: "◌", action: () => hideSpace(server, sp.id) },
        // end (red)
        ...(sp.missing ? [] : [{
          sep: true, danger: true, icon: "⏹",
          label: !sp.isWorktree && groupOf(server, sp).length ? t("Space und Worktrees beenden ({n})", { n: groupOf(server, sp).length }) : t("Space beenden"),
          hint: t("Tabs und Agenten enden, Dateien und Branch bleiben"),
          action: () => void ejectFromList(server, sp),
        }]),
        ...(sp.isWorktree && !sp.missing ? [{ label: t("Worktree löschen …"), icon: "trash", danger: true, action: () => (closing = { server, space: sp }) }] : []),
        ...(!sp.isWorktree && !sp.git && !sp.missing ? [{ label: t("Ordner löschen …"), icon: "trash", danger: true, action: () => (closing = { server, space: sp }) }] : []),
      ],
    };
  }
  /** worktree spaces that end together with a repo's main space (herdr's group) */
  function groupOf(server: string, sp: FullSpace): FullSpace[] {
    if (sp.isWorktree || !sp.repo) return [];
    return ((app.spaces[server] ?? []) as FullSpace[]).filter((s) => s.isWorktree && s.repo === sp.repo);
  }
  /** herdr's one step: branch name, Enter. A worktree branches off its own branch, from the repo's main space. */
  function repoOf(server: string, sp: FullSpace): { ws: string; base?: string } | undefined {
    if (!sp.git || sp.missing) return undefined;
    if (!sp.isWorktree) return { ws: sp.id };
    const main = ((app.spaces[server] ?? []) as FullSpace[]).find((s) => !s.isWorktree && !!s.repo && s.repo === sp.repo);
    return main ? { ws: main.id, base: sp.git?.branch } : undefined;
  }
  let picker = $state<{ server: string; ws: string } | null>(null);
  let ren = $state<{ x: number; y: number; server: string; ws: string } | null>(null);
  let name = $state("");
  let renErr = $state("");
  let renBusy = $state(false);
  async function renameSpace() {
    if (!ren || renBusy) return;
    const label = name.trim();
    if (!label) { renErr = t("Name fehlt"); return; }
    renBusy = true; renErr = "";
    const { server, ws } = ren;
    try {
      await space(server, { op: "rename", ws, label });
      await refreshSpaces(server);
      ren = null;
    } catch (e) {
      renErr = e instanceof Error ? e.message : String(e);
    }
    renBusy = false;
  }
  let wt = $state<{ x: number; y: number; server: string; ws: string; base?: string; label: string } | null>(null);
  let branch = $state("");
  let wtBusy = $state(false);
  let wtErr = $state("");
  const BRANCH_RE = /^[\w][\w./-]{0,120}$/;
  async function createWt() {
    if (!wt || wtBusy) return;
    const name = branch.trim();
    if (!BRANCH_RE.test(name)) { wtErr = t("Ungültiger Branch-Name"); return; }
    wtBusy = true; wtErr = "";
    const { server, ws, base } = wt;
    try {
      const r = await space(server, { op: "worktree", ws, branch: name, ...(base ? { base } : {}), agent: "omp" });
      await Promise.all([refreshSpaces(server), refresh(server)]);
      wt = null; branch = "";
      if (r.pane) go({ view: "agent", server, pane: r.pane });
      else if (r.ws) go({ view: "space", server, ws: r.ws });
    } catch (e) {
      wtErr = e instanceof Error ? e.message : String(e);
    }
    wtBusy = false;
  }

  const focus = (node: HTMLInputElement) => { void tick().then(() => node.focus()); };
  let adding = $state(false);
  let addErr = $state("");
  /** herdr's new main space: a terminal in ~, no agent. herdr renames it to the folder as soon as you cd. */
  async function newMain() {
    const server = currentServer();
    if (!server || adding) return;
    adding = true;
    addErr = "";
    try {
      const r = await space(server, { op: "create", cwd: "~" });
      await Promise.all([refreshSpaces(server), refresh(server)]);
      if (r.pane) go({ view: "agent", server, pane: r.pane });
    } catch (e) {
      addErr = e instanceof Error ? e.message : String(e);
    }
    adding = false;
  }

  /** hidden from the sidebar – herdr keeps running; restore with „alle zeigen“ */
  function hideSpace(server: string, id: string) {
    hiddenSpaces.hide(server, id);
    leaveIfShowing(server, id);
  }

  function leaveIfShowing(server: string, id: string) {
    const r = nav.route;
    const showing = (r.view === "space" && r.server === server && r.ws === id)
      || (r.view === "agent" && r.server === server && findPane(server, r.pane)?.workspace.id === id);
    if (showing) go({ view: "dashboard" });
  }

  async function ejectFromList(server: string, sp: FullSpace) {
    try {
      await ejectSpace(server, sp.id, sp.label);
      await Promise.all([refreshSpaces(server), refresh(server)]);
      leaveIfShowing(server, sp.id);
    } catch (e) {
      void alertAsk(t("Fehler"), e instanceof Error ? e.message : String(e));
    }
  }

  const hiddenCount = $derived(
    ((app.spaces[currentServer()] ?? []) as FullSpace[]).filter((sp) => hiddenSpaces.has(currentServer(), sp.id)).length,
  );
</script>

<div class="tree">
  {#each sections as sec (sec.server.id)}
    {#if app.errors[sec.server.id]}
      <!-- the server's switcher above shows which one; here only what is wrong with it -->
      <button class="note" title={t("Server-Info")} onclick={() => go({ view: "serverinfo", server: sec.server.id })}>
        <span class="nhead"><Icon name="offline" size={14} />{t("Keine Verbindung zu {server}", { server: sec.server.label })}</span>
        <span class="ntext">{app.errors[sec.server.id]}</span>
      </button>
    {/if}
    {#if !sec.loaded}
      {#each [110, 80, 130] as w}<div class="skeleton" style="height:12px; width:{w}px; margin:10px 0 10px 29px"></div>{/each}
    {/if}
    <div class="spaces" class:stale={!!app.errors[sec.server.id]} use:sortable={{ axis: "y", attr: "sort-group", onMove: (id, before) => reorderGroups(sec.server.id, id, before) }}>
    {#each sec.groups as g (g.key)}
      {@const repo = g.spaces[0]!}
      {@const fkey = `${sec.server.id}|${repo.id}`}
      {@const trees = sortTrees(fkey, g.spaces.slice(1))}
      {@const open_ = !folded.has(fkey)}
      <div class="grp" data-sort-group={repo.id} use:sortable={{ axis: "y", onMove: reorder }}>
      {#each open_ ? [repo, ...trees] : [repo] as sp, i (sp.id)}
        {@const st = statusOf(sec.server.id, sp)}
        {@const nested = i > 0}
        {@const busy = st === "working" || st === "blocked" || st === "done"}
        <div class="srow" class:sel={currentWs === `${sec.server.id}|${sp.id}`} class:nested data-sort-id={nested ? sp.id : undefined}>
          <button class="item" onclick={() => onRowClick(sec.server.id, sp)} ondblclick={() => onRowDblClick(sec.server.id, sp)}
            oncontextmenu={(e) => rowMenu(e, sec.server.id, sp)}
            title={[sp.label, sp.git?.branch, statusLabel(st), sp.root].filter(Boolean).join(" · ")}>
            <span class="dotbox">{#if busy}<span class="dot {st}"></span>{/if}</span>
            <span class="name ellipsis" class:gone={sp.missing}>{sp.label}</span>
            {#if sp.missing}<span class="lost" title={t("Der Ordner dieses Spaces fehlt.")}>{t("Ordner fehlt")}</span>{/if}
            {#if !nested && sp.git}
              <span class="stats">{#if sp.git.dirty > 0}<span>*{sp.git.dirty}</span>{/if}{#if sp.git.ahead > 0}<span>↑{sp.git.ahead}</span>{/if}{#if sp.git.behind > 0}<span>↓{sp.git.behind}</span>{/if}</span>
            {/if}
            <LiveMark server={sec.server.id} ws={sp.id} />
          </button>
          {#if !nested && trees.length}
            <button class="fold" data-sort-ignore title={open_ ? t("Worktrees einklappen") : t("Worktrees zeigen")} aria-label={open_ ? t("Worktrees einklappen") : t("Worktrees zeigen")}
              aria-expanded={open_} onclick={() => (folded = toggle(folded, FOLDED, fkey, open_))}>
              <Icon name={open_ ? "chevronD" : "chevronR"} size={13} />{#if !open_}<span>{trees.length}</span>{/if}</button>
          {/if}
          <button class="hide" data-sort-ignore title={t("Ausblenden – läuft weiter")} aria-label={t("Ausblenden")}
            onclick={() => hideSpace(sec.server.id, sp.id)}><Icon name="minus" size={12} /></button>
        </div>
      {/each}
      </div>
    {/each}
    </div>
  {/each}
  {#if hiddenCount}
    <button class="restore" onclick={() => hiddenSpaces.showAll(currentServer())}>
      {t("{n} ausgeblendet – alle zeigen", { n: hiddenCount })}
    </button>
  {/if}
  <button class="addspace" disabled={!currentServer() || adding} onclick={() => void newMain()}>
    <Icon name="plus" size={14} /> {t("Neuer Space")}
  </button>
  {#if addErr}<div class="adderr">{addErr}</div>{/if}
</div>

{#if menu}
  <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => (menu = null)} />
{/if}
{#if ren}
  <button class="wt-back" aria-label={t("Schließen")} onclick={() => (ren = null)}></button>
  <form class="wt" style="left:{Math.min(ren.x, innerWidth - 300)}px; top:{Math.min(ren.y, innerHeight - 92)}px"
    onsubmit={(e) => { e.preventDefault(); void renameSpace(); }}>
    <div class="wt-h">{t("Umbenennen …")}</div>
    <input bind:value={name} disabled={renBusy} use:focus
      onkeydown={(e) => { if (e.key === "Escape") { e.preventDefault(); ren = null; } }} />
    {#if renErr}<div class="wt-err">{renErr}</div>{/if}
  </form>
{/if}
{#if picker}
  <OpenWorktree server={picker.server} ws={picker.ws} onClose={() => (picker = null)} />
{/if}
{#if wt}
  <button class="wt-back" aria-label={t("Schließen")} onclick={() => { if (!wtBusy) wt = null; }}></button>
  <form class="wt" style="left:{Math.min(wt.x, innerWidth - 300)}px; top:{Math.min(wt.y, innerHeight - 92)}px"
    onsubmit={(e) => { e.preventDefault(); void createWt(); }}>
    <div class="wt-h">{t("Neuer Worktree")}<span>{wt.label}</span></div>
    <input bind:value={branch} placeholder={t("Neuer Branch, z. B. feature/PROJ-123-login")} disabled={wtBusy}
      use:focus
      onpaste={(e) => {
        const text = e.clipboardData?.getData("text") ?? "";
        if (!/\s/.test(text)) return;
        e.preventDefault();
        const clean = text.replace(/\s+/g, "");
        const el = e.currentTarget as HTMLInputElement;
        const a = el.selectionStart ?? branch.length;
        const b = el.selectionEnd ?? a;
        branch = branch.slice(0, a) + clean + branch.slice(b);
      }}
      onkeydown={(e) => { if (e.key === "Escape" && !wtBusy) { e.preventDefault(); wt = null; } }} />
    {#if wtBusy}<div class="wt-wait">{t("Worktree wird angelegt …")}</div>{/if}
    {#if wtErr}<div class="wt-err">{wtErr}</div>{/if}
  </form>
{/if}
{#if closing}
  {@const c = closing}
  <CloseSpaceDialog server={c.server} space={c.space} onClose={() => (closing = null)}
    onClosed={() => { if (currentWs === `${c.server}|${c.space.id}`) go({ view: "spaces" }); }} />
{/if}

<style>
  /* minmax(0, 1fr): a long space name ellipsizes instead of widening the column past the sidebar */
  .tree { font-size: 13.5px; padding: 0 0 8px; display: grid; grid-template-columns: minmax(0, 1fr); gap: 6px; }
  .spaces { position: relative; display: grid; grid-template-columns: minmax(0, 1fr); gap: 1px; }
  .spaces.stale { opacity: .55; }
  .note { all: unset; cursor: pointer; box-sizing: border-box; display: grid; gap: 4px; padding: 10px 12px; border-radius: 8px;
    background: var(--card); border: 1px solid var(--border); }
  .note:focus-visible { outline: 2px solid var(--accent); }
  .nhead { display: inline-flex; align-items: center; gap: 7px; font-size: 13px; font-weight: 600; color: var(--orange); }
  .ntext { font-size: 12px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; }
  .grp { position: relative; }
  .srow { position: relative; border-radius: 8px; }
  .srow[data-sort-id], .grp > .srow:first-child { cursor: grab; }
  .srow:hover { background: color-mix(in srgb, var(--fg) 5%, transparent); }
  .srow.sel { background: color-mix(in srgb, var(--accent) 16%, transparent); }
  .srow.sel .name { font-weight: 600; color: var(--fg); }
  .item { all: unset; box-sizing: border-box; cursor: pointer; display: flex; align-items: center; gap: 10px; width: 100%;
    padding: 6px 48px 6px 10px; min-width: 0; }
  .item:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; border-radius: 8px; }
  .nested .item { padding: 4px 48px 4px 29px; font-size: 13px; }
  .nested .name { color: var(--muted); }
  .dotbox { width: 9px; display: grid; place-items: center; flex: none; }
  .dot { width: 7px; height: 7px; border-radius: 50%; flex: none; }
  .dot.working { background: var(--purple); animation: pulse 1.6s ease-in-out infinite; }
  .dot.blocked { background: var(--orange); }
  .dot.done { background: var(--accent); }
  @keyframes pulse { 50% { opacity: .35; } }
  @media (prefers-reduced-motion: reduce) { .dot.working { animation: none; } }
  .name { color: var(--fg); min-width: 0; }
  .name.gone { color: var(--dim); text-decoration: line-through; }
  .lost { flex: none; font-size: 11px; color: var(--orange); }
  .stats { margin-left: auto; display: flex; gap: 6px; flex: none; font: 11.5px var(--mono); color: var(--dim); }
  .fold, .hide { all: unset; cursor: pointer; position: absolute; top: 50%; translate: 0 -50%; height: 22px; display: flex; align-items: center; gap: 2px;
    justify-content: center; border-radius: 5px; color: var(--dim); font-size: 11px; }
  .fold { right: 26px; padding: 0 4px; }
  .hide { right: 4px; width: 22px; opacity: 0; }
  .srow:hover .hide, .srow:focus-within .hide { opacity: 1; }
  .hide:hover, .fold:hover { background: var(--border); color: var(--fg); }
  .hide:focus-visible, .fold:focus-visible { outline: 2px solid var(--accent); }
  .ellipsis { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .restore { all: unset; cursor: pointer; display: block; margin: 10px 10px 0; font-size: 12px; color: var(--dim); }
  .restore:hover, .restore:focus-visible { color: var(--fg); }
  .addspace { all: unset; cursor: pointer; display: flex; align-items: center; gap: 8px; margin: 8px 10px 0;
    padding: 6px 8px; border-radius: 8px; font-size: 13px; color: var(--muted); }
  .addspace:hover, .addspace:focus-visible { background: color-mix(in srgb, var(--fg) 6%, transparent); color: var(--fg); }
  .addspace:disabled { opacity: .5; cursor: default; }
  .adderr { margin: 4px 12px 0; font-size: 12px; color: var(--orange); }
  .wt-back { all: unset; position: fixed; inset: 0; z-index: 40; }
  .wt { position: fixed; z-index: 41; width: 280px; display: grid; gap: 6px; padding: 10px; border-radius: 10px;
    background: var(--card); border: 1px solid var(--border); box-shadow: 0 12px 40px color-mix(in srgb, #000 35%, transparent); }
  .wt-h { display: flex; gap: 8px; align-items: baseline; font-size: 12px; font-weight: 600; }
  .wt-h span { font-weight: 400; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .wt input { width: 100%; box-sizing: border-box; font: 13px var(--mono); padding: 6px 8px; border-radius: 7px;
    border: 1px solid var(--border); background: var(--bg); color: var(--fg); }
  .wt input:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
  .wt-err { font-size: 12px; color: var(--orange); }
  .wt-wait { font-size: 12px; color: var(--muted); }
</style>
