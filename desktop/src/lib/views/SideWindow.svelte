<script lang="ts">
  // The side conversation's own window ("Nebengespräch", src-tauri/src/window.rs): a write-guarded fork of a
  // session (server `fork`) in the whole session view – chat / terminal, composer, live, git / browser / info.
  // The strip on top says what it is about and leads back: "Ergebnis in den Hauptchat" (a summary as the main
  // composer's draft, never sent), "Zurücksetzen" (a fresh fork of the main chat as it is now, in this window),
  // "Beenden" (hang up, close the fork, close the window). Closing the window during a call asks first; without
  // one the fork stays (its dimmed tab in the main window opens this window again).
  import { onMount } from "svelte";
  import { replaceState } from "$app/navigation";
  import { listen } from "@tauri-apps/api/event";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import * as api from "$lib/api";
  import type { Timeline } from "$lib/api";
  import { t } from "$lib/i18n";
  import { draftKey } from "$lib/drafts";
  import { joinLive, liveOn, stopLive, stopLiveOn } from "$lib/live.svelte";
  import { appendDraft, sideItems, sideTranscript } from "$lib/sidetalk";
  import { focusMain, forkError, sendResult, sideTitle } from "$lib/sideWindow";
  import { speech } from "$lib/speech.svelte";
  import { app, drafts, findPane, listenFeeds, nav, refresh, tabName } from "$lib/store.svelte";
  import AgentView from "$lib/components/AgentView.svelte";
  import LivePill from "$lib/components/LivePill.svelte";
  import Modal from "$lib/components/Modal.svelte";
  import ReadAloud from "$lib/components/ReadAloud.svelte";
  import AppLock from "$lib/components/AppLock.svelte";
  import Icon from "$lib/components/git/Icon.svelte";

  let { server, main, pane, live: startLive }: { server: string; main: string; pane: string; live: boolean } = $props();

  /** the fork shown here (a reset or a reopen from another fork's tab changes it) */
  // svelte-ignore state_referenced_locally
  let fork = $state(pane);
  /** start Live once the fork is ready: a fresh omp side conversation, or a reset during a call */
  // svelte-ignore state_referenced_locally
  let autoLive = $state(startLive);

  const forkRef = $derived(findPane(server, fork));
  const mainRef = $derived(findPane(server, main));
  let mainName = $state("");
  $effect(() => {
    if (mainRef) mainName = tabName(mainRef.tab.label, mainRef.workspace.label);
  });
  const forkTitle = $derived(forkRef ? tabName(forkRef.tab.label, forkRef.workspace.label) : sideTitle(mainName || main));
  /** the tree once showed the fork – missing afterwards = closed elsewhere */
  let seen = $state(false);
  $effect(() => {
    if (forkRef) seen = true;
  });
  const gone = $derived(seen && app.loaded[server] && !forkRef);
  // the live pill and the session view treat this window's fork as the one on screen
  const showRoute = (p: string) => (nav.route = { view: "agent", server, pane: p });
  // svelte-ignore state_referenced_locally
  showRoute(fork);

  onMount(() => {
    void (async () => {
      app.servers = await api.servers();
      await refresh(server);
    })();
    void joinLive();
    let offFeeds = () => {};
    listenFeeds().then((off) => (offFeeds = off)).catch(() => {});
    const timer = setInterval(() => void refresh(server), 5000);
    const offShow = listen<{ pane: string }>("hollr-side-show", ({ payload }) => showFork(payload.pane, false));
    // closing the window during a call: ask (hang up and close, or stay)
    const offClose = getCurrentWindow().onCloseRequested((e) => {
      if (!liveOn(server, fork)) return;
      e.preventDefault();
      confirmClose = true;
    });
    return () => {
      clearInterval(timer);
      offFeeds();
      void offShow.then((off) => off());
      void offClose.then((off) => off());
    };
  });

  function showFork(next: string, live: boolean) {
    if (next === fork) return;
    fork = next;
    showRoute(next);
    seen = false;
    autoLive = live;
    timeline = null;
    resultNote = "";
    // a reload of this window shows the same fork
    const url = new URL(location.href);
    url.searchParams.set("pane", next);
    url.searchParams.delete("live");
    replaceState(url, {});
  }

  const closeWindow = () => void getCurrentWindow().destroy().catch(() => {});

  // ------------------------------------------------------------ the result for the main chat
  let timeline = $state<Timeline | null>(null);
  const transcript = $derived(
    timeline && forkRef?.pane.fork ? sideTranscript(sideItems(timeline.items, forkRef.pane.fork.at), { user: "User", agent: "Agent" }) : "",
  );
  let summing = $state(false);
  let resultNote = $state("");
  let error = $state("");
  async function result() {
    if (summing || !transcript) return;
    summing = true;
    resultNote = error = "";
    try {
      // the read-aloud model is only known to exist on the server it was picked for; no language: the draft
      // is for the main agent, in the language of the conversation
      const s = speech.summary;
      const model = !s.server || s.server === server ? s.model || undefined : undefined;
      const r = await api.summarize(server, { text: transcript, model, lang: "", style: "handoff" });
      const text = r.summary.trim();
      if (await sendResult(server, main, text).catch(() => false)) resultNote = t("Steht als Entwurf im Hauptchat – nichts gesendet.");
      else {
        // no main window: the draft waits in the stored drafts for the main chat
        const key = draftKey(server, main);
        drafts.setText(key, appendDraft(drafts.text(key), text));
        drafts.flush();
        resultNote = t("Das Hauptfenster ist zu – das Ergebnis steht dort als Entwurf, sobald es wieder offen ist.");
      }
    } catch (e) {
      const code = e instanceof Error ? e.message : String(e);
      error = code === "not_allowed" ? t("Hollr auf dem Server ist zu alt – unter Server › Werkzeuge aktualisieren.") : t("Zusammenfassen fehlgeschlagen: {e}", { e: code });
    } finally {
      summing = false;
    }
  }

  // ------------------------------------------------------------ reset / end
  let confirmReset = $state(false);
  let resetting = $state(false);
  async function reset() {
    confirmReset = false;
    resetting = true;
    error = resultNote = "";
    const old = fork;
    const wasLive = liveOn(server, old);
    try {
      if (wasLive) await stopLive();
      const r = await api.fork(server, main, sideTitle(mainName || main), old);
      await refresh(server);
      // a server from before the reset left the old fork open
      if (findPane(server, old)) await api.closeFork(server, old).catch(() => {});
      showFork(r.pane, wasLive && r.kind === "omp");
      await refresh(server);
    } catch (e) {
      error = forkError(e);
    } finally {
      resetting = false;
    }
  }

  /** a closed one: a fresh side conversation here (no reset – there is nothing left to replace) */
  async function restart() {
    resetting = true;
    error = "";
    try {
      const r = await api.fork(server, main, sideTitle(mainName || main));
      await refresh(server);
      showFork(r.pane, r.kind === "omp");
    } catch (e) {
      error = forkError(e);
    } finally {
      resetting = false;
    }
  }

  let ending = $state(false);
  async function end() {
    ending = true;
    await stopLiveOn(server, fork);
    try {
      if (!gone) await api.closeFork(server, fork);
      closeWindow();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      ending = false;
    }
  }

  let confirmClose = $state(false);
