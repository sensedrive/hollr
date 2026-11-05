// The chat's find bar opens folded cards that hold a hit (chatFind.ts `FindUnit.key`). TimelineView provides the
// set; cards (and folded thinking) read it next to their own open state – a context, so ToolCalls doesn't have to
// thread a prop through every card.
import { getContext, setContext } from "svelte";

export interface Reveal {
  /** reactive: reading it inside $derived / the template re-runs when the find bar's hits change */
  has(key: string): boolean;
}

const KEY = Symbol("chat-reveal");
const NONE: Reveal = { has: () => false };

export const provideReveal = (r: Reveal) => setContext(KEY, r);
/** outside a TimelineView (a card shown elsewhere): nothing is ever forced open */
export const revealed = (): Reveal => getContext<Reveal | undefined>(KEY) ?? NONE;
