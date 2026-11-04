<script lang="ts">
  // The side conversation ("Nebengespräch") in the session's side panel: a write-guarded fork of the session
  // (server/src/fork.ts) you talk to – omp by voice (live) – while the main chat goes on next to it. Shows only
  // what came after the fork (the history before it folds away), the live bar, a composer, the fork's approval
  // prompts (deny here, approve only in its terminal), "Ergebnis in den Hauptchat" (a summary as the main
  // composer's draft – never sent) and "Beenden" (hangs up, closes the fork's pane).
  import { untrack } from "svelte";
  import * as api from "../api";
  import type { AskPick, Pane, Timeline } from "../api";
  import { statusLabel, t } from "../i18n";
  import { liveOn } from "../live.svelte";
  import { cleanScreen, pendingAsk } from "../agent";
  import { draftKey } from "../drafts";
  import { followTimeline } from "../follow";
  import { sideItems, sideTranscript } from "../sidetalk";
  import { speech } from "../speech.svelte";
  import { drafts, go } from "../store.svelte";
  import Composer from "./Composer.svelte";
  import LiveBar from "./LiveBar.svelte";
  import TimelineView from "./TimelineView.svelte";

  let { server, fork, at, forkPane, kind, starting, gone, error, mainTitle, onLive, onResult, onEnd, onRestart, onLink }: {
    server: string;
    /** the fork's pane ("" while it is being made) */
    fork: string;
    /** when it was forked (server time, ms): the side conversation is what comes after */
    at: number;
    /** the fork as the tree shows it (undefined right after starting, or once it's gone) */
    forkPane?: Pane;
    /** omp / claude – only omp talks (live) */
    kind: string;
    starting: boolean;
    /** the fork's pane was closed elsewhere */
    gone: boolean;
    /** starting / closing failed */
    error: string;
    mainTitle: string;
    /** start live on the fork (asks first when a call runs elsewhere) */
    onLive: () => void;
    /** the side conversation's result for the main composer */
    onResult: (text: string) => void;
    /** hang up and close the fork */
    onEnd: () => void;
    /** a new side conversation (after the old one went) */
    onRestart: () => void;
    onLink: (url: string) => void;
  } = $props();

  const talks = $derived(kind === "omp");
  const ws = $derived(fork.split(":")[0] ?? "");
  const key = $derived(draftKey(server, fork));

  // ------------------------------------------------------------ the fork's chat (stream; polled from the dev bridge)
  let timeline = $state<Timeline | null>(null);
  let streamError = $state("");
  $effect(() => {
    if (!fork || gone) return;
    const pane = fork;
    timeline = null;
    let poll: ReturnType<typeof setInterval> | undefined;
    let busy = false;
    const tick = async () => {
      if (busy) return;
      busy = true;
      try {
        const tl = await api.timeline(server, pane, untrack(() => timeline?.etag));
        if (tl) timeline = tl;
        streamError = "";
      } catch (e) {
        streamError = e instanceof Error ? e.message : String(e);
      } finally {
        busy = false;
      }
    };
    const stop = untrack(() =>
      followTimeline(server, pane, {
        timeline: (tl) => {
          timeline = tl;
          streamError = "";
        },
        error: (e) => (streamError = e),
        unsupported: () => {
          void tick();
          poll = setInterval(tick, 2000);
        },
      }),
    );
    return () => {
      stop();
      clearInterval(poll);
    };
  });

  const items = $derived(timeline ? sideItems(timeline.items, at) : []);
  const before = $derived((timeline?.items.length ?? 0) - items.length);
  let showBefore = $state(false);
  const shown = $derived(timeline ? { ...timeline, items: showBefore ? timeline.items : items } : null);
  const status = $derived(timeline?.status ?? forkPane?.status ?? "unknown");
  const ask = $derived(timeline ? pendingAsk(timeline) : undefined);
  /** an approval / dialog without an ask card: the fork's screen shows it */
  const blocked = $derived(status === "blocked" && !ask);
  const working = $derived(!!timeline?.running && status !== "blocked" && items.length > 0);
  const liveHere = $derived(liveOn(server, fork));

  let screen = $state("");
  $effect(() => {
    if (!blocked || !fork) return void (screen = "");
    const pane = fork;
    const load = () => api.screen(server, pane, 16).then((s) => (screen = cleanScreen(s))).catch(() => {});
    void load();
    const timer = setInterval(load, 2000);
    return () => clearInterval(timer);
  });

  // ------------------------------------------------------------ scrolling: stays at the bottom unless you scroll up
  let scroller: HTMLDivElement | undefined = $state();
  let inner: HTMLDivElement | undefined = $state();
  let stick = true;
  $effect(() => {
    if (!inner || !scroller) return;
    const el = scroller;
    const ro = new ResizeObserver(() => {
      if (stick) el.scrollTop = el.scrollHeight;
    });
    ro.observe(inner);
    return () => ro.disconnect();
  });
  const onScroll = () => {
    if (scroller) stick = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 60;
  };

  // ------------------------------------------------------------ actions
  let actionError = $state("");
  const why = (e: unknown) => (e instanceof Error ? e.message : String(e));

  async function send(text: string): Promise<boolean> {
    stick = true;
    try {
      await api.prompt(server, fork, text);
      actionError = "";
      return true;
    } catch (e) {
      actionError = t("Senden fehlgeschlagen: {e}", { e: why(e) });
      return false;
    }
  }
  async function sendDraft(text: string): Promise<boolean> {
    const k = key;
    drafts.beginSend(k, text);
    const ok = await send(text);
    drafts.endSend(k, text, ok);
    return ok;
  }
  function sendKeys(keys: string[]) {
    api.keys(server, fork, keys)
      .then(() => (actionError = ""))
      .catch((e) => (actionError = t("Tasten senden fehlgeschlagen: {e}", { e: why(e) })));
  }
  async function answer(id: string, picks: AskPick[]): Promise<boolean> {
    try {
      await api.answer(server, fork, id, picks);
      actionError = "";
      return true;
    } catch (e) {
      actionError = t("Antwort nicht gesendet: {e}", { e: why(e) });
      return false;
    }
  }

  // ---- the result for the main chat: summarized on the server (as for read aloud, in the handoff style)
  let summing = $state(false);
  let resultNote = $state("");
  // model input, not UI: the summarizer reads the roles, it writes in the app's language
  const transcript = $derived(sideTranscript(items, { user: "User", agent: "Agent" }));
  async function result() {
    if (summing || !transcript) return;
    summing = true;
    resultNote = "";
    actionError = "";
    try {
      // the read-aloud model is only known to exist on the server it was picked for
      const s = speech.summary;
      const model = !s.server || s.server === server ? s.model || undefined : undefined;
      // no app language: the draft is for the main agent, in the language you talk with it (the model picks it up)
      const r = await api.summarize(server, { text: transcript, model, lang: "", style: "handoff" });
      onResult(r.summary.trim());
      resultNote = t("Steht als Entwurf im Hauptchat – nichts gesendet.");
    } catch (e) {
      const code = why(e);
      actionError =
        code === "not_allowed" ? t("Hollr auf dem Server ist zu alt – unter Server › Werkzeuge aktualisieren.") : t("Zusammenfassen fehlgeschlagen: {e}", { e: code });
    } finally {
      summing = false;
    }
  }

  const placeholder = $derived(talks ? t("Sprich oder tippe – das Nebengespräch ändert nichts ohne dich …") : t("Frag nach – das Nebengespräch ändert nichts ohne dich …"));