</script>

{#snippet what()}
  <span class="badge"><Icon name="mic" size={14} /></span>
  <span class="what"><b>{t("Nebengespräch")}</b><span class="muted ellipsis">{t("zu „{title}“", { title: mainName || main })} · {t("ändert nichts ohne dich")}</span></span>
{/snippet}

{#snippet sideActs()}
  <div class="call"><LivePill onOpen={() => void focusMain()} /></div>
  <button class="btn primary small" disabled={!transcript || summing || !forkRef} title={t("Fasst das Nebengespräch zusammen und legt es als Entwurf in den Hauptchat")}
    onclick={result}>{summing ? t("Fasse zusammen …") : t("Ergebnis in den Hauptchat")}</button>
  <button class="ib" title={t("Zum Hauptfenster")} aria-label={t("Zum Hauptfenster")} onclick={() => void focusMain()}><Icon name="back" size={16} /></button>
  <button class="ib" disabled={resetting || !forkRef} title={t("Zurücksetzen – neu anfangen vom jetzigen Stand des Hauptchats")} aria-label={t("Zurücksetzen")}
    onclick={() => (confirmReset = true)}><Icon name="reload" size={16} /></button>
  <button class="ib end" disabled={ending} title={t("Beenden – Nebengespräch schließen")} aria-label={t("Beenden")} onclick={end}><Icon name="x" size={16} /></button>
  <span class="sep"></span>
{/snippet}

{#snippet starting(label: string)}
  <div class="empty">
    <span class="badge big"><Icon name="mic" size={20} /></span>
    <div class="title">{label}</div>
    <div class="small muted">{t("Der Verlauf von „{title}“ wird kopiert – der Hauptchat läuft ungestört weiter.", { title: mainName || main })}</div>
    <div class="sk">{#each [70, 45, 60] as w}<div class="skeleton" style:width="{w}%"></div>{/each}</div>
  </div>
{/snippet}

<div class="win">
  <div class="view">
    {#if resetting}
      {@render starting(t("Nebengespräch wird neu gestartet …"))}
    {:else if forkRef}
      {#key fork}
        {#if forkRef.pane.agent}
          <AgentView {server} pane={forkRef.pane} title={forkTitle} onClosed={closeWindow} inSideWindow {autoLive} onTimeline={(tl) => (timeline = tl)}
            lead={what} extra={sideActs} />
        {:else}
          {@render starting(t("Nebengespräch startet …"))}
        {/if}
      {/key}
    {:else if gone}
      <div class="empty">
        <div>{t("Das Nebengespräch wurde geschlossen.")}</div>
        <div class="row">
          <button class="btn primary" onclick={restart}>🎙 {t("Neues Nebengespräch")}</button>
          <button class="btn" onclick={closeWindow}>{t("Fenster schließen")}</button>
        </div>
      </div>
    {:else if app.errors[server]}
      <div class="empty">⚠ {app.errors[server]}</div>
    {:else}
      {@render starting(t("Nebengespräch startet …"))}
    {/if}
  </div>
</div>

{#if resultNote || error}
  <div class="toast small" class:err={!!error} role="status">{error ? `⚠ ${error}` : resultNote}
    <button class="ib" aria-label={t("Schließen")} onclick={() => (resultNote = error = "")}><Icon name="x" size={12} /></button></div>
{/if}

<ReadAloud />

{#if confirmReset}
  <Modal title={t("Nebengespräch zurücksetzen?")} onClose={() => (confirmReset = false)}>
    <p>{t("Was hier bisher besprochen wurde, wird verworfen. Das Nebengespräch beginnt neu – mit dem Hauptchat, wie er jetzt ist.")}</p>
    <div class="mbuttons">
      <button class="btn" onclick={() => (confirmReset = false)}>{t("Abbrechen")}</button>
      <button class="btn primary" onclick={reset}>↺ {t("Zurücksetzen")}</button>
    </div>
  </Modal>
{/if}

{#if confirmClose}
  <Modal title={t("Live läuft noch")} onClose={() => (confirmClose = false)}>
    <p>{t("Das Fenster schließen und auflegen? Das Nebengespräch bleibt als Tab im Hauptfenster.")}</p>
    <div class="mbuttons">
      <button class="btn" onclick={() => (confirmClose = false)}>{t("Abbrechen")}</button>
      <button class="btn primary" onclick={async () => { confirmClose = false; await stopLive(); closeWindow(); }}>{t("Auflegen und schließen")}</button>
    </div>
  </Modal>
{/if}
<!-- last: covers everything above while locked (the lock is per window, like the main window's) -->
<AppLock />

<style>
  .win { height: 100vh; display: grid; grid-template-rows: minmax(0, 1fr); background: var(--bg); }
  /* the session's bar is the window's only bar: what this is on the left, its actions and the tools on the right */
  .what { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
  .what b { white-space: nowrap; font-size: 13.5px; }
  .what .muted { font-size: 12.5px; }
  .badge { width: 26px; height: 26px; flex: none; display: grid; place-items: center; border-radius: 8px; color: var(--accent);
    background: color-mix(in srgb, var(--accent) 16%, transparent); }
  .badge.big { width: 44px; height: 44px; border-radius: 50%; }
  .call { flex: none; max-width: 240px; }
  .call :global(.pill) { margin-bottom: 0; }
  .btn.small { font-size: 12.5px; padding: 4px 10px; white-space: nowrap; }
  .ib { all: unset; cursor: pointer; width: 30px; height: 30px; display: grid; place-items: center; border-radius: 8px; color: var(--muted); flex: none; }
  .ib:hover { background: var(--card); color: var(--fg); }
  .ib:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  .ib:disabled { opacity: .4; cursor: default; }
  .ib.end:hover { background: color-mix(in srgb, var(--red) 18%, transparent); color: var(--red); }
  .sep { width: 1px; height: 18px; background: var(--border); margin: 0 4px; flex: none; }
  .toast { position: fixed; left: 50%; bottom: 20px; translate: -50% 0; z-index: 30; display: flex; align-items: center; gap: 6px; max-width: min(560px, 90vw);
    padding: 6px 6px 6px 14px; border-radius: 10px; background: var(--card); border: 1px solid var(--border); color: var(--muted); box-shadow: 0 8px 24px rgba(0,0,0,.3); }
  .toast.err { color: var(--orange); }
  .toast .ib { width: 22px; height: 22px; }
  /* a grid, so the session view fills the window (a percentage height alone doesn't in WebKit) */
  .view { min-height: 0; min-width: 0; display: grid; grid-template-rows: minmax(0, 1fr); }
  .empty { height: 100%; display: flex; flex-direction: column; gap: 8px; align-items: center; justify-content: center; color: var(--muted); text-align: center; padding: 24px; }
  .empty .title { color: var(--fg); font-weight: 600; font-size: 15px; margin-top: 4px; }
  .sk { width: min(420px, 80%); display: grid; gap: 10px; margin-top: 18px; }
  .sk .skeleton { height: 12px; }
  .row { display: flex; gap: 8px; }
  .mbuttons { display: flex; justify-content: flex-end; gap: 8px; }
  p { margin: 0; }
  .ellipsis { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  .small { font-size: 12px; }
  .muted { color: var(--muted); }
</style>
