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
