<script lang="ts">
  // The session's "Nachfragen" panel: its sidechats as a small list, the chosen one below – the selected piece (if any)
  // as a quote, then only what was asked and answered after it, and a field for the next question with "/" skills.
  // "+ Neue Nachfrage" starts one without a selection. With "Kontext" the first question forks the session (the agent
  // knows the whole history – costs tokens); without, a fresh agent starts in the same folder. ✕ ends its agent (RAM).
  import { tick } from "svelte";
  import * as api from "$lib/api";
  import type { Timeline } from "$lib/api";
  import { t } from "$lib/i18n";
  import { forkError } from "$lib/contextChat.svelte";
  import { historyCut } from "$lib/contextChatText";
  import { firstPrompt, questionOf, sideChatLabel, sidechats, type SideChat } from "$lib/sidechats.svelte";
  import TimelineView from "./TimelineView.svelte";
  import Composer from "./Composer.svelte";
  import Icon from "./git/Icon.svelte";

  let { server, main, title, agent, active = $bindable() }: {
    server: string; main: string; title: string;
    /** the main session's agent (omp / claude …): a sidechat without context starts the same one */
    agent?: string;
    active?: string;
  } = $props();

  const list = $derived(sidechats.of(server, main));
  const chat = $derived(list.find((c) => c.id === active) ?? list[0]);

  // ---- the chosen one's log, polled while it is shown
  let timeline = $state<Timeline | null>(null);
  $effect(() => {
    const c = chat;
    timeline = null;
    if (!c?.pane) return;
    const pane = c.pane;
    let gone = false;
    const load = async () => {
      try {
        const tl = await api.timeline(server, pane);
        if (!gone && tl) timeline = tl;
      } catch {}
    };
    void load();
    const timer = setInterval(load, 2000);
    return () => {
      gone = true;
      clearInterval(timer);
    };
  });
  /** after the fork only, the first question without the quote and context sent with it */
  const shown = $derived.by((): Timeline | null => {
    if (!timeline || !chat?.at) return null;
    const items = timeline.items.slice(historyCut(timeline.items, chat.at)).map((i) => (i.k === "user" ? { ...i, text: questionOf(i.text) } : i));
    return { ...timeline, items };
  });
  const running = $derived(!!timeline?.running);
  const statusOf = (c: SideChat) => (c.id === chat?.id && running ? "working" : !c.pane ? "new" : "");

  let renaming = $state<string | null>(null);

  // ---- the list of sidechats folds away (remembered), the chosen one keeps the room
  const FOLD = "hollr.sidechats.folded";
  let folded = $state(localStorage.getItem(FOLD) === "1");
  function toggleFold() {
    folded = !folded;
    try {
      localStorage.setItem(FOLD, folded ? "1" : "0");
    } catch {}
  }

  // ---- sticks to the bottom while new text comes in, unless you scrolled up
  let scroller = $state<HTMLDivElement>();
  let stick = true;
  function onScroll() {
    if (scroller) stick = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 60;
  }
  $effect(() => {
    const el = scroller;
    if (!el) return;
    stick = true;
    const toBottom = () => stick && (el.scrollTop = el.scrollHeight);
    const ro = new ResizeObserver(toBottom);
    // the content grows inside: watch every child, also ones added later
    const mo = new MutationObserver(() => {
      for (const c of el.children) ro.observe(c);
      toBottom();
    });
    mo.observe(el, { childList: true, subtree: true, characterData: true });
    for (const c of el.children) ro.observe(c);
    toBottom();
    return () => {
      ro.disconnect();
      mo.disconnect();
    };
  });
  // another sidechat chosen or a question sent: back to the bottom
  $effect(() => {
    void chat?.id;
    void pending;
    stick = true;
    void tick().then(() => scroller && (scroller.scrollTop = scroller.scrollHeight));
  });

  // ---- asking
  let text = $state("");
  let pending = $state("");
  let busy = $state(false);
  let starting = $state(false);
  let error = $state("");
  let composer = $state<Composer>();
  $effect(() => {
    void chat?.id;
    void tick().then(() => composer?.focus());
  });
  // the question we sent shows until the log has it
  $effect(() => {
    if (pending && shown?.items.some((i) => i.k === "user" && i.text.trim() === pending.trim())) pending = "";
  });

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  /** a fresh fork loads the session first – the first prompt waits for it */
  async function promptWhenReady(pane: string, msg: string) {
    for (let i = 0; ; i++) {
      try {
        return await api.prompt(server, pane, msg);
      } catch (e) {
        if (i >= 30) throw e;
        await sleep(2000);
      }
    }
  }

  async function send(msg: string): Promise<boolean> {
    const q = msg.trim();
    const c = chat;
    if (!q || !c || busy) return false;
    busy = true;
    error = "";
    pending = q;
    try {
      if (!c.pane) {
        starting = true;
        const label = sideChatLabel(c.quote || q);
        if (c.context !== false) {
          const r = await api.fork(server, main, label);
          sidechats.forked(c.id, r.pane, r.at);
          starting = false;
          await promptWhenReady(r.pane, firstPrompt(c.quote, q));
        } else {
          // no history: a fresh agent of the same kind in the same space, opened in the background
          const ws = main.split(":")[0];
          const at = Date.now();
          const pane = await api.newChat(server, { kind: agent ?? "omp", workspace: ws, label, focus: false });
          sidechats.forked(c.id, pane, at);
          starting = false;
          await promptWhenReady(pane, firstPrompt(c.quote, q));
        }
      } else await api.prompt(server, c.pane, q);
      return true;
    } catch (e) {
      error = c.pane || c.context === false ? (e instanceof Error ? e.message : String(e)) : forkError(e);
      pending = "";
      return false;
    } finally {
      busy = starting = false;
    }
  }

  /** a new one without a selection: the question goes in below */
  function startEmpty() {
    active = sidechats.start(server, main);
  }

  async function remove(c: SideChat) {
    if (c.pane) await api.closePane(server, c.pane).catch(() => {});
    sidechats.remove(c.id);
    if (active === c.id) active = undefined;
  }

  const when = (ms: number) => {
    const d = new Date(ms);
    return d.toDateString() === new Date().toDateString()
      ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : d.toLocaleDateString([], { day: "2-digit", month: "2-digit" });
  };
