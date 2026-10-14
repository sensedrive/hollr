<script lang="ts">
  // One history graph row (GraphCell on iOS): pass-through lanes, S-curves into/out of the node, the commit dot.
  import { laneColor, type GraphRow } from "../../git";

  let { row, width, height = 34, selected = false }: { row: GraphRow; width: number; height?: number; selected?: boolean } = $props();

  const L = 14;
  const X0 = 11;
  const x = (i: number) => X0 + i * L;
  const mid = $derived(height / 2);

  function curve(x1: number, y1: number, x2: number, y2: number) {
    if (x1 === x2) return `M${x1},${y1} L${x2},${y2}`;
    const my = (y1 + y2) / 2;
    return `M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}`;
  }

  /** every segment of this row: [path, lane color index] */
  const segments = $derived.by(() => {
    const out: [string, number][] = [];
    row.before.forEach((h, i) => {
      if (!h) return;
      if (h === row.commit.hash) out.push([curve(x(i), 0, x(row.node), mid), i]);
      else {
        const k = row.after[i] === h ? i : row.after.indexOf(h);
        if (k !== -1) out.push([curve(x(i), 0, x(k), height), k]);
      }
    });
    for (const k of row.outgoing) out.push([curve(x(row.node), mid, x(k), height), k]);
    return out;
  });
  const merge = $derived(row.commit.parents.length > 1);
</script>

<svg width={X0 + Math.max(width, 1) * L - 3} {height} class="g" aria-hidden="true">
  {#each segments as [d, c]}<path {d} stroke={laneColor(c)} stroke-width="2" fill="none" stroke-linecap="round" />{/each}
  {#if selected}<circle cx={x(row.node)} cy={mid} r="8.5" fill="none" stroke={laneColor(row.node)} stroke-opacity=".45" stroke-width="2" />{/if}
  {#if merge}
    <circle cx={x(row.node)} cy={mid} r="4.5" fill="var(--bg)" stroke={laneColor(row.node)} stroke-width="2.2" />
  {:else}
    <circle cx={x(row.node)} cy={mid} r="5" fill={laneColor(row.node)} />
  {/if}
</svg>

<style>
  .g { flex: none; display: block; overflow: hidden; }
</style>
