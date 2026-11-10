/** Which column an issue belongs in, and what moving a card means on GitHub and in the queue. */

export type Column = "grill" | "backlog" | "queue" | "done";
export const COLUMNS: Column[] = ["grill", "backlog", "queue", "done"];

export interface Labels {
  queue: string;
  story: string;
  /** null: the project has no grill label – no "Zu grillen" column */
  grill: string | null;
}

export interface Card {
  number: number;
  title: string;
  labels: string[];
  state: "open" | "closed";
  parent?: number;
  jira?: string;
  url: string;
  updatedAt?: string;
  closedAt?: string;
  running?: boolean;
}

export function classify(issue: { state: "open" | "closed"; labels: string[] }, labels: Labels): Column | "story" {
  if (issue.labels.includes(labels.story)) return "story";
  if (issue.state === "closed") return "done";
  if (issue.labels.includes(labels.queue)) return "queue";
  if (labels.grill && issue.labels.includes(labels.grill)) return "grill";
  return "backlog";
}

export interface MovePlan {
  reopen: boolean;
  close: boolean;
  add: string[];
  remove: string[];
  queue: "append" | "remove" | "keep";
}

export function movePlan(card: Card, to: Column, labels: Labels): MovePlan {
  const from = classify(card, labels);
  if (from === "story") throw new Error("Stories stehen nicht auf dem Board.");
  if (to === "grill" && !labels.grill) throw new Error("Dieses Projekt hat kein Grill-Label.");
  const plan: MovePlan = { reopen: false, close: false, add: [], remove: [], queue: "keep" };
  if (from === to) return plan;
  const has = (l: string | null): l is string => !!l && card.labels.includes(l);
  const add = (l: string | null) => l && !card.labels.includes(l) && plan.add.push(l);
  const drop = (...ls: (string | null)[]) => {
    for (const l of ls) if (has(l)) plan.remove.push(l);
  };
  if (to === "done") {
    plan.close = card.state === "open";
    plan.queue = "remove";
    return plan;
  }
  plan.reopen = card.state === "closed";
  if (to === "queue") {
    add(labels.queue);
    drop(labels.grill);
    plan.queue = "append";
  } else if (to === "grill") {
    add(labels.grill);
    drop(labels.queue);
    plan.queue = "remove";
  } else {
    drop(labels.queue, labels.grill);
    plan.queue = "remove";
  }
  return plan;
}
