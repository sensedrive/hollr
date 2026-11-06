import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseFooter } from "../src/spaces";
import { parseMcpLine, parseStartScreen } from "../src/startscreen";

const fixture = (...path: string[]) => readFileSync(join(import.meta.dir, "fixtures", ...path), "utf8");

describe("start screen", () => {
  test("a fresh omp session: version, tip over two lines, update, no MCP line", () => {
    // captured with `herdr agent read <pane> --source visible --lines 80` right after omp started
    expect(parseStartScreen("omp", fixture("omp-screens", "fresh.txt"))).toEqual({
      version: "18.16.0",
      tip: "Start your prompt with `!` to run it as bash — `!!` runs it without adding the output to context",
      update: "18.17.0",
    });
  });

  test("omp's MCP lines: the final status wins over 'Still connecting'", () => {
    const start = parseStartScreen("omp", fixture("omp-screens", "fresh-mcp.txt"));
    expect(start?.tip).toBe("Try starting your prompt with a ->, and writing a list (1. Do X, 2. Do Y)");
    expect(start?.mcp).toEqual({
      connected: ["shadcn", "mcp-atlassian", "storybook"],
      failed: [
        {
          name: "context-mode",
          config: "~/PhpstormProjects/leicht+luftig/tackline/tendr/.codex/config.toml",
          error: "ENOENT: no such file or directory, posix_spawn '~/PhpstormProjects/leicht+lufti…",
        },
      ],
      pending: [],
    });
  });

  test("every MCP status format omp prints", () => {
    expect(parseMcpLine("Connecting to MCP servers: a, b…")).toEqual({ connected: [], failed: [], pending: ["a", "b"] });
    expect(parseMcpLine("Connected to MCP server: shadcn.")).toEqual({ connected: ["shadcn"], failed: [], pending: [] });
    expect(parseMcpLine("MCP servers failed to connect: x: boom; y [config: ~/c.json]: nope")).toEqual({
      connected: [],
      failed: [{ name: "x", error: "boom" }, { name: "y", config: "~/c.json", error: "nope" }],
      pending: [],
    });
    expect(parseMcpLine("Connected: a. Failed: x: boom. Still connecting: c, d…")).toEqual({
      connected: ["a"],
      failed: [{ name: "x", error: "boom" }],
      pending: ["c", "d"],
    });
    expect(parseMcpLine("Connected: a, b. Still connecting: c…")).toEqual({ connected: ["a", "b"], failed: [], pending: ["c"] });
    // cut off by the terminal width before "Still connecting"
    expect(parseMcpLine("Failed: x [config: ~/very/long/pa…")).toEqual({
      connected: [],
      failed: [{ name: "x", config: "~/very/long/pa…" }],
      pending: [],
    });
    expect(parseMcpLine("❯ hello")).toBeUndefined();
    expect(parseMcpLine("Still connecting: c…")).toBeUndefined();
  });

  test("Claude Code's banner: version, model, plan; effort and a failed MCP server from its footer", () => {
    const banner = fixture("claude", "screens", "permission-bash.txt");
    expect(parseStartScreen("claude", banner)).toEqual({ version: "2.1.317", model: "Opus 5.5", plan: "Claude Max" });
    expect(parseStartScreen("claude", `${banner}\n  ◐ medium · /effort\n  1 MCP server failed · /mcp`)).toEqual({
      version: "2.1.317",
      model: "Opus 5.5",
      plan: "Claude Max",
      effort: "medium",
      mcp: { connected: [], failed: [], pending: [], failedCount: 1 },
    });
  });

  test("nothing of a start screen → undefined", () => {
    expect(parseStartScreen("omp", "❯ \n π · Opus 5.5 · x")).toBeUndefined();
    expect(parseStartScreen("codex", fixture("omp-screens", "fresh.txt"))).toBeUndefined();
  });
});

describe("footer thinking level", () => {
  test("the glyph before the model, in every symbol preset", () => {
    expect(parseFooter(fixture("omp-screens", "fresh.txt"))).toMatchObject({ model: "Opus 5.5", thinking: "high", context: "1.4%/1M" });
    expect(parseFooter(" π · \u{F0AA1} Sonnet 4.5 · x · 2%/200K").thinking).toBe("medium");
    expect(parseFooter(" pi · [xhi] Opus 5.5 · x").thinking).toBe("xhigh");
    expect(parseFooter(" π · ○ Opus 5.5 · x").thinking).toBe("minimal");
    // no glyph (thinking off) → none
    expect(parseFooter(" π · Opus 5.5 · x").thinking).toBeUndefined();
  });
});
