<script lang="ts">
  // Moshi-style repo browser for one space: files, changes, history graph, branches.
  import * as git from "../git";
  import type { Branches, Changes, CommitDetail, DirEntry, FileContent, Graph } from "../git";
  import DiffView from "./DiffView.svelte";

  let { server, ws }: { server: string; ws: string } = $props();

  type View =
    | { k: "files"; path: string }
    | { k: "file"; path: string }
    | { k: "changes" }
    | { k: "diff"; title: string; load: () => Promise<string> }
    | { k: "history" }
    | { k: "commit"; hash: string }
    | { k: "branches" };

  let stack = $state<View[]>([{ k: "changes" }]);
  const view = $derived(stack[stack.length - 1]);
  const go = (v: View) => (stack = [...stack, v]);
  const tab = (v: View) => (stack = [v]);
  const back = () => stack.length > 1 && (stack = stack.slice(0, -1));

  let data = $state<unknown>(null);
  let error = $state("");
  let busy = $state(false);

  async function load() {
    const v = view;
    data = null; error = ""; busy = true;
    try {
      if (v.k === "files") data = await git.ls(server, ws, v.path);
      else if (v.k === "file") data = await git.read(server, ws, v.path);
      else if (v.k === "changes") data = await git.changes(server, ws);
      else if (v.k === "diff") data = await v.load();
      else if (v.k === "history") data = await git.graph(server, ws);
      else if (v.k === "commit") data = await git.commit(server, ws, v.hash);
      else if (v.k === "branches") data = await git.branches(server, ws);
    } catch (e) { error = String(e); }
    busy = false;
  }
  $effect(() => { void view; void ws; load(); });

  async function toggleStage(path: string, staged: boolean) {
    await git.stage(server, ws, path, !staged);
    load();
  }

  const sections = (c: Changes) => [
    { title: "Gestaged", files: c.staged, staged: true },
    { title: "Nicht gestaged", files: c.unstaged, staged: false },
  ];
  const branchGroups = (b: Branches) => [
    { title: "Lokal", list: b.local },
    { title: "Remote", list: b.remote },
  ];
  const name = (p: string) => p.split("/").pop() ?? p;
  const dir = (p: string) => p.split("/").slice(0, -1).join("/");
  const statusColor = (s: string) => ({ A: "var(--green)", D: "var(--red)", R: "#5aa9f0" })[s] ?? "#b48cf2";
  const L = 16, H = 34, X0 = 12;
  const x = (i: number) => X0 + i * L;
  function curve(x1: number, y1: number, x2: number, y2: number) {
    if (x1 === x2) return `M${x1},${y1} L${x2},${y2}`;
    const my = (y1 + y2) / 2;
    return `M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}`;
  }
</script>

