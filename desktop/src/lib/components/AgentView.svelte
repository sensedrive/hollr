<script lang="ts">
  // One session: omp transcript (or the terminal screen for other agents / shells), TODO,
  // working row, composer with keys, status line with model switch.
  import { onDestroy } from "svelte";
  import * as api from "../api";
  import type { Pane, Timeline } from "../api";
  import { statusLabel, t } from "../i18n";
  import TimelineView from "./TimelineView.svelte";
  import ModelDialog from "./ModelDialog.svelte";
  import GitPanel from "./GitPanel.svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { listen, type UnlistenFn } from "@tauri-apps/api/event";

  let { server, pane, title, onClosed }: { server: string; pane: Pane; title: string; onClosed: () => void } = $props();

  let timeline = $state<Timeline | null>(null);
  let screen = $state("");
  let text = $state("");
  let error = $state("");
  let showModels = $state(false);
  let mode = $state<"chat" | "git">("chat");
  const ws = $derived(pane.pane.split(":")[0]);

  // ---- live voice (omp /live)
  let livePhase = $state<"" | "connecting" | "live" | "ending">("");
  let ompState = $state<string | undefined>();
  let micMuted = $derived(ompState === "muted");
  let speakerMuted = $state(false);
  let levels = $state({ input: 0, output: 0 });
  let liveError = $state("");
  let unlisten: UnlistenFn[] = [];

  async function startLive() {
    liveError = "";
    livePhase = "connecting";
    unlisten.push(await listen<Record<string, unknown>>("live", (e) => {
      const m = e.payload;
      if (m.t === "phase") {
        if (m.phase === "live") livePhase = "live";
        else if (m.phase === "ended") endLive();
        else if (m.phase === "failed") { liveError = String(m.message ?? m.reason ?? "Live fehlgeschlagen"); endLive(); }
      } else if (m.t === "omp") ompState = String(m.state);
      else if (m.t === "error") liveError = String(m.message ?? m.code);
      else if (m.t === "audio_error") liveError = String(m.message);
      else if (m.t === "closed") endLive();
    }));
    unlisten.push(await listen<{ input: number; output: number }>("live-levels", (e) => (levels = e.payload)));
    try {
      await invoke("live_start", { server, pane: pane.pane });
    } catch (e) {
      liveError = String(e);
      endLive();
    }
  }
  function endLive() {
    livePhase = "";
    ompState = undefined;
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
  onDestroy(() => { if (livePhase) invoke("live_stop").catch(() => {}); endLive(); });
  let scroller: HTMLDivElement | undefined = $state();
  let stick = true;

  const isOmp = $derived(pane.agent === "omp");
  const isShell = $derived(!pane.agent);
  const showsScreen = $derived(!isOmp || timeline?.status === "blocked");

  // strip nerd-font / box glyphs the desktop font can't draw anyway
  const cleanScreen = (s: string) =>
    s.split("\n").map((l) => l.replace(/[\u{E000}-\u{F8FF}\u{F0000}-\u{FFFFF}│┃╭╮╰╯]/gu, "").trimEnd())
      .filter((l) => l.trim() && !/^[─━═-]+$/.test(l.trim())).join("\n");

  async function refresh() {
    try {
      if (isOmp) timeline = await api.timeline(server, pane.pane);
      if (showsScreen) screen = cleanScreen(await api.screen(server, pane.pane, isShell ? 80 : 40));
      error = "";
    } catch (e) {
      error = String(e);
    }
    if (stick && scroller) queueMicrotask(() => scroller && (scroller.scrollTop = scroller.scrollHeight));
  }

  let timer: ReturnType<typeof setInterval> | undefined;
  $effect(() => {
    void pane.pane;
    timeline = null;
    screen = "";
    stick = true;
    refresh();
    clearInterval(timer);
    timer = setInterval(refresh, 2000);
  });
  onDestroy(() => clearInterval(timer));

  function onScroll() {
    if (!scroller) return;
    stick = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 60;
  }

  async function send() {
    const msg = text.trim();
    if (!msg) return;
    text = "";
    stick = true;
    try {
      await api.prompt(server, pane.pane, msg);
      setTimeout(refresh, 500);
    } catch (e) {
      error = String(e);
      text = msg;
    }
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  }

  const sendKeys = (k: string[]) => api.keys(server, pane.pane, k).then(() => setTimeout(refresh, 400));

  async function close() {
    if (!confirm(`„${title}“ – ${t("Sitzung beenden")}?`)) return;
    await api.closePane(server, pane.pane);
    onClosed();
  }

  const activePhase = $derived(timeline?.todo?.find((p) => p.tasks.some((x) => x.status !== "completed" && x.status !== "abandoned")));
  const working = $derived.by(() => {
    if (!timeline?.running) return undefined;
    if (timeline.waiting) return t("wartet auf Hintergrund-Jobs");
    for (const item of [...timeline.items].reverse()) {
      if (item.k === "tools") {
        const c = [...item.calls].reverse().find((c) => c.status === "running");
        if (c) return c.label;
      }
    }
    return "Working…";
  });
</script>

<section class="agent">
  <header>
    <div>
      <div class="title">{title}</div>
      <div class="sub">
        <span class="dot {pane.status}"></span>
        {isShell ? t("Terminal") : `${pane.agent} · ${statusLabel(timeline?.running && timeline?.status !== "blocked" ? "working" : (timeline?.status ?? pane.status))}`}
        · <span class="mono dim">{pane.cwd.replace(/^\/home\/[^/]+/, "~")}</span>
      </div>
    </div>
    <div class="actions">
      {#if pane.agent}
        <div class="seg">
          <button class:on={mode === "chat"} onclick={() => (mode = "chat")}>Chat</button>
          <button class:on={mode === "git"} onclick={() => (mode = "git")}>Git</button>
        </div>
      {/if}
      {#if pane.agent && pane.agent !== "codex"}<button class="btn" onclick={() => (showModels = true)}>{t("Modell wechseln")}</button>{/if}
      <button class="btn" onclick={close}>{t("Sitzung beenden")}</button>
    </div>
  </header>

  {#if mode === "git"}
    <div class="gitwrap"><GitPanel {server} {ws} /></div>
  {:else}
  <div class="scroll" bind:this={scroller} onscroll={onScroll}>
    {#if timeline}
      <TimelineView {timeline} onAnswer={(i) => sendKeys([...Array(i).fill("down"), "enter"])} />
    {/if}
    {#if showsScreen && screen}
      <pre class="screen mono">{screen}</pre>
    {/if}
    {#if !timeline && !screen && !error}<div class="dim">{t("Lädt …")}</div>{/if}
    {#if error}<div class="err">{error}</div>{/if}
  </div>

  {#if activePhase || working}
    <div class="hud mono">
      {#if activePhase}
        <div><b class="acc">TODO</b> <span class="acc">{activePhase.name}</span>
          <span class="dim">· {activePhase.tasks.filter((x) => x.status === "completed").length}/{activePhase.tasks.length}</span></div>
        {#each activePhase.tasks.filter((x) => x.status === "in_progress") as task}<div class="acc">☐ {task.content}</div>{/each}
      {/if}
      {#if working}<div class="acc"><span class="spin">⣾</span> {working}</div>{/if}
    </div>
  {/if}

  {#if livePhase}
    <div class="live" class:muted={micMuted}>
      <div class="bars">{#each [0.45, 0.8, 1, 0.7, 0.4] as w}<span style="height:{6 + 22 * w * Math.min(1, micMuted ? 0 : Math.max(levels.input * 6, levels.output * 4))}px"></span>{/each}</div>
      <div><b>{livePhase === "connecting" ? "Verbinde …" : livePhase === "ending" ? "Beende …" : "Live"}</b>
        <div class="dim small">{[micMuted ? "Mikro aus" : ompState ?? "omp /live", speakerMuted ? "Ton aus" : ""].filter(Boolean).join(" · ")}</div></div>
      <div class="liveactions">
        <button class="round" class:warn={speakerMuted} title="Ton an/aus" onclick={toggleSpeaker}>{speakerMuted ? "🔇" : "🔊"}</button>
        <button class="round" class:warn={micMuted} disabled={livePhase !== "live"} title="Mikrofon an/aus" onclick={toggleMic}>{micMuted ? "🎙̸" : "🎙"}</button>
        <button class="round hang" title="Auflegen" onclick={stopLive}>✕</button>
      </div>
    </div>
  {/if}
  {#if liveError}<div class="err pad">{liveError}</div>{/if}
  <div class="composer">
    <textarea rows="2" bind:value={text} onkeydown={onKey}
      placeholder={isShell ? t("Befehl ausführen …") : `${t("Nachricht an")} ${pane.agent} …`}></textarea>
    <div class="row">
      <div class="keys">
        {#each [["Enter", "enter"], ["Esc", "esc"], ["Tab", "tab"], ["↑", "up"], ["↓", "down"], ["y", "y"], ["n", "n"], ["Ctrl+C", "ctrl+c"]] as [label, k]}
          <button class="key mono" onclick={() => sendKeys([k])}>{label}</button>
        {/each}
      </div>
      <div class="sendrow">
        {#if pane.live && !livePhase}<button class="btn livebtn" onclick={startLive}>● Live</button>{/if}
        <button class="btn primary" onclick={send} disabled={!text.trim()}>{t("Senden")}</button>
      </div>
    </div>
  </div>

  {#if timeline?.line}
    {@const l = timeline.line}
    <button class="status mono" onclick={() => pane.agent && pane.agent !== "codex" && (showModels = true)}>
      {#if timeline.running}<span class="spin acc">⣾</span>{/if}
      {#if l.model}<span class="purple">✦ {l.model}</span>{/if}
      {#if l.folder}<span>…{l.folder}</span>{/if}
      {#if l.branch}<span class="acc">⑂ {l.branch}{l.dirty ? ` *${l.dirty}` : ""}</span>{/if}
      {#if l.context}<span class="dim">{l.context}</span>{/if}
      {#if l.cost}<span class="dim">${l.cost}</span>{/if}
    </button>
  {/if}
  {/if}
</section>

{#if showModels && pane.agent}
  <ModelDialog {server} kind={pane.agent} current={timeline?.line?.model ?? timeline?.model}
    onClose={() => (showModels = false)}
    onPick={async (model, level) => { await api.switchModel(server, pane.pane, model, level); showModels = false; }} />
{/if}

<style>
  .agent { display: flex; flex-direction: column; height: 100%; min-width: 0; }
  header { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 12px 18px;
    border-bottom: 1px solid var(--border); }
  .title { font-weight: 600; font-size: 15px; }
  .sub { color: var(--muted); font-size: 12px; }
  .actions { display: flex; gap: 8px; }
  .dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: var(--dim); margin-right: 4px; }
  .dot.idle, .dot.done { background: var(--green); }
  .dot.working { background: var(--purple); }
  .dot.blocked { background: var(--orange); }
  .scroll { flex: 1; overflow-y: auto; padding: 16px 18px; }
  .screen { background: var(--raised); border: 1px solid var(--border); border-radius: 10px; padding: 12px; font-size: 12px;
    white-space: pre-wrap; margin: 12px 0 0; }
  .hud { padding: 6px 18px; font-size: 12px; border-top: 1px solid var(--border); }
  .composer { padding: 10px 18px 8px; border-top: 1px solid var(--border); }
  textarea { width: 100%; resize: vertical; font-family: var(--mono); min-height: 52px; }
  .row { display: flex; justify-content: space-between; align-items: center; margin-top: 8px; gap: 8px; }
  .keys { display: flex; gap: 4px; flex-wrap: wrap; }
  .key { background: var(--card); border: 1px solid var(--border); border-radius: 6px; padding: 2px 8px; font-size: 12px; }
  .status { all: unset; cursor: pointer; display: flex; gap: 14px; padding: 4px 18px 10px; font-size: 11.5px; color: var(--muted);
    white-space: nowrap; overflow: hidden; }
  .seg { display: flex; background: var(--card); border-radius: 999px; padding: 2px; }
  .seg button { all: unset; cursor: pointer; padding: 3px 12px; border-radius: 999px; color: var(--muted); }
  .seg button.on { background: var(--bg); color: var(--fg); }
  .gitwrap { flex: 1; min-height: 0; }
  .live { display: flex; align-items: center; gap: 14px; margin: 8px 18px 0; padding: 10px 14px; border-radius: 14px;
    border: 1px solid color-mix(in srgb, var(--green) 55%, transparent); background: var(--raised); }
  .live.muted { border-color: color-mix(in srgb, var(--orange) 55%, transparent); }
  .bars { display: flex; gap: 3px; align-items: center; width: 36px; height: 30px; }
  .bars span { width: 4px; border-radius: 2px; background: var(--green); transition: height 0.1s; }
  .live.muted .bars span { background: var(--orange); }
  .liveactions { margin-left: auto; display: flex; gap: 8px; }
  .round { width: 36px; height: 36px; border-radius: 50%; border: 1px solid var(--border); background: var(--card); }
  .round.warn { background: var(--orange); }
  .round.hang { background: var(--red); color: #fff; border-color: var(--red); }
  .livebtn { color: var(--green); border-color: color-mix(in srgb, var(--green) 50%, transparent); }
  .sendrow { display: flex; gap: 8px; }
  .small { font-size: 12px; }
  .pad { padding: 4px 18px; }
  .acc { color: var(--orange); }
  .purple { color: var(--purple); }
  .err { color: var(--red); }
  .spin { display: inline-block; animation: spin 0.8s steps(8) infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
