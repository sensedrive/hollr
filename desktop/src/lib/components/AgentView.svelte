<script lang="ts">
  // One session (AgentDetailView.swift): omp/Claude transcript (else chat history + screen) / terminal, pinned HUD
  // (TODO, jobs, working or waiting-for-you row), composer with keys and live voice, the status line, ⋯ menu, zen mode and a right side
  // panel (git / in-app browser / info). "🎙 Nebengespräch" opens a write-guarded fork of the session in its own window.
  import { onDestroy, onMount, untrack } from "svelte";
  import { openUrl } from "@tauri-apps/plugin-opener";
  import * as api from "../api";
  import type { AskPick, Pane, Timeline, Workspace } from "../api";
  import type { Snippet } from "svelte";
  import WorkspaceTabs from "./WorkspaceTabs.svelte";
  import AskCard from "./AskCard.svelte";
  import SideChats from "./SideChats.svelte";
  import { sidechats } from "../sidechats.svelte";
  import Icon from "./git/Icon.svelte";
  import { statusLabel, t } from "../i18n";
  import { settings } from "../settings.svelte";
  import { allPanes, drafts, findPane, go, refresh, serverById, tabName } from "../store.svelte";
  import {
    live, liveAbout, liveActive, liveColor as liveColorNow, liveStateLabel, startLive as startLiveOn, stopLiveOn,
  } from "../live.svelte";
  import { forkOf } from "../sidetalk";
  import { forkError, openSide, sideTitle } from "../sideWindow";
  import { draftKey } from "../drafts";
  import { followTimeline } from "../follow";
  import { sessionTerms } from "../dictationText";
  import {
    cleanScreen, cleanTitle, duration, hashId, history as loadHistory, hudVisible, isLoopback, openPhase, pendingAsk, phaseDone, phaseName,
    runningActivity, shortPath, todoColor, toolTitle, urlPort, viaTunnel, waitingSince, type HistoryEvent,
  } from "../agent";
  import { jobViews, shortCommand } from "../chatTools";
  import MsgActions from "./MsgActions.svelte";
  import TimelineView from "./TimelineView.svelte";
  import TerminalView from "./TerminalView.svelte";
  import TimeStrip from "./TimeStrip.svelte";
  import Composer from "./Composer.svelte";
  import Markdown from "./Markdown.svelte";
  import BrowserPanel from "./BrowserPanel.svelte";
  import ModelDialog from "./ModelDialog.svelte";
  import GitPanel from "./GitPanel.svelte";
  import Modal from "./Modal.svelte";
  import LiveBar from "./LiveBar.svelte";
  import { rememberViewPrefs, viewPrefsOf, type ViewMode } from "../viewPrefs";
  import { parsePathHref } from "../paths";
  import FilePreview from "./FilePreview.svelte";

  let { server, pane, workspace, title, onClosed, open, url, inSideWindow = false, autoLive = false, onTimeline, lead, extra }: {
    server: string; pane: Pane; title: string;
    /** its space: the session shows the space's tab bar with its own tools in it (none in the side window) */
    workspace?: Workspace;
    /** without a workspace (side window): what the bar says on the left, and its own actions before the tools */
    lead?: Snippet;
    extra?: Snippet;
    /** show this right away (from the dashboard's quick actions) */
    open?: "terminal" | "git" | "browser";
    /** address for open = "browser" */
    url?: string;
    /** the pane was closed; gets its "serverId|pane" */
    onClosed: (id: string) => void;
    /** shown in the side conversation's window (SideWindow): its own strip leads back, not this header */
    inSideWindow?: boolean;
    /** start Live once the agent is ready (a fresh side conversation) – asks first if a call runs elsewhere */
    autoLive?: boolean;
    /** every new timeline (the side window's result needs the conversation) */
    onTimeline?: (tl: Timeline) => void;
  } = $props();

  const ws = $derived(pane.pane.split(":")[0] ?? "");
  const isOmp = $derived(pane.agent === "omp");
  /** agents whose session log the server turns into a timeline (codex: history + screen) */
  const hasTimeline = $derived(pane.agent === "omp" || pane.agent === "claude");
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
  /** typed prompts that are not in the log yet; `seen` = how often the log had this text when it was sent
   *  (a prompt sent again only counts as arrived once the log has one more of it). Raw: entries are
   *  removed by identity, and a deep proxy would hand back a different object. */
  let pending = $state.raw<{ text: string; seen: number }[]>([]);
  let lastSig = "";
  let busy = false;

  const status = $derived(timeline?.status ?? pane.status);
  const ask = $derived(hasTimeline && timeline ? pendingAsk(timeline) : undefined);
  // the question already shows as an Ask card – then the raw screen would only repeat it
  const askShown = $derived(!!ask);
  /** the agent waits for you (question, permission prompt, dialog) – never "working" then */
  const waitingForUser = $derived(status === "blocked" || askShown);
  const working = $derived(!!timeline?.running && !waitingForUser);
  /** the log has something to show as chat – omp's always does; a Claude timeline stays empty on servers
   *  without its parser (then the screen card is the chat, like for codex). Still loading: the chat's skeleton. */
  const chat = $derived(isOmp || (hasTimeline && (!loaded || !!timeline?.items.length)));
  const showsScreen = $derived((!chat || status === "blocked") && !askShown);
  let screenOpen = $state(false);
  /** when this view saw the agent start waiting – fallback for "since when" when the log has no time.
   *  Only a change seen here counts: waiting already on open has an unknown start (no made-up "4s"). */
  let blockedAt = $state<number | undefined>();
  let sawBusy = false;
  $effect(() => {
    if (!timeline) return;
    if (!waitingForUser) {
      sawBusy = true;
      blockedAt = undefined;
    } else if (sawBusy && untrack(() => blockedAt) === undefined) blockedAt = Date.now();
  });
  const waitStart = $derived((timeline && waitingSince(timeline)) ?? blockedAt);

  const loggedCount = (texts: string[], text: string) => texts.reduce((n, x) => n + (x === text ? 1 : 0), 0);
  /** your prompts in the log (timeline or history) */
  const loggedPrompts = (): string[] =>
    hasTimeline
      ? (timeline?.items ?? []).flatMap((i) => (i.k === "user" ? [i.text] : []))
      : bubbles.filter((b) => b.kind === "typed").map((b) => b.text);
  function dropArrived(logged: string[]) {
    if (pending.some((p) => loggedCount(logged, p.text) > p.seen)) pending = pending.filter((p) => loggedCount(logged, p.text) <= p.seen);
  }

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
    dropArrived(tl.items.flatMap((i) => (i.k === "user" ? [i.text] : [])));
    onTimeline?.(tl);
  }

  /** the chat comes as a stream (`follow`); false = poll `timeline` (older server) */
  let streaming = false;
  $effect(() => {
    if (!hasTimeline) return;
    streaming = true;
    const stop = untrack(() =>
      followTimeline(server, pane.pane, {
        timeline: (tl) => {
          setTimeline(tl);
          streamError = "";
          loaded = true;
        },
        error: (e) => {
          streamError = e;
          loaded = true;
        },
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
      if (hasTimeline) {
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
        dropArrived(fresh.filter((b) => b.kind === "typed").map((b) => b.text));
      }
      if (showsScreen && mode === "chat") screen = cleanScreen(await api.screen(server, pane.pane, 40));
      else screen = "";
      pollError = "";
    } catch (e) {
      pollError = e instanceof Error ? e.message : String(e);
    } finally {
      // with a stream the chat counts as loaded once it delivered (else an empty chat flashes "start talking")
      if (!hasTimeline || !streaming || timeline) loaded = true;
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
    }, hasTimeline ? 2000 : 3000);
  });
  onDestroy(() => clearInterval(poll));

  // elapsed times in the HUD
  let now = $state(Date.now());
  const clock = setInterval(() => (now = Date.now()), 1000);
  onDestroy(() => clearInterval(clock));

  /** Since when the agent works on its own: the turn's start, or – when it asked you mid-turn – the first entry
   *  after your answer (the wait for you is not work). Undefined right after an answer, before anything new. */
  function workingSince(tl: Timeline): number | undefined {
    const lastAsk = tl.items.findLastIndex((i) => i.k === "ask" && !i.pending);
    if (lastAsk < 0) return tl.turnStartedAt;
    const after = tl.items.slice(lastAsk + 1).find((i) => i.at !== undefined);
    if (!after?.at) return undefined;
    return tl.turnStartedAt && tl.turnStartedAt > after.at ? tl.turnStartedAt : after.at;
  }

  // ------------------------------------------------------------ view state

  // chat or terminal and zen as last left in this session (a dashboard "Terminal" click wins)
  const prefs = untrack(() => viewPrefsOf(`${server}|${pane.pane}`));
  // a side conversation always opens as a chat: it is a conversation, and a reused pane id may carry an old "terminal"
  let mode = $state<ViewMode>(untrack(() => (open === "terminal" || !pane.agent ? (pane.fork && pane.agent !== "shell" ? "chat" : "terminal")
    : pane.fork ? "chat" : (prefs.view ?? "chat"))));
  $effect(() => {
    if (pane.agent) rememberViewPrefs(`${server}|${pane.pane}`, { view: mode });
  });
  let zen = $state(prefs.zen ?? false);
  $effect(() => {
    // only "on" is kept: every session opened once would otherwise take a slot
    rememberViewPrefs(`${server}|${pane.pane}`, { zen: zen || undefined });
  });
  let panel = $state<"" | "chats" | "git" | "browser" | "info">(untrack(() => (open === "git" || open === "browser" ? open : "")));
  /** browser stays mounted (tunnels open) until its ✕, even while another panel tab shows */
  let browserOpen = $state(untrack(() => open === "browser"));
  let browserRequest = $state<{ url: string } | null>(untrack(() => (open === "browser" && url ? { url } : null)));
  let menu = $state(false);
  let showModels = $state(false);
  let showCodex = $state(false);
  let confirmClose = $state(false);
  let linkUrl = $state<URL | null>(null);
  /** a path from the chat or terminal in the preview; `n` makes a second click on the same path a fresh open */
  let filePreview = $state<{ path: string; line?: number; n: number } | null>(null);
  /** the preview's "Im Git-Panel öffnen" (space-relative) */
  let gitOpen = $state<{ path: string; dir: boolean; n: number } | null>(null);
  let opens = 0;
  let todoOpen = $state(false);
  let toast = $state("");
  let composer: Composer | undefined = $state();
  let term: TerminalView | undefined = $state();

  const PW = "hollr.agent.panelWidth";
  let panelWidth = $state(Number(localStorage.getItem(PW)) || 460);

  // ---- sidechats ("Nachfragen"): the selection's "Nachfragen" asks to open one here
  let chatOpen = $state<string | undefined>();
  const chatCount = $derived(sidechats.of(server, pane.pane).length);
  $effect(() => {
    const r = sidechats.request;
    if (!r || r.server !== server || r.main !== pane.pane) return;
    untrack(() => {
      sidechats.request = null;
      chatOpen = r.id;
      panel = "chats";
      zen = false;
    });
  });

  function togglePanel(p: "chats" | "git" | "browser" | "info") {
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
  /** the chat's find bar is open: no sticking to the bottom, so new messages don't pull you away from a hit */
  let finding = false;
  let timelineView: TimelineView | undefined = $state();
  /** the chat with its overview ruler at the right edge (TimelineView) */
  const ruled = $derived(settings.chatOverview && chat && !!timeline);

  function onScroll() {
    if (!scroller) return;
    stick = !finding && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 60;
    if (stick) unseen = false;
  }
  function toBottom() {
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
    stick = true;
    unseen = false;
  }
  /** From the terminal's time strip: the chat, scrolled to that message and briefly lit. */
  async function showMessage(id: string) {
    mode = "chat";
    // the chat is mounted and has run its first stick-to-bottom after two frames
    for (let i = 0; i < 2; i++) await new Promise(requestAnimationFrame);
    const el = inner?.querySelector<HTMLElement>(`[data-item="${CSS.escape(id)}"]`);
    if (!el) return;
    stick = false;
    el.scrollIntoView({ block: "center" });
    el.animate([{ boxShadow: "0 0 0 2px var(--accent)" }, { boxShadow: "0 0 0 2px transparent" }], { duration: 1800, easing: "ease-out" });
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
    const entry = { text: msg, seen: loggedCount(loggedPrompts(), msg) };
    if (!isShell && !answering) pending = [...pending, entry];
    try {
      await api.prompt(server, pane.pane, msg);
      actionError = "";
      setTimeout(tick, 500);
      return true;
    } catch (e) {
      pending = pending.filter((p) => p !== entry);
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

  /** A prompt's hover action "send again": the same way as typed, not via the drafts. */
  const resend = (text: string) => void sendText(text);

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
    await stopLiveOn(server, pane.pane);
    try {
      await api.closePane(server, pane.pane);
      onClosed(id);
    } catch (e) {
      actionError = e instanceof Error ? e.message : String(e);
    }
  }

  // ---- links: ask like iOS (Hollr browser / system browser / copy); file paths open the preview
  function onLink(href: string) {
    const file = parsePathHref(href);
    if (file) {
      filePreview = { ...file, n: ++opens };
      return;
    }
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
  function openInGit(path: string, dir: boolean) {
    filePreview = null;
    gitOpen = { path, dir, n: ++opens };
    panel = "git";
    zen = false;
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
      else if (c === "KeyK" && !pane.fork) togglePanel("chats");
      else if (c === "KeyB") togglePanel("browser");
      else if (c === "KeyI") togglePanel("info");
      else if (c === "KeyM") openModels();
      else if (c === "KeyT" && pane.agent) mode = mode === "chat" ? "terminal" : "chat";
      else if (c === "KeyL" && canTalk) openTalk();
      else return;
    } else if (c === "KeyJ") {
      if (mode === "terminal") term?.focus();
      else composer?.focus();
    } else if (c === "Period") sendKeys(["esc"]);
    else return;
    e.preventDefault();
  }

  // ------------------------------------------------------------ live voice (omp /live)
  // The call lives app-wide (live.svelte.ts): leaving this view doesn't hang up, the live pill leads back.
  /** the store's call (or its last error / note) is this session's */
  const liveMine = $derived(liveAbout(server, pane.pane));
  const livePhase = $derived(liveMine ? live.phase : "");
  /** a call is running here (not lost) */
  const liveHere = $derived(liveMine && liveActive());
  const ompState = $derived(liveMine ? live.ompState : undefined);
  const liveColor = $derived(liveMine ? liveColorNow() : "var(--accent)");
  /** Live runs on another pane: starting here ends that call (one microphone, in any window) – asked first */
  let confirmLiveSwitch = $state(false);
  function startLive() {
    if (liveActive() && !liveMine) confirmLiveSwitch = true;
    else void startLiveOn(server, pane.pane, title);
  }
  const ompStateLabel = liveStateLabel;

  // A fresh side conversation talks right away – once omp is ready for /live (idle after loading its session).
  let autoLiveDone = false;
  $effect(() => {
    if (!autoLive || autoLiveDone || !pane.live || !timeline) return;
    if (status !== "idle" && status !== "done") return;
    autoLiveDone = true;
    untrack(startLive);
  });

  // ------------------------------------------------------------ side conversation ("Nebengespräch", sideWindow.ts)
  // A write-guarded fork of this session (server `fork`) in its own window – the whole session view there.
  const canTalk = $derived(hasTimeline && !pane.fork);
  /** this session's side conversation in the tree (the server marks forks) */
  const treeFork = $derived(canTalk ? forkOf(allPanes(server), pane.pane) : undefined);
  let forking = $state(false);

  /** 🎙 / ⌘⇧L: its window – the side conversation is started first when there is none */
  async function openTalk() {
    if (forking) return;
    if (treeFork) return void openSide(server, pane.pane, treeFork.pane.pane, sideTitle(title), false).catch(showError);
    forking = true;
    try {
      const r = await api.fork(server, pane.pane, sideTitle(title));
      await refresh(server);
      // omp: Live starts in the window once the fork is ready
      await openSide(server, pane.pane, r.pane, sideTitle(title), r.kind === "omp");
      actionError = "";
    } catch (e) {
      actionError = forkError(e);
    } finally {
      forking = false;
    }
  }
  const showError = (e: unknown) => (actionError = e instanceof Error ? e.message : String(e));

  /** a side conversation shown in the main window: to its own window (the session it talks about) */
  const forkMain = $derived(pane.fork ? findPane(server, pane.fork.of) : undefined);
  function openOwnWindow() {
    if (!pane.fork) return;
    const main = forkMain ? tabName(forkMain.tab.label, forkMain.workspace.label) : title;
    void openSide(server, pane.fork.of, pane.pane, sideTitle(main), false).catch(showError);
  }

  const placeholder = $derived(
    isShell ? t("Befehl ausführen …") : liveHere ? t("Oder tippen …") : t("Nachricht an {agent} …", { agent: agentName }),
  );
  const keysTitle = $derived(isShell ? t("Tasten ans Terminal senden") : t("Tasten an {agent} senden", { agent: agentName }));
  const transcriptTitle = $derived(cleanTitle(timeline?.title) ?? pane.title);
  const phase = $derived(timeline ? openPhase(timeline) : undefined);
  /** background jobs with what they do (their starting call's intent) – HUD and info panel */
  const jobs = $derived(timeline ? jobViews(timeline) : []);
  /** the HUD only shows what the log doesn't: thinking without a tool, the TODO task, background jobs */
  const hudShown = $derived(!!timeline && (!!phase || jobs.length > 0 || (!!timeline.running && !waitingForUser && !runningActivity(timeline)?.call)));
</script>

<svelte:window onkeydown={onKey} onclick={() => (menu = false)} />

{#snippet liveStrip()}
  <LiveBar {server} pane={pane.pane} />
  {#if mode === "chat" && timeline && hudShown}<div class="inbox">{@render hud(timeline)}</div>{/if}
{/snippet}

{#snippet statusMeta()}
  {#if timeline?.line?.model}<button class="metab" title={t("Modell wechseln")} onclick={openModels}>{timeline.line.model}</button>{/if}
  {#if timeline?.line?.context}<span> · {timeline.line.context}</span>{/if}
{/snippet}

{#snippet liveButton()}
  {#if pane.live && !livePhase}
    <button class="livebtn" title={t("Live mit omp sprechen")} onclick={startLive}><Icon name="〰" size={15} /> Live</button>
  {/if}
{/snippet}

{#snippet hud(tl: Timeline)}
  <!-- one aligned block: what happens now, the todo task, the background jobs – icon | text | time columns -->
  {@const act = waitingForUser ? undefined : runningActivity(tl)}
  {@const since = workingSince(tl)}
  <div class="hud mono">
    {#if waitingForUser && !ask}
      <span class="ic waitc"><Icon name="⚠" size={15} /></span>
      <span class="htxt ellipsis waitc">{t("Wartet auf dich")}</span>
      <span class="meta">{waitStart ? duration(now - waitStart) : ""}</span>
    {:else if tl.running && !act?.call}
      {@const call = act?.call}
      {@const waits = call?.name === "wait" || (!call && tl.waiting)}
      {@const intent = call && call.label && call.label !== call.name ? call.label : undefined}
      {@const line = call?.detail?.split("\n")[0]?.trim()}
      {@const detail = waits
        ? jobs.length ? t("wartet auf {jobs}", { jobs: jobs.length === 1 ? t("1 Job") : t("{n} Jobs", { n: jobs.length }) }) : ""
        : line && line !== intent ? (call?.name === "bash" ? shortCommand(line) : shortPath(line)) : ""}
      {@const start = act?.at ?? since}
      <span class="ic braille acc"></span>
      <span class="htxt ellipsis" title={[call?.detail, since ? t("Antwort läuft seit {d}", { d: duration(now - since) }) : ""].filter(Boolean).join("\n")}>
        <span class="acc">{intent ?? (waits ? t("Wartet auf Hintergrund-Jobs") : call ? toolTitle(call.name) : tl.items.at(-1)?.k === "thinking" ? t("Denkt nach …") : t("Arbeitet …"))}</span>{#if detail}<span class="dim gap">{detail}</span>{/if}
      </span>
      <span class="meta">{start ? duration(now - start) : ""}</span>
    {/if}
    {#if phase}
      {@const phases = tl.todo ?? []}
      {@const current = phase.tasks.find((x) => x.status === "in_progress") ?? phase.tasks.find((x) => x.status !== "completed" && x.status !== "abandoned")}
      <span class="ic" style:color={todoColor(current?.status ?? "pending")}><Icon name={current?.status === "in_progress" ? "◐" : "☐"} size={13} /></span>
      <span class="htxt ellipsis fgs" title={current?.content}>{current?.content ?? phaseName(phase, phases)}</span>
      <button class="meta fold" class:open={todoOpen} onclick={() => (todoOpen = !todoOpen)} title={todoOpen ? t("TODO zuklappen") : t("Ganze TODO-Liste")}
        aria-expanded={todoOpen}>{phaseName(phase, phases)} · {phaseDone(phase)}/{phase.tasks.length}<span class="chev">›</span></button>
      {#if todoOpen}
        <div class="list">
          {#each phases as ph (ph.name)}
            {@const active = ph.name === phase.name}
            <div class="hrow"><span class:acc={active} class:muted={!active} class:b={active}>{phaseName(ph, phases)}</span><span class="dim">{phaseDone(ph)}/{ph.tasks.length}</span></div>
            {#if active}
              {#each ph.tasks as task}
                <div class="hrow pad">{@render todoRow(task)}</div>
              {/each}
            {/if}
          {/each}
        </div>
      {/if}
    {/if}
    {#each jobs as job (job.id)}
      <span class="ic job"><Icon name="⚙" size={15} /></span>
      <span class="htxt ellipsis" title={[hashId(job.id) ? "" : job.id, job.title, job.full].filter(Boolean).join("\n")}>
        {#if !hashId(job.id)}<span class="jid">{job.id}</span>{" "}{/if}<span>{job.title}</span>{#if job.command}<span class="dim gap">{job.command}</span>{/if}
      </span>
      <span class="meta">{job.startedAt ? duration(now - job.startedAt) : ""}</span>
    {/each}
  </div>
{/snippet}

{#snippet todoRow(task: { content: string; status: string })}
  <span style:color={todoColor(task.status)}><Icon name={task.status === "completed" ? "☑" : "☐"} size={13} /></span>
  <span class="clamp2" style:color={todoColor(task.status)} class:strike={task.status === "completed" || task.status === "abandoned"}>{task.content}{task.status === "blocked" ? " (blocked)" : ""}</span>
{/snippet}


{#snippet toolbar()}
      <div class="actions">
        {#if pane.fork && !inSideWindow}
          <button class="talkbtn" title={t("Das Nebengespräch in seinem eigenen Fenster")} onclick={openOwnWindow}><Icon name="🎙" size={15} /> {t("Im eigenen Fenster")}</button>
        {/if}
        {#if pane.agent}
          <div class="seg">
            <button class:on={mode === "chat"} onclick={() => (mode = "chat")} title={`${mod}${shift}T`}>{t("Chat")}</button>
            <button class:on={mode === "terminal"} onclick={() => (mode = "terminal")} title={`${mod}${shift}T`}>{t("Terminal")}</button>
          </div>
        {/if}
        {#if !pane.fork}
          <button class="ib" class:on={panel === "chats"} title={`${t("Nachfragen")}${chatCount ? ` · ${chatCount}` : ""} (${mod}${shift}K)`}
            onclick={() => togglePanel("chats")}><Icon name="message" size={16} /></button>
        {/if}
        <button class="ib" class:on={panel === "git"} title={`${t("Git & Dateien")} (${mod}${shift}G)`} onclick={() => togglePanel("git")}><Icon name="branch" size={16} /></button>
        <button class="ib" class:on={panel === "browser"} title={`${t("Browser")} (${mod}${shift}B)`} onclick={() => togglePanel("browser")}><Icon name="globe" size={16} /></button>
        <button class="ib" class:on={panel === "info"} title={`${t("Info")} (${mod}${shift}I)`} onclick={() => togglePanel("info")}><Icon name="info" size={16} /></button>
        <button class="ib" title={`${t("Zen-Modus")} (${mod}${shift}F)`} onclick={() => { zen = true; menu = false; }}><Icon name="maximize" size={16} /></button>
        <div class="menuwrap">
          <button class="ib" class:on={menu} title={t("Mehr")} onclick={(e) => { e.stopPropagation(); menu = !menu; }}><Icon name="more" size={16} /></button>
          {#if menu}
            <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
            <div class="menu" onclick={(e) => e.stopPropagation()}>
              {#if pane.agent}<button class="mi" onclick={openModels}><Icon name="⬢" size={15} /> {t("Modell wechseln")}<kbd>{mod}{shift}M</kbd></button>{/if}
              {#if canTalk}<button class="mi" onclick={() => { menu = false; openTalk(); }}><Icon name="🎙" size={15} /> {t("Nebengespräch")}<kbd>{mod}{shift}L</kbd></button>{/if}
              <button class="mi" onclick={() => { menu = false; togglePanel("git"); }}><Icon name="⑂" size={15} /> {t("Git & Dateien")}<kbd>{mod}{shift}G</kbd></button>
              <button class="mi" onclick={() => { menu = false; togglePanel("browser"); }}><Icon name="◍" size={15} /> {t("Browser")}<kbd>{mod}{shift}B</kbd></button>
              <button class="mi" onclick={() => { menu = false; zen = true; }}><Icon name="⤢" size={15} /> {t("Zen-Modus")}<kbd>{mod}{shift}F</kbd></button>
              {#if mode === "chat" && chat && timeline}
                <button class="mi" onclick={() => { menu = false; void timelineView?.openFind(); }}><Icon name="⌕" size={15} /> {t("Im Chat suchen")}<kbd>{mod}F</kbd></button>
                <button class="mi" onclick={() => (settings.chatOverview = !settings.chatOverview)}><Icon name="▥" size={15} /> {t("Übersicht")}<kbd>{settings.chatOverview ? "✓" : ""}</kbd></button>
              {/if}
              {#if pane.agent}
                <button class="mi" onclick={() => { menu = false; mode = mode === "chat" ? "terminal" : "chat"; }}><Icon name="terminal" size={14} /> {mode === "chat" ? t("Terminal zeigen") : t("Chat zeigen")}<kbd>{mod}{shift}T</kbd></button>
                <button class="mi" onclick={() => { menu = false; sendKeys(["esc"]); }}><Icon name="⏹" size={15} /> {t("Unterbrechen (Esc)")}<kbd>{mod}.</kbd></button>
              {/if}
              <div class="msec">{t("Textgröße")} · {Math.round(settings.zoom * 100)} %</div>
              <button class="mi" onclick={() => zoomBy(0.1)}><Icon name="zoom-in" size={15} /> {t("Größer")}<kbd>{mod}+</kbd></button>
              <button class="mi" onclick={() => zoomBy(-0.1)}><Icon name="zoom-out" size={15} /> {t("Kleiner")}<kbd>{mod}-</kbd></button>
              <button class="mi" onclick={() => zoomBy(0)}><Icon name="↺" size={15} /> {t("Standardgröße")}<kbd>{mod}0</kbd></button>
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
              <button class="mi danger" onclick={() => { menu = false; confirmClose = true; }}><Icon name="✕" size={15} /> {t("Chat schließen")}</button>
            </div>
          {/if}
        </div>
      </div>
{/snippet}

<section class="agent" class:zen>
  {#if !zen}
    <!-- one bar: the space's tabs, this session's tools on the right (name and status are in its tab) -->
    {#if workspace}
      <WorkspaceTabs {server} {workspace} active={pane.pane} actions={toolbar} />
    {:else}
      <header class="slim">
        {#if lead}<div class="lead">{@render lead()}</div>{/if}
        <span class="grow"></span>
        {#if extra}{@render extra()}{/if}
        {@render toolbar()}
      </header>
    {/if}
  {/if}

  <div class="body">
    <div class="main">
      {#if mode === "chat"}
        <div class="scroll" class:ruled bind:this={scroller} onscroll={onScroll}>
          <div class="inner" bind:this={inner}>
            <div class="ttl">{transcriptTitle}</div>
            {#if chat && timeline}
              {#if !timeline.items.length && !pending.length}{@render emptyHint()}{/if}
              <TimelineView bind:this={timelineView} {timeline} {onLink} onAnswer={answerAsk} pinnedAsk={ask?.id} onResend={askShown ? undefined : resend} root={pane.cwd}
                {scroller} overview={settings.chatOverview} onFinding={(on) => { finding = on; if (on) stick = false; else onScroll(); }} />
            {:else if !hasTimeline}
              {#if !bubbles.length && !pending.length && (!screen || !showsScreen)}{@render emptyHint()}{/if}
              {#each bubbles as b, i (i)}
                {#if b.kind === "voice" || b.kind === "typed"}
                  <div class="bubble"><span class="bi"><Icon name={b.kind === "voice" ? "〰" : "⌨"} size={13} /></span><div class="bt">{b.text}<MsgActions text={b.text} onResend={b.kind === "typed" && !askShown ? resend : undefined} /></div></div>
                {:else if b.kind === "agent"}
                  <Markdown text={b.text} dimmed={!b.final} {onLink} />
                {:else if b.kind === "tool"}
                  <div class="tool mono ellipsis"><Icon name="🔨" size={15} /> {b.text}</div>
                {:else}
                  <div class="info">{b.text}</div>
                {/if}
              {/each}
            {:else if !pending.length && (!screen || !showsScreen)}
              {@render emptyHint()}
            {/if}
            {#each pending as p}
              <div class="bubble pending"><span class="bi"><Icon name="⌨" size={15} /></span><div class="bt">{p.text}</div></div>
            {/each}
            {#if showsScreen && screen}
              {@const waiting = status === "blocked"}
              <div class="screencard" class:waiting>
                <div class="sc-head">
                  <span><Icon name={waiting ? "alert" : "terminal"} size={14} /> {waiting ? t("Wartet auf dich – antworte mit >_ (z. B. ↓ und Enter)") : t("Terminal")}</span>
                  {#if chat}<button class="link" onclick={() => (screenOpen = !screenOpen)}><Icon name={screenOpen ? "▴" : "▾"} size={13} /></button>{/if}
                  <button class="link" onclick={() => (mode = "terminal")}>{t("Interaktiv öffnen")}</button>
                </div>
                {#if !chat || screenOpen}<pre>{screen}</pre>{/if}
              </div>
            {/if}
            {#if error}<div class="warnline"><Icon name="⚠" size={15} /> {error}</div>{/if}
          </div>
        </div>
        {#if !stick}
          <button class="jump" class:new={unseen} onclick={toBottom} title={t("Nach unten")}>↓{#if unseen} {t("Neu")}{/if}</button>
        {/if}
      {:else}
        <div class="termwrap">
          {#if chat && timeline}<TimeStrip {timeline} {working} agent={agentName} onPick={showMessage} />{/if}
          <TerminalView bind:this={term} {server} pane={pane.pane} {onLink} />
          {#if error}<div class="warnline"><Icon name="⚠" size={15} /> {error}</div>{/if}
        </div>
      {/if}

      <!-- terminal mode: the TUI shows TODO, jobs and status itself – only the composer stays (live, typing) -->
      <div class="bottom" class:float={zen} class:term={mode === "terminal"}>
        {#if mode === "chat" && ask}
          <div class="pinned" class:glass={zen}><AskCard item={ask} onAnswer={answerAsk} agent={timeline?.agent === "claude" ? "Claude" : "omp"} /></div>
        {/if}
        <Composer bind:this={composer} bind:value={() => drafts.text(key), (v) => drafts.setText(key, v)}
          bind:sent={() => drafts.recall(key), (v) => drafts.setRecall(key, v)} {placeholder} {keysTitle} translucent={zen} onSend={sendDraft} onKeys={sendKeys}
          {server} {ws} top={liveStrip} trailing={liveButton} meta={mode === "chat" && !zen ? statusMeta : undefined} quick={mode === "terminal"} dictationKey={key} micBlocked={liveActive()}
          vocabulary={() => sessionTerms([title, pane.cwd.split("/").pop() ?? "", timeline?.title ?? ""], timeline?.items ?? [])} />
      </div>

      {#if zen}
        <div class="readbar">
          <button title={t("Text kleiner")} onclick={() => zoomBy(-0.1)}>A⁻</button>
          <button title={t("Text größer")} onclick={() => zoomBy(0.1)}>A⁺</button>
          <span class="vsep"></span>
          <button title={`${t("Zen-Modus beenden")} (Esc)`} onclick={() => (zen = false)}><Icon name="⤡" size={15} /></button>
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
          {#if !pane.fork}<button class:on={panel === "chats"} onclick={() => (panel = "chats")}><Icon name="message" size={15} /> {t("Nachfragen")}</button>{/if}
          <button class:on={panel === "git"} onclick={() => (panel = "git")}><Icon name="⑂" size={15} /> Git</button>
          <button class:on={panel === "browser"} onclick={() => { browserOpen = true; panel = "browser"; }}><Icon name="◍" size={15} /> {t("Browser")}</button>
          <button class:on={panel === "info"} onclick={() => (panel = "info")}><Icon name="ⓘ" size={15} /> {t("Info")}</button>
          <span class="grow"></span>
          <button class="x" title={t("Seitenleiste schließen")} onclick={() => (panel = "")}><Icon name="✕" size={15} /></button>
        </div>
        <div class="pbody">
          {#if panel === "chats"}
            <div class="fill"><SideChats {server} main={pane.pane} {title} bind:active={chatOpen} /></div>
          {:else if panel === "git"}
            <div class="fill"><GitPanel {server} {ws} openFile={gitOpen} /></div>
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
      <button class="btn wide" onclick={openModels}><Icon name="⬢" size={15} /> {t("Modell wechseln")}</button>
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
        {#each timeline.jobs as job (job.id)}<div class="hrow"><span class="acc"><Icon name="⚙" size={15} />{hashId(job.id) ? "" : ` ${job.id}`}</span><span class="dim ellipsis grow" title={job.id}>{job.label}</span><span class="dim">{duration(now - job.startedAt)}</span></div>{/each}
      </div>
    {/if}
    <div class="section">{t("Tastenkürzel")}</div>
    <div class="card small keys">
      {#each [["⏎", t("Senden")], [`${shift}⏎`, t("Neue Zeile")], ["↑", t("Letzte Nachricht")], [`${mod}J`, t("Eingabe fokussieren")], [`${mod}K`, t("Alle Befehle")], [`${mod}.`, t("Unterbrechen (Esc)")], [`${mod}${shift}T`, t("Chat / Terminal")], [`${mod}${shift}F`, t("Zen-Modus")], ["Esc", t("Zen-Modus beenden")], [`${mod}${shift}G / B / I`, t("Git / Browser / Info")], [`${mod}${shift}L`, t("Nebengespräch")], [`${mod}${shift}M`, t("Modell wechseln")], [`${mod}+ / ${mod}-`, t("Textgröße")]] as [k, v]}
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
  <Modal icon="cpu" width={460} title={t("Modell wechseln")} onClose={() => (showCodex = false)}>
    <p>{t("Codex wechselt das Modell nur über seine eigene Auswahl im Terminal.")}</p>
    <p class="muted small">{t("Danach mit >_ ↑ ↓ und Enter wählen.")}</p>
    <div class="mbuttons">
      <button class="btn" onclick={() => (showCodex = false)}>{t("Abbrechen")}</button>
      <button class="btn primary" onclick={() => { showCodex = false; sendText("/model"); mode = "terminal"; }}>{t("Auswahl in Codex öffnen (/model)")}</button>
    </div>
  </Modal>
{/if}

{#if confirmClose}
  <Modal icon="trash" tone="danger" place="center" width={420} title={t("Chat schließen?")} onClose={() => (confirmClose = false)}>
    <p>{t("Das Pane „{title}“ wird in herdr auf {server} geschlossen und {agent} beendet.", { title, server: serverLabel, agent: agentName })}</p>
    <div class="mbuttons">
      <button class="btn" onclick={() => (confirmClose = false)}>{t("Abbrechen")}</button>
      <button class="btn danger" onclick={close}>{t("Schließen")}</button>
    </div>
  </Modal>
{/if}

{#if confirmLiveSwitch}
  <Modal icon="mic" place="center" width={420} title={t("Live wechseln?")} onClose={() => (confirmLiveSwitch = false)}>
    <p>{t("Live läuft gerade mit „{other}“. Das Gespräch dort endet, wenn du hier startest.", { other: live.label || live.pane })}</p>
    <div class="mbuttons">
      <button class="btn" onclick={() => (confirmLiveSwitch = false)}>{t("Abbrechen")}</button>
      <button class="btn primary" onclick={() => { confirmLiveSwitch = false; void startLiveOn(server, pane.pane, title); }}>{t("Hier starten")}</button>
    </div>
  </Modal>
{/if}

{#if linkUrl}
  {@const url = linkUrl}
  <Modal icon="globe" width={440} title={url.host || "Link"} onClose={() => (linkUrl = null)}>
    <div class="mono small sel linkurl">{url.href}</div>
    {#if isLoopback(url)}<div class="muted small">{t("localhost-Adressen öffnet Hollr über die SSH-Verbindung zum Server.")}</div>{/if}
    <div class="choices">
      <!-- svelte-ignore a11y_autofocus -->
      <button class="btn primary" autofocus onclick={() => linkInBrowser(url)}><Icon name="◍" size={15} /> {t("Im Hollr-Browser")}</button>
      <button class="btn" onclick={() => linkExternal(url)}><Icon name="↗" size={15} /> {t("Im System-Browser")}</button>
      <button class="btn" onclick={() => linkCopy(url)}><Icon name="⧉" size={15} /> {t("Link kopieren")}</button>
      <button class="btn" onclick={() => (linkUrl = null)}>{t("Abbrechen")}</button>
    </div>
  </Modal>
{/if}

{#if filePreview}
  {#key filePreview.n}
    <FilePreview {server} pane={pane.pane} path={filePreview.path} line={filePreview.line}
      onClose={() => (filePreview = null)} onGit={openInGit} />
  {/key}
{/if}

<style>
  .agent { display: flex; flex-direction: column; height: 100%; min-width: 0; background: var(--bg); }
  .agent.zen { position: fixed; inset: 0; z-index: 5; }
  header { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 10px 16px 10px 18px;
    border-bottom: 1px solid var(--border); min-width: 0; }
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
  .mi { all: unset; box-sizing: border-box; cursor: pointer; display: flex; align-items: center; gap: 10px; width: 100%; padding: 7px 10px; border-radius: 7px; font-size: 13px; }
  .mi > :global(.icon) { color: var(--muted); }
  .mi:hover, .mi:focus-visible { background: color-mix(in srgb, var(--accent) 16%, transparent); }
  .mi:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  .mi.danger, .mi.danger > :global(.icon) { color: var(--red); }
  .mi kbd { margin-left: auto; }
  kbd { font-family: var(--mono); font-size: 10.5px; color: var(--dim); }
  .msec { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.07em; color: var(--dim); padding: 9px 10px 3px; border-top: 1px solid var(--border); margin-top: 5px; }
  .msep { border-top: 1px solid var(--border); margin: 5px 4px; }
  .mscroll { max-height: 200px; overflow-y: auto; }

  .body { flex: 1; min-height: 0; display: flex; position: relative; }
  .main { flex: 1; min-width: 0; display: flex; flex-direction: column; position: relative; }
  .scroll { flex: 1; overflow-y: auto; padding: 14px 22px 18px; overflow-anchor: none; }
  .zen .scroll { padding-top: 22px; padding-bottom: 220px; }
  /* room for TimelineView's overview ruler (RULER_W = 56px), which also stands in for the scrollbar */
  .scroll.ruled { padding-right: calc(22px + 56px); scrollbar-width: none; }
  .scroll.ruled::-webkit-scrollbar { display: none; }
  .inner { max-width: 920px; margin: 0 auto; display: flex; flex-direction: column; gap: 12px; }
  .ttl { text-align: center; font-size: 11.5px; color: var(--dim); }
  .termwrap { flex: 1; min-height: 0; padding: 12px 16px 6px; display: flex; flex-direction: column; gap: 6px; }
  .bottom { padding: 6px 16px 8px; display: flex; flex-direction: column; gap: 8px; width: 100%; max-width: 952px; margin: 0 auto; }
  .bottom.term { padding: 2px 16px 6px; gap: 4px; }
  .bottom.float { position: absolute; left: 50%; bottom: 12px; transform: translateX(-50%); width: min(880px, calc(100% - 32px)); padding: 0; }
  .inbox { margin: -2px -2px 2px; padding-bottom: 8px; border-bottom: 1px solid color-mix(in srgb, var(--border) 70%, transparent); }
  .inbox .hud { background: none; border: 0; padding: 0 2px; }
  .pinned { margin-bottom: 8px; max-height: min(52vh, 460px); overflow-y: auto; overscroll-behavior: contain; border-radius: 12px; }
  .pinned.glass { background: color-mix(in srgb, var(--raised) 70%, transparent); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px); border-radius: 12px; }
  .metab { all: unset; cursor: pointer; border-radius: 4px; padding: 0 2px; }
  .metab:hover, .metab:focus-visible { color: var(--fg); background: var(--card); }
  .slim { display: flex; align-items: center; gap: 8px; padding: 6px 10px 6px 14px; border-bottom: 1px solid var(--border); background: var(--side); min-width: 0; }
  .slim .lead { min-width: 0; display: flex; align-items: center; gap: 8px; }
  /* icon | text | time: every row's text and time line up; rows are the grid's cells (no row wrappers) */
  .hud { font-size: 12px; display: grid; grid-template-columns: 1.3em minmax(0, 1fr) auto; column-gap: 8px; row-gap: 4px;
    align-items: baseline; padding: 7px 12px; border-radius: 12px; line-height: 1.45;
    background: color-mix(in srgb, var(--raised) 55%, transparent); border: 1px solid color-mix(in srgb, var(--border) 55%, transparent); }
  .hud .ic { text-align: center; }
  .hud .meta { color: var(--dim); font-variant-numeric: tabular-nums; text-align: right; white-space: nowrap; }
  .hud .job { color: var(--dim); }
  .hud .jid { color: var(--cyan); }
  .hud .htxt { color: var(--muted); }
  .hud .fgs { color: color-mix(in srgb, var(--fg) 82%, transparent); }
  /* what follows the main text (command, job count) – set apart by room, not by punctuation */
  .hud .gap { margin-left: 1.5ch; }
  /* the TODO's fold switch: a small pill with the phase, so it reads as a button and not as stray text */
  .fold { all: unset; cursor: pointer; justify-self: end; color: var(--dim); white-space: nowrap; font-variant-numeric: tabular-nums;
    padding: 0 4px 0 8px; margin: -1px -4px -1px 0; border-radius: 99px; border: 1px solid transparent; }
  .fold:hover, .fold:focus-visible { color: var(--fg); border-color: var(--border); background: color-mix(in srgb, var(--fg) 5%, transparent); }
  .fold .chev { display: inline-block; margin-left: 5px; transition: transform .12s; }
  .fold.open .chev { transform: rotate(90deg); }
  .list { grid-column: 2 / -1; display: flex; flex-direction: column; gap: 2px; padding: 2px 0 4px; border-left: 1px solid var(--border); padding-left: 10px; }
  .hrow { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
  .pad { padding-left: 4px; }
  .b { font-weight: 700; }
  .strike { text-decoration: line-through; }
  .clamp2 { display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .waitc { color: var(--yellow); }

  .bubble { align-self: flex-end; display: flex; align-items: flex-end; gap: 6px; max-width: 78%; }
  .bt { position: relative; background: color-mix(in srgb, var(--accent) 35%, transparent); border-radius: 18px; padding: 9px 14px; white-space: pre-wrap; overflow-wrap: anywhere; user-select: text; }
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
  .ruled ~ .jump { right: calc(26px + 56px); }

  .livebtn { all: unset; cursor: pointer; height: 32px; padding: 0 12px; border-radius: 999px; font-size: 13px; font-weight: 600;
    color: var(--green); background: color-mix(in srgb, var(--green) 20%, transparent); }
  .livebtn:hover { background: color-mix(in srgb, var(--green) 30%, transparent); }
  .talkbtn { all: unset; cursor: pointer; height: 28px; padding: 0 11px; margin-right: 6px; border-radius: 999px; font-size: 12.5px; font-weight: 600;
    color: var(--fg); background: color-mix(in srgb, var(--accent) 16%, transparent); white-space: nowrap; }
  .talkbtn:hover { background: color-mix(in srgb, var(--accent) 30%, transparent); }
  .talkbtn:disabled { opacity: 0.5; cursor: default; }

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

  /* omp's braille spinner (chat cards, HUD, status line). A vertical strip of the eight frames scrolled in steps –
     WebKit (the app's webview) doesn't animate `content`, so swapping the glyph in keyframes stood still there. */
  :global(.braille) { display: inline-block; height: 1.25em; line-height: 1.25em; overflow: hidden; vertical-align: -0.3em; }
  :global(.braille)::before { content: "⣾\A⣽\A⣻\A⢿\A⡿\A⣟\A⣯\A⣷"; display: block; white-space: pre; animation: braille 0.8s steps(8) infinite; }
  @keyframes -global-braille { to { transform: translateY(-10em); } }
</style>
