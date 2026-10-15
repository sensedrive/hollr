<script lang="ts">
  // The input card (Composer.swift): text on top, actions below. Enter sends, Shift+Enter adds a line,
  // ↑ in an empty field brings back the last message. ">_" sends single keys to the pane.
  // Above the text: prompt snippets (chips), "@" completes file names of the space, 📎 / paste / drop
  // uploads files and puts their server path into the text (ComposerAssist.swift, Attachments.swift).
  import type { Snippet } from "svelte";
  import { tick } from "svelte";
  import { t } from "../i18n";
  import { pushRecall } from "../drafts";
  import { applyMention, insertAt, mentionAt } from "../assist";
  import { attach } from "../attach";
  import { files as findFiles } from "../git";
  import { snippets } from "../snippets.svelte";
  import Icon from "./git/Icon.svelte";

  let {
    placeholder, keysTitle, translucent = false, disabled = false, onSend, onKeys, top, trailing, value = $bindable(""),
    sent = $bindable([]), server, ws,
  }: {
    placeholder: string;
    keysTitle: string;
    translucent?: boolean;
    disabled?: boolean;
    /** returns false when sending failed (text stays) */
    onSend: (text: string) => Promise<boolean> | boolean;
    onKeys: (keys: string[]) => void;
    /** extra row inside the card above the text (live strip) */
    top?: Snippet;
    /** extra buttons left of "send" (live button) */
    trailing?: Snippet;
    value?: string;
    /** ↑ history, newest first (bind it to keep it beyond this component) */
    sent?: string[];
    /** for "@" files and uploads; without them both are off */
    server?: string;
    /** workspace id (pane id before ":") */
    ws?: string;
  } = $props();

  const KEYS: [string, string][] = $derived([
    ["Enter", "enter"], ["Esc", "esc"], ["Tab", "tab"], ["↑", "up"], ["↓", "down"], ["←", "left"], ["→", "right"],
    [t("y (ja)"), "y"], [t("n (nein)"), "n"], ["Ctrl+C", "ctrl+c"], ["Ctrl+D", "ctrl+d"], ["Ctrl+L", "ctrl+l"],
  ]);
  /** always visible on wide windows */
  const QUICK: [string, string][] = [["Esc", "esc"], ["↑", "up"], ["↓", "down"], ["Tab", "tab"], ["⏎", "enter"], ["^C", "ctrl+c"]];

  let area: HTMLTextAreaElement | undefined = $state();
  let picker: HTMLInputElement | undefined = $state();
  let menu = $state(false);
  let focused = $state(false);
  let recall = -1;
  const trimmed = $derived(value.trim());
  const showSnippets = $derived(snippets.list.length > 0 && (focused || !value) && !disabled);

  export function focus() {
    area?.focus();
  }

  // grow with the text (1 … 10 lines)
  $effect(() => {
    void value;
    if (!area) return;
    area.style.height = "auto";
    area.style.height = `${Math.min(area.scrollHeight, 220)}px`;
  });

  /** sets the text and puts the caret at `caret` once the field shows it */
  async function edit(e: { text: string; caret: number }) {
    value = e.text;
    await tick();
    area?.focus();
    area?.setSelectionRange(e.caret, e.caret);
  }

  /** caret / selection (end of the text when the field never had focus) */
  const selection = () =>
    area && document.activeElement === area ? [area.selectionStart, area.selectionEnd] : [value.length, value.length];

  // ------------------------------------------------------------ snippets

  function useSnippet(s: string) {
    const [a, b] = selection();
    edit(insertAt(value, a ?? 0, b ?? 0, s));
  }

  // ------------------------------------------------------------ "@" files

  let mention = $state<{ start: number; query: string } | null>(null);
  let found = $state<string[]>([]);
  let pick = $state(0);
  let mentionTimer: ReturnType<typeof setTimeout> | undefined;
  let mentionSeq = 0;
  const mentionOpen = $derived(!!mention && found.length > 0);

  function closeMention() {
    clearTimeout(mentionTimer);
    mentionSeq++;
    mention = null;
    found = [];
  }

  /** after typing / moving the caret: is there an "@frag" right before it? */
  function checkMention() {
    if (!server || !ws || !area || area.selectionStart !== area.selectionEnd) return closeMention();
    const m = mentionAt(area.value, area.selectionStart);
    if (!m) return closeMention();
    if (mention && m.start === mention.start && m.query === mention.query) return;
    mention = m;
    clearTimeout(mentionTimer);
    const n = ++mentionSeq;
    const [s, w] = [server, ws];
    mentionTimer = setTimeout(async () => {
      try {
        const list = await findFiles(s, w, m.query, 8);
        if (n !== mentionSeq) return;
        found = list.slice(0, 8);
        pick = 0;
      } catch {
        if (n === mentionSeq) found = [];
      }
    }, 180);
  }

  function choose(path: string) {
    if (!mention || !area) return;
    const caret = area.selectionStart;
    const start = mention.start;
    closeMention();
    edit(applyMention(value, caret, start, path));
  }

  // ------------------------------------------------------------ attachments

  let uploading = $state(0);
  let uploadError = $state("");
  let dragging = $state(false);
  let errorTimer: ReturnType<typeof setTimeout> | undefined;

  async function upload(list: File[]) {
    if (!server || !list.length) return;
    uploadError = "";
    for (const file of list) {
      uploading++;
      try {
        const path = await attach(server, file);
        const [a, b] = selection();
        let r = insertAt(value, a ?? 0, b ?? 0, path);
        if (r.caret === r.text.length) r = { text: `${r.text} `, caret: r.caret + 1 };
        await edit(r);
      } catch (e) {
        uploadError = t("Hochladen fehlgeschlagen: {e}", { e: e instanceof Error ? e.message : String(e) });
        clearTimeout(errorTimer);
        errorTimer = setTimeout(() => (uploadError = ""), 8000);
      } finally {
        uploading--;
      }
    }
  }

  function onPaste(e: ClipboardEvent) {
    const list = [...(e.clipboardData?.files ?? [])];
    if (!list.length || !server) return;
    e.preventDefault();
    upload(list);
  }

  const hasFiles = (e: DragEvent) => !!server && !!e.dataTransfer?.types.includes("Files");
  function onDragOver(e: DragEvent) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    dragging = true;
  }
  function onDrop(e: DragEvent) {
    dragging = false;
    if (!hasFiles(e)) return;
    e.preventDefault();
    upload([...(e.dataTransfer?.files ?? [])]);
  }

  // ------------------------------------------------------------ sending

  async function send() {
    const msg = trimmed;
    if (!msg || disabled) return;
    closeMention();
    value = "";
    recall = -1;
    sent = pushRecall(sent, msg);
    const ok = await onSend(msg);
    // the owner may already have put it back (drafts) – never twice
    if (ok === false && !value.includes(msg)) value = value ? `${msg}\n${value}` : msg;
  }

  function onKey(e: KeyboardEvent) {
    if (e.isComposing) return;
    if (mentionOpen) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        pick = (pick + (e.key === "ArrowDown" ? 1 : found.length - 1)) % found.length;
        return;
      }
      if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
        e.preventDefault();
        choose(found[pick] ?? "");
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closeMention();
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      send();
    } else if (e.key === "ArrowUp" && (!value || recall >= 0) && sent.length && area?.selectionStart === 0) {
      e.preventDefault();
      recall = Math.min(recall + 1, sent.length - 1);
      value = sent[recall] ?? "";
    } else if (e.key === "ArrowDown" && recall >= 0) {
      e.preventDefault();
      recall--;
      value = recall >= 0 ? (sent[recall] ?? "") : "";
    } else if (e.key === "Escape" && value === "" ) {
      area?.blur();
    }
  }

  function key(k: string) {
    menu = false;
    onKeys([k]);
  }
