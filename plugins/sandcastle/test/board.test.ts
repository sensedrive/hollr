import { describe, expect, test } from "bun:test";
import { type Card, classify, type Labels, movePlan } from "../src/board";

const L: Labels = { queue: "Sandcastle", story: "story", grill: "grillTicket" };
const card = (labels: string[], state: "open" | "closed" = "open"): Card => ({
  number: 7,
  title: "t",
  labels,
  state,
  url: "",
});

describe("classify", () => {
  test("story first, then closed, then queue before grill", () => {
    expect(classify(card(["story", "Sandcastle"]), L)).toBe("story");
    expect(classify(card(["Sandcastle"], "closed"), L)).toBe("done");
    expect(classify(card(["Sandcastle", "grillTicket"]), L)).toBe("queue");
    expect(classify(card(["grillTicket"]), L)).toBe("grill");
    expect(classify(card(["bug"]), L)).toBe("backlog");
  });

  test("without a grill label there is no grill column", () => {
    expect(classify(card(["grillTicket"]), { ...L, grill: null })).toBe("backlog");
  });
});

describe("movePlan", () => {
  test("into the queue: label on, grill label off, appended; a closed card reopens", () => {
    expect(movePlan(card(["grillTicket", "bug"], "closed"), "queue", L)).toEqual({
      reopen: true,
      close: false,
      add: ["Sandcastle"],
      remove: ["grillTicket"],
      queue: "append",
    });
  });

  test("to grill: grill on, queue off, removed from the queue", () => {
    expect(movePlan(card(["Sandcastle"]), "grill", L)).toEqual({
      reopen: false,
      close: false,
      add: ["grillTicket"],
      remove: ["Sandcastle"],
      queue: "remove",
    });
  });

  test("to backlog: only labels the card carries are removed", () => {
    expect(movePlan(card(["grillTicket"]), "backlog", L)).toEqual({
      reopen: false,
      close: false,
      add: [],
      remove: ["grillTicket"],
      queue: "remove",
    });
  });

  test("to done: close, labels untouched", () => {
    expect(movePlan(card(["Sandcastle"]), "done", L)).toEqual({
      reopen: false,
      close: true,
      add: [],
      remove: [],
      queue: "remove",
    });
  });

  test("same column changes nothing", () => {
    expect(movePlan(card(["Sandcastle"]), "queue", L)).toEqual({
      reopen: false,
      close: false,
      add: [],
      remove: [],
      queue: "keep",
    });
  });

  test("grill without a grill label and stories are refused", () => {
    expect(() => movePlan(card([]), "grill", { ...L, grill: null })).toThrow();
    expect(() => movePlan(card(["story"]), "queue", L)).toThrow();
  });
});
