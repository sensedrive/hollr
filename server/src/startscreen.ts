/**
 * What an agent's start screen says before the first prompt – only on the terminal, not in its session log:
 * omp's logo with its version, a tip, the MCP connection line and an update notice; Claude Code's banner with
 * version, model and plan. The app shows it as the start of a fresh session instead of an empty chat.
 */

export interface McpFailure {
  name: string;
  /** the error as far as the terminal shows it (omp truncates long lines with "…") */
  error?: string;
  /** config file the server came from */
  config?: string;
}

export interface McpStatus {
  connected: string[];
  failed: McpFailure[];
  /** still connecting */
  pending: string[];
  /** Claude only reports a count ("1 MCP server failed · /mcp") */
  failedCount?: number;
}

export interface StartInfo {
  version?: string;
  /** Claude: model from its banner (its log has none before the first answer) */
  model?: string;
  /** Claude: the subscription from its banner, e.g. "Claude Max" */
  plan?: string;
  /** Claude: effort level from its prompt footer ("◐ medium · /effort") */
  effort?: string;
  tip?: string;
  /** newer version the agent announced ("New version 18.17.0 is available") */
  update?: string;
  mcp?: McpStatus;
}

const names = (list: string) =>
  list
    .replace(/[….]+$/, "")
    .split(",")
    .map((n) => n.trim())
    .filter(Boolean);

/** "context-mode [config: ~/x/config.toml]: ENOENT …" (omp's startup-events format) */
function failure(entry: string): McpFailure {
  const m = entry.trim().match(/^(.*?)(?: \[config: ([^\]]*)\]?)?(?:: (.*))?$/);
  const out: McpFailure = { name: (m?.[1] ?? entry).trim() };
  if (m?.[2]) out.config = m[2].trim();
  if (m?.[3]) out.error = m[3].trim();
  return out;
}

const failures = (list: string) =>
  list
    .replace(/\.$/, "")
    .split("; ")
    .filter((e) => e.trim())
    .map(failure);

/** One of omp's MCP status lines (its text formats in mcp/startup-events.ts), or undefined. */
export function parseMcpLine(line: string): McpStatus | undefined {
  const text = line.trim();
  const empty = (): McpStatus => ({ connected: [], failed: [], pending: [] });
  let m = text.match(/^Connecting to MCP servers?: (.+)$/);
  if (m) return { ...empty(), pending: names(m[1] ?? "") };
  m = text.match(/^Connected to MCP servers?: (.+)$/);
  if (m) return { ...empty(), connected: names(m[1] ?? "") };
  m = text.match(/^MCP servers? failed to connect: (.+)$/);
  if (m) return { ...empty(), failed: failures(m[1] ?? "") };
  m = text.match(/^MCP finished with failures\. Connected: (.*?)\. Failed: (.+)$/);
  if (m) return { ...empty(), connected: names(m[1] ?? ""), failed: failures(m[2] ?? "") };
  // still connecting, some done: "Connected: a, b. Failed: x: err. Still connecting: c…" (each part optional)
  m = text.match(/^(?:Connected: (.*?)\.\s*)?(?:Failed: (.*?)\s*)?Still connecting: (.+)$/);
  if (m && (m[1] || m[2])) {
    return { connected: names(m[1] ?? ""), failed: failures(m[2] ?? ""), pending: names(m[3] ?? "") };
  }
  // the line cut off before "Still connecting"
  m = text.match(/^Connected: (.*?)\.\s*Failed: (.+)$/) ?? text.match(/^()Failed: (.+)$/);
  if (m) return { ...empty(), connected: names(m[1] ?? ""), failed: failures(m[2] ?? "") };
  return undefined;
}

function parseOmp(lines: string[]): StartInfo {
  const out: StartInfo = {};
  for (const [i, line] of lines.entries()) {
    const version = line.match(/(?:^|\s)v(\d+\.\d+\.\d+[\w.+-]*)\s*$/);
    if (version && !out.version) out.version = version[1];
    const tip = line.match(/^\s*Tip:\s*(.*)$/);
    if (tip) {
      // centred and wrapped over several lines, up to the next empty one
      const parts = [tip[1] ?? ""];
      for (const next of lines.slice(i + 1)) {
        if (!next.trim()) break;
        parts.push(next.trim());
      }
      out.tip = parts.join(" ").replace(/\s+/g, " ").trim();
    }
    const update = line.match(/New version (\S+?)\.? is available/);
    if (update) out.update = update[1];
    // the newest status wins (omp prints "Still connecting" first, then the final line)
    const mcp = parseMcpLine(line);
    if (mcp) out.mcp = mcp;
  }
  return out;
}

function parseClaude(lines: string[]): StartInfo {
  const out: StartInfo = {};
  for (const [i, line] of lines.entries()) {
    const version = line.match(/Claude Code v(\d+\.\d+\.\d+[\w.+-]*)/);
    if (version && !out.version) {
      out.version = version[1];
      // the banner's next line: "Opus 5.5 · Claude Max" behind the logo blocks
      const info = (lines[i + 1] ?? "").replace(/^[^A-Za-z]*/, "").trim();
      const [model, ...plan] = info.split(" · ");
      if (model) out.model = model.trim();
      if (plan.length) out.plan = plan.join(" · ").trim();
    }
    const effort = line.match(/(low|medium|high|xhigh|max)\s*·\s*\/effort/);
    if (effort) out.effort = effort[1];
    const mcp = line.match(/(\d+) MCP servers? failed/);
    if (mcp) out.mcp = { connected: [], failed: [], pending: [], failedCount: Number(mcp[1]) };
  }
  return out;
}

/** The start screen of a fresh session; undefined when it shows nothing of it (e.g. already scrolled away). */
export function parseStartScreen(kind: string, screen: string): StartInfo | undefined {
  const lines = screen.split("\n");
  const info = kind === "claude" ? parseClaude(lines) : kind === "omp" ? parseOmp(lines) : {};
  return Object.keys(info).length ? info : undefined;
}
