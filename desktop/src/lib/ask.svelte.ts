// In-app replacements for window.confirm / prompt / alert: the Tauri webview answers those natively with
// "no" / nothing without showing anything. One question at a time, shown by AskDialog (mounted in Shell).
export interface Question {
  kind: "confirm" | "prompt" | "alert";
  title: string;
  text?: string;
  value?: string;
  ok?: string;
  danger?: boolean;
  resolve: (v: string | boolean | null) => void;
}

export const asking = $state<{ q: Question | null }>({ q: null });

function ask(q: Omit<Question, "resolve">): Promise<string | boolean | null> {
  asking.q?.resolve(q.kind === "prompt" ? null : false);
  return new Promise((resolve) => (asking.q = { ...q, resolve }));
}

export const confirmAsk = (title: string, opts: { text?: string; ok?: string; danger?: boolean } = {}) =>
  ask({ kind: "confirm", title, ...opts }).then((v) => v === true);
export const promptAsk = (title: string, value = "", opts: { text?: string; ok?: string } = {}) =>
  ask({ kind: "prompt", title, value, ...opts }).then((v) => (typeof v === "string" ? v : null));
export const alertAsk = (title: string, text?: string) => ask({ kind: "alert", title, text }).then(() => undefined);
