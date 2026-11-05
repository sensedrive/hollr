// Tab order kept in Hollr (herdr has no "tab move"): the saved ids merged with what exists now – new ones at
// the end, vanished ones dropped.

/** `items` in the saved order; ones not saved yet follow in their own order. */
export function ordered<T>(items: readonly T[], saved: readonly string[] | undefined, id: (item: T) => string): T[] {
  if (!saved?.length) return [...items];
  const rank = new Map(saved.map((s, i) => [s, i]));
  const known = items.filter((x) => rank.has(id(x))).sort((a, b) => rank.get(id(a))! - rank.get(id(b))!);
  return [...known, ...items.filter((x) => !rank.has(id(x)))];
}

/** `ids` with `id` moved in front of `before` (to the end for null). */
export function moveBefore(ids: readonly string[], id: string, before: string | null): string[] {
  if (id === before) return [...ids];
  const rest = ids.filter((x) => x !== id);
  const at = before === null ? -1 : rest.indexOf(before);
  if (at < 0) return [...rest, id];
  return [...rest.slice(0, at), id, ...rest.slice(at)];
}

/** Side conversations right behind the tab of the session they talk about (`parent`: that tab's id), whatever
 *  order the tabs have otherwise – so a fork tab hangs off its own session, not off whichever came before it. */
export function forksAfterParents<T>(items: readonly T[], id: (item: T) => string, parent: (item: T) => string | undefined): T[] {
  const ids = new Set(items.map(id));
  const forks = new Map<string, T[]>();
  const roots: T[] = [];
  for (const x of items) {
    const p = parent(x);
    if (p !== undefined && p !== id(x) && ids.has(p)) forks.set(p, [...(forks.get(p) ?? []), x]);
    else roots.push(x);
  }
  const out: T[] = [];
  const seen = new Set<string>();
  const add = (x: T) => {
    if (seen.has(id(x))) return;
    seen.add(id(x));
    out.push(x);
    for (const f of forks.get(id(x)) ?? []) add(f);
  };
  roots.forEach(add);
  // a cycle of parents (not expected from the server): those keep their place at the end
  items.forEach(add);
  return out;
}
