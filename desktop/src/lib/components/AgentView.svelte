<script lang="ts">
  // One session (AgentDetailView.swift): omp transcript / chat history / terminal, pinned HUD (TODO, jobs,
  // working row), composer with keys and live voice, omp's status line, ⋯ menu, zen mode and a right side
  // panel (git / in-app browser / info).
  import { onDestroy, onMount, untrack } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { listen, type UnlistenFn } from "@tauri-apps/api/event";
  import { openUrl } from "@tauri-apps/plugin-opener";
  import * as api from "../api";
  import type { AskPick, Pane, Timeline } from "../api";
  import { statusLabel, t } from "../i18n";
  import { settings } from "../settings.svelte";
  import { allPanes, drafts, go, serverById, tabName } from "../store.svelte";
  import { draftKey } from "../drafts";
  import { followTimeline } from "../follow";
  import {
    cleanScreen, cleanTitle, duration, history as loadHistory, hudVisible, isLoopback, openPhase, phaseDone, phaseName,
    shortPath, todoColor, urlPort, viaTunnel, workingLabel, type HistoryEvent,
  } from "../agent";
  import TimelineView from "./TimelineView.svelte";
  import TerminalView from "./TerminalView.svelte";
  import Composer from "./Composer.svelte";
  import Markdown from "./Markdown.svelte";
  import BrowserPanel from "./BrowserPanel.svelte";
  import ModelDialog from "./ModelDialog.svelte";
  import GitPanel from "./GitPanel.svelte";
  import Modal from "./Modal.svelte";

  let { server, pane, title, onClosed }: {
    server: string; pane: Pane; title: string;
    /** the pane was closed; gets its "serverId|pane" */
    onClosed: (id: string) => void;
  } = $props();

  const ws = $derived(pane.pane.split(":")[0] ?? "");
  const isOmp = $derived(pane.agent === "omp");
  const isShell = $derived(!pane.agent);
  const agentName = $derived(
    pane.agent ? ({ omp: "omp", claude: "Claude", codex: "Codex" } as Record<string, string>)[pane.agent] ?? pane.agent : "Shell",
  );
  const serverLabel = $derived(serverById(server)?.label ?? server);
  /** drafts / ↑ history of this session */
  const key = $derived(draftKey(server, pane.pane));
  const mac = navigator.platform.toLowerCase().includes("mac");
  const mod = mac ? "⌘" : "Ctrl+";
  const shift = mac ? "⇧" : "Shift+";

  // ------------------------------------------------------------ data

  type Bubble = { kind: "voice" | "typed" | "tool" | "agent" | "info"; text: string; final: boolean };

  let timeline = $state<Timeline | null>(null);
  let bubbles = $state<Bubble[]>([]);
  let screen = $state("");
  let loaded = $state(false);
  /** polling problem – cleared by the next good poll */
  let pollError = $state("");
  /** a failed action (send, keys, close …) – stays until the next action works */
  let actionError = $state("");
  /** chat stream problem – cleared by its next timeline */
  let streamError = $state("");
  const error = $derived(actionError || pollError || streamError);
  /** typed prompts that are not in the log yet */
  let pending = $state<string[]>([]);
  let lastSig = "";
  let busy = false;

  const status = $derived(timeline?.status ?? pane.status);
  const working = $derived(!!timeline?.running && status !== "blocked");
  // omp's question already shows as an Ask card – then the raw screen would only repeat it
  const askShown = $derived(isOmp && (timeline?.items ?? []).some((i) => i.k === "ask" && i.pending));
  const showsScreen = $derived((!isOmp || status === "blocked") && !askShown);
  let screenOpen = $state(false);

  function toBubbles(events: HistoryEvent[]): Bubble[] {
    const out: Bubble[] = [];
    for (const e of events) {
      if (e.t === "delegation") out.push({ kind: "voice", text: e.text, final: true });
      else if (e.t === "user") out.push({ kind: "typed", text: e.text, final: true });
      else if (e.t === "tool") out.push({ kind: "tool", text: e.intent ? `${e.name} · ${e.intent}` : e.name, final: true });
      else if (e.t === "answer") out.push({ kind: "agent", text: e.text, final: e.final });
    }
    return out;
  }

  function setTimeline(tl: Timeline) {
    timeline = tl;
    const logged = new Set(tl.items.flatMap((i) => (i.k === "user" ? [i.text] : [])));
    if (pending.some((p) => logged.has(p))) pending = pending.filter((p) => !logged.has(p));
  }

  /** omp's chat comes as a stream (`follow`); false = poll `timeline` (older server) */
  let streaming = false;
  $effect(() => {
    if (!isOmp) return;
    streaming = true;
    const stop = untrack(() =>
      followTimeline(server, pane.pane, {
        timeline: (tl) => {
          setTimeline(tl);
          streamError = "";
          loaded = true;
        },
        error: (e) => (streamError = e),
        unsupported: () => {
          streaming = false;
          streamError = "";
          tick();
        },
      }),
    );
    return () => {
      streaming = false;
      stop();
    };
  });

  async function tick() {
    if (busy || isShell) return;
    busy = true;
    try {
      if (isOmp) {
        // the stream brings the timeline; polled only from servers without `follow`
        if (!streaming) {
          // unchanged → the server answers a few bytes instead of the whole timeline
          const tl = await api.timeline(server, pane.pane, timeline?.etag);
          if (tl) setTimeline(tl);
        }
      } else {
        const h = await loadHistory(server, pane.pane);
        const fresh = toBubbles(h.events ?? []);
        const sig = JSON.stringify(fresh);
        if (sig !== lastSig && !(fresh.length === 0 && bubbles.length)) {
          lastSig = sig;
          bubbles = fresh;
        }
        const logged = new Set(fresh.filter((b) => b.kind === "typed").map((b) => b.text));
        if (pending.some((p) => logged.has(p))) pending = pending.filter((p) => !logged.has(p));
      }
      if (showsScreen && mode === "chat") screen = cleanScreen(await api.screen(server, pane.pane, 40));
      else screen = "";
      pollError = "";
    } catch (e) {
      pollError = e instanceof Error ? e.message : String(e);
    } finally {
      loaded = true;
      busy = false;
    }
  }

  let ticks = 0;
  let poll: ReturnType<typeof setInterval> | undefined;
  onMount(() => {
    tick();
    poll = setInterval(() => {
      ticks++;
      // slow down while the window is hidden
      if (document.visibilityState !== "visible" && ticks % 4) return;
      tick();
    }, isOmp ? 2000 : 3000);
  });
  onDestroy(() => clearInterval(poll));

  // elapsed times in the HUD
  let now = $state(Date.now());
  const clock = setInterval(() => (now = Date.now()), 1000);
  onDestroy(() => clearInterval(clock));

  // ------------------------------------------------------------ view state

  let mode = $state<"chat" | "terminal">(untrack(() => pane.agent) ? "chat" : "terminal");
  let zen = $state(false);
  let panel = $state<"" | "git" | "browser" | "info">("");
  /** browser stays mounted (tunnels open) until its ✕, even while another panel tab shows */
  let browserOpen = $state(false);
  let browserRequest = $state<{ url: string } | null>(null);
  let menu = $state(false);
  let showModels = $state(false);
  let showCodex = $state(false);
  let confirmClose = $state(false);
  let linkUrl = $state<URL | null>(null);
  let todoOpen = $state(false);
  let toast = $state("");
  let composer: Composer | undefined = $state();
  let term: TerminalView | undefined = $state();

  const PW = "hollr.agent.panelWidth";
  let panelWidth = $state(Number(localStorage.getItem(PW)) || 460);

  function togglePanel(p: "git" | "browser" | "info") {
    if (p === "browser") browserOpen = true;
    panel = panel === p ? "" : p;
    zen = false;
  }

  function startResize(e: PointerEvent) {
    const startX = e.clientX;
    const start = panelWidth;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      panelWidth = Math.round(Math.min(Math.max(start + (startX - ev.clientX), 300), window.innerWidth * 0.7));
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      try {
        localStorage.setItem(PW, String(panelWidth));
      } catch {}
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  }

  // ---- text scale → the app zoom (same steps as ⌘+ / ⌘-)
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  function zoomBy(d: number) {
    settings.zoom = d === 0 ? 1 : Math.round(Math.min(1.6, Math.max(0.7, settings.zoom + d)) * 100) / 100;
    toast = `${Math.round(settings.zoom * 100)} %`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast = ""), 1200);
  }

  // ------------------------------------------------------------ scrolling (sticks to the bottom unless you scroll up)

  let scroller: HTMLDivElement | undefined = $state();
  let inner: HTMLDivElement | undefined = $state();
  let stick = $state(true);
  let unseen = $state(false);

  function onScroll() {
    if (!scroller) return;
    stick = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 60;
    if (stick) unseen = false;
  }
  function toBottom() {
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
    stick = true;
    unseen = false;
  }
  $effect(() => {
    if (!inner || !scroller) return;
    const ro = new ResizeObserver(() => {
      if (stick) toBottom();
      else unseen = true;
    });
    ro.observe(inner);
    ro.observe(scroller);
    return () => ro.disconnect();
  });

  // ------------------------------------------------------------ actions

  async function sendText(msg: string): Promise<boolean> {
    stick = true;
    // omp waits on its question: the server makes the text the own answer – it never shows as a message
    const answering = askShown;
    if (!isShell && !answering) pending = [...pending, msg];
    try {
      await api.prompt(server, pane.pane, msg);
      actionError = "";
      setTimeout(tick, 500);
      if (mode === "terminal") term?.refresh();
      return true;
    } catch (e) {
      pending = pending.filter((p) => p !== msg);
      const why = e instanceof Error ? e.message : String(e);
      actionError = answering ? t("Antwort nicht gesendet: {e}", { e: why }) : t("Senden fehlgeschlagen: {e}", { e: why });
      return false;
    }
  }

  async function answerAsk(ask: string, picks: AskPick[]): Promise<boolean> {
    try {
      await api.answer(server, pane.pane, ask, picks);
      actionError = "";
      setTimeout(tick, 400);
      return true;
    } catch (e) {
      actionError = t("Antwort nicht gesendet: {e}", { e: e instanceof Error ? e.message : String(e) });
      return false;
    }
  }

  /** Composer text: stays in the drafts until the server took it (back into the draft if not – even if this view is gone). */
  async function sendDraft(msg: string): Promise<boolean> {
    const k = key;
    drafts.beginSend(k, msg);
    const ok = await sendText(msg);
    drafts.endSend(k, msg, ok);
    return ok;
  }

  function sendKeys(keys: string[]) {
    if (mode === "terminal" && term) return term.send(keys);
    api.keys(server, pane.pane, keys)
      .then(() => { actionError = ""; setTimeout(tick, 400); })
      .catch((e) => (actionError = t("Tasten senden fehlgeschlagen: {e}", { e: e instanceof Error ? e.message : String(e) })));
  }

  function openModels() {
    menu = false;
    if (!pane.agent) return;
    if (pane.agent === "codex") showCodex = true;
    else showModels = true;
  }

  async function close() {
    confirmClose = false;
    const id = key;
    if (livePhase) await invoke("live_stop").catch(() => {});
    try {
      await api.closePane(server, pane.pane);
      onClosed(id);
    } catch (e) {
      actionError = e instanceof Error ? e.message : String(e);
    }
  }

  // ---- links: ask like iOS (Hollr browser / system browser / copy)
  function onLink(href: string) {
    let url: URL;
    try {
      url = new URL(href);
    } catch {
      return;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      openUrl(url.href).catch(() => {});
      return;
    }
    linkUrl = url;
  }
  function linkInBrowser(url: URL) {
    linkUrl = null;
    browserOpen = true;
    panel = "browser";
    zen = false;
    browserRequest = { url: url.href };
  }
  async function linkExternal(url: URL) {
    linkUrl = null;
    try {
      // the server's localhost goes through a tunnel (stays open until Hollr quits)
      await openUrl(isLoopback(url) ? viaTunnel(url, await api.tunnelOpen(server, urlPort(url))) : url.href);
    } catch (e) {
      actionError = e instanceof Error ? e.message : String(e);
    }
  }
  function linkCopy(url: URL) {
    linkUrl = null;
    navigator.clipboard.writeText(url.href).catch(() => {});
  }

  // ---- other sessions (the iPhone's switcher chips)
  const others = $derived(
    allPanes().filter((r) => r.server.id === server && r.pane.pane !== pane.pane && (r.pane.agent || settings.showShells)),
  );

  // ---- keyboard
  function onKey(e: KeyboardEvent) {
    const m = e.metaKey || e.ctrlKey;
    if (e.key === "Escape") {
      // another dialog (new session, model …) handles its own Esc – don't also leave zen
      if (!linkUrl && document.querySelector('[role="dialog"]')) return;
      if (linkUrl) linkUrl = null;
      else if (menu) menu = false;
      else if (zen && !showModels && !showCodex && !confirmClose) zen = false;
      else return;
      e.preventDefault();
      return;
    }
    if (!m) return;
    const c = e.code;
    if (e.shiftKey) {
      if (c === "KeyF") zen = !zen;
      else if (c === "KeyG") togglePanel("git");
      else if (c === "KeyB") togglePanel("browser");
      else if (c === "KeyI") togglePanel("info");
      else if (c === "KeyM") openModels();
      else if (c === "KeyT" && pane.agent) mode = mode === "chat" ? "terminal" : "chat";
      else return;
    } else if (c === "KeyK") {
      if (mode === "terminal") (document.querySelector(".agent .screen") as HTMLElement | null)?.focus();
      else composer?.focus();
    } else if (c === "Period") sendKeys(["esc"]);
    else return;
    e.preventDefault();
  }

  // ------------------------------------------------------------ live voice (omp /live)
  let livePhase = $state<"" | "connecting" | "live" | "ending">("");
  let ompState = $state<string | undefined>();
  let micMuted = $derived(ompState === "muted");
  let speakerMuted = $state(false);
  let levels = $state({ input: 0, output: 0 });
  let liveError = $state("");
  let liveNote = $state("");
  let unlisten: UnlistenFn[] = [];
  /** false once this view is gone (a start may still be under way) */
  let alive = true;
  /** id from live_start; events of other (older) sessions are ignored */
  let liveSession: number | null = null;
  /** events that arrived before live_start returned the id */
  let early: Record<string, unknown>[] = [];

  async function startLive() {
    liveError = "";
    liveNote = "";
    livePhase = "connecting";
    liveSession = null;
    early = [];
    const offs = [
      await listen<Record<string, unknown>>("live", (e) => {
        if (liveSession === null) early.push(e.payload);
        else if (e.payload.session === liveSession) onLive(e.payload);
      }),
      await listen<{ input: number; output: number; session?: number }>("live-levels", (e) => {
        if (e.payload.session === liveSession) levels = e.payload;
      }),
    ];
    if (!alive) return offs.forEach((u) => u());
    unlisten.push(...offs);
    try {
      const id = await invoke<number>("live_start", { server, pane: pane.pane });
      if (!alive) return;
      liveSession = id;
      for (const m of early.splice(0)) if (m.session === id) onLive(m);
    } catch (e) {
      liveError = String(e);
      endLive();
    }
  }
  function onLive(m: Record<string, unknown>) {
    if (m.t === "phase") {
      if (m.phase === "live") livePhase = "live";
      else if (m.phase === "ended") {
        if (m.reason === "live_stopped") liveNote = t("Live wurde am Rechner beendet.");
        endLive();
      } else if (m.phase === "failed") { liveError = String(m.message ?? m.reason ?? t("Live fehlgeschlagen")); endLive(); }
    } else if (m.t === "omp") ompState = String(m.state);
    else if (m.t === "error") liveError = String(m.message ?? m.code);
    else if (m.t === "audio_error") liveError = String(m.message);
    else if (m.t === "closed") endLive();
  }
  function endLive() {
    livePhase = "";
    liveSession = null;
    early = [];
    ompState = undefined;
    speakerMuted = false;
    for (const u of unlisten) u();
    unlisten = [];
  }
  async function stopLive() {
    livePhase = "ending";
    await invoke("live_stop").catch(() => {});
    setTimeout(() => { if (livePhase === "ending") endLive(); }, 6000);
  }
  const toggleMic = () => { ompState = micMuted ? "listening" : "muted"; invoke("live_mute", { on: ompState === "muted" }); };
  const toggleSpeaker = () => { speakerMuted = !speakerMuted; invoke("live_speaker", { muted: speakerMuted }); };
  // always: a start may still be under way (live_stop waits for it, then stops it)
  onDestroy(() => { alive = false; invoke("live_stop").catch(() => {}); endLive(); });

  function ompStateLabel(s?: string) {
    if (!s) return t("verbunden");
    return ({ listening: t("hört zu"), speaking: t("spricht"), working: t("arbeitet"), thinking: t("arbeitet"), muted: t("stumm"), connecting: t("verbindet") } as Record<string, string>)[s] ?? s;
  }
  const liveColor = $derived(
    micMuted ? "var(--orange)" : livePhase !== "live" ? "var(--accent)" : ompState === "working" || ompState === "thinking" ? "var(--purple)" : "var(--green)",
  );

  const placeholder = $derived(
    isShell ? t("Befehl ausführen …") : livePhase ? t("Oder tippen …") : t("Nachricht an {agent} …", { agent: agentName }),
  );
  const keysTitle = $derived(isShell ? t("Tasten ans Terminal senden") : t("Tasten an {agent} senden", { agent: agentName }));
  const transcriptTitle = $derived(cleanTitle(timeline?.title) ?? pane.title);
  const phase = $derived(timeline ? openPhase(timeline) : undefined);