</script>

<div class="talk">
  <div class="head">
    <div class="grow">
      <div class="ttl ellipsis">🎙 {t("Nebengespräch")}</div>
      <div class="sub ellipsis">
        {#if !starting && !gone}<span class="dot" class:working class:blocked={status === "blocked"} class:ok={!working && (status === "idle" || status === "done")}></span>{/if}
        {t("zu „{title}“", { title: mainTitle })} · {t("ändert nichts ohne dich")}{#if !starting && !gone}{` · ${working ? t("arbeitet") : statusLabel(status)}`}{/if}
      </div>
    </div>
    {#if fork && !gone}
      <button class="ib" title={t("Als eigenen Tab öffnen")} onclick={() => go({ view: "agent", server, pane: fork })}>↗</button>
    {/if}
  </div>

  <div class="scroll" bind:this={scroller} onscroll={onScroll}>
    <div class="inner" bind:this={inner}>
      {#if starting}
        <div class="empty">
          <div class="braille acc"></div>
          <div>{t("Nebengespräch wird gestartet …")}</div>
          <div class="small">{t("Der bisherige Verlauf wird kopiert – der Hauptchat läuft ungestört weiter.")}</div>
        </div>
      {:else if gone || !fork}
        <!-- closed elsewhere, or it couldn't start (the error below says why) -->
        <div class="empty">
          {#if gone}<div>{t("Das Nebengespräch wurde geschlossen.")}</div>{/if}
          <button class="btn" onclick={onRestart}>🎙 {t("Neues Nebengespräch")}</button>
        </div>
      {:else if shown}
        {#if before > 0}
          <button class="before" onclick={() => (showBefore = !showBefore)}>
            {showBefore ? t("Verlauf davor ausblenden") : t("Verlauf davor zeigen ({n} Einträge aus dem Hauptchat)", { n: before })}
          </button>
        {/if}
        {#if !items.length && !showBefore}
          <div class="empty">
            {#if talks}
              <div>{liveHere ? t("Ich höre zu …") : t("Frag, was du zur Sitzung wissen willst.")}</div>
              <div class="small">{t("Es kennt den ganzen Verlauf bis jetzt und liest bei Bedarf Dateien – ändern darf es nur mit deiner Freigabe.")}</div>
            {:else}
              <div>{t("Frag, was du zur Sitzung wissen willst.")}</div>
              <div class="small">{t("Sprechen geht bisher nur mit omp – hier tippen oder diktieren.")}</div>
            {/if}
          </div>
        {/if}
        <TimelineView timeline={shown} {onLink} onAnswer={answer} root={forkPane?.cwd} />
        {#if blocked}
          <div class="screencard">
            <div class="sc-head">⚠ {t("Wartet auf dich – z. B. eine Freigabe zum Schreiben")}</div>
            {#if screen}<pre>{screen}</pre>{/if}
            <div class="row">
              <button class="btn" onclick={() => sendKeys(["esc"])}>{t("Ablehnen (Esc)")}</button>
              <button class="btn" onclick={() => go({ view: "agent", server, pane: fork, open: "terminal" })}>{t("Im Terminal antworten")}</button>
            </div>
          </div>
        {/if}
      {:else}
        <div class="sk">{#each [70, 45, 60] as w, i}<div class="skeleton" style:width="{w}%" style:align-self={i === 1 ? "flex-end" : "flex-start"}></div>{/each}</div>
      {/if}
      {#if error || actionError || streamError}<div class="warnline">⚠ {error || actionError || streamError}</div>{/if}
    </div>
  </div>

  {#if fork && !gone}
    <div class="bottom">
      <Composer bind:value={() => drafts.text(key), (v) => drafts.setText(key, v)} bind:sent={() => drafts.recall(key), (v) => drafts.setRecall(key, v)}
        {placeholder} keysTitle={t("Tasten ans Nebengespräch senden")} onSend={sendDraft} onKeys={sendKeys} {server} {ws}
        top={liveTop} trailing={liveButton} dictationKey={key} micBlocked={liveHere} disabled={starting} />
      <div class="actions">
        <button class="btn" disabled={!transcript || summing} title={t("Fasst das Nebengespräch zusammen und legt es als Entwurf in den Hauptchat")} onclick={result}>
          {summing ? t("Fasse zusammen …") : `↩ ${t("Ergebnis in den Hauptchat")}`}
        </button>
        <span class="grow"></span>
        <button class="btn danger" onclick={onEnd}>{t("Beenden")}</button>
      </div>
      {#if resultNote}<div class="muted small note">{resultNote}</div>{/if}
    </div>
  {/if}
</div>

{#snippet liveTop()}<LiveBar {server} pane={fork} />{/snippet}

{#snippet liveButton()}
  {#if talks && !liveHere && !starting}
    <button class="livebtn" title={t("Live mit dem Nebengespräch sprechen")} onclick={onLive}>〰 Live</button>
  {/if}
{/snippet}

<style>
  .talk { flex: 1; min-height: 0; display: flex; flex-direction: column; }
  .head { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--border); }
  .ttl { font-weight: 600; font-size: 13.5px; }
  .sub { color: var(--muted); font-size: 11.5px; }
  .dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: var(--dim); margin-right: 4px; }
  .dot.ok { background: var(--green); }
  .dot.working { background: var(--purple); }
  .dot.blocked { background: var(--orange); }
  .ib { all: unset; cursor: pointer; width: 28px; height: 28px; display: grid; place-items: center; border-radius: 8px; color: var(--muted); }
  .ib:hover { background: var(--card); color: var(--fg); }
  .scroll { flex: 1; min-height: 0; overflow-y: auto; padding: 10px 12px 12px; overflow-anchor: none; }
  .inner { display: flex; flex-direction: column; gap: 10px; font-size: 13px; }
  .before { all: unset; cursor: pointer; align-self: center; font-size: 11.5px; color: var(--muted); padding: 3px 10px; border-radius: 999px;
    border: 1px dashed var(--border); }
  .before:hover { color: var(--fg); border-color: var(--accent); }
  .empty { text-align: center; color: var(--muted); padding: 28px 8px 6px; display: flex; flex-direction: column; gap: 6px; align-items: center; }
  .sk { display: flex; flex-direction: column; gap: 12px; }
  .sk .skeleton { height: 28px; border-radius: 12px; }
  .screencard { background: var(--raised); border: 1px solid color-mix(in srgb, var(--orange) 50%, transparent); border-radius: 12px; padding: 10px; }
  .sc-head { font-size: 12px; font-weight: 600; color: var(--orange); margin-bottom: 6px; }
  .screencard pre { margin: 0 0 8px; font-family: var(--mono); font-size: 11px; white-space: pre; overflow-x: auto; user-select: text; }
  .row { display: flex; gap: 6px; flex-wrap: wrap; }
  .warnline { color: var(--orange); font-size: 12px; text-align: center; }
  .bottom { padding: 6px 10px 10px; display: flex; flex-direction: column; gap: 6px; border-top: 1px solid var(--border); }
  .actions { display: flex; gap: 6px; align-items: center; }
  .note { text-align: center; }
  .livebtn { all: unset; cursor: pointer; height: 32px; padding: 0 12px; border-radius: 999px; font-size: 13px; font-weight: 600;
    color: var(--green); background: color-mix(in srgb, var(--green) 20%, transparent); }
  .livebtn:hover { background: color-mix(in srgb, var(--green) 30%, transparent); }
  .danger { color: var(--red); }
  .grow { flex: 1; min-width: 0; }
  .ellipsis { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  .small { font-size: 12px; }
  .muted { color: var(--muted); }
  .acc { color: var(--orange); }
</style>
