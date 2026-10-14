<script lang="ts">
  // Branches: local / remote, current highlighted, last commit + age, ahead/behind, PR number/state/draft/checks.
  import * as git from "../../git";
  import { t } from "../../i18n";
  import Icon from "./Icon.svelte";
  import Skeleton from "./Skeleton.svelte";
  import { navKey, reveal } from "./nav";

  let { server, ws, rev }: { server: string; ws: string; rev: number } = $props();

  let data = $state<git.Branches | null>(null);
  let error = $state("");
  let filter = $state("");
  let sel = $state(-1);
  let hideRemote = $state(false);
  let list: HTMLElement | undefined = $state();

  let seq = 0;
  async function load() {
    const n = ++seq;
    try {
      const r = await git.branches(server, ws);
      if (n === seq) { data = r; error = ""; }
    } catch (e) { if (n === seq) error = String(e); }
  }
  let lastWs = "";
  $effect(() => {
    void rev;
    if (ws !== lastWs) { data = null; lastWs = ws; }
    load();
  });

  const q = $derived(filter.trim().toLowerCase());
  const match = (b: git.Branch) => !q || b.name.toLowerCase().includes(q) || b.subject.toLowerCase().includes(q) || (b.pr && `#${b.pr.number}` === q);
  const groups = $derived(data ? [
    { title: t("Lokal"), list: data.local.filter(match), total: data.local.length, remote: false },
    { title: t("Remote"), list: hideRemote ? [] : data.remote.filter(match), total: data.remote.length, remote: true },
  ] : []);
  const flat = $derived(groups.flatMap((g) => g.list));

  const checks = (c?: string) =>
    c === "ok" ? { icon: "check", color: "var(--green)", label: t("Checks ok") }
    : c === "fail" ? { icon: "x", color: "var(--red)", label: t("Checks fehlgeschlagen") }
    : c === "pending" ? { icon: "clock", color: "var(--orange)", label: t("Checks laufen") } : null;

  function onkeydown(e: KeyboardEvent) {
    if (navKey(e, flat.length, sel, (i) => { sel = i; reveal(list, i); }, () => {})) return;
    if (e.key === "Escape" && filter) { filter = ""; e.preventDefault(); }
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div class="tab" bind:this={list} tabindex="0" {onkeydown} role="listbox" aria-label="Branches">
  <div class="head">
    <h3>Branches</h3>
    <label class="filter">
      <Icon name="search" size={13} />
      <input bind:value={filter} placeholder={t("Branches filtern …")} spellcheck="false" oninput={() => (sel = -1)} />
    </label>
  </div>

  {#if error}<div class="state err">{error}</div>{/if}
  {#if !data && !error}
    <Skeleton kind="list" count={10} />
  {:else if data}
    {#each groups as g, gi}
      {@const offset = gi === 0 ? 0 : groups[0].list.length}
      <div class="section">
        {#if g.remote}
          <button class="sect" onclick={() => (hideRemote = !hideRemote)}>
            <Icon name={hideRemote ? "chevronR" : "chevronD"} size={11} /><span>{g.title}</span>
          </button>
        {:else}<span>{g.title}</span>{/if}
        <span class="count">{q ? `${g.list.length}/${g.total}` : g.total}</span>
      </div>
      {#if !g.list.length && !(g.remote && hideRemote)}<div class="state dim small">{q ? t("Keine Treffer") : "–"}</div>{/if}
      <div class="items">
        {#each g.list as b, j (b.name)}
          {@const i = offset + j}
          {@const ck = checks(b.pr?.checks)}
          <div class="item" data-i={i} class:sel={i === sel} class:current={b.current} title={b.name}>
            <span class="bi" style={b.current ? `color:${git.laneColor(0)}` : ""}><Icon name="branch" size={16} /></span>
            <span class="txt">
              <span class="name">{b.name}{#if b.current}<span class="curtag">{t("aktuell")}</span>{/if}</span>
              <span class="sub">{b.subject} · {git.age(b.at)}</span>
            </span>
            {#if b.ahead || b.behind}
              <span class="ab mono">
                {#if b.ahead}<span class="up" title={t("{n} voraus", { n: b.ahead })}>↑{b.ahead}</span>{/if}
                {#if b.behind}<span class="down" title={t("{n} hinterher", { n: b.behind })}>↓{b.behind}</span>{/if}
              </span>
            {/if}
            {#if b.pr}
              <span class="pr" class:draft={b.pr.draft} title={`${b.pr.state}${b.pr.draft ? " · " + t("Entwurf") : ""}${ck ? " · " + ck.label : ""}`}>
                <Icon name="pr" size={12} />
                <span class="mono">#{b.pr.number}</span>
                {#if b.pr.draft}<span class="dr">{t("Entwurf")}</span>{/if}
                {#if ck}<span class="ck" style="color:{ck.color}"><Icon name={ck.icon} size={12} /></span>{/if}
              </span>
            {/if}
          </div>
        {/each}
      </div>
    {/each}
  {/if}
</div>

<style>
  .tab { outline: none; padding-bottom: 16px; }
  .head { position: sticky; top: 0; z-index: 2; background: var(--bg); padding: 12px 14px 8px; display: flex; align-items: center; gap: 12px; }
  h3 { margin: 0; font-size: 15px; font-weight: 650; }
  .filter { flex: 1; max-width: 320px; margin-left: auto; display: flex; align-items: center; gap: 6px; color: var(--dim); background: var(--raised);
    border: 1px solid var(--border); border-radius: 8px; padding: 0 8px; }
  .filter:focus-within { border-color: var(--accent); }
  .filter input { all: unset; flex: 1; padding: 5px 0; font-size: 12.5px; color: var(--fg); min-width: 0; }
  .section { display: flex; align-items: center; gap: 8px; margin: 14px 14px 4px; font-size: 11px; font-weight: 600; text-transform: uppercase;
    letter-spacing: .05em; color: var(--muted); }
  .sect { all: unset; cursor: pointer; display: inline-flex; align-items: center; gap: 4px; }
  .count { font-family: var(--mono); color: var(--dim); }
  .items { padding: 0 6px; }
  .item { display: flex; align-items: center; gap: 12px; padding: 6px 8px; border-radius: 8px; min-height: 44px; }
  .item:hover { background: color-mix(in srgb, var(--fg) 5%, transparent); }
  .item.sel { background: color-mix(in srgb, var(--accent) 16%, transparent); }
  .tab:not(:focus-within) .item.sel { background: transparent; }
  .bi { color: var(--dim); display: inline-flex; width: 20px; justify-content: center; }
  .txt { flex: 1; min-width: 0; display: flex; flex-direction: column; line-height: 1.35; }
  .name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .current .name { font-weight: 650; }
  .curtag { margin-left: 8px; font-size: 10.5px; font-weight: 600; padding: 1px 6px; border-radius: 99px; vertical-align: 1px;
    color: var(--purple); background: color-mix(in srgb, var(--purple) 15%, transparent); }
  .sub { font-size: 12px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ab { display: inline-flex; gap: 6px; font-size: 12.5px; flex: none; }
  .up { color: var(--green); } .down { color: var(--orange); }
  .pr { flex: none; display: inline-flex; align-items: center; gap: 5px; padding: 3px 9px; border-radius: 99px; font-size: 12px;
    background: color-mix(in srgb, var(--fg) 8%, transparent); color: var(--fg); }
  .pr.draft { color: var(--muted); }
  .dr { font-size: 10.5px; text-transform: uppercase; letter-spacing: .03em; }
  .ck { display: inline-flex; }
  .state { padding: 6px 22px; }
  .small { font-size: 12px; }
</style>