</script>

<svelte:window onclick={() => (menu = false)} />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="composer" class:translucent class:dragging ondragover={onDragOver} ondragleave={() => (dragging = false)} ondrop={onDrop}>
  {#if top}{@render top()}{/if}
  {#if mentionOpen}
    <div class="mentions" role="listbox" aria-label={t("Dateien")}>
      {#each found as f, i (f)}
        <!-- mousedown: keep the caret in the text field -->
        <button class="mention mono" class:on={i === pick} role="option" aria-selected={i === pick}
          onmousedown={(e) => e.preventDefault()} onmouseenter={() => (pick = i)} onclick={() => choose(f)}>
          <span class="base">{f.split("/").pop()}</span>
          {#if f.includes("/")}<span class="dir">{f.split("/").slice(0, -1).join("/")}</span>{/if}
        </button>
      {/each}
    </div>
  {/if}
  {#if showSnippets}
    <div class="snippets" aria-label={t("Prompt-Bausteine")}>
      {#each snippets.list as s (s)}
        <button class="chip" title={s} onmousedown={(e) => e.preventDefault()} onclick={() => useSnippet(s)}>{s}</button>
      {/each}
    </div>
  {/if}
  <textarea bind:this={area} bind:value rows="1" {placeholder} {disabled} spellcheck="false" onkeydown={onKey}
    oninput={checkMention} onkeyup={(e) => !["ArrowUp", "ArrowDown", "Enter", "Tab", "Escape"].includes(e.key) && checkMention()}
    onclick={checkMention} onfocus={() => (focused = true)} onblur={() => { focused = false; closeMention(); }}
    onpaste={onPaste}></textarea>
  {#if uploadError}
    <div class="uperr"><span class="grow">⚠ {uploadError}</span><button class="link" aria-label={t("Schließen")} onclick={() => (uploadError = "")}>✕</button></div>
  {/if}
  <div class="actions">
    <div class="keys">
      <div class="menuwrap">
        <button class="term mono" title={keysTitle} aria-label={t("Tasten senden")} onclick={(e) => { e.stopPropagation(); menu = !menu; }}>&gt;_</button>
        {#if menu}
          <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
          <div class="menu" onclick={(e) => e.stopPropagation()}>
            <div class="mtitle">{keysTitle}</div>
            {#each KEYS as [label, k]}
              <button class="mitem" onclick={() => key(k)}>{label}<span class="mono dim">{k}</span></button>
            {/each}
          </div>
        {/if}
      </div>
      {#if server}
        <button class="clip" class:busy={uploading > 0} disabled={disabled} onclick={() => picker?.click()}
          title={t("Datei anhängen (auch einfügen oder hierher ziehen)")} aria-label={t("Datei anhängen")}>
          {#if uploading}<span class="spin"></span>{:else}<Icon name="paperclip" size={15} />{/if}
        </button>
        <input bind:this={picker} type="file" multiple hidden
          onchange={(e) => { upload([...(e.currentTarget.files ?? [])]); e.currentTarget.value = ""; }} />
        {#if uploading}<span class="uploading">{t("Lädt hoch …")}</span>{/if}
      {/if}
      <div class="quick">
        {#each QUICK as [label, k]}
          <button class="key mono" title={k} onclick={() => onKeys([k])}>{label}</button>
        {/each}
      </div>
    </div>
    <div class="right">
      {#if trailing}{@render trailing()}{/if}
      <button class="send" class:on={!!trimmed} disabled={!trimmed || disabled} title={`${t("Senden")} (⏎)`} aria-label={t("Senden")} onclick={send}>↑</button>
    </div>
  </div>
</div>

<style>
  .composer { background: var(--raised); border: 1px solid color-mix(in srgb, var(--fg) 12%, transparent); border-radius: 22px;
    padding: 12px 14px 8px; display: flex; flex-direction: column; gap: 8px; transition: border-color 0.15s; container-type: inline-size;
    position: relative; }
  .composer:focus-within { border-color: color-mix(in srgb, var(--accent) 60%, transparent); }
  .composer.dragging { border-color: var(--accent); border-style: dashed; }
  .composer.translucent { background: color-mix(in srgb, var(--raised) 62%, transparent); backdrop-filter: blur(22px) saturate(1.4);
    -webkit-backdrop-filter: blur(22px) saturate(1.4); box-shadow: 0 8px 30px rgba(0, 0, 0, 0.25); }
  textarea { all: unset; box-sizing: border-box; width: 100%; resize: none; font-family: var(--mono); font-size: 13.5px; line-height: 1.5;
    min-height: 21px; max-height: 220px; overflow-y: auto; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--fg); }
  textarea::placeholder { color: var(--dim); }
  .snippets { display: flex; gap: 6px; overflow-x: auto; scrollbar-width: none; margin: -2px 0 0; }
  .snippets::-webkit-scrollbar { display: none; }
  .chip { all: unset; cursor: pointer; flex: none; max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    font-size: 12px; color: var(--muted); padding: 3px 10px; border-radius: 99px; background: color-mix(in srgb, var(--fg) 6%, transparent);
    border: 1px solid color-mix(in srgb, var(--fg) 10%, transparent); }
  .chip:hover { color: var(--fg); border-color: var(--accent); }
  .mentions { position: absolute; bottom: calc(100% + 6px); left: 10px; z-index: 20; min-width: 260px; max-width: min(520px, calc(100% - 20px));
    background: var(--side); border: 1px solid var(--border); border-radius: 12px; padding: 5px; box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
    display: flex; flex-direction: column; }
  .mention { all: unset; cursor: pointer; display: flex; align-items: baseline; gap: 10px; padding: 5px 8px; border-radius: 7px; font-size: 12.5px;
    min-width: 0; }
  .mention.on { background: color-mix(in srgb, var(--accent) 22%, transparent); }
  .mention .base { flex: none; }
  .mention .dir { font-size: 11px; color: var(--dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left; }
  .uperr { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--red); }
  .link { all: unset; cursor: pointer; color: var(--muted); padding: 0 4px; }
  .link:hover { color: var(--fg); }
  .actions { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  .keys { display: flex; align-items: center; gap: 6px; min-width: 0; }
  .quick { display: flex; gap: 4px; overflow: hidden; }
  .key { all: unset; cursor: pointer; font-size: 11px; color: var(--muted); padding: 2px 7px; border-radius: 6px;
    border: 1px solid color-mix(in srgb, var(--fg) 10%, transparent); }
  .key:hover { color: var(--fg); border-color: var(--accent); }
  @container (max-width: 520px) { .quick { display: none; } }
  .term { all: unset; cursor: pointer; font-weight: 600; font-size: 15px; padding: 2px 6px; border-radius: 6px; }
  .term:hover { background: color-mix(in srgb, var(--fg) 8%, transparent); }
  .clip { all: unset; cursor: pointer; display: grid; place-items: center; width: 26px; height: 26px; border-radius: 6px; color: var(--muted); }
  .clip:hover { background: color-mix(in srgb, var(--fg) 8%, transparent); color: var(--fg); }
  .clip.busy { cursor: default; }
  .spin { width: 12px; height: 12px; border-radius: 50%; border: 2px solid color-mix(in srgb, var(--fg) 20%, transparent);
    border-top-color: var(--accent); animation: spin .8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .uploading { font-size: 11px; color: var(--muted); white-space: nowrap; }
  .menuwrap { position: relative; }
  .menu { position: absolute; bottom: calc(100% + 8px); left: -6px; z-index: 20; min-width: 220px; background: var(--side);
    border: 1px solid var(--border); border-radius: 12px; padding: 6px; box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35); }
  .mtitle { font-size: 11px; color: var(--muted); padding: 4px 8px 6px; }
  .mitem { all: unset; cursor: pointer; display: flex; justify-content: space-between; gap: 16px; width: calc(100% - 16px);
    padding: 5px 8px; border-radius: 7px; font-size: 13px; }
  .mitem:hover { background: color-mix(in srgb, var(--accent) 22%, transparent); }
  .mitem .dim { font-size: 11px; color: var(--dim); }
  .right { display: flex; align-items: center; gap: 8px; }
  .send { all: unset; cursor: default; width: 34px; height: 34px; border-radius: 50%; display: grid; place-items: center; font-weight: 700;
    background: color-mix(in srgb, var(--fg) 10%, transparent); color: var(--muted); }
  .send.on { cursor: pointer; background: var(--accent); color: #fff; }
  .send.on:hover { filter: brightness(1.1); }
</style>