</script>

<div class="chats">
  <div class="bar">
    {#if list.length}
      <button class="fold" aria-expanded={!folded} title={folded ? t("Liste zeigen") : t("Liste einklappen")} onclick={toggleFold}>
        <Icon name={folded ? "chevronR" : "chevronD"} size={13} /> {list.length}
      </button>
    {/if}
    <button class="new" onclick={startEmpty}><Icon name="plus" size={13} /> {t("Neue Nachfrage")}</button>
    {#if list.some((c) => c.pane)}
      <button class="closeall" title={t("Beendet alle Nachfrage-Agenten dieser Sitzung (gibt Speicher frei)")}
        onclick={() => { for (const c of list) void remove(c); }}>{t("Alle schließen")}</button>
    {/if}
  </div>
  {#if list.length && !folded}
    <div class="list" role="list" aria-label={t("Nachfragen")}>
      {#each list as c (c.id)}
        {@const st = statusOf(c)}
        <div class="item" class:on={c.id === chat?.id} role="listitem">
          <button class="pick" aria-current={c.id === chat?.id} onclick={() => (active = c.id)} title={c.quote}>
            <span class="dot {st}"></span>
            {#if renaming === c.id}
              <!-- svelte-ignore a11y_autofocus -->
              <input class="rename" autofocus value={c.name ?? ""} placeholder={c.quote || t("Freie Nachfrage")}
                onclick={(e) => e.stopPropagation()}
                onkeydown={(e) => {
                  if (e.key === "Enter") { sidechats.rename(c.id, e.currentTarget.value); renaming = null; }
                  else if (e.key === "Escape") { e.stopPropagation(); renaming = null; }
                }}
                onblur={(e) => { sidechats.rename(c.id, e.currentTarget.value); renaming = null; }} />
            {:else}
              <span class="q" role="textbox" tabindex="-1" ondblclick={() => (renaming = c.id)}>{c.name ?? (c.quote ? `„${c.quote}“` : t("Freie Nachfrage"))}</span>
            {/if}
            <span class="when">{when(c.created)}</span>
          </button>
          <button class="ren" title={t("Umbenennen …")} aria-label={t("Umbenennen …")} onclick={() => (renaming = c.id)}><Icon name="✎" size={12} /></button>
          <button class="del" title={t("Schließen – beendet den Agenten, gibt Speicher frei")} aria-label={t("Nachfrage schließen")} onclick={() => remove(c)}><Icon name="x" size={12} /></button>
        </div>
      {/each}
    </div>
  {/if}

  {#if chat}
    <div class="active">
      <div class="scroll" bind:this={scroller} onscroll={onScroll}>
        {#if chat.quote}<blockquote class="quote">{chat.quote}</blockquote>{/if}
        {#if !chat.pane}
          <label class="ctxpick">
            <input type="checkbox" checked={chat.context !== false} onchange={(e) => sidechats.setContext(chat.id, e.currentTarget.checked)} />
            <span>{t("Kontext von „{title}“ mitgeben", { title })}<i>{t("Der Agent kennt den ganzen Verlauf – kostet Tokens. Ohne: ein frischer Agent im selben Ordner.")}</i></span>
          </label>
        {:else}
          <span class="ctx"><Icon name="info" size={12} />
            {chat.context === false ? t("Ohne Verlauf – frischer Agent im selben Ordner") : t("Kennt den ganzen Verlauf von „{title}“", { title })}</span>
        {/if}
        {#if shown}
          <TimelineView timeline={shown} overview={false} onAnswer={(ask, picks) => api.answer(server, chat.pane!, ask, picks).then(() => true, () => false)} />
        {/if}
        {#if pending}<p class="mine">{pending}</p>{/if}
        {#if starting}
          <span class="thinking"><Icon name="loader" size={13} spin /> {t("Nachfrage startet – der Verlauf wird kopiert …")}</span>
        {:else if running || (pending && chat.pane)}
          <span class="thinking"><Icon name="loader" size={13} spin /> {t("denkt nach …")}</span>
        {/if}
        {#if error}<div class="err small"><Icon name="alert" size={13} /> {error}</div>{/if}
      </div>
      <div class="compose">
        <Composer bind:this={composer} bind:value={text} {server} ws={main.split(":")[0]} disabled={busy} quick={false} chips={false}
          skillsPane={chat.pane ?? main} skillPrefix={agent === "claude" ? "/" : "/skill:"}
          placeholder={chat.pane ? t("Weiter nachfragen …") : chat.quote ? t("Was willst du dazu wissen?") : t("Frage stellen – „/“ für Skills")}
          keysTitle={t("Tasten")} onSend={send} onKeys={(keys) => chat.pane && void api.keys(server, chat.pane, keys)} />
      </div>
    </div>
  {:else}
    <div class="empty">
      <span class="eico"><Icon name="message" size={18} /></span>
      <span>{t("Eine Frage nebenher, ohne den Hauptchat zu stören – auch zu markiertem Text („Nachfragen“).")}</span>
      <button class="btn primary" onclick={startEmpty}><Icon name="plus" size={13} /> {t("Neue Nachfrage")}</button>
    </div>
  {/if}
</div>

<style>
  .chats { flex: 1; min-height: 0; display: flex; flex-direction: column; }
  .list { display: grid; gap: 2px; padding: 8px; border-bottom: 1px solid var(--border); max-height: 190px; overflow-y: auto; flex: none; }
  .item { position: relative; border-radius: 8px; }
  .item:hover { background: color-mix(in srgb, var(--fg) 5%, transparent); }
  .item.on { background: color-mix(in srgb, var(--accent) 14%, transparent); }
  .pick { all: unset; box-sizing: border-box; cursor: pointer; display: grid; grid-template-columns: 10px minmax(0, 1fr) auto; column-gap: 8px; align-items: center;
    width: 100%; padding: 6px 56px 6px 8px; border-radius: 8px; }
  .pick:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  .dot { width: 7px; height: 7px; border-radius: 50%; justify-self: center; }
  .dot.working { background: var(--purple); animation: pulse 1.6s ease-in-out infinite; }
  .dot.new { border: 1.5px solid var(--accent); box-sizing: border-box; }
  @keyframes pulse { 50% { opacity: 0.35; } }
  .q { font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .on .q { font-weight: 600; }
  .when { font-size: 11.5px; color: var(--dim); font-variant-numeric: tabular-nums; }
  .del { all: unset; cursor: pointer; position: absolute; right: 4px; top: 50%; translate: 0 -50%; width: 22px; height: 22px; display: grid; place-items: center;
    border-radius: 5px; color: var(--dim); opacity: 0; }
  .item:hover .del, .item:focus-within .del, .item:hover .ren, .item:focus-within .ren { opacity: 1; }
  .ren { all: unset; cursor: pointer; position: absolute; right: 28px; top: 50%; translate: 0 -50%; width: 22px; height: 22px; display: grid;
    place-items: center; border-radius: 5px; color: var(--dim); opacity: 0; }
  .ren:hover { background: var(--border); color: var(--fg); }
  .rename { font: inherit; font-size: 13px; min-width: 0; padding: 1px 6px; border-radius: 5px; border: 1px solid var(--accent);
    background: var(--bg); color: var(--fg); outline: none; }
  .del:hover { background: var(--border); color: var(--fg); }
  .del:focus-visible { outline: 2px solid var(--accent); }
  .active { flex: 1; min-height: 0; display: flex; flex-direction: column; }
  .scroll { flex: 1; min-height: 0; overflow-y: auto; padding: 14px 14px 10px; display: flex; flex-direction: column; gap: 14px; }
  .quote { margin: 0; padding: 8px 12px; border-left: 3px solid var(--accent); border-radius: 0 8px 8px 0; background: color-mix(in srgb, var(--accent) 7%, transparent);
    font-size: 13px; line-height: 1.55; color: var(--muted); white-space: pre-wrap; display: -webkit-box; -webkit-line-clamp: 6; line-clamp: 6; -webkit-box-orient: vertical; overflow: hidden; }
  .ctx { display: flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--dim); margin-top: -6px; }
  .mine { align-self: flex-end; max-width: 88%; margin: 0; padding: 8px 12px; border-radius: 12px; background: var(--card); font-size: 13.5px; line-height: 1.5; opacity: 0.7; white-space: pre-wrap; }
  .thinking { display: inline-flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--dim); }
  .err { color: var(--orange); display: flex; gap: 6px; align-items: center; }
  .small { font-size: 12px; }
  .compose { padding: 10px 12px 12px; border-top: 1px solid var(--border); flex: none; }
  .bar { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-bottom: 1px solid var(--border); flex: none; }
  .fold { all: unset; cursor: pointer; display: inline-flex; align-items: center; gap: 4px; padding: 4px 6px; border-radius: 6px;
    font-size: 12px; color: var(--muted); }
  .fold:hover { background: var(--border); color: var(--fg); }
  .new { all: unset; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 7px; font-size: 12.5px;
    color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, transparent); }
  .new:hover { background: color-mix(in srgb, var(--accent) 22%, transparent); }
  .closeall { all: unset; cursor: pointer; margin-left: auto; font-size: 12px; color: var(--dim); }
  .closeall:hover { color: var(--red); }
  .ctxpick { display: flex; gap: 8px; align-items: flex-start; font-size: 12.5px; cursor: pointer; }
  .ctxpick input { margin-top: 3px; }
  .ctxpick i { display: block; font-style: normal; font-size: 11.5px; color: var(--dim); }
  .empty { flex: 1; display: grid; place-content: center; justify-items: center; gap: 8px; padding: 24px; text-align: center; color: var(--muted); font-size: 13px; }
  .eico { width: 40px; height: 40px; border-radius: 50%; display: grid; place-items: center; background: var(--card); color: var(--accent); }
  /* the log inside: a narrow column – user messages a little smaller */
  .scroll :global(.tl) { gap: 12px; }
</style>
