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
