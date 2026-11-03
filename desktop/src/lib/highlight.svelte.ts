// Syntax highlighting for code blocks in agent answers (Markdown.svelte). highlight.js's core and each
// language load on first use only, as their own chunks – a chat without code blocks costs nothing.
import type { HLJSApi, LanguageFn } from "highlight.js";

type Loader = () => Promise<{ default: LanguageFn }>;

// explicit imports so the bundler can split them (it can't follow a computed module name)
const LOADERS: Record<string, Loader> = {
  bash: () => import("highlight.js/lib/languages/bash"),
  c: () => import("highlight.js/lib/languages/c"),
  cpp: () => import("highlight.js/lib/languages/cpp"),
  csharp: () => import("highlight.js/lib/languages/csharp"),
  css: () => import("highlight.js/lib/languages/css"),
  diff: () => import("highlight.js/lib/languages/diff"),
  dockerfile: () => import("highlight.js/lib/languages/dockerfile"),
  go: () => import("highlight.js/lib/languages/go"),
  ini: () => import("highlight.js/lib/languages/ini"),
  java: () => import("highlight.js/lib/languages/java"),
  javascript: () => import("highlight.js/lib/languages/javascript"),
  json: () => import("highlight.js/lib/languages/json"),
  kotlin: () => import("highlight.js/lib/languages/kotlin"),
  lua: () => import("highlight.js/lib/languages/lua"),
  makefile: () => import("highlight.js/lib/languages/makefile"),
  markdown: () => import("highlight.js/lib/languages/markdown"),
  php: () => import("highlight.js/lib/languages/php"),
  python: () => import("highlight.js/lib/languages/python"),
  ruby: () => import("highlight.js/lib/languages/ruby"),
  rust: () => import("highlight.js/lib/languages/rust"),
  scss: () => import("highlight.js/lib/languages/scss"),
  sql: () => import("highlight.js/lib/languages/sql"),
  swift: () => import("highlight.js/lib/languages/swift"),
  typescript: () => import("highlight.js/lib/languages/typescript"),
  xml: () => import("highlight.js/lib/languages/xml"),
  yaml: () => import("highlight.js/lib/languages/yaml"),
};

const ALIAS: Record<string, string> = {
  sh: "bash", zsh: "bash", shell: "bash", console: "bash", shellsession: "bash",
  "c++": "cpp", cc: "cpp", h: "c", hpp: "cpp", cs: "csharp",
  patch: "diff", docker: "dockerfile", golang: "go", toml: "ini", conf: "ini",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  ts: "typescript", tsx: "typescript", mts: "typescript",
  jsonc: "json", json5: "json", kt: "kotlin", make: "makefile", md: "markdown",
  py: "python", python3: "python", rb: "ruby", rs: "rust",
  html: "xml", svelte: "xml", vue: "xml", svg: "xml", plist: "xml", yml: "yaml",
};

/** The supported language of a fence's info string ("ts", "python title=x" …), undefined = plain. */
export function langOf(info?: string): string | undefined {
  const l = info?.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  const name = ALIAS[l] ?? l;
  return name in LOADERS ? name : undefined;
}

let hljs: HLJSApi | undefined;
let core: Promise<HLJSApi> | undefined;
const loading = new Map<string, Promise<void>>();

/** Bumped whenever a language arrives – renderers read it to highlight again. */
export const highlighter = $state({ version: 0 });

function load(lang: string): void {
  if (loading.has(lang)) return;
  core ??= import("highlight.js/lib/core").then((m) => (hljs = m.default));
  const loader = LOADERS[lang];
  if (!loader) return;
  loading.set(
    lang,
    Promise.all([core, loader()])
      .then(([h, m]) => {
        h.registerLanguage(lang, m.default);
        highlighter.version++;
      })
      // offline / chunk missing: the block stays plain
      .catch(() => {}),
  );
}

/** Highlighted HTML of `code`, or undefined while its language is still loading (then it is fetched). */
export function highlight(code: string, lang: string): string | undefined {
  if (!hljs?.getLanguage(lang)) {
    load(lang);
    return undefined;
  }
  return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
}
