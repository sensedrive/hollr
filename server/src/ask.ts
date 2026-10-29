/**
 * Answers omp's ask dialog the way you would at the keyboard.
 *
 * The dialog puts the cursor on the recommended option (not the first), its lists don't wrap,
 * a multi-select question toggles with Space, the last row is "Other (type your own)" which
 * opens a text prompt, and several questions (or a multi-select one) end on a Submit tab.
 * The keys are worked out here from the question as the session log has it, so every app
 * only says *what* was picked.
 */
import { findSessionFile } from "./sessionlog";
import { type Herdr, HerdrError } from "./herdr";
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

/** The question omp is waiting on in `pane`, or undefined. */
export async function pendingAsk(
  herdr: Herdr,
  pane: string,
): Promise<Extract<TimelineItem, { k: "ask" }> | undefined> {
  const agent = await herdr.agent(pane);
  if (agent.kind !== "omp") return undefined;
  const file = agent.sessionFile ?? findSessionFile(agent.cwd, 0);
  if (!file) return undefined;
  const tl = await readTimeline(file, 60);
  const ask = tl.items.findLast((i) => i.k === "ask");
  return ask?.k === "ask" && ask.pending ? ask : undefined;
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
  const ask = await pendingAsk(herdr, pane);
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
 * A message for an agent that waits on omp's question: it is the own answer to it. Throws
 * `agent_blocked` again when nothing answerable is open.
 */
export async function answerWithText(herdr: Herdr, pane: string, text: string): Promise<void> {
  const ask = await pendingAsk(herdr, pane);
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
