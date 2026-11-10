/** Calls to the plugin's /api with the token Hollr put in the URL fragment. */

const KEY = "sc.token";
let token = "";

/** Takes the token from `#token=…` (then drops the fragment, so it isn't copied or shown) or the session. */
export function initToken(): void {
  const m = location.hash.match(/token=([0-9a-f]+)/);
  if (m?.[1]) {
    sessionStorage.setItem(KEY, m[1]);
    history.replaceState(null, "", location.pathname + location.search);
  }
  token = sessionStorage.getItem(KEY) ?? "";
}

function expired(): void {
  const el = document.createElement("div");
  el.className = "expired";
  el.textContent = "Sitzung abgelaufen – in Hollr neu öffnen";
  document.body.replaceChildren(el);
}

export async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) {
    expired();
    throw new Error("Sitzung abgelaufen");
  }
  const data: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = data && typeof data === "object" && "error" in data ? String(data.error) : `HTTP ${res.status}`;
    throw new Error(error);
  }
  return data as T;
}

/** Public links: Hollr Desktop opens them (postMessage from its iframe), iOS catches window.open. */
export function openExternal(url: string): void {
  if (!/^https?:\/\//i.test(url)) return;
  if (window.parent !== window) window.parent.postMessage({ type: "hollr-open-url", url }, "*");
  else window.open(url, "_blank");
}
