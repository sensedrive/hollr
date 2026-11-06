<script lang="ts">
  import Icon from "$lib/components/git/Icon.svelte";
  // Übersicht (DashboardView.swift, laid out for a wide window): usage limits, "Braucht dich" ordered by urgency
  // with everything answerable in place, "Läuft gerade" grouped by project (Alle / Arbeitet / Neu), the sessions you
  // opened in Hollr (grouped by machine, live previews). j/k + ↩ and single keys switch fast.
  import { onMount } from "svelte";
  import * as api from "$lib/api";
  import { byUrgency, isLong, mainCaps, pooled, projectOf, portsIn, type FocusKind } from "$lib/dashboard";
  import { hiddenLong, hideLong } from "./dashboard/hiddenLong.svelte";
  import { t } from "$lib/i18n";
  import {
    allPanes, app, dialogs, findPane, go, mySessions, refresh, type AgentOpen, type PaneRef,
  } from "$lib/store.svelte";
  import { answer, dismiss, fetchInbox, inboxEntries, type InboxEntry } from "$lib/inbox.svelte";
  import { hiddenSpaces, isHidden } from "$lib/hiddenSpaces.svelte";
  import SessionCard from "./dashboard/SessionCard.svelte";
  import ContextMenu from "./dashboard/ContextMenu.svelte";
  import ConfirmDialog from "./dashboard/ConfirmDialog.svelte";
  import LimitsDialog from "./dashboard/LimitsDialog.svelte";
  import BrowserDialog from "./dashboard/BrowserDialog.svelte";
  import FocusCard from "./dashboard/FocusCard.svelte";
  import ProjectCard from "./dashboard/ProjectCard.svelte";
  import { providerName, refreshUsage, usage, usedColor } from "./dashboard/usage.svelte";
  import { fetchContexts, fetchPorts, sessionCtx, type WorkRow } from "./dashboard/context.svelte";
  import { arrowNav, refTitle, statusRank, type MenuItem } from "./dashboard/util";

  let now = $state(Date.now());

  onMount(() => {
    const timer = setInterval(() => refreshUsage(), 120_000);
    // inbox details and session context: only while the dashboard shows (each pane throttled on its own)
    const tick = () => {
      now = Date.now();
      fetchInbox();
      fetchContexts([...new Set([...focus.map((f) => f.ref), ...workRefs])]);
      fetchPorts(app.servers.map((s) => s.id));
    };
    tick();
    const fast = setInterval(tick, 2500);
    return () => {
      clearInterval(timer);
      clearInterval(fast);
    };
  });

  // load as soon as the paired servers are known (on app start they come in after mount)
  $effect(() => {
    if (app.servers.length) refreshUsage();
  });

  const entries = $derived(inboxEntries());
  const anyLoaded = $derived(app.servers.some((s) => app.loaded[s.id]));
  const several = $derived(app.servers.length > 1);

  // ------------------------------------------------------------ "Braucht dich" (by urgency)

  interface Focus { kind: FocusKind; since: number; ref: PaneRef; entry?: InboxEntry & { ref: PaneRef } }

  const focus = $derived.by((): Focus[] => {
    const items: Focus[] = entries.map((e) => ({ kind: e.kind, since: e.since, ref: e.ref, entry: e }));
    const listed = new Set(entries.map((e) => e.id));
    for (const r of allPanes()) {
      if (isHidden(r)) continue;
      const ctx = sessionCtx.byId[r.id];
      if (r.pane.agent && r.pane.status === "working" && !listed.has(r.id) && isLong(ctx, now) && hiddenLong[r.id] !== ctx!.turnStartedAt)
        items.push({ kind: "long", since: ctx!.turnStartedAt!, ref: r });
    }
    return items.sort(byUrgency);
  });

  // ------------------------------------------------------------ "Woran ich arbeite" (by project)

  const mineSet = $derived(new Set(mySessions.ids));
  /** what's going on: sessions you opened here plus every agent that works, waits or just finished – not from
   *  spaces taken off the list (unless the agent waits for you) */
  const workRefs = $derived(
    allPanes().filter((r) => !isHidden(r) && (mineSet.has(r.id) || (!!r.pane.agent && ["working", "blocked", "done"].includes(r.pane.status)))),
  );
  const rowOf = (r: PaneRef): WorkRow => {
    const ctx = sessionCtx.byId[r.id];
    const project = projectOf(r.server.id, r.workspace, r.pane.cwd, app.spaces[r.server.id], ctx);
    return { ref: r, project, ctx, changed: sessionCtx.changed[r.id], ports: portsIn(project.root, sessionCtx.ports[r.server.id]) };
  };
  const projects = $derived.by(() => {
    const byKey = new Map<string, WorkRow[]>();
    for (const r of workRefs) {
      const row = rowOf(r);
      byKey.set(row.project.key, [...(byKey.get(row.project.key) ?? []), row]);
    }
    const order = (w: WorkRow) => statusRank(w.ref);
    return [...byKey.values()]
      .map((rows) => rows.sort((a, b) => order(a) - order(b) || (b.changed ?? 0) - (a.changed ?? 0)))
      .sort((a, b) => order(a[0]!) - order(b[0]!) || (b[0]!.changed ?? 0) - (a[0]!.changed ?? 0));
  });
  const workCount = $derived(projects.reduce((n, p) => n + p.length, 0));
  // "Läuft gerade" can be narrowed to the busy ones or the fresh results – this list replaces the old "Agents" page
  let filter = $state<"all" | "busy" | "new">("all");
  const FILTERS: [typeof filter, string][] = [["all", "Alle"], ["busy", "Arbeitet"], ["new", "Neu"]];
  const shownProjects = $derived(
    projects.map((rows) => rows.filter((w) => filter === "all" || (filter === "new" ? w.ref.pane.status === "done"
      : w.ref.pane.status === "working" || w.ref.pane.status === "blocked"))).filter((rows) => rows.length > 0),
  );

  // ------------------------------------------------------------ my sessions by machine (live previews)

  const mine = $derived(
    mySessions.ids
      .map((id) => {
        const i = id.indexOf("|");
        return findPane(id.slice(0, i), id.slice(i + 1));
      })
      .filter((r): r is PaneRef => !!r && !isHidden(r)),
  );
  const groups = $derived(
    app.servers.map((server) => ({ server, refs: mine.filter((r) => r.server.id === server.id) })).filter((g) => g.refs.length),
  );

  // ------------------------------------------------------------ limits: "Claude 5h 2% 7d 64%  ChatGPT …" (pooled)

  const capGroups = $derived.by(() => {
    const caps = pooled(mainCaps(app.servers.flatMap((s) => usage.capacity[s.id] ?? [])));
    return [...new Set(caps.map((c) => c.provider))].map((p) => ({ provider: p, rows: caps.filter((c) => c.provider === p) }));
  });

  // ------------------------------------------------------------ actions

  let menu = $state<{ x: number; y: number; items: MenuItem[] } | null>(null);
  let ending = $state<PaneRef | null>(null);
  let showLimits = $state(false);
  let showBrowser = $state(false);
  let showKeys = $state(false);
  let reloading = $state(false);

  const open = (r: PaneRef, how?: AgentOpen, url?: string) =>
    go({ view: "agent", server: r.server.id, pane: r.pane.pane, ...(how ? { open: how } : {}), ...(url ? { url } : {}) });

  function cardMenu(e: MouseEvent, r: PaneRef) {
    const row = rowOf(r);
    menu = {
      x: e.clientX, y: e.clientY,
      items: [
        { label: t("Chat öffnen"), icon: "↗", action: () => open(r) },
        { label: t("Terminal öffnen"), icon: ">_", action: () => open(r, "terminal") },
        { label: t("Git & Dateien"), icon: "⑂", action: () => open(r, "git") },
        ...row.ports.map((p) => ({ label: t("Im Browser öffnen") + ` :${p.port}`, icon: "◍", action: () => open(r, "browser", `http://localhost:${p.port}`) })),
        ...(mineSet.has(r.id) ? [{ label: t("Aus der Übersicht nehmen"), icon: "◌", action: () => mySessions.remove(r.id) }] : []),
        { label: t("Space aus der Liste nehmen"), icon: "◌", action: () => hiddenSpaces.hide(r.server.id, r.workspace.id) },
        { label: t("Sitzung beenden"), icon: "✕", danger: true, action: () => (ending = r) },
      ],
    };
  }

  async function endSession(r: PaneRef) {
    await api.closePane(r.server.id, r.pane.pane);
    mySessions.remove(r.id);
    ending = null;
    await refresh();
  }

  async function reload() {
    reloading = true;
    await Promise.all([refresh(), refreshUsage(true)]);
    reloading = false;
  }

  // ------------------------------------------------------------ keyboard: j/k ↩ 1–9 r t g b e x ?

  /** "f:<id>" (Braucht dich) or "w:<id>" (Woran ich arbeite) */
  let sel = $state<string | null>(null);
  const cards: Record<string, FocusCard | undefined> = $state({});
  const navKeys = $derived([...focus.map((f) => `f:${f.ref.id}`), ...shownProjects.flat().map((w) => `w:${w.ref.id}`)]);
  const selRef = $derived.by(() => {
    if (!sel) return undefined;
    const id = sel.slice(2);
    return sel.startsWith("f:") ? focus.find((f) => f.ref.id === id)?.ref : workRefs.find((r) => r.id === id);
  });
  const selFocus = $derived(sel?.startsWith("f:") ? focus.find((f) => `f:${f.ref.id}` === sel) : undefined);

  function select(key: string, move = true) {
    sel = key;
    if (!move) return;
    const el = document.querySelector<HTMLElement>(`[data-fid="${CSS.escape(key)}"]`);
    el?.scrollIntoView({ block: "nearest" });
    (el?.matches("[tabindex]") ? el : el?.querySelector<HTMLElement>("button"))?.focus({ preventScroll: true });
  }

  function onKey(e: KeyboardEvent) {
    if (e.metaKey || e.ctrlKey || e.altKey || menu || ending || showLimits || showBrowser) return;
    const el = e.target as HTMLElement | null;
    if (el?.matches?.("input, textarea, select") || el?.isContentEditable || document.querySelector("dialog[open], .modal")) return;
    const k = e.key;
    if (k === "?") return void ((showKeys = !showKeys), e.preventDefault());
    if (k === "j" || k === "k") {
      if (!navKeys.length) return;
      e.preventDefault();
      const i = sel ? navKeys.indexOf(sel) : -1;
      const next = i === -1 ? (k === "j" ? 0 : navKeys.length - 1) : Math.min(navKeys.length - 1, Math.max(0, i + (k === "j" ? 1 : -1)));
      return select(navKeys[next]!);
    }
    if (k === "Escape" && sel) return void ((sel = null), (document.activeElement as HTMLElement | null)?.blur());
    const n = Number(k);
    if (Number.isInteger(n) && n >= 1 && n <= 9) {
      // the selected question, else the first open one
      const ask = selFocus?.entry?.kind === "ask" ? selFocus.entry : focus.find((f) => f.entry?.kind === "ask")?.entry;
      if (!ask || n > (ask.options?.length ?? 0)) return;
      e.preventDefault();
      return void answer(ask, n - 1);
    }
    const r = selRef;
    if (!r) return;
    // a focused button handles ↩ itself
    if (k === "Enter" && !el?.matches?.("button, a")) return void (e.preventDefault(), open(r));
    const row = rowOf(r);
    const actions: Record<string, () => void> = {
      t: () => open(r, "terminal"),
      g: () => open(r, "git"),
      b: () => open(r, "browser", row.ports[0] ? `http://localhost:${row.ports[0].port}` : undefined),
      r: () => (sel?.startsWith("f:") ? cards[r.id]?.focusReply() : open(r)),
      e: () => (selFocus?.entry ? dismiss(selFocus.entry) : selFocus?.kind === "long" && hideLong(selFocus.ref.id, selFocus.since)),
      x: () => (ending = r),
    };
    const action = actions[k];
    if (action) {
      e.preventDefault();
      action();
    }
  }

  const KEYS: [string, string][] = [
    ["j / k", "Nächster / vorheriger Eintrag"],
    ["↩", "Chat öffnen"],
    ["1 – 9", "Option der Frage wählen"],
    ["r", "Antworten"],
    ["t", "Terminal öffnen"],
    ["g", "Git & Dateien"],
    ["b", "Browser (Port des Projekts)"],
    ["e", "Als gesehen markieren"],
    ["x", "Sitzung beenden"],
    ["esc", "Auswahl aufheben"],
  ];
