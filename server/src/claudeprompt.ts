/**
 * Reads the dialog Claude Code shows at the bottom of its screen: a permission prompt ("Do you want to
 * proceed? ❯ 1. Yes …"), the plan approval, the folder trust check and AskUserQuestion's tabs. Only
 * AskUserQuestion is in the log – the others exist on the screen alone, so this is how the apps learn
 * that Claude waits and for what. The text is what `herdr agent read --source visible` returns.
 */

export interface ClaudePrompt {
  kind: "permission" | "plan" | "trust" | "question";
  /** the dialog's text above the options (what is asked, the command or diff it is about) */
  question: string;
  options: string[];
  descriptions?: string[];
  /** the row that takes an own text ("Type something", "Tell Claude what to change") */
  textOption?: number;
  /** the rows carry numbers: pressing one picks it (moves to it for a text row) */
  numbered: boolean;
  /** the row the cursor is on */
  cursor: number;
}

const RULE = /^\s*[─━]{12,}\s*$/;
const DASHES = /^\s*[╌┄┈]{8,}\s*$/;
const OPTION = /^\s*(?:❯\s+)?(\d+)\.\s+(.*)$/;
const TEXT_ROW = /^(Type something|Tell Claude what to change|No, and tell Claude)/i;

const indent = (l: string) => l.length - l.trimStart().length;

export function parseClaudePrompt(screen: string): ClaudePrompt | undefined {
  const lines = screen.split("\n").map((l) => l.replace(/\s+$/, ""));
  const c = lines.findLastIndex((l) => /^\s*❯\s+\S/.test(l));
  if (c < 0) return undefined;
  // Claude's own input box ("───", "❯ text", "───") is no dialog: nothing is open then
  if (RULE.test(lines[c - 1] ?? "")) {
    for (let i = c + 1; i < Math.min(lines.length, c + 8) && lines[i]?.trim(); i++)
      if (RULE.test(lines[i] ?? "")) return undefined;
  }
  // the list: the lines around the cursor up to a blank line or a rule
  let start = c;
  while (start > 0 && lines[start - 1]?.trim() && !RULE.test(lines[start - 1] ?? "")) start--;
  let end = c;
  while (end + 1 < lines.length && lines[end + 1]?.trim() && !RULE.test(lines[end + 1] ?? ""))
    end++;

  const options: string[] = [];
  const descriptions: string[] = [];
  let cursor = -1;
  let first = -1;
  const numbered = OPTION.test(lines[c] ?? "");
  if (numbered) {
    for (let i = start; i <= end; i++) {
      const line = lines[i] ?? "";
      const m = line.match(OPTION);
      if (m && Number(m[1]) === options.length + 1) {
        if (first < 0) first = i;
        if (i === c) cursor = options.length;
        options.push(cleanLabel(m[2] ?? ""));
        descriptions.push("");
      } else if (first >= 0 && line.trim()) {
        // a description under its option ("shift+tab to approve with this feedback", AskUserQuestion's text)
        const d = descriptions.length - 1;
        if (d >= 0 && line.trim() !== options[d] && !/^(Submit|Next)$/.test(line.trim()))
          descriptions[d] = [descriptions[d], line.trim()].filter(Boolean).join(" ");
      }
    }
  } else {
    // the trust dialog lists its two choices without numbers
    const col = indent((lines[c] ?? "").replace("❯", " "));
    for (let i = start; i <= end; i++) {
      const line = (lines[i] ?? "").replace("❯", " ");
      if (indent(line) !== col) continue;
      if (first < 0) first = i;
      if (i === c) cursor = options.length;
      options.push(line.trim());
      descriptions.push("");
    }
  }
  if (options.length < 2 || cursor < 0 || first < 0) return undefined;

  // the dialog's text: from its top rule down to the options
  let top = first - 1;
  while (top >= 0 && !RULE.test(lines[top] ?? "")) top--;
  const body = lines
    .slice(top + 1, first)
    .filter((l) => !DASHES.test(l) && !/^\s*Tip:/.test(l))
    .map((l) => l.trim());
  const all = body.join("\n");
  const tabs = body.some((l) => /[☐☒✔]\s+\S/.test(l));
  const kind: ClaudePrompt["kind"] = /trust this folder|one you trust/i.test(
    all + options.join(" "),
  )
    ? "trust"
    : tabs || options.some((o) => /^Type something/i.test(o))
      ? "question"
      : /written up a plan|ready to execute|Ready to code\?/i.test(all)
        ? "plan"
        : "permission";
  let question = body
    .filter((l) => !(kind === "question" && /[☐☒✔]\s+\S/.test(l)))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (kind === "trust") {
    const path = body.find((l) => /^(\/|~)\S*$/.test(l));
    question = `Claude Code möchte im Ordner ${path ?? "hier"} arbeiten (Dateien lesen, ändern, ausführen). Vertraust du ihm?`;
  } else if (kind === "plan") {
    // the plan itself is in the chat already (ExitPlanMode's text): the question is the last paragraph
    question = question.split("\n\n").at(-1) ?? question;
  } else if (kind === "permission") {
    // what is asked and the question only: the change itself is in the chat already (the pending call's card);
    // Claude's preview below it has line numbers and wraps mid-word in the dialog
    const rows = question.split("\n").filter(Boolean);
    const ask = rows.findLast((l) => l.endsWith("?"));
    const preview = rows.findIndex((l) => /^\d+(\s|$)/.test(l));
    const head = (preview >= 0 ? rows.slice(0, preview) : rows).filter((l) => l !== ask).slice(0, 4);
    question = [...head, ...(ask ? ["", ask] : [])].join("\n");
  }
  const textOption = options.findIndex((o) => TEXT_ROW.test(o));
  return {
    kind,
    question: question.slice(0, 1500) || "Claude wartet auf dich",
    options,
    ...(descriptions.some(Boolean) ? { descriptions } : {}),
    ...(textOption >= 0 ? { textOption } : {}),
    numbered,
    cursor,
  };
}

/** "[✔] Käse" → "Käse", "Type something." → "Type something" */
function cleanLabel(label: string): string {
  return label
    .replace(/^\[[ ✔x]\]\s*/, "")
    .replace(/^Type something\.?$/, "Type something")
    .trim();
}
