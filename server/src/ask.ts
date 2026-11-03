/**
 * Answers omp's ask dialog – and Claude Code's dialogs – the way you would at the keyboard.
 *
 * omp's dialog puts the cursor on the recommended option (not the first), its lists don't wrap,
 * a multi-select question toggles with Space, the last row is "Other (type your own)" which
 * opens a text prompt, and several questions (or a multi-select one) end on a Submit tab.
 * The keys are worked out here from the question as the session log has it, so every app
 * only says *what* was picked.
 *
 * Claude numbers its rows: a digit picks an option (and moves on), on a text row it only moves
 * there; a multi-select question toggles with its digits and goes on from its "Next"/"Submit" row
 * below the text row; several questions (or a multi-select one) end on a review tab whose first
 * row submits. Permission, plan and trust dialogs are read from the screen (claudeprompt.ts).
 */
import { claudeLive, paneTimeline, promptAsk } from "./claudelog";
import { type ClaudePrompt, parseClaudePrompt } from "./claudeprompt";
import { type Agent, type Herdr, HerdrError } from "./herdr";
import { type AskQuestion, readTimeline, type TimelineItem } from "./timeline";

/** The answer to one question: picked option indexes and/or an own text. */
export interface AskPick {
  options?: number[];
  text?: string;
}

export type AskStep = { keys: string[] } | { text: string };

/** Key presses (and texts to type) that answer `questions` with `picks` in a freshly opened dialog. */
export function askSteps(questions: AskQuestion[], picks: AskPick[]): AskStep[] {
  if (!questions.length || picks.length !== questions.length)
    throw new HerdrError("bad_answer", "one answer per question");
  const steps: AskStep[] = [];
  const press = (...keys: string[]) => {
    const last = steps.at(-1);
    if (last && "keys" in last) last.keys.push(...keys);
    else steps.push({ keys });
  };
  questions.forEach((q, qi) => {
    const pick = picks[qi] ?? {};
    const count = q.options.length;
    const chosen = [...new Set(pick.options ?? [])].sort((a, b) => a - b);
    if (chosen.some((i) => !Number.isInteger(i) || i < 0 || i >= count))
      throw new HerdrError("bad_answer", "no such option");
    // the prompt is one line: Enter would submit it early
    const text = pick.text?.replace(/\s+/g, " ").trim() || undefined;
    if (!q.multi && chosen.length + (text ? 1 : 0) !== 1)
      throw new HerdrError("bad_answer", "pick exactly one option");
    // the cursor starts on the recommended option: go to the top first (the list stops there)
    press(...Array<string>(count).fill("up"));
    let at = 0;
    const moveTo = (row: number) => {
      press(...Array<string>(row - at).fill("down"));
      at = row;
    };
    if (q.multi) {
      for (const i of chosen) {
        moveTo(i);
        press("space");
      }
    } else if (!text) {
      moveTo(chosen[0] ?? 0);
    }
    if (text) {
      // "Other (type your own)" is the row after the options
      moveTo(count);
      press("enter");
      steps.push({ text });
    } else {
      press("enter");
    }
  });
  // several questions end on the Submit tab; a lone multi-select one goes there after its own text
  if (questions.length > 1 || (questions[0]?.multi && picks[0]?.text?.trim())) press("enter");
  return steps;
}

/** omp's text prompt for an own answer is open ("Custom answer: …"). */
export const customPromptOpen = (screen: string) => /Custom answer/.test(screen);

