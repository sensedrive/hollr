/** A tiny element builder: text always goes in as text, never as HTML. */
type Child = Node | string | number | false | null | undefined;
type Attrs = Record<string, string | number | boolean | EventListener | undefined | null>;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (typeof v === "function") el.addEventListener(k.replace(/^on/, ""), v);
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, String(v));
  }
  for (const c of children) if (c !== false && c !== null && c !== undefined) el.append(c instanceof Node ? c : String(c));
  return el;
}

/** Replaces an element's children. */
export const fill = (el: Element, ...children: Child[]) => {
  el.replaceChildren(...children.filter((c): c is Node | string | number => c !== false && c !== null && c !== undefined).map((c) => (c instanceof Node ? c : String(c))));
};

/** Server-rendered, sanitised HTML (src/body.ts renderMarkdown) into a fresh element. */
export function html(className: string, markup: string): HTMLDivElement {
  const el = h("div", { class: className });
  el.innerHTML = markup;
  return el;
}

export const fmtDate = (iso?: string) =>
  iso ? new Date(iso).toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" }) : "";

/**
 * Makes `parent`'s children exactly `nodes`, moving only what is out of place – reused nodes keep focus, open
 * <details> and scroll position, which a full replaceChildren on every poll would reset.
 */
export function reconcile(parent: Element, nodes: Node[]): void {
  let cur = parent.firstChild;
  for (const n of nodes) {
    if (n === cur) cur = cur.nextSibling;
    else parent.insertBefore(n, cur);
  }
  while (cur) {
    const next = cur.nextSibling;
    cur.remove();
    cur = next;
  }
}

/** Copies text; the async clipboard API is missing in some embedded webviews, then a selected field + execCommand. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = h("textarea", { readonly: true, style: "position:fixed;opacity:0;top:0" });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}
