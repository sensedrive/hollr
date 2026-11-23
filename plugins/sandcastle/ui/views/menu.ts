/** A small action sheet (long press on a card): bottom sheet on phones, centred box elsewhere. */
import { h } from "../dom";

export interface MenuItem {
  label: string;
  disabled: boolean;
  run: () => unknown;
}

export function showMenu(title: string, items: MenuItem[]): void {
  const close = () => {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
  };
  const overlay = h(
    "div",
    { class: "overlay sheet", onclick: (e: Event) => e.target === overlay && close() },
    h(
      "div",
      { class: "menu", role: "menu" },
      h("div", { class: "menu-title" }, title),
      ...items.map((it) =>
        h(
          "button",
          {
            class: "menu-item",
            role: "menuitem",
            disabled: it.disabled,
            onclick: () => {
              close();
              it.run();
            },
          },
          it.label,
        ),
      ),
      h("button", { class: "menu-item cancel", onclick: close }, "Abbrechen"),
    ),
  );
  document.addEventListener("keydown", onKey);
  document.body.append(overlay);
}