/** Keys (and texts to type – without Enter) that answer Claude's AskUserQuestion dialog, freshly opened. */
export function claudeAskSteps(questions: AskQuestion[], picks: AskPick[]): AskStep[] {
  if (!questions.length || picks.length !== questions.length)
    throw new HerdrError("bad_answer", "one answer per question");
  const steps: AskStep[] = [];
  questions.forEach((q, qi) => {
    const pick = picks[qi] ?? {};
    const count = q.options.length;
    const chosen = [...new Set(pick.options ?? [])].sort((a, b) => a - b);
    if (chosen.some((i) => !Number.isInteger(i) || i < 0 || i >= count))
      throw new HerdrError("bad_answer", "no such option");
    const text = pick.text?.replace(/\s+/g, " ").trim() || undefined;
    if (!q.multi && chosen.length + (text ? 1 : 0) !== 1)
      throw new HerdrError("bad_answer", "pick exactly one option");
    if (q.multi) {
      // digits toggle and leave the cursor on the first row; the text row is right below the options,
      // "Next"/"Submit" below that. One digit per step: digits sent together arrive as one input ("13")
      for (const i of chosen) steps.push({ keys: [String(i + 1)] });
      if (text) {
        steps.push({ keys: Array<string>(count).fill("down") }, { text }, { keys: ["down", "enter"] });
      } else steps.push({ keys: [...Array<string>(count + 1).fill("down"), "enter"] });
    } else if (text) {
      steps.push({ keys: [String(count + 1)] }, { text }, { keys: ["enter"] });
    } else steps.push({ keys: [String((chosen[0] ?? 0) + 1)] });
  });
  // the review tab: "1. Submit answers"
  if (questions.length > 1 || questions.some((q) => q.multi)) steps.push({ keys: ["1"] });
  return steps;
}

/** Keys that pick `pick` in a dialog Claude shows on its screen (permission, plan, folder trust). */
export function claudePromptSteps(prompt: ClaudePrompt, pick: AskPick): AskStep[] {
  const count = prompt.options.length;
  const chosen = [...new Set(pick.options ?? [])];
  if (chosen.some((i) => !Number.isInteger(i) || i < 0 || i >= count)) throw new HerdrError("bad_answer", "no such option");
  const text = pick.text?.replace(/\s+/g, " ").trim() || undefined;
  if (chosen.length + (text ? 1 : 0) !== 1) throw new HerdrError("bad_answer", "pick exactly one option");
  /** to a row (a digit, else arrows from the cursor); `enter` = pick it */
  const to = (row: number, enter: boolean): string[] => {
    if (prompt.numbered && row < 9) return [String(row + 1)];
    const d = row - prompt.cursor;
    return [...Array<string>(Math.abs(d)).fill(d < 0 ? "up" : "down"), ...(enter ? ["enter"] : [])];
  };
  if (!text) return [{ keys: to(chosen[0] ?? 0, true) }];
  if (prompt.textOption !== undefined) return [{ keys: to(prompt.textOption, false) }, { text }, { keys: ["enter"] }];
  // no row for a text: refuse ("No"), then the text is the next message – what you'd do at the keyboard
  const no = prompt.options.findLastIndex((o) => /^No\b/i.test(o));
  if (prompt.kind !== "permission" || no < 0) throw new HerdrError("bad_answer", "this question takes no own text");
  return [{ keys: to(no, true) }, { text }, { keys: ["enter"] }];
}

type AskItem = Extract<TimelineItem, { k: "ask" }>;

/** What a claude pane waits on: the question or dialog as an ask item, and the dialog as read from the screen. */
async function claudePending(herdr: Herdr, agent: Agent) {
  const screen = await herdr.screen(agent.pane, 40);
  const prompt = parseClaudePrompt(screen);
  if (!prompt) return undefined;
  // the log alone (no second screen read): the dialog is merged in here
  const { timeline } = await paneTimeline(herdr, { ...agent, status: "unknown" }, 60);
  if (prompt.kind !== "question") return { ask: promptAsk(prompt, timeline), prompt };
  const ask = claudeLive(timeline, "blocked", screen).items.findLast((i) => i.k === "ask");
  return ask?.k === "ask" && ask.pending ? { ask, prompt } : undefined;
}

async function ompPending(agent: Agent): Promise<AskItem | undefined> {
  if (agent.kind !== "omp") return undefined;
  const file = agent.sessionFile;
  if (!file) return undefined;
  const tl = await readTimeline(file, 60);
  const ask = tl.items.findLast((i) => i.k === "ask");
  return ask?.k === "ask" && ask.pending ? ask : undefined;
}

/** The question omp (or Claude) is waiting on in `pane`, or undefined. */
export async function pendingAsk(herdr: Herdr, pane: string): Promise<AskItem | undefined> {
  const agent = await herdr.agent(pane);
  return agent.kind === "claude" ? (await claudePending(herdr, agent))?.ask : ompPending(agent);
}

