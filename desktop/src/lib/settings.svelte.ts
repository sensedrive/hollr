// App settings, persisted in the webview's localStorage (per device, like UserDefaults on iOS).
const KEY = "hollr.settings";

export interface Settings {
  /** theme: fixed palette, or dark/light following the system */
  followSystem: boolean;
  theme: string;
  darkTheme: string;
  lightTheme: string;
  /** UI zoom factor (0.7 … 1.6), the desktop "Ansicht skalieren" */
  zoom: number;
  /** "system" | "de" | "en" */
  lang: string;
  /** desktop notifications when an agent waits / finishes / fails */
  notify: boolean;
  /** show plain shells in session lists */
  showShells: boolean;
  /** last build the "Neuigkeiten" were seen for */
  seenNotes: number;
}

const defaults: Settings = {
  followSystem: false,
  theme: "Hollr",
  darkTheme: "Hollr",
  lightTheme: "Catppuccin Latte",
  zoom: 1,
  lang: "system",
  notify: true,
  showShells: false,
  seenNotes: 0,
};

function load(): Settings {
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
  } catch {
    return { ...defaults };
  }
}

export const settings = $state<Settings>(load());

$effect.root(() => {
  $effect(() => {
    const snapshot = JSON.stringify(settings);
    try {
      localStorage.setItem(KEY, snapshot);
    } catch {}
  });
});
