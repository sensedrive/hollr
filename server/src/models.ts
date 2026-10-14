/**
 * Models per agent kind (for "new session" and the in-session model switch).
 *   omp    → `omp models --json` (only providers you are logged in to), thinking levels
 *   claude → aliases + full ids, effort levels
 *   codex  → `codex debug models` (visible models), reasoning efforts
 * Cached for 10 minutes; listing omp's catalog takes a few seconds.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export interface ModelOption {
  id: string;
  name: string;
  group: string;
  context?: number;
}

export interface ModelList {
  kind: string;
  models: ModelOption[];
  /** thinking / effort levels the agent accepts */
  levels: string[];
  /** level label: "Thinking" (omp) or "Effort" (claude, codex) */
  levelName: string;
  /** whether the model can be switched inside a running session */
  canSwitch: boolean;
}

const bin = (name: string) => {
  for (const dir of [
    join(homedir(), ".local", "bin"),
    join(homedir(), ".bun", "bin"),
    "/usr/local/bin",
    "/usr/bin",
  ]) {
    if (existsSync(join(dir, name))) return join(dir, name);
  }
  return name;
};

const PROVIDER_ORDER = [
  "anthropic",
  "openai-codex",
  "openai",
  "google",
  "cursor",
  "ollama-cloud",
  "ollama",
];

function ompModels(): ModelList {
  const res = Bun.spawnSync([bin("omp"), "models", "--json"], {
    stdout: "pipe",
    stderr: "ignore",
    timeout: 40_000,
  });
  let models: ModelOption[] = [];
  try {
    const data = JSON.parse(res.stdout.toString()) as {
      models: Array<{
        provider: string;
        kind: string;
        selector: string;
        name: string;
        contextWindow?: number;
      }>;
    };
    models = data.models
      .filter((m) => m.kind === "chat")
      .map((m) => ({ id: m.selector, name: m.name, group: m.provider, context: m.contextWindow }));
  } catch {}
  const rank = (g: string) => PROVIDER_ORDER.indexOf(g) + 1 || 99;
  // newest version first, then the bigger model (Opus, Sonnet, Haiku …), dated snapshots last
  const version = (name: string) => (name.match(/\d+(\.\d+)?/)?.[0] ?? "0").split(".").map(Number);
  const family = (name: string) => {
    const i = ["opus", "sonnet", "haiku", "fable"].findIndex((f) => name.toLowerCase().includes(f));
    return i === -1 ? 9 : i;
  };
  models.sort((a, b) => {
    const byProvider = rank(a.group) - rank(b.group) || a.group.localeCompare(b.group);
    if (byProvider) return byProvider;
    const [a1 = 0, a2 = 0] = version(a.name);
    const [b1 = 0, b2 = 0] = version(b.name);
    return (
      b1 - a1 ||
      b2 - a2 ||
      family(a.name) - family(b.name) ||
      a.id.length - b.id.length ||
      a.name.localeCompare(b.name)
    );
  });
  return {
    kind: "omp",
    models,
    levels: ["auto", "off", "minimal", "low", "medium", "high", "xhigh", "max"],
    levelName: "Thinking",
    canSwitch: true,
  };
}

function claudeModels(): ModelList {
  const models: ModelOption[] = [
    { id: "opus", name: "Opus (neuestes)", group: "Aliase" },
    { id: "sonnet", name: "Sonnet (neuestes)", group: "Aliase" },
    { id: "haiku", name: "Haiku (neuestes)", group: "Aliase" },
    { id: "fable", name: "Fable (neuestes)", group: "Aliase" },
    { id: "opusplan", name: "Opus planen, Sonnet ausführen", group: "Aliase" },
    { id: "claude-opus-5-5", name: "Claude Opus 5.5", group: "Modelle" },
    { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", group: "Modelle" },
    { id: "claude-haiku-5-5", name: "Claude Haiku 5.5", group: "Modelle" },
    { id: "claude-fable-5-1", name: "Claude Fable 5.1", group: "Modelle" },
  ];
  return {
    kind: "claude",
    models,
    levels: ["low", "medium", "high", "xhigh", "max"],
    levelName: "Effort",
    canSwitch: true,
  };
}

function codexModels(): ModelList {
  const res = Bun.spawnSync([bin("codex"), "debug", "models"], {
    stdout: "pipe",
    stderr: "ignore",
    timeout: 20_000,
  });
  const text = res.stdout.toString();
  let models: ModelOption[] = [];
  const levels = new Set<string>();
  try {
    const start = text.indexOf("{");
    const data = JSON.parse(text.slice(start)) as {
      models?: Array<{
        slug: string;
        display_name?: string;
        visibility?: string;
        supported_reasoning_levels?: Array<{ effort: string }>;
      }>;
    };
    for (const m of data.models ?? []) {
      if (m.visibility && m.visibility !== "list") continue;
      models.push({ id: m.slug, name: m.display_name ?? m.slug, group: "ChatGPT" });
      for (const l of m.supported_reasoning_levels ?? []) levels.add(l.effort);
    }
  } catch {
    models = [];
  }
  return {
    kind: "codex",
    models,
    levels: levels.size ? [...levels] : ["low", "medium", "high", "xhigh"],
    levelName: "Effort",
    // codex only offers an interactive picker for /model
    canSwitch: false,
  };
}

export function listModels(kind: string, refresh = false): ModelList {
  const dir = join(tmpdir(), "hollr-models");
  const file = join(dir, `${kind}.json`);
  if (!refresh) {
    try {
      const cached = JSON.parse(readFileSync(file, "utf8")) as { at: number; list: ModelList };
      if (Date.now() - cached.at < 600_000 && cached.list.models.length) return cached.list;
    } catch {}
  }
  const list =
    kind === "omp"
      ? ompModels()
      : kind === "claude"
        ? claudeModels()
        : kind === "codex"
          ? codexModels()
          : undefined;
  if (!list) throw new Error(`Keine Modelle für ${kind}`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify({ at: Date.now(), list }));
  } catch {}
  return list;
}

const SAFE = /^[\w./:@+-]{1,120}$/;

/** CLI args to start an agent with a model / level. */
export function startArgs(kind: string, model?: string, level?: string): string[] {
  const args: string[] = [];
  if (model && !SAFE.test(model)) throw new Error("ungültiges Modell");
  if (level && !/^[a-z]{2,10}$/.test(level)) throw new Error("ungültige Stufe");
  if (kind === "omp") {
    if (model) args.push(`--model=${model}`);
    if (level) args.push(`--thinking=${level}`);
  } else if (kind === "claude") {
    if (model) args.push("--model", model);
    if (level) args.push("--effort", level);
  } else if (kind === "codex") {
    if (model) args.push("-m", model);
    if (level) args.push("-c", `model_reasoning_effort="${level}"`);
  }
  return args;
}

/** Slash command that switches the model in a running session. */
export function switchCommand(kind: string, model: string, level?: string): string {
  if (!SAFE.test(model)) throw new Error("ungültiges Modell");
  if (level && !/^[a-z]{2,10}$/.test(level)) throw new Error("ungültige Stufe");
  // session-only (/model would open omp's role hub and could persist)
  if (kind === "omp") return `/switch ${model}${level ? `:${level}` : ""}`;
  if (kind === "claude") return `/model ${model}`;
  throw new Error("Bei Codex geht der Wechsel nur über die Auswahl im Terminal (/model)");
}