</script>

<svelte:window onkeydown={onKey} onclick={() => (menu = false)} />

{#snippet liveStrip()}
  {#if livePhase}
    <div class="live" style:--live={liveColor}>
      <div class="bars">{#each [0.45, 0.8, 1, 0.7, 0.4] as w}<span style:height="{6 + 22 * w * Math.min(1, micMuted ? 0 : Math.max(levels.input * 6, levels.output * 4))}px"></span>{/each}</div>
      <div class="grow">
        <b>{livePhase === "connecting" ? t("Verbinde …") : livePhase === "ending" ? t("Beende …") : "Live"}</b>
        <div class="small livestate">{livePhase === "live" ? [micMuted ? t("Mikro aus") : ompStateLabel(ompState), speakerMuted ? t("Ton aus") : ""].filter(Boolean).join(" · ") : "omp /live"}</div>
      </div>
      <button class="round" class:warn={speakerMuted} disabled={livePhase !== "live"} title={speakerMuted ? t("Ton an") : t("Ton aus (Antwort nicht hören)")} onclick={toggleSpeaker}>{speakerMuted ? "🔇" : "🔊"}</button>
      <button class="round" class:warn={micMuted} disabled={livePhase !== "live"} title={micMuted ? t("Mikrofon an") : t("Mikrofon aus (wie Leertaste) – du hörst weiter zu")} onclick={toggleMic}>{micMuted ? "🎙̸" : "🎙"}</button>
      <button class="round hang" title={t("Live beenden")} onclick={stopLive}>✕</button>
    </div>
  {/if}
  {#if liveError}<div class="err small">{liveError}</div>{/if}
  {#if liveNote && !livePhase}<div class="muted small">{liveNote}</div>{/if}
{/snippet}

{#snippet liveButton()}
  {#if pane.live && !livePhase}
    <button class="livebtn" title={t("Live mit omp sprechen")} onclick={startLive}>〰 Live</button>
  {/if}
{/snippet}

{#snippet hud(tl: Timeline)}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="hud mono">
    {#if phase}
      {@const phases = tl.todo ?? []}
      <div class="todo" onclick={() => (todoOpen = !todoOpen)} title={todoOpen ? t("TODO zuklappen") : t("Ganze TODO-Liste")}>
        <div class="hrow">
          <b class="acc">TODO</b>
          {#if !todoOpen}<span class="acc ellipsis">{phaseName(phase, phases)}</span><span class="dim">· {phaseDone(phase)}/{phase.tasks.length}</span>{/if}
          <span class="grow"></span><span class="dim">{todoOpen ? "▾" : "▴"}</span>
        </div>
        {#if todoOpen}
          {#each phases as ph (ph.name)}
            {@const active = ph.name === phase.name}
            <div class="hrow"><span class="dim">├─</span><span class:acc={active} class:muted={!active} class:b={active}>{phaseName(ph, phases)}</span><span class="dim">· {phaseDone(ph)}/{ph.tasks.length}</span></div>
            {#if active}
              {#each ph.tasks as task}
                <div class="hrow"><span class="dim">│ </span>{@render todoRow(task)}</div>
              {/each}
            {/if}
          {/each}
          <div class="dim">└─────</div>
        {:else}
          {#each phase.tasks.filter((x) => x.status === "in_progress").slice(0, 2) as task}
            <div class="hrow pad">{@render todoRow(task)}</div>
          {/each}
        {/if}
      </div>
    {/if}
    {#each tl.jobs as job (job.id)}
      <div class="hrow"><span class="acc">⚙</span><span class="acc">{job.id}</span><span class="dim ellipsis grow">{job.label}</span><span class="dim">{duration(now - job.startedAt)}</span></div>
    {/each}
    {#if tl.running}
      <div class="hrow">
        <span class="braille acc"></span>
        <span class="acc ellipsis grow">{tl.waiting ? t("wartet auf Hintergrund-Jobs") : (workingLabel(tl) ?? "Working…")}</span>
        {#if tl.turnStartedAt}<span class="dim">{duration(now - tl.turnStartedAt)}</span>{/if}
      </div>
    {/if}
  </div>
{/snippet}

{#snippet todoRow(task: { content: string; status: string })}
  <span style:color={todoColor(task.status)}>{task.status === "completed" ? "☑" : "☐"}</span>
  <span class="clamp2" style:color={todoColor(task.status)} class:strike={task.status === "completed" || task.status === "abandoned"}>{task.content}{task.status === "blocked" ? " (blocked)" : ""}</span>
{/snippet}

{#snippet statusLine()}
  {#if timeline?.line}
    {@const l = timeline.line}
    <div class="status mono">
      {#if timeline.running}<span class="braille acc"></span>{/if}
      {#if l.model}<button class="model" title={t("Modell wechseln")} onclick={openModels}>⬢ {l.model}</button>{/if}
      {#if l.folder}<span class="fg">🗀 …{l.folder}</span>{/if}
      {#if l.branch}<button class="branch" title={t("Git & Dateien")} onclick={() => togglePanel("git")}>⑂ {l.branch}{l.dirty ? ` *${l.dirty}` : ""}</button>{/if}
      {#if l.context}<span class="muted">◔ {l.context}</span>{/if}
      {#if l.cost}<span class="dim">${l.cost}</span>{/if}
    </div>
  {/if}
{/snippet}

<section class="agent" class:zen>
  {#if !zen}
    <header>
      <div class="who">
        <div class="title ellipsis">{title}</div>
        <div class="sub ellipsis">
          <span class="dot" class:working class:blocked={!working && status === "blocked"} class:ok={!working && (status === "idle" || status === "done")}></span>
          {isShell ? `${t("Terminal")} · ${shortPath(pane.cwd)}` : `${agentName} · ${working ? t("arbeitet") : statusLabel(status)}`}
          {#if livePhase === "live"}<span style:color={liveColor}> · Live: {ompStateLabel(ompState)}</span>{/if}
          {#if !isShell}<span class="dim"> · {shortPath(pane.cwd)}</span>{/if}
          <span class="dim"> · {serverLabel}</span>
        </div>
      </div>
      <div class="actions">
        {#if pane.agent}
          <div class="seg">
            <button class:on={mode === "chat"} onclick={() => (mode = "chat")} title={`${mod}${shift}T`}>{t("Chat")}</button>
            <button class:on={mode === "terminal"} onclick={() => (mode = "terminal")} title={`${mod}${shift}T`}>{t("Terminal")}</button>
          </div>
        {/if}
        <button class="ib" class:on={panel === "git"} title={`${t("Git & Dateien")} (${mod}${shift}G)`} onclick={() => togglePanel("git")}>⑂</button>
        <button class="ib" class:on={panel === "browser"} title={`${t("Browser")} (${mod}${shift}B)`} onclick={() => togglePanel("browser")}>◍</button>
        <button class="ib" class:on={panel === "info"} title={`${t("Info")} (${mod}${shift}I)`} onclick={() => togglePanel("info")}>ⓘ</button>
        <button class="ib" title={`${t("Zen-Modus")} (${mod}${shift}F)`} onclick={() => { zen = true; menu = false; }}>⤢</button>
        <div class="menuwrap">
          <button class="ib" class:on={menu} title={t("Mehr")} onclick={(e) => { e.stopPropagation(); menu = !menu; }}>⋯</button>
          {#if menu}
            <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
            <div class="menu" onclick={(e) => e.stopPropagation()}>
              {#if pane.agent}<button class="mi" onclick={openModels}>⬢ {t("Modell wechseln")}<kbd>{mod}{shift}M</kbd></button>{/if}
              <button class="mi" onclick={() => { menu = false; togglePanel("git"); }}>⑂ {t("Git & Dateien")}<kbd>{mod}{shift}G</kbd></button>
              <button class="mi" onclick={() => { menu = false; togglePanel("browser"); }}>◍ {t("Browser")}<kbd>{mod}{shift}B</kbd></button>
              <button class="mi" onclick={() => { menu = false; zen = true; }}>⤢ {t("Zen-Modus")}<kbd>{mod}{shift}F</kbd></button>
              {#if pane.agent}
                <button class="mi" onclick={() => { menu = false; mode = mode === "chat" ? "terminal" : "chat"; }}>&gt;_ {mode === "chat" ? t("Terminal zeigen") : t("Chat zeigen")}<kbd>{mod}{shift}T</kbd></button>
                <button class="mi" onclick={() => { menu = false; sendKeys(["esc"]); }}>⏹ {t("Unterbrechen (Esc)")}<kbd>{mod}.</kbd></button>
              {/if}
              <div class="msec">{t("Textgröße")} · {Math.round(settings.zoom * 100)} %</div>
              <button class="mi" onclick={() => zoomBy(0.1)}>A⁺ {t("Größer")}<kbd>{mod}+</kbd></button>
              <button class="mi" onclick={() => zoomBy(-0.1)}>A⁻ {t("Kleiner")}<kbd>{mod}-</kbd></button>
              <button class="mi" onclick={() => zoomBy(0)}>↺ {t("Standardgröße")}<kbd>{mod}0</kbd></button>
              {#if others.length}
                <div class="msec">{t("Wechseln zu")}</div>
                <div class="mscroll">
                  {#each others as r (r.id)}
                    <button class="mi" onclick={() => { menu = false; go({ view: "agent", server: r.server.id, pane: r.pane.pane }); }}>
                      <span class="dot" class:working={r.pane.status === "working"} class:blocked={r.pane.status === "blocked"} class:ok={r.pane.status === "idle" || r.pane.status === "done"}></span>
                      <span class="ellipsis">{tabName(r.tab.label, r.workspace.label)}</span><span class="dim small">{r.pane.agent ?? t("Terminal")}</span>
                    </button>
                  {/each}
                </div>
              {/if}
              <div class="msep"></div>
              <button class="mi danger" onclick={() => { menu = false; confirmClose = true; }}>✕ {t("Chat schließen")}</button>
            </div>
          {/if}
        </div>
      </div>
    </header>
  {/if}

  <div class="body">
    <div class="main">
      {#if mode === "chat"}
        <div class="scroll" bind:this={scroller} onscroll={onScroll}>
          <div class="inner" bind:this={inner}>
            <div class="ttl">{transcriptTitle}</div>
            {#if isOmp && timeline}
              {#if !timeline.items.length && !pending.length}{@render emptyHint()}{/if}
              <TimelineView {timeline} {onLink} onAnswer={answerAsk} />
            {:else if !isOmp}
              {#if !bubbles.length && !pending.length && (!screen || !showsScreen)}{@render emptyHint()}{/if}
              {#each bubbles as b, i (i)}
                {#if b.kind === "voice" || b.kind === "typed"}
                  <div class="bubble"><span class="bi">{b.kind === "voice" ? "〰" : "⌨"}</span><div class="bt">{b.text}</div></div>
                {:else if b.kind === "agent"}
                  <Markdown text={b.text} dimmed={!b.final} {onLink} />
                {:else if b.kind === "tool"}
                  <div class="tool mono ellipsis">🔨 {b.text}</div>
                {:else}
                  <div class="info">{b.text}</div>
                {/if}
              {/each}
            {:else}
              {@render emptyHint()}
            {/if}
            {#each pending as p}
              <div class="bubble pending"><span class="bi">⌨</span><div class="bt">{p}</div></div>
            {/each}
            {#if showsScreen && screen}
              {@const waiting = status === "blocked"}
              <div class="screencard" class:waiting>
                <div class="sc-head">
                  <span>{waiting ? `⚠ ${t("Wartet auf dich – antworte mit >_ (z. B. ↓ und Enter)")}` : `>_ ${t("Terminal")}`}</span>
                  {#if isOmp}<button class="link" onclick={() => (screenOpen = !screenOpen)}>{screenOpen ? "▴" : "▾"}</button>{/if}
                  <button class="link" onclick={() => (mode = "terminal")}>{t("Interaktiv öffnen")}</button>
                </div>
                {#if !isOmp || screenOpen}<pre>{screen}</pre>{/if}
              </div>
            {/if}
            {#if error}<div class="warnline">⚠ {error}</div>{/if}
          </div>
        </div>
        {#if !stick}
          <button class="jump" class:new={unseen} onclick={toBottom} title={t("Nach unten")}>↓{#if unseen} {t("Neu")}{/if}</button>
        {/if}
      {:else}
        <div class="termwrap">
          <TerminalView bind:this={term} {server} pane={pane.pane} onError={(m) => (actionError = m)} />
          {#if error}<div class="warnline">⚠ {error}</div>{/if}
        </div>
      {/if}

      <div class="bottom" class:float={zen}>
        {#if timeline && hudVisible(timeline)}
          <div class="hudwrap" class:glass={zen}>{@render hud(timeline)}</div>
        {/if}
        <Composer bind:this={composer} bind:value={() => drafts.text(key), (v) => drafts.setText(key, v)}
          bind:sent={() => drafts.recall(key), (v) => drafts.setRecall(key, v)} {placeholder} {keysTitle} translucent={zen} onSend={sendDraft} onKeys={sendKeys}
          {server} {ws} top={liveStrip} trailing={liveButton} />
        {#if !zen}{@render statusLine()}{/if}
      </div>

      {#if zen}
        <div class="readbar">
          <button title={t("Text kleiner")} onclick={() => zoomBy(-0.1)}>A⁻</button>
          <button title={t("Text größer")} onclick={() => zoomBy(0.1)}>A⁺</button>
          <span class="vsep"></span>
          <button title={`${t("Zen-Modus beenden")} (Esc)`} onclick={() => (zen = false)}>⤡</button>
        </div>
      {/if}
      {#if toast}<div class="toast">Aa {toast}</div>{/if}
    </div>

    {#if (panel || browserOpen) && !zen}
      <div class="splitter" class:hidden={!panel} role="separator" aria-orientation="vertical" onpointerdown={startResize}></div>
    {/if}
    <aside class="side" class:hidden={!panel || zen} style:width="{panelWidth}px">
      {#if panel || browserOpen}
        <div class="tabs">
          <button class:on={panel === "git"} onclick={() => (panel = "git")}>⑂ Git</button>
          <button class:on={panel === "browser"} onclick={() => { browserOpen = true; panel = "browser"; }}>◍ {t("Browser")}</button>
          <button class:on={panel === "info"} onclick={() => (panel = "info")}>ⓘ {t("Info")}</button>
          <span class="grow"></span>
          <button class="x" title={t("Seitenleiste schließen")} onclick={() => (panel = "")}>✕</button>
        </div>
        <div class="pbody">
          {#if panel === "git"}
            <div class="fill"><GitPanel {server} {ws} /></div>
          {:else if panel === "info"}
            {@render info()}
          {/if}
          {#if browserOpen}
            <div class="fill" class:hidden={panel !== "browser"}>
              <BrowserPanel {server} {serverLabel} request={browserRequest} onClose={() => { browserOpen = false; browserRequest = null; if (panel === "browser") panel = ""; }} />
            </div>
          {/if}
        </div>
      {/if}
    </aside>
  </div>
</section>

{#snippet emptyHint()}
  <div class="empty">
    {#if !loaded && !isShell}
      <div class="sk">{#each [80, 55, 70, 40, 65, 50] as w, i}<div class="skeleton" style:width="{w}%" style:align-self={i % 3 === 0 ? "flex-end" : "flex-start"}></div>{/each}</div>
    {:else if livePhase === "connecting"}
      <div>{t("omp /live wird gestartet …")}</div>
    {:else if livePhase === "live"}
      <div>{t("Ich höre zu …")}</div>
    {:else if pane.live}
      <div>{t("Klicke auf „Live“ und sprich mit omp.")}</div>
      <div class="small">{t("Was du sagst, landet direkt in dieser Session – wie /live am Rechner.")}</div>
    {:else if pane.agent}
      <div>{t("Sprechen geht bisher nur mit omp.")}</div>
      <div class="small">{t("An {agent} kannst du unten Text schicken.", { agent: agentName })}</div>
    {:else}
      <div>{t("Hier läuft kein Agent, nur eine Shell.")}</div>
    {/if}
  </div>
{/snippet}

{#snippet info()}
  {@const l = timeline?.line}
  <div class="infop">
    <div class="rows">
      {#each [[t("Server"), serverLabel], ["Pane", pane.pane], [t("Agent"), pane.agent ? agentName : t("Terminal")], [t("Status"), working ? t("arbeitet") : statusLabel(status)], [t("Ordner"), shortPath(pane.cwd)], [t("Modell"), l?.model ?? timeline?.model], ["Branch", l?.branch ? `${l.branch}${l.dirty ? ` *${l.dirty}` : ""}` : undefined], [t("Kontext"), l?.context], [t("Kosten"), l?.cost ? `$${l.cost}` : undefined]] as [k, v]}
        {#if v}<div class="row"><span class="muted grow">{k}</span><span class="mono small sel ellipsis">{v}</span></div>{/if}
      {/each}
    </div>
    {#if pane.agent && pane.agent !== "shell"}
      <button class="btn wide" onclick={openModels}>⬢ {t("Modell wechseln")}</button>
    {/if}
    {#if timeline?.todo?.length}
      <div class="section">TODO</div>
      <div class="card mono small">
        {#each timeline.todo as ph (ph.name)}
          <div class="b">{phaseName(ph, timeline.todo)} <span class="dim">· {phaseDone(ph)}/{ph.tasks.length}</span></div>
          {#each ph.tasks as task}<div class="hrow pad">{@render todoRow(task)}</div>{/each}
        {/each}
      </div>
    {/if}
    {#if timeline?.jobs.length}
      <div class="section">{t("Hintergrund-Jobs")}</div>
      <div class="card mono small">
        {#each timeline.jobs as job (job.id)}<div class="hrow"><span class="acc">⚙ {job.id}</span><span class="dim ellipsis grow">{job.label}</span><span class="dim">{duration(now - job.startedAt)}</span></div>{/each}
      </div>
    {/if}
    <div class="section">{t("Tastenkürzel")}</div>
    <div class="card small keys">
      {#each [["⏎", t("Senden")], [`${shift}⏎`, t("Neue Zeile")], ["↑", t("Letzte Nachricht")], [`${mod}K`, t("Eingabe fokussieren")], [`${mod}.`, t("Unterbrechen (Esc)")], [`${mod}${shift}T`, t("Chat / Terminal")], [`${mod}${shift}F`, t("Zen-Modus")], ["Esc", t("Zen-Modus beenden")], [`${mod}${shift}G / B / I`, t("Git / Browser / Info")], [`${mod}${shift}M`, t("Modell wechseln")], [`${mod}+ / ${mod}-`, t("Textgröße")]] as [k, v]}
        <div class="hrow"><kbd>{k}</kbd><span class="muted">{v}</span></div>
      {/each}
    </div>
  </div>
{/snippet}

{#if showModels && pane.agent}
  <ModelDialog {server} kind={pane.agent} current={timeline?.line?.model ?? timeline?.model}
    onClose={() => (showModels = false)}
    onPick={async (model, level) => {
      try {
        await api.switchModel(server, pane.pane, model, level);
        setTimeout(tick, 1500);
      } catch (e) {
        actionError = e instanceof Error ? e.message : String(e);
      }
      showModels = false;
    }} />
{/if}

{#if showCodex}
  <Modal title={t("Modell wechseln")} onClose={() => (showCodex = false)}>
    <p>{t("Codex wechselt das Modell nur über seine eigene Auswahl im Terminal.")}</p>
    <p class="muted small">{t("Danach mit >_ ↑ ↓ und Enter wählen.")}</p>
    <div class="mbuttons">
      <button class="btn" onclick={() => (showCodex = false)}>{t("Abbrechen")}</button>
      <button class="btn primary" onclick={() => { showCodex = false; sendText("/model"); mode = "terminal"; }}>{t("Auswahl in Codex öffnen (/model)")}</button>
    </div>
  </Modal>
{/if}

{#if confirmClose}
  <Modal title={t("Chat schließen?")} onClose={() => (confirmClose = false)}>
    <p>{t("Das Pane „{title}“ wird in herdr auf {server} geschlossen und {agent} beendet.", { title, server: serverLabel, agent: agentName })}</p>
    <div class="mbuttons">
      <button class="btn" onclick={() => (confirmClose = false)}>{t("Abbrechen")}</button>
      <button class="btn danger" onclick={close}>{t("Schließen")}</button>
    </div>
  </Modal>
{/if}

{#if linkUrl}
  {@const url = linkUrl}
  <Modal title={url.host || "Link"} onClose={() => (linkUrl = null)}>
    <div class="mono small sel linkurl">{url.href}</div>
    {#if isLoopback(url)}<div class="muted small">{t("localhost-Adressen öffnet Hollr über die SSH-Verbindung zum Server.")}</div>{/if}
    <div class="choices">
      <!-- svelte-ignore a11y_autofocus -->
      <button class="btn primary" autofocus onclick={() => linkInBrowser(url)}>◍ {t("Im Hollr-Browser")}</button>
      <button class="btn" onclick={() => linkExternal(url)}>↗ {t("Im System-Browser")}</button>
      <button class="btn" onclick={() => linkCopy(url)}>⧉ {t("Link kopieren")}</button>
      <button class="btn" onclick={() => (linkUrl = null)}>{t("Abbrechen")}</button>
    </div>
  </Modal>
{/if}

<style>
  .agent { display: flex; flex-direction: column; height: 100%; min-width: 0; background: var(--bg); }
  .agent.zen { position: fixed; inset: 0; z-index: 5; }
  header { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 10px 16px 10px 18px;
    border-bottom: 1px solid var(--border); min-width: 0; }
  .who { min-width: 0; }
  .title { font-weight: 600; font-size: 15px; }
  .sub { color: var(--muted); font-size: 12px; }
  .actions { display: flex; gap: 4px; align-items: center; flex: none; }
  .dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: var(--dim); margin-right: 4px; flex: none; }
  .dot.ok { background: var(--green); }
  .dot.working { background: var(--purple); }
  .dot.blocked { background: var(--orange); }
  .seg { display: flex; background: var(--card); border-radius: 999px; padding: 2px; margin-right: 6px; }
  .seg button { all: unset; cursor: pointer; padding: 3px 12px; border-radius: 999px; color: var(--muted); font-size: 12.5px; }
  .seg button.on { background: var(--bg); color: var(--fg); }
  .ib { all: unset; cursor: pointer; width: 30px; height: 30px; display: grid; place-items: center; border-radius: 8px; color: var(--muted); font-size: 15px; }
  .ib:hover { background: var(--card); color: var(--fg); }
  .ib.on { background: color-mix(in srgb, var(--accent) 22%, transparent); color: var(--fg); }
  .menuwrap { position: relative; }
  .menu { position: absolute; right: 0; top: calc(100% + 6px); z-index: 20; width: 270px; background: var(--side); border: 1px solid var(--border);
    border-radius: 12px; padding: 6px; box-shadow: 0 12px 34px rgba(0, 0, 0, 0.38); }
  .mi { all: unset; box-sizing: border-box; cursor: pointer; display: flex; align-items: center; gap: 8px; width: 100%; padding: 6px 9px; border-radius: 7px; font-size: 13px; }
  .mi:hover { background: color-mix(in srgb, var(--accent) 22%, transparent); }
  .mi.danger { color: var(--red); }
  .mi kbd { margin-left: auto; }
  kbd { font-family: var(--mono); font-size: 10.5px; color: var(--dim); }
  .msec { font-size: 11px; color: var(--muted); padding: 8px 9px 3px; border-top: 1px solid var(--border); margin-top: 4px; }
  .msep { border-top: 1px solid var(--border); margin: 4px 0; }
  .mscroll { max-height: 200px; overflow-y: auto; }

  .body { flex: 1; min-height: 0; display: flex; position: relative; }
  .main { flex: 1; min-width: 0; display: flex; flex-direction: column; position: relative; }
  .scroll { flex: 1; overflow-y: auto; padding: 14px 22px 18px; overflow-anchor: none; }
  .zen .scroll { padding-top: 22px; padding-bottom: 220px; }
  .inner { max-width: 920px; margin: 0 auto; display: flex; flex-direction: column; gap: 12px; }
  .ttl { text-align: center; font-size: 11.5px; color: var(--dim); }
  .termwrap { flex: 1; min-height: 0; padding: 12px 16px 6px; display: flex; flex-direction: column; gap: 6px; }
  .bottom { padding: 6px 16px 8px; display: flex; flex-direction: column; gap: 8px; width: 100%; max-width: 952px; margin: 0 auto; }
  .bottom.float { position: absolute; left: 50%; bottom: 12px; transform: translateX(-50%); width: min(880px, calc(100% - 32px)); padding: 0; }
  .hudwrap.glass { background: color-mix(in srgb, var(--raised) 70%, transparent); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
    border-radius: 12px; padding: 6px 10px; }
  .hud { font-size: 12px; display: flex; flex-direction: column; gap: 3px; padding: 0 6px; }
  .todo { cursor: pointer; display: flex; flex-direction: column; gap: 3px; }
  .hrow { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
  .pad { padding-left: 4px; }
  .b { font-weight: 700; }
  .strike { text-decoration: line-through; }
  .clamp2 { display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .status { display: flex; align-items: center; gap: 14px; padding: 0 8px; font-size: 11px; color: var(--muted); white-space: nowrap; overflow-x: auto; scrollbar-width: none; }
  .status button { all: unset; cursor: pointer; border-radius: 5px; padding: 1px 3px; margin: 0 -3px; }
  .status button:hover { background: color-mix(in srgb, var(--fg) 8%, transparent); }
  .model { color: var(--purple); }
  .branch { color: var(--orange); }
  .fg { color: color-mix(in srgb, var(--fg) 80%, transparent); }

  .bubble { align-self: flex-end; display: flex; align-items: flex-end; gap: 6px; max-width: 78%; }
  .bt { background: color-mix(in srgb, var(--accent) 35%, transparent); border-radius: 18px; padding: 9px 14px; white-space: pre-wrap; overflow-wrap: anywhere; user-select: text; }
  .bubble.pending .bt { background: color-mix(in srgb, var(--accent) 20%, transparent); }
  .bubble.pending { opacity: 0.85; }
  .bi { font-size: 11px; color: var(--muted); padding-bottom: 6px; }
  .tool { color: var(--purple); font-size: 12px; padding-left: 6px; }
  .info { text-align: center; color: var(--muted); font-size: 12px; }
  .empty { text-align: center; color: var(--muted); padding: 40px 0 10px; display: flex; flex-direction: column; gap: 6px; }
  .sk { display: flex; flex-direction: column; gap: 14px; }
  .sk .skeleton { height: 34px; border-radius: 14px; }
  .screencard { background: var(--raised); border: 1px solid color-mix(in srgb, var(--fg) 8%, transparent); border-radius: 14px; padding: 12px; }
  .screencard.waiting { border-color: color-mix(in srgb, var(--orange) 50%, transparent); }
  .sc-head { display: flex; justify-content: space-between; gap: 10px; font-size: 12px; font-weight: 600; color: var(--muted); margin-bottom: 8px; }
  .screencard.waiting .sc-head > span { color: var(--orange); }
  .screencard pre { margin: 0; font-family: var(--mono); font-size: 12px; white-space: pre; overflow-x: auto; user-select: text; }
  .link { all: unset; cursor: pointer; color: var(--accent); font-weight: 500; }
  .link:hover { text-decoration: underline; }
  .warnline { color: var(--orange); font-size: 12.5px; text-align: center; }
  .jump { position: absolute; right: 26px; bottom: 150px; z-index: 3; border: 1px solid var(--border); background: var(--side); color: var(--fg);
    border-radius: 999px; padding: 5px 12px; font-size: 12px; box-shadow: 0 4px 14px rgba(0, 0, 0, 0.3); }
  .zen .jump { bottom: 190px; }
  .jump.new { border-color: var(--accent); }

  .live { display: flex; align-items: center; gap: 12px; }
  .live b { font-size: 13.5px; }
  .livestate { color: var(--live); }
  .bars { display: flex; gap: 3px; align-items: center; width: 36px; height: 30px; flex: none; }
  .bars span { width: 4px; border-radius: 2px; background: var(--live); transition: height 0.1s; }
  .round { width: 34px; height: 34px; border-radius: 50%; border: 0; background: color-mix(in srgb, var(--fg) 10%, transparent); flex: none; }
  .round:disabled { opacity: 0.4; }
  .round.warn { background: var(--orange); }
  .round.hang { background: var(--red); color: #fff; }
  .livebtn { all: unset; cursor: pointer; height: 32px; padding: 0 12px; border-radius: 999px; font-size: 13px; font-weight: 600;
    color: var(--green); background: color-mix(in srgb, var(--green) 20%, transparent); }
  .livebtn:hover { background: color-mix(in srgb, var(--green) 30%, transparent); }

  .readbar { position: absolute; top: 10px; right: 14px; z-index: 4; display: flex; align-items: center; gap: 2px; padding: 3px 6px;
    border-radius: 999px; background: color-mix(in srgb, var(--raised) 70%, transparent); backdrop-filter: blur(20px);
    -webkit-backdrop-filter: blur(20px); border: 1px solid color-mix(in srgb, var(--fg) 10%, transparent); }
  .readbar button { all: unset; cursor: pointer; width: 34px; height: 30px; display: grid; place-items: center; border-radius: 999px; font-weight: 600; }
  .readbar button:hover { background: color-mix(in srgb, var(--fg) 10%, transparent); }
  .vsep { width: 1px; height: 18px; background: var(--border); margin: 0 3px; }
  .toast { position: absolute; top: 12px; left: 50%; transform: translateX(-50%); z-index: 6; background: var(--card); border: 1px solid var(--border);
    border-radius: 999px; padding: 6px 14px; font-size: 12.5px; font-weight: 600; pointer-events: none; animation: fade 0.15s ease-out; }
  @keyframes fade { from { opacity: 0; transform: translate(-50%, -6px); } }

  .splitter { width: 5px; margin: 0 -2px; cursor: col-resize; z-index: 2; position: relative; flex: none; }
  .splitter::after { content: ""; position: absolute; inset: 0 2px; background: var(--border); }
  .splitter:hover::after { background: var(--accent); }
  .side { flex: none; min-width: 300px; max-width: 70%; display: flex; flex-direction: column; min-height: 0; background: var(--bg); }
  .hidden { display: none !important; }
  .tabs { display: flex; align-items: center; gap: 2px; padding: 6px 8px; border-bottom: 1px solid var(--border); }
  .tabs button { all: unset; cursor: pointer; padding: 4px 10px; border-radius: 7px; font-size: 12.5px; color: var(--muted); }
  .tabs button:hover { color: var(--fg); background: var(--card); }
  .tabs button.on { color: var(--fg); background: color-mix(in srgb, var(--accent) 20%, transparent); }
  .tabs .x { padding: 4px 8px; }
  .pbody { flex: 1; min-height: 0; position: relative; display: flex; flex-direction: column; }
  .fill { flex: 1; min-height: 0; display: flex; flex-direction: column; }
  .fill > :global(*) { flex: 1; min-height: 0; }
  .infop { flex: 1; overflow-y: auto; padding: 12px 14px 24px; display: flex; flex-direction: column; gap: 8px; }
  .infop .section { margin: 14px 0 0; }
  .infop .row { min-height: 36px; padding: 6px 12px; gap: 12px; }
  .infop .keys { display: flex; flex-direction: column; gap: 4px; }
  .infop .keys kbd { min-width: 110px; color: var(--fg); }
  .wide { width: 100%; }
  .sel { user-select: text; }
  @media (max-width: 980px) {
    .side { position: absolute; right: 0; top: 0; bottom: 0; z-index: 4; box-shadow: -10px 0 30px rgba(0, 0, 0, 0.35); border-left: 1px solid var(--border); }
    .splitter { display: none; }
  }

  .mbuttons { display: flex; justify-content: flex-end; gap: 8px; }
  .choices { display: flex; flex-direction: column; gap: 6px; }
  .choices .btn { text-align: left; padding: 8px 12px; }
  .linkurl { word-break: break-all; color: var(--muted); }
  p { margin: 0; }
  .grow { flex: 1; min-width: 0; }
  .ellipsis { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  .small { font-size: 12px; }
  .mono { font-family: var(--mono); }
  .acc { color: var(--orange); }
  .dim { color: var(--dim); }
  .muted { color: var(--muted); }
  .err { color: var(--red); }

  /* omp's braille spinner (TimelineView & HUD) */
  :global(.braille)::before { content: "⣾"; display: inline-block; animation: braille 0.72s steps(1) infinite; }
  @keyframes -global-braille {
    0% { content: "⣾"; } 12.5% { content: "⣽"; } 25% { content: "⣻"; } 37.5% { content: "⢿"; }
    50% { content: "⡿"; } 62.5% { content: "⣟"; } 75% { content: "⣯"; } 87.5% { content: "⣷"; }
  }
</style>
