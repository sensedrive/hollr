import { describe, expect, test } from "bun:test";
import { parseProgress } from "../src/events";
import { type RunRecord, skillPrompt, status, validateConfig } from "../src/run";

const base = { agent: "opus-5.5", provider: null, model: null, parallel: 1, screencast: false };

describe("skillPrompt", () => {
  test("preset agent", () => {
    expect(skillPrompt("haccp", { ...base, parallel: 2 })).toBe(
      "/skill:lul-workr-run-sandcastle haccp opus-5.5 2 warteschlange",
    );
  });

  test("custom agent and screencast", () => {
    expect(
      skillPrompt("haccp", { ...base, agent: "custom", provider: "omp", model: "anthropic/claude-opus-5", screencast: true }),
    ).toBe("/skill:lul-workr-run-sandcastle haccp custom:omp:anthropic/claude-opus-5 1 warteschlange --screencast");
  });
});

describe("validateConfig", () => {
  test("accepts a preset and normalises custom fields away", () => {
    expect(validateConfig({ agent: "cursor-grok", provider: "omp", model: "x", parallel: 3 })).toEqual({
      agent: "cursor-grok",
      provider: null,
      model: null,
      parallel: 3,
      screencast: false,
    });
  });

  test("refuses unknown agents, parallel below 1 or fractional, bad custom models", () => {
    expect(() => validateConfig({ agent: "gpt", parallel: 1 })).toThrow("Agent");
    expect(() => validateConfig({ ...base, parallel: 0 })).toThrow("Parallelität");
    expect(() => validateConfig({ ...base, parallel: 1.5 })).toThrow("Parallelität");
    expect(() => validateConfig({ ...base, agent: "custom", provider: "omp", model: "zwei worte" })).toThrow("Modell");
    expect(() => validateConfig({ ...base, agent: "custom", provider: "codex", model: "m" })).toThrow("Anbieter");
  });
});

describe("status", () => {
  const run: RunRecord = {
    id: "1",
    project: "p",
    pane: "w1:p2",
    startedAt: "2026-01-01T10:00:00Z",
    config: base,
    endedAt: null,
    endReason: null,
  };
  const none = parseProgress("", run.startedAt);

  test("a closed session ends the run; unknown agents (hollr failed) don't", () => {
    expect(status(run, none, [{ pane: "w9:p1", status: "idle" }])).toMatchObject({
      status: "ended",
      ended: { endReason: "Sitzung geschlossen" },
    });
    expect(status(run, none, null)).toEqual({ status: "running" });
  });

  test("waiting while the agent is blocked, loop-ended after the loop's last event", () => {
    expect(status(run, none, [{ pane: "w1:p2", status: "blocked" }])).toEqual({ status: "waiting" });
    const ended = parseProgress(JSON.stringify({ t: "loop-end", at: "2026-01-01T11:00:00Z", reason: "empty" }), run.startedAt);
    expect(status(run, ended, [{ pane: "w1:p2", status: "working" }])).toEqual({ status: "loop-ended" });
  });

  test("run-end from the skill ends it", () => {
    const done = parseProgress(JSON.stringify({ t: "run-end", at: "2026-01-01T12:00:00Z", result: "aborted", pr: null }), run.startedAt);
    expect(status(run, done, [{ pane: "w1:p2", status: "idle" }])).toMatchObject({
      status: "ended",
      ended: { endReason: "abgebrochen" },
    });
  });
});
