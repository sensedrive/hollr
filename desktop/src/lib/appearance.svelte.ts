// Theme (a fixed palette or following the system) and the app zoom ("Ansicht skalieren").
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { settings } from "./settings.svelte";
import * as theme from "./theme";

/** Call during a window's root component setup. */
export function appearance() {
  const mq = matchMedia("(prefers-color-scheme: dark)");
  let systemDark = $state(mq.matches);
  $effect(() => {
    const onScheme = () => (systemDark = mq.matches);
    mq.addEventListener("change", onScheme);
    return () => mq.removeEventListener("change", onScheme);
  });
  $effect(() => {
    const name = settings.followSystem ? (systemDark ? settings.darkTheme : settings.lightTheme) : settings.theme;
    theme.apply(theme.named(name) ?? theme.DARK[0]!);
  });
  $effect(() => {
    const z = settings.zoom;
    getCurrentWebview().setZoom(z).catch(() => {});
  });
}