/** Whitespace-free, so a question the screen wrapped still compares equal. */
const flat = (s: string) => s.replace(/\s+/g, "");

async function answerClaude(
  herdr: Herdr,
  agent: Agent,
  req: { id?: string; picks: AskPick[] },
  pause: number,
): Promise<void> {
  const pending = await claudePending(herdr, agent);
  if (!pending) throw new HerdrError("no_question", "claude is not asking anything right now");
  const { ask, prompt } = pending;
  if (req.id && req.id !== ask.id) throw new HerdrError("stale_question", "claude is asking something else by now");
  let steps: AskStep[];
  if (prompt.kind === "question") {
    const questions = ask.questions ?? [ask];
    // half answered in the terminal (another tab or the review is open): the keys would not fit
    if (!flat(prompt.question).includes(flat(questions[0]?.question ?? "")))
      throw new HerdrError("stale_question", "the question is partly answered in the terminal");
    steps = claudeAskSteps(questions, req.picks);
  } else steps = claudePromptSteps(prompt, req.picks[0] ?? {});
  // each step re-renders Claude's dialog (next tab, text row): keys sent before that are lost
  for (const step of steps) {
    if ("keys" in step) await herdr.sendKeys(agent.pane, step.keys);
    else await herdr.typeText(agent.pane, step.text);
    await Bun.sleep(pause);
  }
}

/**
 * Answers the pending question. `id` (the ask call) guards against a stale tap answering a newer
 * question; without it the current one is answered.
 */
export async function answerAsk(
  herdr: Herdr,
  pane: string,
  req: { id?: string; picks: AskPick[] },
  pause = 300,
): Promise<void> {
  const agent = await herdr.agent(pane);
  if (agent.kind === "claude") return answerClaude(herdr, agent, req, pause);
  const ask = await ompPending(agent);
  if (!ask) throw new HerdrError("no_question", "omp is not asking anything right now");
  if (req.id && req.id !== ask.id) throw new HerdrError("stale_question", "omp is asking something else by now");
  const steps = askSteps(ask.questions ?? [ask], req.picks);
  for (const step of steps) {
    if ("keys" in step) {
      await herdr.sendKeys(pane, step.keys);
      continue;
    }
    // the prompt opens a moment after Enter; keys before that are dropped
    await Bun.sleep(pause);
    await herdr.typeText(pane, step.text);
    await herdr.sendKeys(pane, ["enter"]);
    await Bun.sleep(pause);
  }
}

/**
 * A message for an agent that waits on a question: it is the own answer to it (for a Claude
 * permission prompt: "No", then the message). Throws `agent_blocked` again when nothing answerable is open.
 */
export async function answerWithText(herdr: Herdr, pane: string, text: string): Promise<void> {
  const agent = await herdr.agent(pane);
  if (agent.kind === "claude") {
    const pending = await claudePending(herdr, agent);
    if (!pending) throw new HerdrError("agent_blocked", "the agent waits for input in its terminal");
    if (pending.ask.questions)
      throw new HerdrError("several_questions", "claude asks several questions – answer them in the chat");
    try {
      await answerClaude(herdr, agent, { id: pending.ask.id, picks: [{ text }] }, 300);
    } catch (err) {
      // the folder trust check takes no text
      if (err instanceof HerdrError && err.code === "bad_answer")
        throw new HerdrError("agent_blocked", "the agent waits for input in its terminal");
      throw err;
    }
    return;
  }
  const ask = await ompPending(agent);
  if (!ask) throw new HerdrError("agent_blocked", "the agent waits for input in its terminal");
  const screen = await herdr.screen(pane, 30);
  if (customPromptOpen(screen)) {
    // the own-answer prompt is already open (picked in the terminal or by an older app)
    await herdr.typeText(pane, text.replace(/\s+/g, " ").trim());
    await herdr.sendKeys(pane, ["enter"]);
    return;
  }
  if (ask.questions)
    throw new HerdrError("several_questions", "omp asks several questions – answer them in the chat");
  await answerAsk(herdr, pane, { id: ask.id, picks: [{ text }] });
}
