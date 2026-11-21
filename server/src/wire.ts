/**
 * JSON for the apps. A string cut in the middle of a surrogate pair (a tool output clipped right inside an emoji)
 * would come out as a lone "\ud83d" escape: JavaScript reads that, but Swift's JSONDecoder rejects the whole
 * answer – the iPhone's chat then never loads. Lone surrogates become U+FFFD instead.
 */
const LONE = /\\ud[89a-f][0-9a-f]{2}/i;

export function wireJson(data: unknown): string {
  const text = JSON.stringify(data);
  // the usual case: nothing to repair, no second pass
  if (!LONE.test(text)) return text;
  return JSON.stringify(data, (_key, value) =>
    typeof value === "string" ? value.toWellFormed() : value,
  );
}
