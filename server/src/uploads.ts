/**
 * Files sent from the phone to an agent (screenshots, photos, documents). They land in
 * ~/.cache/hollr/uploads/<day>/ – outside every repo, so `git status` stays clean – and are
 * deleted after 7 days.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const UPLOAD_LIMIT = 20 * 1024 * 1024;
const KEEP_MS = 7 * 86_400_000;

export const uploadDir = () =>
  Bun.env.HOLLR_UPLOAD_DIR ?? join(homedir(), ".cache", "hollr", "uploads");

/** A safe file name: no paths, no hidden files, sane length. */
export function safeName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const clean = base
    .normalize("NFC")
    .replace(/[^\p{L}\p{N}._ -]/gu, "_")
    .replace(/^[.\s]+/, "")
    .slice(-80);
  return clean || "datei";
}

export function saveUpload(name: string, base64: string, now = new Date()): string {
  const data = Buffer.from(base64, "base64");
  if (!data.length) throw new Error("empty");
  if (data.length > UPLOAD_LIMIT) throw new Error("too_large");
  const day = now.toISOString().slice(0, 10);
  const dir = join(uploadDir(), day);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stamp = now.toISOString().slice(11, 19).replace(/:/g, "");
  const path = join(dir, `${stamp}-${safeName(name)}`);
  writeFileSync(path, data, { mode: 0o600 });
  pruneUploads(now.getTime());
  return path;
}

export function pruneUploads(now = Date.now()) {
  let days: string[] = [];
  try {
    days = readdirSync(uploadDir());
  } catch {
    return;
  }
  for (const day of days) {
    const dir = join(uploadDir(), day);
    try {
      if (now - statSync(dir).mtimeMs > KEEP_MS) rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
}

const DIAG_LIMIT = 4 * 1024 * 1024;

/** The phone's breadcrumbs (Diagnostics.swift): appended per device under <state>/diag/, the newest 4 MB kept. */
export function saveDiag(device: string, app: string, text: string, now = new Date()): string {
  if (!text) throw new Error("empty");
  const dir = join(Bun.env.HOLLR_STATE_DIR ?? join(homedir(), ".local", "state", "hollr"), "diag");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${safeName(device || "iphone")}.log`);
  let old = "";
  try {
    old = readFileSync(path, "utf8");
  } catch {}
  const next = `${old}--- ${now.toISOString()} build ${app}\n${text.endsWith("\n") ? text : `${text}\n`}`;
  writeFileSync(path, next.length > DIAG_LIMIT ? next.slice(-DIAG_LIMIT) : next, { mode: 0o600 });
  return path;
}
