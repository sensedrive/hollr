import { existsSync, statSync } from "node:fs";
import { homedir, platform, userInfo } from "node:os";
import { join } from "node:path";
import { herdrBin } from "./herdr";
import { MAC_SETUP, MIC_DEVICE, macAudioMissing, SPEAKER_DEVICE } from "./macaudio";
import { tailscaleInfo, tailscaleSteps } from "./network";
import { authorizedKeysPath, hostKeyFingerprint, listDevices } from "./pairing";
import { pulseAvailable } from "./pulse";

interface Check {
  name: string;
  ok: boolean;
  detail: string;
  fix?: string;
}

function which(cmd: string): string | undefined {
  const local = join(homedir(), ".local", "bin", cmd);
  if (existsSync(local)) return local;
  const res = Bun.spawnSync(["sh", "-c", `command -v ${cmd}`]);
  return res.exitCode === 0 ? res.stdout.toString().trim() : undefined;
}

function version(cmd: string, ...args: string[]): string {
  try {
    const res = Bun.spawnSync([cmd, ...args]);
    return (res.stdout.toString() || res.stderr.toString()).trim().split("\n")[0] ?? "";
  } catch {
    return "";
  }
}

const mac = platform() === "darwin";

export async function collectChecks(): Promise<Check[]> {
  const checks: Check[] = [];
  const herdr = herdrBin();
  const herdrOk = herdr !== "herdr" || Boolean(which("herdr"));
  checks.push({
    name: "herdr",
    ok: herdrOk,
    detail: herdrOk ? version(herdr, "--version") : "nicht gefunden",
    fix: "curl -fsSL https://herdr.dev/install.sh | sh",
  });
  const omp = which("omp");
  checks.push({
    name: "omp",
    ok: Boolean(omp),
    detail: omp ? version(omp, "--version") : "nicht gefunden",
    fix: "curl -fsSL https://omp.sh/install | sh",
  });
  if (!mac) {
    for (const tool of ["pactl", "pacat"]) {
      const path = which(tool);
      checks.push({
        name: tool,
        ok: Boolean(path),
        detail: path ?? "nicht gefunden",
        fix: mac
          ? "brew install pulseaudio"
          : "sudo apt-get install -y pulseaudio pulseaudio-utils",
      });
    }
    const pulse = await pulseAvailable();
    checks.push({
      name: "PulseAudio läuft",
      ok: pulse,
      detail: pulse ? "ja" : "nein",
      fix: mac
        ? 'launchctl kickstart -k "gui/$(id -u)/app.hollr.pulseaudio"  (oder Installer erneut ausführen)'
        : "systemctl --user enable --now pulseaudio.socket pulseaudio.service",
    });
  }
  if (mac) {
    const missing = macAudioMissing();
    checks.push({
      name: "Live-Audio (BlackHole)",
      ok: missing.length === 0,
      detail: missing.length ? `fehlt: ${missing.join(", ")}` : `${MIC_DEVICE} · ${SPEAKER_DEVICE}`,
      fix: MAC_SETUP,
    });
    const ssh = await sshListening();
    checks.push({
      name: "SSH (Entfernte Anmeldung)",
      ok: ssh,
      detail: ssh ? "Port 22 offen" : "aus",
      fix: "Systemeinstellungen → Allgemein → Teilen → Entfernte Anmeldung",
    });
  } else {
    const linger = Bun.spawnSync([
      "loginctl",
      "show-user",
      userInfo().username,
      "-p",
      "Linger",
    ]).stdout.toString();
    checks.push({
      name: "Dienste ohne Login (linger)",
      ok: linger.includes("Linger=yes"),
      detail: linger.trim() || "unbekannt",
      fix: `sudo loginctl enable-linger ${userInfo().username}`,
    });
  }
  // remote access (optional): Tailscale reaches this machine from anywhere without open ports
  const ts = tailscaleInfo();
  checks.push({
    name: "Tailscale (Fernzugriff)",
    ok: true,
    detail: !ts.installed
      ? "nicht installiert (optional)"
      : ts.state === "Running"
        ? `läuft · ${ts.dnsName ?? ts.ips[0] ?? ""}`
        : `${ts.state ?? "?"} – ${tailscaleSteps(ts)[0] ?? ""}`,
  });
  let fp = "";
  try {
    fp = hostKeyFingerprint();
  } catch {}
  checks.push({
    name: "SSH-Host-Key",
    ok: Boolean(fp),
    detail: fp || "fehlt",
    fix: "sudo ssh-keygen -A",
  });
  const ak = authorizedKeysPath();
  const akMode = existsSync(ak) ? (statSync(ak).mode & 0o777).toString(8) : "fehlt";
  checks.push({
    name: "authorized_keys",
    // sshd only refuses keys files others can write to
    ok: akMode === "fehlt" || (Number.parseInt(akMode, 8) & 0o022) === 0,
    detail: `${ak} (${akMode})`,
    fix: `chmod 600 ${ak}`,
  });
  checks.push({ name: "Gekoppelte Geräte", ok: true, detail: String(listDevices().length) });
  return checks;
}

async function sshListening(): Promise<boolean> {
  try {
    const socket = await Bun.connect({
      hostname: "127.0.0.1",
      port: 22,
      socket: { data() {} },
    });
    socket.end();
    return true;
  } catch {
    return false;
  }
}

export async function runDoctor(): Promise<number> {
  const checks = await collectChecks();
  let failed = 0;
  for (const c of checks) {
    console.log(`${c.ok ? "✅" : "❌"} ${c.name.padEnd(28)} ${c.detail}`);
    if (!c.ok) {
      failed++;
      if (c.fix) console.log(`   → ${c.fix}`);
    }
  }
  console.log(
    failed ? `\n${failed} Problem(e) gefunden.` : "\nAlles bereit. Weiter mit: hollr pair",
  );
  return failed ? 1 : 0;
}
