// Desktop notifications: which kinds to show (like iOS "Melden, wenn …") and the plugin wrappers.
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";

export type NoticeKind = "waiting" | "done" | "error";

export const KINDS: { kind: NoticeKind; title: string }[] = [
  { kind: "waiting", title: "Fragen & Bestätigungen" },
  { kind: "done", title: "Aufgabe fertig" },
  { kind: "error", title: "Fehler" },
];

const KEY = "hollr.notifyKinds";

function load(): Record<NoticeKind, boolean> {
  const all = { waiting: true, done: true, error: true };
  try {
    return { ...all, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
  } catch {
    return all;
  }
}

/** per-kind switches, persisted next to the settings */
export const notifyKinds = $state(load());

$effect.root(() => {
  $effect(() => {
    const snapshot = JSON.stringify(notifyKinds);
    try {
      localStorage.setItem(KEY, snapshot);
    } catch {}
  });
});

/** "granted" | "denied" | "default" (not asked yet) */
export const permission = $state({ state: "default" as string });

export async function checkPermission(): Promise<boolean> {
  try {
    const ok = await isPermissionGranted();
    if (ok) permission.state = "granted";
    return ok;
  } catch {
    return false;
  }
}

/** Asks the OS once; returns whether notifications may be shown. */
export async function ensurePermission(): Promise<boolean> {
  if (await checkPermission()) return true;
  try {
    permission.state = await requestPermission();
  } catch {
    permission.state = "denied";
  }
  return permission.state === "granted";
}

export async function notify(title: string, body: string): Promise<boolean> {
  if (!(await ensurePermission())) return false;
  try {
    sendNotification({ title, body });
    return true;
  } catch {
    return false;
  }
}
