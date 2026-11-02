// Desktop notifications: which kinds to show (like iOS "Melden, wenn …") and the plugin wrappers.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isPermissionGranted, onAction, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";

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

/** the session a notification is about: a click on it opens that session */
export interface NoticeTarget {
  server: string;
  pane: string;
}

// macOS: the plugin never reports a click on a notification without buttons – src-tauri/src/notice.rs
// sends them itself and waits for the click; elsewhere the plugin's own click report (`tap`) works
const mac = navigator.platform.includes("Mac");

export async function notify(title: string, body: string, target?: NoticeTarget): Promise<boolean> {
  if (!(await ensurePermission())) return false;
  try {
    if (mac) await invoke("notice_show", { title, body, server: target?.server ?? null, pane: target?.pane ?? null });
    else sendNotification({ title, body, ...(target ? { extra: { server: target.server, pane: target.pane } } : {}) });
    return true;
  } catch {
    return false;
  }
}

/**
 * Calls `open` when a notification of this app is clicked, after the window came to the front (also
 * out of the Dock). Only notifications shown while this listener exists report their click.
 */
export async function onNoticeClick(open: (target: NoticeTarget) => void): Promise<() => void> {
  const go = (server: unknown, pane: unknown) => {
    if (typeof server === "string" && typeof pane === "string") open({ server, pane });
  };
  if (mac) {
    // notice.rs has already brought the window forward
    const off = await listen<{ server?: string | null; pane?: string | null }>("notice-click", (e) => go(e.payload.server, e.payload.pane));
    return off;
  }
  const listener = await onAction(async (e) => {
    if (e.actionId !== "tap") return;
    const win = getCurrentWindow();
    await win.unminimize().catch(() => {});
    await win.show().catch(() => {});
    await win.setFocus().catch(() => {});
    const extra = e.notification?.extra ?? {};
    go(extra.server, extra.pane);
  });
  return () => void listener.unregister().catch(() => {});
}
