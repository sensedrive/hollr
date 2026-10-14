/**
 * How a phone reaches this server – chosen when pairing:
 *   lan        the addresses of this machine (same Wi-Fi / router; a cloud server's public IP)
 *   tailscale  the machine in your tailnet (MagicDNS name + 100.x IP): from anywhere, no open ports,
 *              WireGuard underneath; the LAN addresses stay as a fallback at home
 *   auto       everything we find (older `hollr pair` behaviour)
 * SSH with the pinned host key runs on top in every case.
 */
import { existsSync } from "node:fs";
import { platform } from "node:os";
import { detectAddresses } from "./pairing";

export type NetworkMode = "lan" | "tailscale" | "auto";

export interface TailscaleInfo {
  installed: boolean;
  cli?: string;
  /** Running | Stopped | NeedsLogin | NeedsMachineAuth | Starting | NoState */
  state?: string;
  dnsName?: string;
  ips: string[];
}

const TS_CLIS = [
  "tailscale",
  "/opt/homebrew/bin/tailscale",
  "/usr/local/bin/tailscale",
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
];

function findCli(): string | undefined {
  for (const c of TS_CLIS) {
    if (c.startsWith("/")) {
      if (existsSync(c)) return c;
      continue;
    }
    try {
      const r = Bun.spawnSync(["sh", "-c", `command -v ${c}`], { stdout: "pipe" });
      const p = r.stdout.toString().trim();
      if (r.exitCode === 0 && p) return p;
    } catch {}
  }
  return undefined;
}

/** 100.64.0.0/10 – Tailscale's address range */
export const isTailscaleIp = (a: string) => /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a);

export function tailscaleInfo(): TailscaleInfo {
  const cli = findCli();
  if (!cli) return { installed: false, ips: [] };
  try {
    const r = Bun.spawnSync([cli, "status", "--json"], {
      stdout: "pipe",
      stderr: "ignore",
      timeout: 6000,
    });
    const d = JSON.parse(r.stdout.toString() || "{}") as {
      BackendState?: string;
      Self?: { DNSName?: string; TailscaleIPs?: string[] };
    };
    const ips = (d.Self?.TailscaleIPs ?? []).filter((ip) => !ip.includes(":"));
    return {
      installed: true,
      cli,
      state: d.BackendState,
      dnsName: d.Self?.DNSName?.replace(/\.$/, "") || undefined,
      ips,
    };
  } catch {
    return { installed: true, cli, ips: [] };
  }
}

/** Addresses on the local network (and a cloud server's public IP), without Tailscale's. */
export const lanAddresses = () => detectAddresses().filter((a) => !isTailscaleIp(a));

export function tailscaleAddresses(ts = tailscaleInfo()): string[] {
  if (ts.state !== "Running") return [];
  return [...(ts.dnsName ? [ts.dnsName] : []), ...ts.ips];
}

/** Addresses for the QR code, in the order the phone tries them. */
export function addressesFor(mode: NetworkMode, ts = tailscaleInfo()): string[] {
  const lan = lanAddresses();
  if (mode === "lan") return lan;
  if (mode === "tailscale") return [...new Set([...tailscaleAddresses(ts), ...lan])];
  return [...new Set([...lan, ...tailscaleAddresses(ts)])];
}

/** What to do so Tailscale works here – shown by `hollr pair --tailscale` and `hollr doctor`. */
export function tailscaleSteps(ts = tailscaleInfo()): string[] {
  const mac = platform() === "darwin";
  if (!ts.installed)
    return mac
      ? [
          "Tailscale installieren: App Store („Tailscale“) oder  brew install --cask tailscale",
          "Tailscale öffnen und anmelden (Google, Apple, GitHub, Microsoft …)",
        ]
      : [
          "Tailscale installieren:  curl -fsSL https://tailscale.com/install.sh | sh",
          "Anmelden:  sudo tailscale up",
        ];
  if (ts.state === "NeedsLogin" || ts.state === "NeedsMachineAuth")
    return [mac ? "Tailscale-App öffnen und anmelden" : "Anmelden:  sudo tailscale up"];
  if (ts.state !== "Running")
    return [
      mac
        ? "Tailscale starten:  tailscale up  (oder in der Menüleiste „Connect“)"
        : "Starten:  sudo tailscale up",
    ];
  return [];
}

export const IPHONE_TAILSCALE_HINT =
  "Auf dem iPhone: Tailscale-App installieren und mit demselben Konto anmelden – dann klappt es auch unterwegs.";
