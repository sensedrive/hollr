/**
 * Server info for the app: OS, load, CPU, memory, disks, top processes and the setup checks.
 * Reads /proc directly so it works on every Linux (Debian/Ubuntu, Fedora/RHEL, Arch,
 * openSUSE, Alpine/busybox …); macOS falls back to ps/sysctl where possible.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import {
  arch,
  cpus,
  freemem,
  hostname,
  loadavg,
  platform,
  release,
  totalmem,
  uptime,
  userInfo,
} from "node:os";
import { collectChecks } from "./doctor";
import { type Lang, tr } from "./i18n";
import { pushConfig, pushDevices } from "./push";

export interface ProcessInfo {
  pid: number;
  user: string;
  cpu: number;
  mem: number;
  rssMb: number;
  name: string;
  command: string;
  /** belongs to the Hollr stack (herdr, omp, claude, codex, hollr, pulseaudio) */
  stack: boolean;
}

const STACK_RE = /\b(herdr|omp|claude|codex|hollr|pulseaudio|pipewire|pacat)\b/;

function read(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

export function osName(): string {
  const os = read("/etc/os-release");
  const pretty = os.match(/^PRETTY_NAME="?([^"\n]+)"?/m)?.[1];
  return pretty ?? `${platform()} ${release()}`;
}

/** Package manager → install command for PulseAudio tools on this distro. */
export function packageHint(pkgs: string): string {
  const has = (cmd: string) => Bun.spawnSync(["sh", "-c", `command -v ${cmd}`]).exitCode === 0;
  if (has("apt-get")) return `sudo apt-get install -y ${pkgs}`;
  if (has("dnf")) return `sudo dnf install -y ${pkgs}`;
  if (has("yum")) return `sudo yum install -y ${pkgs}`;
  if (has("pacman")) return `sudo pacman -S --needed ${pkgs}`;
  if (has("zypper")) return `sudo zypper install -y ${pkgs}`;
  if (has("apk")) return `sudo apk add ${pkgs}`;
  return `Paket(e) installieren: ${pkgs}`;
}

/** CPU usage over a short window from /proc/stat (0–100). */
async function cpuUsage(): Promise<number | undefined> {
  const sample = () => {
    const line = read("/proc/stat").split("\n")[0] ?? "";
    const nums = line.split(/\s+/).slice(1).map(Number);
    const idle = (nums[3] ?? 0) + (nums[4] ?? 0);
    const total = nums.reduce((a, b) => a + (b || 0), 0);
    return { idle, total };
  };
  const a = sample();
  if (!a.total) return undefined;
  await Bun.sleep(300);
  const b = sample();
  const total = b.total - a.total;
  return total > 0 ? Math.round(((total - (b.idle - a.idle)) / total) * 1000) / 10 : undefined;
}

function memory() {
  const info = read("/proc/meminfo");
  const kb = (key: string) =>
    Number(info.match(new RegExp(`^${key}:\\s+(\\d+)`, "m"))?.[1] ?? 0) * 1024;
  const total = kb("MemTotal") || totalmem();
  const available = kb("MemAvailable") || freemem();
  return {
    total,
    used: total - available,
    swapTotal: kb("SwapTotal"),
    swapUsed: kb("SwapTotal") - kb("SwapFree"),
  };
}

function disks() {
  const res = Bun.spawnSync(["df", "-P", "-k"], { stdout: "pipe", stderr: "ignore" });
  const seen = new Set<string>();
  return res.stdout
    .toString()
    .split("\n")
    .slice(1)
    .map((l) => l.trim().split(/\s+/))
    .filter(
      (c) =>
        c.length >= 6 &&
        c[0]?.startsWith("/dev/") &&
        !c[5]?.startsWith("/snap") &&
        !c[5]?.startsWith("/boot"),
    )
    .filter((c) => {
      const dev = c[0] ?? "";
      if (seen.has(dev)) return false;
      seen.add(dev);
      return true;
    })
    .map((c) => ({ mount: c[5] ?? "/", total: Number(c[1]) * 1024, used: Number(c[2]) * 1024 }))
    .slice(0, 8);
}

