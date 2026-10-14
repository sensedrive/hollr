// Color themes – the same palettes as the iPhone/Mac app (Settings → Design).
export interface Palette {
  name: string;
  dark: boolean;
  bg: string; surface: string; raised: string; fg: string; muted: string; dim: string; border: string; accent: string;
  red: string; green: string; yellow: string; orange: string; purple: string; cyan: string; pink: string; blue: string;
}

const p = (name: string, dark: boolean, c: string): Palette => {
  const [bg, surface, raised, fg, muted, dim, border, accent, red, green, yellow, orange, purple, cyan, pink, blue] =
    c.split(" ").map((h) => `#${h}`);
  return { name, dark, bg, surface, raised, fg, muted, dim, border, accent, red, green, yellow, orange, purple, cyan, pink, blue } as Palette;
};

export const DARK: Palette[] = [
  p("Hollr", true, "000000 1C1C1E 161616 FFFFFF 777D88 5F6673 3D424A 7C9CFF FC3A4B 2EB57A E4C00F FEBC38 9A63FF 5ED3C1 F286C4 5AA9F0"),
  p("Moshi", true, "1E1F26 2A2B33 24252C E6E6EA 9A9BA5 6C6E78 3A3B44 A98BF5 E5737F 6CCB8C E3C46B E39A4C B48CF2 5ED3C1 E05CA8 7FA3F5"),
  p("Dracula", true, "282A36 343746 2F3240 F8F8F2 A0A4C0 6272A4 44475A BD93F9 FF5555 50FA7B F1FA8C FFB86C BD93F9 8BE9FD FF79C6 8BE9FD"),
  p("Nord", true, "2E3440 3B4252 353C4A ECEFF4 A3ABBA 6B7385 4C566A 88C0D0 BF616A A3BE8C EBCB8B D08770 B48EAD 8FBCBB B48EAD 81A1C1"),
  p("Solarized Dark", true, "002B36 073642 04313C EEE8D5 93A1A1 657B83 0E4A57 268BD2 DC322F 859900 B58900 CB4B16 6C71C4 2AA198 D33682 268BD2"),
  p("Gruvbox", true, "282828 3C3836 32302F EBDBB2 A89984 7C6F64 504945 83A598 FB4934 B8BB26 FABD2F FE8019 D3869B 8EC07C D3869B 83A598"),
  p("Catppuccin Mocha", true, "1E1E2E 313244 181825 CDD6F4 A6ADC8 6C7086 45475A CBA6F7 F38BA8 A6E3A1 F9E2AF FAB387 CBA6F7 94E2D5 F5C2E7 89B4FA"),
];
export const LIGHT: Palette[] = [
  p("Solarized Light", false, "FDF6E3 EEE8D5 F5EFDC 073642 586E75 93A1A1 D9D2BF 268BD2 DC322F 859900 B58900 CB4B16 6C71C4 2AA198 D33682 268BD2"),
  p("Catppuccin Latte", false, "EFF1F5 E6E9EF DCE0E8 4C4F69 6C6F85 9CA0B0 CCD0DA 8839EF D20F39 40A02B DF8E1D FE640B 8839EF 179299 EA76CB 1E66F5"),
  p("GitHub Light", false, "FFFFFF F6F8FA F0F2F5 1F2328 59636E 8C959F D0D7DE 0969DA CF222E 1A7F37 9A6700 BC4C00 8250DF 1B7C83 BF3989 0969DA"),
];
export const ALL = [...DARK, ...LIGHT];
export const named = (name: string) => ALL.find((x) => x.name === name);

/** Five preview dots like in the picker: background, text, red, green, blue. */
export const preview = (x: Palette) => [x.bg, x.fg, x.red, x.green, x.blue];

/** Writes the palette into the CSS variables used everywhere (app.css). */
export function apply(x: Palette) {
  const s = document.documentElement.style;
  const set = (k: string, v: string) => s.setProperty(`--${k}`, v);
  set("bg", x.bg);
  set("side", x.dark ? mix(x.bg, x.surface, 0.5) : x.surface);
  set("card", x.surface);
  set("raised", x.raised);
  set("fg", x.fg);
  set("muted", x.muted);
  set("dim", x.dim);
  set("border", x.border);
  set("accent", x.accent);
  for (const k of ["red", "green", "yellow", "orange", "purple", "cyan", "pink", "blue"] as const) set(k, x[k]);
  s.colorScheme = x.dark ? "dark" : "light";
  document.documentElement.dataset.theme = x.dark ? "dark" : "light";
}

function mix(a: string, b: string, t: number): string {
  const n = (h: string, i: number) => Number.parseInt(h.slice(1 + i * 2, 3 + i * 2), 16);
  return `#${[0, 1, 2].map((i) => Math.round(n(a, i) * (1 - t) + n(b, i) * t).toString(16).padStart(2, "0")).join("")}`;
}