<div class="panel">
  <nav>
    {#each [["changes", "Änderungen"], ["history", "Verlauf"], ["branches", "Branches"], ["files", "Dateien"]] as [k, label]}
      <button class:on={stack[0].k === k} onclick={() => tab(k === "files" ? { k: "files", path: "" } : ({ k } as View))}>{label}</button>
    {/each}
    {#if stack.length > 1}<button class="back" onclick={back}>‹ zurück</button>{/if}
    <button class="reload" onclick={load} title="Neu laden">⟳</button>
  </nav>
  <div class="body">
    {#if error}<div class="err">{error}</div>{/if}
    {#if busy}<div class="skeleton">{#each Array(10) as _, i}<div style="width:{40 + ((i * 37) % 50)}%"></div>{/each}</div>{/if}

    {#if !busy && data}
      {#if view.k === "files"}
        {@const entries = data as DirEntry[]}
        {#if view.path}<div class="crumb mono">{view.path}</div>{/if}
        {#each entries as e}
          <button class="row" onclick={() => go(e.dir ? { k: "files", path: view.path ? `${view.path}/${e.name}` : e.name } : { k: "file", path: view.path ? `${view.path}/${e.name}` : e.name })}>
            <span>{e.dir ? "📁" : "📄"}</span><span class:dimname={e.name.startsWith(".")}>{e.name}</span>
            <span class="right dim">{e.mtime ? git.age(e.mtime) : ""}</span>
          </button>
        {/each}
      {:else if view.k === "file"}
        {@const f = data as FileContent}
        <div class="crumb mono">{f.path}</div>
        {#if f.binary}<div class="dim">Binärdatei</div>
        {:else}
          <div class="code">{#each f.text.split("\n") as line, i}<div class="cl"><span class="no">{i + 1}</span><code>{@html git.highlight(line, git.extOf(f.path)) || " "}</code></div>{/each}</div>
        {/if}
      {:else if view.k === "changes"}
        {@const c = data as Changes}
        <div class="sum mono">⑂ {c.branch}</div>
        {#if !c.staged.length && !c.unstaged.length}<div class="dim">Alles committet.</div>{/if}
        {#each sections(c) as { title, files, staged }}
          {#if files.length}
            <h4>{title} <span class="dim">{files.length}</span></h4>
            {#each files as f}
              <div class="row">
                <span class="badge" style="color:{statusColor(f.status)}">{f.status}</span>
                <button class="link" onclick={() => go({ k: "diff", title: f.path, load: () => git.diff(server, ws, f.path, staged) })}>
                  {name(f.path)} <span class="dim">{dir(f.path)}</span>
                </button>
                <span class="right mono"><span class="add">+{f.add}</span> <span class="del">-{f.del}</span></span>
                <button class="mini" title={staged ? "Unstagen" : "Stagen"} onclick={() => toggleStage(f.path, staged)}>{staged ? "−" : "+"}</button>
              </div>
            {/each}
          {/if}
        {/each}
      {:else if view.k === "diff"}
        <div class="crumb mono">{view.title}</div>
        <DiffView text={data as string} />
      {:else if view.k === "history"}
        {@const g = data as Graph}
        {@const rows = git.graphRows(g.commits, g.changes.files > 0)}
        {#if g.changes.files > 0}
          <button class="row" onclick={() => tab({ k: "changes" })}>
            <svg width={x(0) + 12} height={H}><circle cx={x(0)} cy={H / 2} r="5.5" fill="none" stroke={git.LANE_COLORS[0]} stroke-width="2" />
              <line x1={x(0)} y1={H / 2 + 6} x2={x(0)} y2={H} stroke={git.LANE_COLORS[0]} stroke-width="2" /></svg>
            <span>Nicht committete Änderungen</span>
            <span class="right mono"><span class="add">+{g.changes.add}</span> <span class="del">-{g.changes.del}</span></span>
          </button>
        {/if}
        {#each rows as r}
          <button class="row grow" onclick={() => go({ k: "commit", hash: r.commit.hash })}>
            <svg width={X0 + r.width * L} height={H}>
              {#each r.before as h, i}
                {#if h}
                  {#if h === r.commit.hash}
                    <path d={curve(x(i), 0, x(r.node), H / 2)} stroke={git.LANE_COLORS[i % 8]} stroke-width="2" fill="none" />
                  {:else}
                    {@const k = r.after[i] === h ? i : r.after.indexOf(h)}
                    {#if k !== -1}<path d={curve(x(i), 0, x(k), H)} stroke={git.LANE_COLORS[k % 8]} stroke-width="2" fill="none" />{/if}
                  {/if}
                {/if}
              {/each}
              {#each r.outgoing as k}<path d={curve(x(r.node), H / 2, x(k), H)} stroke={git.LANE_COLORS[k % 8]} stroke-width="2" fill="none" />{/each}
              <circle cx={x(r.node)} cy={H / 2} r={r.commit.parents.length > 1 ? 4.5 : 5.5} fill={git.LANE_COLORS[r.node % 8]} />
            </svg>
            <span class="subject">{r.commit.subject}</span>
            <span class="right dim">{git.age(r.commit.at)}</span>
          </button>
        {/each}
      {:else if view.k === "commit"}
        {@const c = data as CommitDetail}
        <h3>{c.subject}</h3>
        {#if c.body}<p class="muted pre">{c.body}</p>{/if}
        <div class="meta mono dim">{c.hash.slice(0, 12)} · {c.author} · {new Date(c.at).toLocaleString()}</div>
        <button class="btn" onclick={() => go({ k: "diff", title: c.hash.slice(0, 8), load: () => git.commitDiff(server, ws, c.hash) })}>Änderungen anzeigen</button>
        <h4>Geänderte Dateien <span class="dim">{c.files.length}</span></h4>
        {#each c.files as f}
          <button class="row" onclick={() => go({ k: "diff", title: f.path, load: () => git.commitDiff(server, ws, c.hash, f.path) })}>
            <span class="badge" style="color:{statusColor(f.status)}">{f.status}</span>
            <span>{name(f.path)} <span class="dim">{dir(f.path)}</span></span>
            <span class="right mono"><span class="add">+{f.add}</span> <span class="del">-{f.del}</span></span>
          </button>
        {/each}
      {:else if view.k === "branches"}
        {@const b = data as Branches}
        {#each branchGroups(b) as { title, list }}
          <h4>{title} <span class="dim">{list.length}</span></h4>
          {#each list as br}
            <div class="row">
              <span style="color:{br.current ? git.LANE_COLORS[0] : 'var(--dim)'}">⑂</span>
              <span class="bname"><b class:cur={br.current}>{br.name}</b><br /><span class="dim">{br.subject} · {git.age(br.at)}</span></span>
              <span class="right mono">
                {#if br.pr}<span class="pr">#{br.pr.number} {br.pr.checks === "ok" ? "✅" : br.pr.checks === "fail" ? "❌" : br.pr.checks === "pending" ? "⏳" : ""}</span>
                {:else}{#if br.ahead}<span class="add">↑{br.ahead}</span>{/if} {#if br.behind}<span class="acc">↓{br.behind}</span>{/if}{/if}
              </span>
            </div>
          {/each}
        {/each}
      {/if}
    {/if}
  </div>
</div>

<style>
  .panel { display: flex; flex-direction: column; height: 100%; min-height: 0; }
  nav { display: flex; gap: 4px; padding: 8px 14px; border-bottom: 1px solid var(--border); }
  nav button { all: unset; cursor: pointer; padding: 4px 12px; border-radius: 999px; color: var(--muted); }
  nav button.on { background: var(--card); color: var(--fg); }
  nav .back { margin-left: 8px; }
  nav .reload { margin-left: auto; }
  .body { flex: 1; overflow: auto; padding: 12px 16px; }
  .row { all: unset; cursor: pointer; display: flex; align-items: center; gap: 10px; width: 100%; padding: 2px 4px; min-height: 30px;
    border-radius: 6px; box-sizing: border-box; }
  .row:hover { background: color-mix(in srgb, var(--fg) 5%, transparent); }
  .row.grow { min-height: 34px; padding: 0 4px; }
  .right { margin-left: auto; white-space: nowrap; font-size: 12px; }
  .subject { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .badge { font-family: var(--mono); font-weight: 600; width: 18px; text-align: center; }
  .link { all: unset; cursor: pointer; flex: 1; }
  .mini { background: var(--card); border: 1px solid var(--border); border-radius: 6px; width: 26px; }
  .add { color: var(--green); } .del { color: var(--red); } .acc { color: var(--orange); }
  .crumb { color: var(--muted); margin-bottom: 8px; font-size: 12px; }
  .sum { color: var(--muted); margin-bottom: 8px; }
  h4 { margin: 14px 0 4px; } h3 { margin: 0 0 8px; }
  .pre { white-space: pre-wrap; }
  .meta { margin-bottom: 10px; font-size: 12px; }
  .code { font-family: var(--mono); font-size: 12px; }
  .cl { display: flex; } .no { width: 48px; text-align: right; padding-right: 10px; color: var(--dim); flex-shrink: 0; }
  .cl code { white-space: pre-wrap; word-break: break-all; }
  .dimname { color: var(--muted); }
  .bname { overflow: hidden; } .cur { color: var(--fg); }
  .pr { background: var(--card); border-radius: 999px; padding: 2px 8px; }
  .err { color: var(--red); }
  .skeleton div { height: 12px; margin: 12px 0; border-radius: 6px; background: color-mix(in srgb, var(--fg) 8%, transparent);
    animation: pulse 1.2s ease-in-out infinite; }
  @keyframes pulse { 50% { opacity: 0.45; } }
</style>
