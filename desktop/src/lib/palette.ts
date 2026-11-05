// ⌘K palette filtering (CommandPalette.svelte): every word of the query has to occur in the item's label or its
// sub line ("hollr mac" finds "hollr · main · Mac"), in any order and case. Items whose label holds the whole
// query come first, then those whose label holds the first word – otherwise the given order (urgency) stays.

export interface Matchable {
  label: string;
  sub?: string;
}

export function matchItems<T extends Matchable>(items: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  const words = q.split(/\s+/);
  return items
    .filter((i) => {
      const text = `${i.label} ${i.sub ?? ""}`.toLowerCase();
      return words.every((w) => text.includes(w));
    })
    .map((i, n) => {
      const label = i.label.toLowerCase();
      return { i, n, rank: label.includes(q) ? 0 : label.includes(words[0]!) ? 1 : 2 };
    })
    .sort((a, b) => a.rank - b.rank || a.n - b.n)
    .map((x) => x.i);
}