/** Processes sorted by CPU – via /proc (works without procps, e.g. on Alpine). */
export async function processes(limit = 40): Promise<ProcessInfo[]> {
  if (!existsSync("/proc/stat")) return psFallback(limit);
  const hz = 100;
  const total = memory().total;
  const users = new Map<string, string>();
  for (const line of read("/etc/passwd").split("\n")) {
    const [name, , uid] = line.split(":");
    if (name && uid) users.set(uid, name);
  }
  const snap = () => {
    const map = new Map<number, { ticks: number; rss: number; name: string; uid: string }>();
    for (const entry of readdirSync("/proc")) {
      const pid = Number(entry);
      if (!pid) continue;
      const stat = read(`/proc/${pid}/stat`);
      const close = stat.lastIndexOf(")");
      if (close < 0) continue;
      const name = stat.slice(stat.indexOf("(") + 1, close);
      const f = stat.slice(close + 2).split(" ");
      const ticks = Number(f[11] ?? 0) + Number(f[12] ?? 0);
      const rss = Number(f[21] ?? 0) * 4096;
      const uid = read(`/proc/${pid}/status`).match(/^Uid:\s+(\d+)/m)?.[1] ?? "";
      map.set(pid, { ticks, rss, name, uid });
    }
    return map;
  };
  const a = snap();
  const t0 = performance.now();
  await Bun.sleep(400);
  const b = snap();
  const seconds = (performance.now() - t0) / 1000;
  const out: ProcessInfo[] = [];
  for (const [pid, p] of b) {
    const before = a.get(pid);
    const cpu = before ? ((p.ticks - before.ticks) / hz / seconds) * 100 : 0;
    const command =
      read(`/proc/${pid}/cmdline`).split("\0").filter(Boolean).join(" ").slice(0, 300) ||
      `[${p.name}]`;
    out.push({
      pid,
      user: users.get(p.uid) ?? p.uid,
      cpu: Math.round(cpu * 10) / 10,
      mem: total ? Math.round((p.rss / total) * 1000) / 10 : 0,
      rssMb: Math.round(p.rss / 1048576),
      name: p.name,
      command,
      stack: STACK_RE.test(`${p.name} ${command}`),
    });
  }
  return out.sort((x, y) => y.cpu - x.cpu || y.rssMb - x.rssMb).slice(0, limit);
}

function psFallback(limit: number): ProcessInfo[] {
  const res = Bun.spawnSync(["ps", "-axo", "pid=,user=,pcpu=,pmem=,rss=,comm="], {
    stdout: "pipe",
    stderr: "ignore",
  });
  return res.stdout
    .toString()
    .split("\n")
    .map((l) => l.trim().split(/\s+/))
    .filter((c) => c.length >= 6)
    .map((c) => {
      const command = c.slice(5).join(" ");
      return {
        pid: Number(c[0]),
        user: c[1] ?? "",
        cpu: Number(c[2]),
        mem: Number(c[3]),
        rssMb: Math.round(Number(c[4]) / 1024),
        name: command.split("/").pop() ?? command,
        command,
        stack: STACK_RE.test(command),
      };
    })
    .sort((x, y) => y.cpu - x.cpu)
    .slice(0, limit);
}

function serviceActive(unit: string): boolean | undefined {
  const res = Bun.spawnSync(["systemctl", "--user", "is-active", unit], {
    stdout: "pipe",
    stderr: "ignore",
  });
  if (res.exitCode !== 0 && !res.stdout.toString().trim()) return undefined;
  return res.stdout.toString().trim() === "active";
}

export async function sysinfo(version: string, lang: Lang = "de") {
  const [cpu, procs, baseChecks] = await Promise.all([cpuUsage(), processes(), collectChecks()]);
  const checks = baseChecks.map((c) =>
    c.name === "pactl" || c.name === "pacat"
      ? { ...c, fix: packageHint("pulseaudio pulseaudio-utils") }
      : c,
  );
  const watch = serviceActive("hollr-watch.service");
  checks.push({
    name: "Hollr-Wächter (Push)",
    ok: watch !== false,
    detail: watch === undefined ? "kein systemd" : watch ? "läuft" : "gestoppt",
    fix: "systemctl --user enable --now hollr-watch.service",
  });
  const push = pushConfig();
  checks.push({
    name: "Push-Schlüssel",
    ok: Boolean(push),
    detail: push
      ? `Key ${push.keyId} · ${pushDevices().length} ${lang === "en" ? "device(s)" : "Gerät(e)"}`
      : "nicht eingerichtet (in der App importieren)",
  });
  const localized = checks.map((c) => ({
    ...c,
    name: tr(lang, c.name),
    detail: tr(lang, c.detail),
  }));
  const [l1 = 0, l5 = 0, l15 = 0] = loadavg();
  return {
    host: hostname(),
    os: osName(),
    kernel: release(),
    arch: arch(),
    user: userInfo().username,
    uptime: Math.round(uptime()),
    hollr: version,
    cores: cpus().length,
    load: [l1, l5, l15].map((v) => Math.round(v * 100) / 100),
    cpu,
    memory: memory(),
    disks: disks(),
    processes: procs,
    checks: localized,
  };
}
