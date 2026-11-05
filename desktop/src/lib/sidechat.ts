// Sidechats ("Nachfragen"): how their forks are named and what goes to the agent – pure helpers, tested.

/** tab name of a sidechat's fork (also how the tree and the tabs know to leave it out) */
export const SIDECHAT_PREFIX = "Nachfrage · ";
export const isSideChatLabel = (label: string) => label.startsWith(SIDECHAT_PREFIX);
export const sideChatLabel = (quote: string) => `${SIDECHAT_PREFIX}${oneLine(quote).slice(0, 40)}`;

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/** what goes to the agent with the first question: the quote, then the question */
export const FIRST_PREFIX = "Nachfrage zu diesem Ausschnitt aus unserem Gespräch:";
export function firstPrompt(quote: string, question: string) {
  const quoted = quote.trim().split("\n").map((l) => `> ${l}`).join("\n");
  return `${FIRST_PREFIX}\n\n${quoted}\n\n${question.trim()}\n\n(Nur eine Rückfrage – bitte nichts ändern, nur antworten.)`;
}
/** the question alone, from the first prompt (the panel shows the quote itself above) */
export function questionOf(text: string): string {
  if (!text.startsWith(FIRST_PREFIX)) return text;
  const rest = text.slice(FIRST_PREFIX.length).split("\n").filter((l) => !l.startsWith(">"));
  return rest.join("\n").replace(/\n*\([^)]*\)\s*$/, "").trim();
}

