/** What /api answers (src/http.ts). */
import type { Card, Column } from "../src/board";
import type { Project } from "../src/projects";
import type { RunConfig, RunStatus } from "../src/run";

export type { Card, Column, Project, RunConfig, RunStatus };

export interface Label {
  name: string;
  color?: string;
}

export interface Board {
  columns: Partial<Record<Column, Card[]>>;
  stories: { number: number; title: string }[];
  labels: Label[];
  hasGrill: boolean;
}

export interface IssueDetail {
  number: number;
  title: string;
  state: string;
  url: string;
  labels: string[];
  bodyHtml: string;
  parent?: { number: number; title: string };
  jira?: { key: string; url: string };
  blockedBy: number[];
  comments: { author: string; createdAt: string; bodyHtml: string }[];
  run?: { status: "in-arbeit" | "erledigt" | "fehlgeschlagen" | "ohne-commits"; reason?: string; logs: { name: string; tail: string }[] };
}

export interface RunView {
  project: { id: string; name: string };
  status: RunStatus;
  startedAt: string;
  endedAt?: string;
  endReason?: string;
  config: RunConfig;
  branch?: string;
  pr?: number;
  inProgress: Card[];
  queue: Card[];
  done: Card[];
  failed: { card: Card; reason: string }[];
}

export interface RunResponse {
  run: RunView | null;
  lastConfig?: RunConfig;
  queue?: Card[];
}
