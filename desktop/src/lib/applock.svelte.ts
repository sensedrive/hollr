// App lock (Settings → Allgemein → Sicherheit), like iOS AppLock.swift: Touch ID or the computer's password
// on start and after the window was away (unfocused / hidden) for more than GRACE_MS. macOS only.
import { invoke } from "@tauri-apps/api/core";
import { t } from "./i18n";
import { settings } from "./settings.svelte";

/** relock after this long away from the window (iOS: 30 s in the background) */
export const GRACE_MS = 30_000;

export interface LockSupport {
  available: boolean;
  biometry: "touchid" | "faceid" | "opticid" | "none";
}

const NONE: LockSupport = { available: false, biometry: "none" };

export const appLock = $state({
  /** starts locked when the lock is on, so nothing is readable before the first unlock */
  locked: settings.appLock,
  /** null until asked */
  support: null as LockSupport | null,
  /** a system prompt is open */
  authenticating: false,
});

export async function loadSupport(): Promise<LockSupport> {
  if (!appLock.support) {
    try {
      appLock.support = (await invoke<LockSupport | null>("applock_available")) ?? NONE;
    } catch {
      appLock.support = NONE;
    }
  }
  return appLock.support;
}

/** "Touch ID", or the password when the Mac has no Touch ID */
export function biometryName(): string {
  switch (appLock.support?.biometry) {
    case "touchid": return "Touch ID";
    case "faceid": return "Face ID";
    case "opticid": return "Optic ID";
    default: return t("Passwort");
  }
}

/** One system prompt. macOS shows the reason as "„Hollr“ versucht, <reason>." – phrase it as that sentence's end.
 *  Like iOS, a computer that cannot ask for its owner counts as confirmed (the bridge dev mode answers null). */
async function authenticate(reason: string): Promise<boolean> {
  if (appLock.authenticating) return false;
  appLock.authenticating = true;
  try {
    return (await invoke<boolean | null>("applock_authenticate", { reason })) ?? true;
  } catch {
    return false;
  } finally {
    appLock.authenticating = false;
  }
}

/** Unlock button / automatic prompt; failed or cancelled stays locked. */
export async function unlock(): Promise<void> {
  if (await authenticate(t("Hollr zu entsperren"))) appLock.locked = false;
}

/** Settings toggle: confirm with Touch ID / password before switching, also when turning it off (like iOS). */
export async function setEnabled(on: boolean): Promise<void> {
  if (await authenticate(on ? t("die Sperre einzuschalten") : t("die Sperre auszuschalten"))) {
    settings.appLock = on;
    appLock.locked = false;
  }
}
