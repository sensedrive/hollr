<script lang="ts">
  // Uncommitted changes: branch + totals, staged / unstaged sections, stage/unstage per file, full-context diffs.
  // Review (iOS GitPanel): discard a file, comment on it to the space's agent, commit / push / open a PR.
  import { onDestroy } from "svelte";
  import { openUrl } from "@tauri-apps/plugin-opener";
  import { prompt } from "../../api";
  import * as git from "../../git";
  import { t } from "../../i18n";
  import { allPanes } from "../../store.svelte";
  import ConfirmDialog from "../../views/dashboard/ConfirmDialog.svelte";
  import Modal from "../Modal.svelte";
  import ChangeRow from "./ChangeRow.svelte";
  import Icon from "./Icon.svelte";
  import PlusMinus from "./PlusMinus.svelte";
  import Skeleton from "./Skeleton.svelte";
  import { detailKey, navKey, reveal, type Detail } from "./nav";

  let { server, ws, rev, openKey = "", preview = false, onOpen, onStaged }:
    { server: string; ws: string; rev: number; openKey?: string; preview?: boolean; onOpen: (d: Detail) => void;
      onStaged?: (path: string, staged: boolean) => void } = $props();

  let data = $state<git.Changes | null>(null);
  let error = $state("");
  let busy = $state<string | null>(null);
  let sel = $state(-1);
  let list: HTMLElement | undefined = $state();

  let seq = 0;
  async function load() {
    const n = ++seq;
    try {
      const r = await git.changes(server, ws);
      if (n === seq) { data = r; error = ""; }
    } catch (e) { if (n === seq) error = String(e); }
  }
  let lastWs = "";
  $effect(() => {
    void rev;
    if (ws !== lastWs) { data = null; lastWs = ws; }
    load();
  });

  type Item = { file: git.FileChange; staged: boolean };
  const items = $derived<Item[]>(data ? [...data.staged.map((file) => ({ file, staged: true })), ...data.unstaged.map((file) => ({ file, staged: false }))] : []);
  const all = $derived(data ? [...data.staged, ...data.unstaged] : []);
  const sections = $derived(data ? [
    { title: t("Gestaged"), staged: true, files: data.staged, offset: 0 },
    { title: t("Nicht gestaged"), staged: false, files: data.unstaged, offset: data.staged.length },
  ] : []);

  const detailOf = (it: Item): Detail => ({ k: "diff", title: it.file.path, path: it.file.path, staged: it.staged });

  async function toggle(it: Item) {
    busy = it.file.path;
    try {
      await git.stage(server, ws, it.file.path, !it.staged);
      onStaged?.(it.file.path, !it.staged);
      await load();
    } catch (e) { error = String(e); }
    busy = null;
  }

  function open(i: number) { const it = items[i]; if (it) { sel = i; onOpen(detailOf(it)); } }
  let timer: ReturnType<typeof setTimeout> | undefined;
  onDestroy(() => clearTimeout(timer));
  function select(i: number) {
    sel = i;
    reveal(list, i);
    if (preview) { clearTimeout(timer); timer = setTimeout(() => open(i), 140); }
  }
  function onkeydown(e: KeyboardEvent) {
    if (navKey(e, items.length, sel, select, open)) return;
    if ((e.key === " " || e.key === "s") && items[sel] && !e.metaKey && !e.ctrlKey) { e.preventDefault(); toggle(items[sel]); }
  }
  // ------------------------------------------------------------ review

  /** the space's first agent pane – gets comments and "write the commit message" */
  const agent = $derived(allPanes(server).find((r) => r.workspace.id === ws && r.pane.agent));
  const agentName = $derived(
    agent?.pane.agent ? ({ omp: "omp", claude: "Claude", codex: "Codex" } as Record<string, string>)[agent.pane.agent] ?? agent.pane.agent : "Agent",
  );
  /** short confirmation under the head ("sent to Claude") */
  let notice = $state("");
  let noticeTimer: ReturnType<typeof setTimeout> | undefined;
  onDestroy(() => clearTimeout(noticeTimer));
  function note(text: string) {
    notice = text;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => (notice = ""), 4000);
  }
  /** a dialog opens: the row button must not get the Enter / Esc meant for it */
  const unfocus = () => (document.activeElement as HTMLElement | null)?.blur();

  async function ask(text: string) {
    if (!agent) throw new Error(t("In diesem Space läuft kein Agent."));
    await prompt(server, agent.pane.pane, text);
    note(t("An {agent} geschickt.", { agent: agentName }));
  }

  let discarding = $state<string | null>(null);
  async function discard(path: string) {
    await git.discard(server, ws, path);
    discarding = null;
    await load();
  }

  let commenting = $state<string | null>(null);
  let comment = $state("");
  let commentBusy = $state(false);
  let commentError = $state("");
  function startComment(path: string) {
    unfocus();
    commenting = path;
    comment = "";
    commentError = "";
  }
  async function sendComment() {
    if (!commenting || !comment.trim()) return;
    commentBusy = true;
    commentError = "";
    try {
      await ask(t("Zu {path}: {comment}", { path: commenting, comment: comment.trim() }));
      commenting = null;
    } catch (e) { commentError = e instanceof Error ? e.message : String(e); }
    commentBusy = false;
  }

  let committing = $state(false);
  let message = $state("");
  let withAll = $state(false);
  let hash = $state("");
  let cBusy = $state<"" | "commit" | "agent" | "push" | "pr">("");
  let cError = $state("");
  let pushed = $state("");
  function startCommit() {
    unfocus();
    committing = true;
    hash = "";
    pushed = "";
    cError = "";
    withAll = !data?.staged.length;
  }
  async function run(kind: typeof cBusy, fn: () => Promise<void>) {
    cBusy = kind;
    cError = "";
    try { await fn(); } catch (e) { cError = e instanceof Error ? e.message : String(e); }
    cBusy = "";
  }
  const doCommit = () => run("commit", async () => {
    hash = await git.gitCommit(server, ws, message, withAll);
    message = "";
    await load();
  });
  const agentCommit = () => run("agent", async () => {
    await ask(t("Schau dir die aktuellen Änderungen an und committe sie mit einer passenden, kurzen Commit-Nachricht."));
    committing = false;
  });
  const doPush = () => run("push", async () => {
    await git.push(server, ws);
    pushed = t("Gepusht.");
  });
  const doPr = () => run("pr", async () => {
    const url = await git.openPr(server, ws);
    pushed = url;
    await openUrl(url).catch(() => window.open(url, "_blank"));
  });
  /** dialogs live inside the git panel: keys typed there must not drive the list / panel */
  function dialogKeys(e: KeyboardEvent, close: () => void) {
    e.stopPropagation();
    if (e.key === "Escape") { e.preventDefault(); close(); }
  }

  const summary = (d: git.Changes) => [
    d.unstaged.length ? t("{n} nicht gestaged", { n: d.unstaged.length }) : "",
    d.staged.length ? t("{n} gestaged", { n: d.staged.length }) : "",
  ].filter(Boolean).join(" · ");
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div class="tab" bind:this={list} tabindex="0" {onkeydown} role="listbox" aria-label={t("Änderungen")}>
  <div class="head">
    <h3>{t("Nicht committete Änderungen")}</h3>
    {#if data}
      <div class="sum">
        <span class="branch"><Icon name="branch" size={13} /><span>{data.branch}</span></span>
        <span class="dim small">{summary(data)}</span>
        <span class="sp"></span>
        <PlusMinus add={git.sumAdd(all)} del={git.sumDel(all)} />
      </div>
    {/if}
  </div>

  {#if error}<div class="state err">{error}</div>{/if}
  {#if !data && !error}
    <Skeleton kind="list" count={10} />
  {:else if data && !all.length}
    <div class="clean"><span class="ok"><Icon name="check" size={20} /></span><b>{t("Alles committet.")}</b>
      <span class="dim small">{t("Keine offenen Änderungen auf {branch}.", { branch: data.branch })}</span></div>
  {:else if data}
    {#each sections as s}
      {#if s.files.length}
        <div class="section"><span>{s.title}</span><span class="count">{s.files.length}</span></div>
        <div class="items">
          {#each s.files as file, j (file.path)}
            {@const it = { file, staged: s.staged }}
            {@const i = s.offset + j}
            <div class:kbd={i === sel}>
              <ChangeRow {file} index={i} selected={openKey === detailKey(detailOf(it))} onclick={() => open(i)}>
                {#snippet trailing()}
                  <button class="stage act" onclick={() => { unfocus(); discarding = file.path; }} title={t("Verwerfen")} aria-label={t("Verwerfen")}>
                    <Icon name="discard" size={13} />
                  </button>
                  <button class="stage act" onclick={() => startComment(file.path)} title={t("Kommentar")} aria-label={t("Kommentar")}>
                    <Icon name="comment" size={13} />
                  </button>
                  <button class="stage" class:busy={busy === file.path} disabled={busy === file.path} onclick={() => toggle(it)}
                    title={s.staged ? t("Unstagen") : t("Stagen")} aria-label={s.staged ? t("Unstagen") : t("Stagen")}>
                    <Icon name={s.staged ? "minus" : "plus"} size={13} />
                  </button>
                {/snippet}
              </ChangeRow>
            </div>
          {/each}
        </div>
      {/if}
    {/each}
    <div class="hint dim">{t("↑↓ wählen · ⏎ öffnen · Leertaste stagen")}</div>
  {/if}
  {#if data && (all.length || hash)}
    <div class="commitbar">
      {#if notice}<span class="notice small">{notice}</span>{/if}
      <span class="sp"></span>
      <button class="btn primary" onclick={startCommit}><Icon name="commit" size={14} /><span>{t("Commit …")}</span></button>
    </div>
  {:else if notice}
    <div class="commitbar"><span class="notice small">{notice}</span></div>
  {/if}
</div>

{#if discarding}
  {@const path = discarding}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div onkeydown={(e) => dialogKeys(e, () => (discarding = null))}>
    <ConfirmDialog title={t("Änderungen verwerfen?")} confirmLabel={t("Verwerfen")}
      message={t("Alle Änderungen an {path} gehen verloren – neue Dateien werden gelöscht.", { path })}
      onConfirm={() => discard(path)} onClose={() => (discarding = null)} />
  </div>
{/if}

{#if commenting}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div onkeydown={(e) => dialogKeys(e, () => (commenting = null))}>
    <Modal title={t("Kommentar an {agent}", { agent: agentName })} onClose={() => (commenting = null)}>
      <div class="muted small mono">{commenting}</div>
      <!-- svelte-ignore a11y_autofocus -->
      <textarea class="field" rows="4" bind:value={comment} autofocus placeholder={t("Was soll {agent} hier ändern?", { agent: agentName })}
        onkeydown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); sendComment(); } }}></textarea>
      {#if !agent}<div class="err small">{t("In diesem Space läuft kein Agent.")}</div>{/if}
      {#if commentError}<div class="err small">{commentError}</div>{/if}
      <div class="buttons">
        <button class="btn" onclick={() => (commenting = null)}>{t("Abbrechen")}</button>
        <button class="btn primary" disabled={!comment.trim() || !agent || commentBusy} onclick={sendComment}>{commentBusy ? "…" : t("Senden")}</button>
      </div>
    </Modal>
  </div>
{/if}

{#if committing}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div onkeydown={(e) => dialogKeys(e, () => (committing = false))}>
    <Modal title={hash ? t("Committet") : t("Commit")} onClose={() => (committing = false)}>
      {#if hash}
        <div class="done"><span class="ok small"><Icon name="check" size={14} /></span><span>{t("Commit {hash} angelegt.", { hash })}</span></div>
        {#if pushed}
          {#if pushed.startsWith("http")}
            <button class="url mono small" onclick={() => openUrl(pushed).catch(() => {})}>{pushed}</button>
          {:else}
            <div class="muted small">{pushed}</div>
          {/if}
        {/if}
        {#if cError}<div class="err small">{cError}</div>{/if}
        <div class="buttons">
          <button class="btn" onclick={() => (committing = false)}>{t("Fertig")}</button>
          <button class="btn" disabled={!!cBusy} onclick={doPush}>{cBusy === "push" ? "…" : t("Pushen")}</button>
          <button class="btn primary" disabled={!!cBusy} onclick={doPr}>{cBusy === "pr" ? "…" : t("Pushen und PR öffnen")}</button>
        </div>
      {:else}
        <!-- svelte-ignore a11y_autofocus -->
        <textarea class="field" rows="3" bind:value={message} autofocus placeholder={t("Commit-Nachricht")}
          onkeydown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && message.trim()) { e.preventDefault(); doCommit(); } }}></textarea>
        <label class="check"><input type="checkbox" bind:checked={withAll} /> {t("Auch nicht gestagte Änderungen")}</label>
        {#if cError}<div class="err small">{cError}</div>{/if}
        <div class="buttons">
          <button class="btn agentbtn" disabled={!agent || !!cBusy} onclick={agentCommit}
            title={agent ? "" : t("In diesem Space läuft kein Agent.")}>{cBusy === "agent" ? "…" : t("{agent} die Nachricht schreiben lassen", { agent: agentName })}</button>
          <span class="sp"></span>
          <button class="btn" onclick={() => (committing = false)}>{t("Abbrechen")}</button>
          <button class="btn primary" disabled={!message.trim() || !!cBusy} onclick={doCommit}>{cBusy === "commit" ? "…" : t("Committen")}</button>
        </div>
      {/if}
    </Modal>
  </div>
{/if}

<style>
  .tab { outline: none; min-height: 100%; display: flex; flex-direction: column; }
  .head { padding: 12px 14px 6px; }
  h3 { margin: 0 0 6px; font-size: 15px; font-weight: 650; }
  .sum { display: flex; align-items: center; gap: 8px; }
  .branch { display: inline-flex; align-items: center; gap: 5px; font-family: var(--mono); font-size: 12px; padding: 2px 8px; border-radius: 99px;
    background: color-mix(in srgb, var(--purple) 15%, transparent); color: var(--purple); max-width: 50%; }
  .branch span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sp { flex: 1; }
  .small { font-size: 12px; }
  .section { display: flex; align-items: center; gap: 8px; margin: 14px 14px 4px; font-size: 11px; font-weight: 600; text-transform: uppercase;
    letter-spacing: .05em; color: var(--muted); }
  .count { font-family: var(--mono); color: var(--dim); }
  .items { padding: 0 6px; }
  .kbd { border-radius: 8px; box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 60%, transparent); }
  .tab:not(:focus-within) .kbd { box-shadow: none; }
  .stage { width: 26px; height: 26px; flex: none; display: grid; place-items: center; border-radius: 7px; border: 1px solid var(--border);
    background: var(--card); color: var(--muted); padding: 0; }
  .stage:hover { color: var(--fg); border-color: var(--accent); }
  .stage.busy { animation: pulse 1s ease-in-out infinite; }
  @keyframes pulse { 50% { opacity: .35; } }
  .clean { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 50px 20px; text-align: center; }
  .ok { width: 40px; height: 40px; border-radius: 50%; display: grid; place-items: center; color: var(--green);
    background: color-mix(in srgb, var(--green) 14%, transparent); margin-bottom: 4px; }
  .state { padding: 12px 16px; }
  .hint { font-size: 11px; padding: 16px 16px 12px; }
  .act { opacity: 0; }
  .items > div:hover .act, .kbd .act, .act:focus-visible { opacity: 1; }
  .commitbar { position: sticky; bottom: 0; margin-top: auto; display: flex; align-items: center; gap: 10px; padding: 8px 12px;
    border-top: 1px solid var(--border); background: var(--bg); }
  .commitbar .btn { display: inline-flex; align-items: center; gap: 6px; }
  .notice { color: var(--green); }
  .field { width: 100%; box-sizing: border-box; padding: 8px 10px; border-radius: 8px; resize: vertical; font-family: var(--mono); font-size: 13px; }
  .check { display: flex; align-items: center; gap: 8px; font-size: 13px; cursor: pointer; }
  .buttons { display: flex; align-items: center; justify-content: flex-end; gap: 8px; flex-wrap: wrap; }
  .done { display: flex; align-items: center; gap: 8px; }
  .done .ok { width: 24px; height: 24px; margin: 0; }
  .url { all: unset; cursor: pointer; color: var(--accent); overflow-wrap: anywhere; }
  .url:hover { text-decoration: underline; }
</style>
