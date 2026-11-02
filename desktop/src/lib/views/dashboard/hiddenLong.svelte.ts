// Long-running turns taken out of "Braucht dich" by hand: pane id → start of the hidden turn.
// The next turn of the same session shows up again (a different start time).
const KEY = "hollr.hiddenLong";
/** forget hidden turns after this – they are long over by then */
const KEEP_MS = 3 * 24 * 3600_000;

function load(): Record<string, number> {
  try {
    const all = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, number>;
    return Object.fromEntries(Object.entries(all).filter(([, at]) => Date.now() - at < KEEP_MS));
  } catch {
    return {};
  }
}

export const hiddenLong = $state<Record<string, number>>(load());

export function hideLong(id: string, turnStartedAt: number) {
  hiddenLong[id] = turnStartedAt;
  try {
    localStorage.setItem(KEY, JSON.stringify(hiddenLong));
  } catch {}
}