</script>

<svelte:window onkeydown={onKey} />

<div class="page dash">
  <div class="page-head">
    <h1>{t("Übersicht")}</h1>
    <button class="btn" class:on={showKeys} onclick={() => (showKeys = !showKeys)} title="{t('Tastenkürzel')} (?)">?</button>
    <button class="btn" disabled={reloading} onclick={reload} title={t("Aktualisieren")}>{reloading ? "…" : "↻"}</button>
    <button class="btn" disabled={!app.servers.length} onclick={() => (showBrowser = true)} title={t("Browser")}>{t("Browser")}</button>
    <button class="btn primary" disabled={!app.servers.length} onclick={() => (dialogs.newSession = {})}><Icon name="＋" size={15} /> {t("Neue Sitzung")}</button>
  </div>

  {#if showKeys}
    <div class="keys card">
      {#each KEYS as [key, what]}<span><kbd>{key}</kbd> {t(what)}</span>{/each}
    </div>
  {/if}

  {#if capGroups.length}
    <button class="limits" onclick={() => (showLimits = true)} title={t("Nutzungslimits")}>
      {#each capGroups as g}
        <span class="lg"><span class="muted">{providerName(g.provider)}</span>
          {#each g.rows as c}<span style="color:{usedColor(c.used, true)}">{c.window} {Math.round(c.used * 100)}%</span>{/each}
        </span>
      {/each}
      <span class="grow"></span><span class="dim">›</span>
    </button>
  {/if}

  <div class="cols">
    <!-- needs you, most urgent first -->
    <section class="needs">
      <div class="section head">
        <span class="sdot warn" class:quiet={!focus.length}></span><span class="grow">{t("Braucht dich")}</span>
        {#if focus.length}<span class="dim">{focus.length}</span>{/if}
      </div>
      {#if focus.length}
        <div class="stack">
          {#each focus as f (f.ref.id)}
            {@const row = rowOf(f.ref)}
            <FocusCard bind:this={cards[f.ref.id]} kind={f.kind} since={f.since} ref={f.ref} entry={f.entry} ctx={row.ctx}
              project={row.project} ports={row.ports} selected={sel === `f:${f.ref.id}`}
              onSelect={() => select(`f:${f.ref.id}`, false)} onOpen={(how, url) => open(f.ref, how, url)} onEnd={() => (ending = f.ref)}
              onHide={() => hideLong(f.ref.id, f.since)} />
          {/each}
        </div>
      {:else}
        <div class="quiet card">
          <span class="ok"><Icon name="✓" size={15} /></span>
          <span>{anyLoaded ? t("Nichts wartet auf dich.") : t("Lädt …")}
            {#if anyLoaded}<span class="muted small">{t("Fragen, fertige und lange laufende Agents erscheinen hier.")}</span>{/if}</span>
        </div>
      {/if}
    </section>

    <!-- what you're working on, by project -->
    <section class="working">
      <div class="section head">
        <span class="grow">{t("Läuft gerade")}</span>{#if workCount}<span class="dim">{workCount}</span>{/if}
      </div>
      {#if projects.length}
        <div class="seg" role="radiogroup" aria-label={t("Filter")}>
          {#each FILTERS as [v, label] (v)}
            <button role="radio" aria-checked={filter === v} class:on={filter === v} onclick={() => (filter = v)}>{t(label)}</button>
          {/each}
        </div>
        <div class="stack" use:arrowNav>
          {#if !shownProjects.length}<div class="card muted small">{t("Nichts mit diesem Filter.")}</div>{/if}
          {#each shownProjects as rows (rows[0]!.project.key)}
            <ProjectCard name={rows[0]!.project.name} server={several ? rows[0]!.ref.server.label : undefined} {rows}
              selectedId={sel?.startsWith("w:") ? sel.slice(2) : undefined}
              onOpen={open} onSelect={(r) => select(`w:${r.id}`, false)} onMenu={cardMenu} />
          {/each}
        </div>
      {:else if !anyLoaded && app.servers.length}
        <div class="skeleton" style="height:120px; border-radius:16px"></div>
      {:else}
        <div class="empty card">
          <div class="muted">{t("Gerade arbeitet kein Agent. Starte eine Sitzung oder öffne eine aus „Alle Agents“.")}</div>
          <div class="row-buttons">
            <button class="btn primary" disabled={!app.servers.length} onclick={() => (dialogs.newSession = {})}><Icon name="＋" size={15} /> {t("Neue Sitzung")}</button>
            <button class="btn" onclick={() => go({ view: "agents" })}>{t("Alle Agents")}</button>
          </div>
        </div>
      {/if}
    </section>
  </div>

  <!-- sessions you opened in Hollr, by machine -->
  {#if !mine.length && !anyLoaded && mySessions.ids.length}
    <div class="skeleton" style="width:120px; height:12px; margin: 22px 0 14px"></div>
    <div class="grid">
      {#each Array(Math.min(4, mySessions.ids.length)) as _}
        <div><div class="skeleton" style="height:160px; border-radius:12px"></div>
          <div class="skeleton" style="height:12px; width:60%; margin-top:10px"></div></div>
      {/each}
    </div>
  {:else if !mine.length}
    <div class="section">{t("Sitzungen")}</div>
    <div class="empty card">
      <div class="muted">{t("Hier erscheinen die Sitzungen, die du in Hollr öffnest oder startest – Agents und Terminals, nach Maschine sortiert.")}</div>
      <div class="row-buttons">
        <button class="btn primary" disabled={!app.servers.length} onclick={() => (dialogs.newSession = {})}><Icon name="＋" size={15} /> {t("Neue Sitzung")}</button>
        <button class="btn" onclick={() => go({ view: "agents" })}>{t("Alle Agents")}</button>
      </div>
    </div>
  {/if}

  {#each groups as g (g.server.id)}
    <div class="section head">
      <span class="sdot" class:bad={!!app.errors[g.server.id]}></span>
      <span class="grow">{g.server.label}</span><span class="dim">{g.refs.length}</span>
    </div>
    <div class="grid" use:arrowNav>
      {#each g.refs as r (r.id)}
        <SessionCard ref={r} onOpen={() => open(r)} onMenu={(e) => cardMenu(e, r)}
          onHide={() => mySessions.remove(r.id)} onEnd={() => (ending = r)} />
      {/each}
    </div>
  {/each}

</div>

{#if menu}
  <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => (menu = null)} />
{/if}
{#if ending}
  {@const r = ending}
  <ConfirmDialog title={t("Sitzung beenden?")} confirmLabel={t("Sitzung beenden")}
    message={`${t("„{title}“ wird in herdr geschlossen und {agent} beendet.", { title: refTitle(r), agent: r.pane.agent ?? "Shell" })}${api.lastPaneOf(r.workspace) ? ` ${t("Der Space bleibt – mit einem leeren Terminal.")}` : ""}`}
    onConfirm={() => endSession(r)} onClose={() => (ending = null)} />
{/if}
{#if showLimits}
  <LimitsDialog onClose={() => (showLimits = false)} />
{/if}
{#if showBrowser}
  <BrowserDialog onClose={() => (showBrowser = false)} />
{/if}

<style>
  .cols { display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr); gap: 0 26px; align-items: start; }
  @media (max-width: 1100px) { .cols { grid-template-columns: minmax(0, 1fr); } }
  .stack { display: grid; gap: 12px; }
  .quiet { display: flex; align-items: flex-start; gap: 12px; padding: 16px; }
  .quiet > span:last-child { display: grid; gap: 2px; }
  .ok { color: var(--green); font-weight: 700; }
  .keys { display: flex; flex-wrap: wrap; gap: 8px 18px; font-size: 12px; color: var(--muted); margin-bottom: 12px; }
  kbd { font: 600 11px var(--mono); padding: 1px 6px; border-radius: 5px; border: 1px solid var(--border); background: var(--raised); color: var(--fg); }
  .btn.on { border-color: var(--accent); color: var(--accent); }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 18px 16px; }
  .head { display: flex; align-items: center; gap: 8px; }
  .sdot { width: 7px; height: 7px; border-radius: 50%; background: var(--green); flex: none; }
  .sdot.warn { background: var(--orange); }
  .sdot.quiet { background: var(--dim); }
  .sdot.bad { background: var(--orange); }
  .limits { all: unset; box-sizing: border-box; cursor: pointer; display: flex; align-items: center; gap: 16px; width: 100%;
    padding: 7px 12px; border-radius: 10px; font-size: 12px; font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; }
  .limits:hover, .limits:focus-visible { background: var(--card); }
  .lg { display: inline-flex; gap: 6px; }
  .empty { display: grid; gap: 12px; padding: 18px; max-width: 640px; }
  .row-buttons { display: flex; gap: 8px; }
  .seg { display: inline-flex; margin-bottom: 10px; background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 2px; }
  .seg button { all: unset; cursor: pointer; padding: 3px 10px; border-radius: 6px; font-size: 12px; color: var(--muted); }
  .seg button.on { background: color-mix(in srgb, var(--accent) 20%, transparent); color: var(--fg); }
  .seg button:focus-visible { outline: 2px solid var(--accent); }
</style>
