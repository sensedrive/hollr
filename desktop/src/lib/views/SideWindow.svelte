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

<div class="win">
  <header class="strip">
    <div class="what">
      <b>🎙 {t("Nebengespräch")}</b>
      <span class="muted ellipsis">{t("zu „{title}“", { title: mainName || main })} · {t("ändert nichts ohne dich")}</span>
    </div>
    <div class="call"><LivePill onOpen={() => void focusMain()} /></div>
    <div class="acts">
      <button class="btn" title={t("Zum Hauptfenster")} onclick={() => void focusMain()}>↩ {t("Hauptchat")}</button>
      <button class="btn" disabled={!transcript || summing || !forkRef} title={t("Fasst das Nebengespräch zusammen und legt es als Entwurf in den Hauptchat")}
        onclick={result}>{summing ? t("Fasse zusammen …") : `↩ ${t("Ergebnis in den Hauptchat")}`}</button>
      <button class="btn" disabled={resetting || !forkRef} title={t("Neu anfangen – vom jetzigen Stand des Hauptchats")} onclick={() => (confirmReset = true)}>
        ↺ {t("Zurücksetzen")}</button>
      <button class="btn danger" disabled={ending} onclick={end}>{t("Beenden")}</button>
    </div>
  </header>
  {#if resultNote || error}
    <div class="note small" class:err={!!error}>{error ? `⚠ ${error}` : resultNote}</div>
  {/if}

  <div class="view">
    {#if resetting}
      <div class="empty"><div class="braille acc"></div><div>{t("Nebengespräch wird neu gestartet …")}</div>
        <div class="small muted">{t("Der Verlauf des Hauptchats wird neu kopiert – der Hauptchat läuft ungestört weiter.")}</div></div>
    {:else if forkRef}
      {#key fork}
        <AgentView {server} pane={forkRef.pane} title={forkTitle} onClosed={closeWindow} inSideWindow {autoLive} onTimeline={(tl) => (timeline = tl)} />
      {/key}
    {:else if gone}
      <div class="empty">
        <div>{t("Das Nebengespräch wurde geschlossen.")}</div>
        <div class="row">
          <button class="btn primary" onclick={restart}>🎙 {t("Neues Nebengespräch")}</button>
          <button class="btn" onclick={closeWindow}>{t("Fenster schließen")}</button>
        </div>
      </div>
    {:else}
      <div class="empty">{app.errors[server] ? `⚠ ${app.errors[server]}` : t("Lädt …")}</div>
    {/if}
  </div>
</div>

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
  .win { height: 100vh; display: grid; grid-template-rows: auto auto minmax(0, 1fr); background: var(--bg); }
  .strip { display: flex; align-items: center; gap: 10px; padding: 7px 12px; border-bottom: 1px solid var(--border); background: var(--side); min-width: 0; }
  .what { display: flex; align-items: baseline; gap: 10px; min-width: 0; flex: 1; }
  .what b { white-space: nowrap; font-size: 13.5px; }
  .call { flex: none; max-width: 260px; }
  .call :global(.pill) { margin-bottom: 0; }
  .acts { display: flex; gap: 6px; flex: none; }
  .acts .btn { font-size: 12.5px; padding: 4px 10px; white-space: nowrap; }
  .note { padding: 5px 14px; color: var(--muted); border-bottom: 1px solid var(--border); }
  .note.err { color: var(--orange); }
  .view { min-height: 0; min-width: 0; }
  .empty { height: 100%; display: flex; flex-direction: column; gap: 8px; align-items: center; justify-content: center; color: var(--muted); text-align: center; }
  .row { display: flex; gap: 8px; }
  .mbuttons { display: flex; justify-content: flex-end; gap: 8px; }
  p { margin: 0; }
  .ellipsis { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  .small { font-size: 12px; }
  .muted { color: var(--muted); }
  .acc { color: var(--orange); }
</style>
