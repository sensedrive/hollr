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
  homedir,
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
import { usageLimits } from "./spaces";

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

/** Runs a command; missing binaries (systemctl on macOS …) give "" instead of throwing. */
function run(cmd: string[]): { ok: boolean; out: string } {
  try {
    const res = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "ignore", timeout: 5000 });
    return { ok: res.exitCode === 0, out: res.stdout.toString() };
  } catch {
    return { ok: false, out: "" };
  }
}

const mac = platform() === "darwin";

export function osName(): string {
  if (mac) {
    const v = run(["sw_vers", "-productVersion"]).out.trim();
    return v ? `macOS ${v}` : `macOS ${release()}`;
  }
  const os = read("/etc/os-release");
  const pretty = os.match(/^PRETTY_NAME="?([^"\n]+)"?/m)?.[1];
  return pretty ?? `${platform()} ${release()}`;
}

/** Package manager → install command for PulseAudio tools on this distro. */
export function packageHint(pkgs: string): string {
  const has = (cmd: string) => run(["sh", "-c", `command -v ${cmd}`]).ok;
  if (mac)
    return has("brew")
      ? "brew install pulseaudio"
      : "Homebrew installieren (https://brew.sh), dann: brew install pulseaudio";
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
    if (!line) {
      // macOS & co.: per-core times from the OS
      const t = cpus().map((c) => c.times);
      const idle = t.reduce((a, c) => a + c.idle, 0);
      return { idle, total: t.reduce((a, c) => a + c.user + c.nice + c.sys + c.idle + c.irq, 0) };
    }
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
  let swapTotal = kb("SwapTotal");
  let swapUsed = swapTotal - kb("SwapFree");
  if (!info && mac) {
    // "total = 2048.00M  used = 1024.50M  free = …"
    const m = run(["sysctl", "-n", "vm.swapusage"]).out;
    const mb = (k: string) => Number(m.match(new RegExp(`${k} = ([\\d.]+)M`))?.[1] ?? 0) * 1048576;
    swapTotal = mb("total");
    swapUsed = mb("used");
  }
  return { total, used: total - available, swapTotal, swapUsed };
}

function disks() {
  const seen = new Set<string>();
  return run(["df", "-P", "-k"])
    .out.split("\n")
    .slice(1)
    .map((l) => l.trim().split(/\s+/))
    .filter(
      (c) =>
        c.length >= 6 &&
        c[0]?.startsWith("/dev/") &&
        !c[5]?.startsWith("/snap") &&
        !c[5]?.startsWith("/boot") &&
        // macOS system volumes (the data volume is the one that fills up)
        !(c[5]?.startsWith("/System/Volumes/") && c[5] !== "/System/Volumes/Data") &&
        !c[5]?.startsWith("/Volumes/") &&
        !c[5]?.startsWith("/Library/"),
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
  return run(["ps", "-axo", "pid=,user=,pcpu=,pmem=,rss=,comm="])
    .out.split("\n")
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

/** The push watcher service: systemd user unit on Linux, launchd agent on macOS. */
function watcherActive(): boolean | undefined {
  if (mac) {
    const r = run(["launchctl", "list", "app.hollr.watch"]);
    return r.ok ? /"PID" = \d+/.test(r.out) : false;
  }
  const r = run(["systemctl", "--user", "is-active", "hollr-watch.service"]);
  if (!r.ok && !r.out.trim()) return undefined;
  return r.out.trim() === "active";
}

export async function sysinfo(version: string, lang: Lang = "de") {
  const [cpu, procs, baseChecks] = await Promise.all([cpuUsage(), processes(), collectChecks()]);
  const checks = baseChecks.map((c) =>
    c.name === "pactl" || c.name === "pacat"
      ? { ...c, fix: packageHint("pulseaudio pulseaudio-utils") }
      : c,
  );
  const watch = watcherActive();
  checks.push({
    name: "Hollr-Wächter (Push)",
    ok: watch !== false,
    detail: watch === undefined ? "kein systemd" : watch ? "läuft" : "gestoppt",
    fix: mac
      ? 'launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/app.hollr.watch.plist'
      : "systemctl --user enable --now hollr-watch.service",
  });
  const push = pushConfig();
  checks.push({
    name: "Push-Schlüssel",
    // without it there are no notifications and no Live Activities – the app offers to set it up
    ok: Boolean(push),
    detail: push
      ? `Key ${push.keyId} · ${pushDevices().length} ${lang === "en" ? "device(s)" : "Gerät(e)"}`
      : "fehlt – keine Mitteilungen von diesem Rechner",
  });
  // logged in to a provider: omp reports usage limits only then
  const usage = await usageLimits().catch(() => undefined);
  checks.push({
    name: "omp angemeldet",
    ok: Boolean(usage?.limits.length),
    detail: usage?.limits.length
      ? [...new Set(usage.limits.map((l) => l.provider))].join(", ")
      : "kein Anbieter – im Terminal: omp, dann /login",
    fix: "omp   # dann /login",
  });
  // what the app's setup checklist can fix with one tap
  const actions: Record<string, string> = {
    herdr: "tool:herdr",
    omp: "tool:omp",
    "Hollr-Wächter (Push)": "watch",
    "Push-Schlüssel": "push",
  };
  const localized = checks.map((c) => ({
    ...c,
    id: c.name,
    ...(actions[c.name] ? { action: actions[c.name] } : {}),
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

/** Restarts the push watcher (setup checklist "Neu starten"). */
export function restartWatcher(): boolean {
  if (mac) {
    const uid = userInfo().uid;
    const kick = run(["launchctl", "kickstart", "-k", `gui/${uid}/app.hollr.watch`]);
    if (kick.ok) return true;
    const plist = `${homedir()}/Library/LaunchAgents/app.hollr.watch.plist`;
    return run(["launchctl", "bootstrap", `gui/${uid}`, plist]).ok;
  }
  return run(["systemctl", "--user", "restart", "hollr-watch.service"]).ok;
}
