#!/usr/bin/env bun
/**
 * hollr – talk to omp /live on a remote herdr server from your iPhone.
 *
 * Admin commands (run on the server):
 *   hollr pair [--name LABEL] [--host ADDR]... [--port N]   QR code to pair a phone
 *   hollr devices                                           list paired phones
 *   hollr revoke <id|name>                                  remove a phone
 *   hollr doctor                                            check the server setup
 *   hollr version
 *
 * Called by sshd for paired phones (forced command):
 *   hollr gate      → hello | agents | live <pane> | prompt <pane> | keys <pane> <key>...
 *   hollr enroll ID → pairing handshake
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import QRCode from "qrcode";
import { listDirs } from "./dirs";
import { runDoctor } from "./doctor";
import { runEvents } from "./events";
import {
  execHerdr,
  Herdr,
  HerdrError,
  installedKinds,
  type NewChatRequest,
  newChat,
} from "./herdr";
import { toLang } from "./i18n";
import { runLive } from "./live";
import { LOG_FILE, log } from "./log";
import { listModels, switchCommand } from "./models";
import {
  addressesFor,
  IPHONE_TAILSCALE_HINT,
  isTailscaleIp,
  lanAddresses,
  type NetworkMode,
  type TailscaleInfo,
  tailscaleAddresses,
  tailscaleInfo,
  tailscaleSteps,
} from "./network";
import { OTP_PORT, type OtpServer, serveCode } from "./otp";
import {
  addBootstrap,
  answerRequest,
  awaitConfirmation,
  buildPayload,
  endConfirmation,
  enroll,
  listDevices,
  newBootstrapKey,
  PAIRING_TTL_SEC,
  payloadUrl,
  pendingRequest,
  removeBootstrap,
  requireConfirmation,
  revokeDevice,
  upgradeDeviceKeys,
} from "./pairing";
import { webPorts } from "./ports";
import { runTerm } from "./term";
import { saveUpload, UPLOAD_LIMIT } from "./uploads";
import {
  pushConfig,
  pushDevices,
  pushDir,
  registerDevice,
  sendNotice,
  setActivityToken,
  setupPush,
  setupPushKey,
  unregisterDevice,
} from "./push";
import { findSessionFile, readHistory } from "./sessionlog";
import {
  type FsRequest,
  listSpaces,
  manageSpace,
  parseFooter,
  type SpaceRequest,
  spaceFs,
  statusLine,
  usageLimits,
} from "./spaces";
import { restartWatcher, sysinfo } from "./sysinfo";
import { readTimeline } from "./timeline";
import { latestVersions, startTool, TOOL_NAMES, type ToolName, toolStates } from "./tools";
import { usageHistory } from "./usagehistory";
import { runWatch } from "./watch";

export const VERSION = "0.27.0";

const PANE_RE = /^[\w-]+:[\w-]+$/;

let pendingOutput: Promise<unknown> = Promise.resolve();

/** Queues a JSON line; flushed completely before the process exits (pipes would truncate otherwise). */
function json(data: unknown) {
  const text = `${JSON.stringify(data)}\n`;
  pendingOutput = pendingOutput.then(() => Bun.write(Bun.stdout, text));
}

/** Reads the first line from stdin (clients cannot always send EOF on an SSH channel). */
async function readStdinLine(limit = 64 * 1024): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of Bun.stdin.stream()) {
    text += decoder.decode(chunk, { stream: true });
    const nl = text.indexOf("\n");
    if (nl !== -1) return text.slice(0, nl).trim();
    if (text.length > limit) break;
  }
  return text.trim();
}

function flag(args: string[], name: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i++)
    if (args[i] === name && args[i + 1]) values.push(args[++i] ?? "");
  return values;
}

/** The pane's agent, or undefined after answering {"error": …} (a closed pane is "not_found"). */
async function agentOrError(herdr: Herdr, pane: string) {
  try {
    return await herdr.agent(pane);
  } catch (err) {
    const gone = err instanceof HerdrError && err.code !== "herdr_failed";
    json({ error: gone ? "not_found" : err instanceof Error ? err.message : String(err) });
    return undefined;
  }
}

async function gate(): Promise<number> {
  // forced SSH commands get a minimal PATH (and Bun hands children the PATH it started with):
  // restart once with the places installers use, Homebrew on macOS included
  const home = Bun.env.HOME ?? "";
  const want = [`${home}/.local/bin`, `${home}/.bun/bin`, "/opt/homebrew/bin", "/usr/local/bin"];
  const path = (Bun.env.PATH ?? "/usr/bin:/bin").split(":");
  if (!Bun.env.HOLLR_GATE_PATH && want.some((d) => !path.includes(d) && existsSync(d))) {
    // compiled binary: execPath is hollr itself; `bun src/cli.ts`: execPath is bun + the script
    const script = Bun.argv[1]?.startsWith("/$bunfs/") ? [] : [Bun.argv[1] ?? ""];
    const child = Bun.spawn([process.execPath, ...script, ...Bun.argv.slice(2)], {
      env: { ...Bun.env, PATH: [...want, ...path].join(":"), HOLLR_GATE_PATH: "1" },
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    return await child.exited;
  }
  const original = (Bun.env.SSH_ORIGINAL_COMMAND ?? "").trim();
  const [cmd = "", pane = "", ...rest] = original.split(/\s+/);
  const herdr = new Herdr();
  if (
    ![
      "tree",
      "agents",
      "history",
      "screen",
      "timeline",
      "spaces",
      "fs",
      "usage",
      "ports",
      "tools",
      "sysinfo",
      "models",
      "events",
      "dirs",
    ].includes(cmd)
  )
    log("gate", original);
  if (pane && !["usage", "models", "sysinfo"].includes(cmd) && !PANE_RE.test(pane)) {
    json({ error: "bad_pane" });
    return 2;
  }
  // keys paired with older versions get the current options (browser forwarding);
  // only reads authorized_keys unless something is stale
  try {
    const n = upgradeDeviceKeys();
    if (n) log("gate", `upgraded ${n} device key(s)`);
  } catch (err) {
    log("gate", `key upgrade failed: ${err}`);
  }
  switch (cmd) {
    case "hello": {
      // the app shows how it is connected and can switch between LAN and Tailscale
      const ts = tailscaleInfo();
      json({
        hollr: VERSION,
        host: (await import("node:os")).hostname(),
        network: {
          lan: lanAddresses(),
          tailscale: {
            installed: ts.installed,
            state: ts.state ?? null,
            addresses: tailscaleAddresses(ts),
          },
        },
      });
      return 0;
    }
    case "agents":
      json({ agents: await herdr.agents() });
      return 0;
    case "tree":
      json({ workspaces: await herdr.tree() });
      return 0;
    case "kinds":
      json({ kinds: installedKinds() });
      return 0;
    case "new": {
      const req = JSON.parse((await readStdinLine()) || "{}") as NewChatRequest;
      if (!installedKinds().includes(req.kind)) {
        json({ error: `${req.kind} ist auf diesem Server nicht installiert.` });
        return 2;
      }
      json({ pane: await newChat(herdr, execHerdr, req) });
      return 0;
    }
    case "screen": {
      const lines = Math.min(Number(rest[0] ?? 40) || 40, 200);
      const text = await execHerdr([
        "pane",
        "read",
        pane,
        "--source",
        "visible",
        "--lines",
        String(lines),
      ]);
      json({ text: typeof text === "string" ? text.replace(/\s+$/g, "") : "" });
      return 0;
    }
    case "close":
      await execHerdr(["pane", "close", pane]);
      json({ ok: true });
      return 0;
    case "timeline": {
      // a pane that is gone: an answer the app understands, not empty output
      const agent = await agentOrError(herdr, pane);
      if (!agent) return 0;
      const file = agent.sessionFile ?? findSessionFile(agent.cwd, 0);
      const timeline = file
        ? await readTimeline(file, Number(rest[0] ?? 150))
        : { items: [], jobs: [], running: false, waiting: false };
      const screen = await execHerdr([
        "agent",
        "read",
        pane,
        "--source",
        "visible",
        "--lines",
        "4",
      ]).catch(() => "");
      const footer = parseFooter(typeof screen === "string" ? screen : "");
      const full = {
        ...timeline,
        status: agent.status,
        line: statusLine(agent.cwd, footer, (timeline as { model?: string }).model),
      };
      // the app polls often: with its last etag, an unchanged timeline is a few bytes, not ~100 KB
      const etag = createHash("sha1").update(JSON.stringify(full)).digest("base64url").slice(0, 16);
      if (rest[1] && rest[1] === etag) json({ same: true, etag });
      else json({ ...full, etag });
      return 0;
    }
    case "ports":
      json({ ports: await webPorts() });
      return 0;
    case "sysinfo":
      // pane slot carries the language: sysinfo en
      json(await sysinfo(VERSION, toLang(pane)));
      return 0;
    case "models":
      // pane slot carries the kind here: models omp [refresh]
      try {
        json(listModels(pane, rest[0] === "refresh"));
      } catch (err) {
        json({ error: err instanceof Error ? err.message : String(err) });
      }
      return 0;
    case "model": {
      const req = JSON.parse((await readStdinLine()) || "{}") as { model?: string; level?: string };
      try {
        const agent = await herdr.agent(pane);
        await herdr.prompt(pane, switchCommand(agent.kind, req.model ?? "", req.level));
        log("gate", `model ${pane} ${req.model}${req.level ? `:${req.level}` : ""}`);
        json({ ok: true });
      } catch (err) {
        json({ error: err instanceof Error ? err.message : String(err) });
      }
      return 0;
    }
    case "tools": {
      const req = JSON.parse((await readStdinLine()) || "{}") as {
        op?: string;
        name?: string;
        lang?: string;
      };
      try {
        if (req.op === "restart-watch") {
          log("gate", "tools restart-watch");
          json({ ok: restartWatcher() });
          return 0;
        }
        if (req.op === "run") {
          if (!TOOL_NAMES.includes(req.name as ToolName)) throw new Error("unbekanntes Werkzeug");
          log("gate", `tools run ${req.name}`);
          startTool(req.name as ToolName, VERSION);
        }
        const latest = await latestVersions(req.op === "check");
        json({ tools: toolStates(VERSION, latest, toLang(req.lang)) });
      } catch (err) {
        json({ error: err instanceof Error ? err.message : String(err) });
      }
      return 0;
    }
    case "push": {
      const req = JSON.parse((await readStdinLine()) || "{}") as {
        op?: string;
        token?: string;
        key?: string;
        keyId?: string;
        teamId?: string;
        bundleId?: string;
        env?: "sandbox" | "production";
        name?: string;
        prefs?: Record<string, boolean>;
        pane?: string;
        activity?: string | null;
      };
      try {
        if (req.op === "setup") {
          // the app installs the team's APNs key it keeps in its keychain
          if (!pushConfig()) {
            setupPushKey(req.key ?? "", req.keyId ?? "", req.teamId ?? "", req.bundleId);
            log("gate", "push key installed from app");
          }
        } else if (req.op === "register") registerDevice(req as never);
        else if (req.op === "activity")
          // a Live Activity started on the phone: its update token (null = ended)
          setActivityToken(req.token ?? "", req.pane ?? "", req.activity ?? null);
        else if (req.op === "unregister") unregisterDevice(req.token ?? "");
        else if (req.op === "export") {
          // the app copies the team's APNs key to another paired computer (asks you first)
          const config = pushConfig();
          if (!config) throw new Error("Auf diesem Rechner ist kein Push-Schlüssel eingerichtet");
          log("gate", "push key exported to a paired device");
          json({ ...config, key: readFileSync(join(pushDir(), "apns.p8"), "utf8") });
          return 0;
        }
        else if (req.op === "test") {
          const sent = await sendNotice({
            title: "Hollr",
            subtitle: (await import("node:os")).hostname(),
            body: "Test-Mitteilung – Push funktioniert.",
            thread: "hollr-test",
            kind: "done",
            data: {},
          });
          json({ configured: Boolean(pushConfig()), sent });
          return 0;
        }
        json({ configured: Boolean(pushConfig()), devices: pushDevices().length });
      } catch (err) {
        json({ error: err instanceof Error ? err.message : String(err) });
      }
      return 0;
    }
    case "spaces":
      json({ spaces: await listSpaces() });
      return 0;
    case "term":
      // live terminal: screen out, typing in (runs until the app closes the channel)
      return runTerm(pane);
    case "upload": {
      // a photo / file from the phone for the agent: stored outside the repo, the path goes into the prompt
      const req = JSON.parse((await readStdinLine(UPLOAD_LIMIT * 1.4)) || "{}") as { name?: string; data?: string };
      try {
        json({ path: saveUpload(req.name ?? "", req.data ?? "") });
      } catch (err) {
        json({ error: err instanceof Error ? err.message : String(err) });
      }
      return 0;
    }
    case "fs": {
      const req = JSON.parse((await readStdinLine()) || "{}") as FsRequest;
      try {
        json(await spaceFs(req));
      } catch (err) {
        json({ error: err instanceof Error ? err.message : String(err) });
      }
      return 0;
    }
    case "space": {
      const req = JSON.parse((await readStdinLine()) || "{}") as SpaceRequest;
      try {
        json(await manageSpace(req));
      } catch (err) {
        json({ error: err instanceof Error ? err.message : String(err) });
      }
      return 0;
    }
    case "usage":
      if (pane === "history") json(usageHistory(Number(rest[0] ?? 7)));
      else json(await usageLimits(pane === "refresh"));
      return 0;
    case "history": {
      const agent = await agentOrError(herdr, pane);
      if (!agent) return 0;
      const file = agent.sessionFile ?? findSessionFile(agent.cwd, 0);
      json({
        events: file ? await readHistory(file, Number(rest[0] ?? 60)) : [],
        status: agent.status,
      });
      return 0;
    }
    case "events":
      return await runEvents();
    case "dirs": {
      const req = JSON.parse((await readStdinLine()) || "{}") as { path?: string };
      try {
        json(listDirs(req.path));
      } catch (err) {
        json({ error: err instanceof Error ? err.message : String(err) });
      }
      return 0;
    }
    case "live":
      await runLive(pane, herdr, {
        input: Bun.stdin.stream() as unknown as AsyncIterable<Uint8Array>,
        write: (bytes) => process.stdout.write(bytes),
      });
      return 0;
    case "prompt": {
      const { text } = JSON.parse((await readStdinLine()) || "{}") as { text?: string };
      if (!text) return 2;
      await herdr.prompt(pane, text);
      json({ ok: true });
      return 0;
    }
    case "keys":
      await herdr.sendKeys(pane, rest.slice(0, 10));
      json({ ok: true });
      return 0;
    default:
      json({
        error: "not_allowed",
        hint: "hello | events | tree | kinds | new | close <pane> | ports | history <pane> | live <pane> | prompt <pane> | keys <pane> <key>...",
      });
      return 2;
  }
}

async function enrollCmd(id: string): Promise<number> {
  let asked = false;
  try {
    const input = JSON.parse(await readStdinLine()) as { pub?: string; name?: string };
    // `hollr pair` in a terminal asks first: a scanned code alone is not enough
    asked = await awaitConfirmation(id, input.name ?? "iPhone");
    const device = enroll(id, input.pub ?? "", input.name ?? "iPhone");
    json({
      ok: true,
      device: device.id,
      name: device.name,
      user: (await import("node:os")).userInfo().username,
    });
    return 0;
  } catch (err) {
    // a confirmed code that still failed is spent too (never enrolls later without a yes)
    if (asked) removeBootstrap(id);
    json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    return 1;
  } finally {
    if (asked) endConfirmation(id);
  }
}

const MODE_LABEL: Record<NetworkMode, string> = {
  lan: "Lokales Netzwerk",
  tailscale: "Tailscale / Fernzugriff",
  auto: "Automatisch (alle Adressen)",
};

const ask = (question: string, fallback = "") => (prompt(question) ?? fallback).trim();
const yes = (question: string) => !/^n/i.test(ask(`${question} [J/n] `));

/** Interactive: which connection the phone should use. */
function chooseMode(ts: TailscaleInfo): NetworkMode {
  const tsState = !ts.installed
    ? "nicht installiert"
    : ts.state === "Running"
      ? `läuft – ${ts.dnsName ?? ts.ips[0] ?? ""}`
      : ts.state === "NeedsLogin"
        ? "nicht angemeldet"
        : "gestoppt";
  console.log("Wie soll sich das iPhone verbinden?\n");
  console.log(
    "  1) Lokales Netzwerk        – iPhone und Rechner im selben WLAN, kein Zusatzdienst",
  );
  console.log(
    `  2) Tailscale / Fernzugriff – auch von unterwegs, ohne offene Ports (Tailscale: ${tsState})\n`,
  );
  return ask("Auswahl [1]: ", "1") === "2" ? "tailscale" : "lan";
}

/** Makes Tailscale usable here (start / log in), guiding through what can't be automated. */
async function ensureTailscale(interactive: boolean): Promise<TailscaleInfo | undefined> {
  let ts = tailscaleInfo();
  if (ts.state === "Running" && tailscaleAddresses(ts).length) return ts;
  console.log("\nTailscale ist hier noch nicht bereit:");
  for (const step of tailscaleSteps(ts)) console.log(`  • ${step}`);
  if (!interactive || !ts.installed || !ts.cli) return undefined;
  if (!yes("\nJetzt „tailscale up“ ausführen (startet die Verbindung, ggf. mit Anmelde-Link)?"))
    return undefined;
  const up = Bun.spawn([ts.cli, "up"], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  const until = Date.now() + 180_000;
  while (Date.now() < until) {
    await Bun.sleep(1500);
    ts = tailscaleInfo();
    if (ts.state === "Running" && tailscaleAddresses(ts).length) break;
  }
  up.kill();
  return ts.state === "Running" ? ts : undefined;
}

async function pair(args: string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`hollr pair [--lan|--tailscale] [--code] [--name LABEL] [--host ADDR] [--port N] [--link] [--yes]

  Koppelt ein Gerät: zeigt einen QR-Code (und einen Einmalcode), gültig 10 Minuten, einmal nutzbar.
  --lan / --tailscale   Verbindungsart (sonst Auswahl)
  --code                nur den Einmalcode zeigen
  --link                den Kopplungs-Link ausgeben (für die Mac-/Desktop-App)
  --yes                 ohne Rückfrage bestätigen`);
    return 0;
  }
  const interactive =
    Boolean(process.stdin.isTTY && process.stdout.isTTY) && !args.includes("--yes");
  const hosts = flag(args, "--host");
  let ts = tailscaleInfo();
  const requested = flag(args, "--network")[0];
  let mode: NetworkMode = args.includes("--tailscale")
    ? "tailscale"
    : args.includes("--lan")
      ? "lan"
      : requested === "lan" || requested === "tailscale" || requested === "auto"
        ? requested
        : hosts.length || !interactive
          ? "auto"
          : chooseMode(ts);
  if (mode === "tailscale" && !hosts.length) {
    const ready = await ensureTailscale(interactive);
    if (ready) ts = ready;
    else if (interactive && yes("\nStattdessen über das lokale Netzwerk koppeln?")) mode = "lan";
    else {
      console.log("\nDanach erneut:  hollr pair --tailscale");
      return 1;
    }
  }
  const addresses = hosts.length ? hosts : addressesFor(mode, ts);
  const wantCode = interactive || args.includes("--code");
  // the code carries one IPv4: Tailscale's when remote, the LAN one otherwise
  const codeIp =
    (mode !== "lan" ? ts.ips[0] : undefined) ??
    addresses.find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a) && !isTailscaleIp(a)) ??
    addresses.find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a));

  /** One pairing: bootstrap key, QR code and (optionally) the one-time code for the same payload. */
  const issue = async () => {
    const { seed, publicLine } = newBootstrapKey();
    const { id, exp } = addBootstrap(publicLine);
    if (interactive && !args.includes("--no-confirm")) requireConfirmation(id);
    const payload = buildPayload({
      seed,
      exp,
      addresses,
      port: Number(flag(args, "--port")[0] ?? 22),
      label: flag(args, "--name")[0],
      network: mode,
    });
    const url = payloadUrl(payload);
    console.log(await QRCode.toString(url, { type: "utf8", errorCorrectionLevel: "L", margin: 2 }));
    let otp: OtpServer | undefined;
    if (wantCode && codeIp) {
      try {
        otp = serveCode(codeIp, JSON.stringify(payload), exp);
      } catch (err) {
        console.log(
          `(Kein Code: Port ${OTP_PORT} auf ${codeIp} belegt – ${err instanceof Error ? err.message : err})`,
        );
      }
    }
    const until = new Date(exp * 1000).toLocaleTimeString("de-DE", {
      hour: "2-digit",
      minute: "2-digit",
    });
    console.log(`Mit der iPhone-Kamera oder in Hollr scannen – oder in Hollr „Code eingeben“:`);
    if (otp) console.log(`\n      Code:  ${otp.code}\n`);
    console.log(`Gültig bis ${until} (${PAIRING_TTL_SEC / 60} Min.), einmal nutzbar.`);
    console.log(
      `Verbindung: ${MODE_LABEL[mode]} · ${payload.u}@${payload.a.join(" / ")}:${payload.p}`,
    );
    console.log(`Host-Key: ${payload.fp}`);
    if (mode === "tailscale") console.log(IPHONE_TAILSCALE_HINT);
    if (args.includes("--link")) console.log(`\nLink (wie ein Passwort behandeln):\n${url}`);
    return { id, exp, otp };
  };

  let current = await issue();
  if (!interactive && !current.otp) return 0;
  // Strg+C, closed terminal: the one-time key must not outlive this command
  const abort = () => {
    current.otp?.stop();
    removeBootstrap(current.id);
    process.exit(130);
  };
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, abort);

  // wait for the phone: confirm here, "n" = new code, then report the result
  const lines: string[] = [];
  if (interactive) {
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) =>
      lines.push(...chunk.split("\n").filter((_, i, a) => i < a.length - 1 || _)),
    );
  }
  console.log(
    interactive
      ? "\nWarte auf das iPhone … („n“ + Enter = neuer Code, Strg+C = Abbrechen)"
      : "\nWarte auf das iPhone …",
  );
  const before = new Set(listDevices().map((d) => d.id));
  try {
    while (Date.now() / 1000 < current.exp) {
      const request = pendingRequest(current.id);
      if (request) {
        process.stdout.write(
          `\n„${request.name}“ möchte sich mit diesem Rechner koppeln. Erlauben? [J/n] `,
        );
        lines.length = 0;
        while (!lines.length) await Bun.sleep(100);
        const allow = !/^n/i.test(lines.shift()?.trim() ?? "");
        answerRequest(current.id, allow);
        if (!allow) {
          removeBootstrap(current.id);
          console.log("Abgelehnt – der Code ist damit verbraucht.");
          return 1;
        }
      } else if (lines.length) {
        const line = lines.shift()?.trim().toLowerCase();
        if (line === "n") {
          current.otp?.stop();
          removeBootstrap(current.id);
          console.log("\nNeuer Code:\n");
          current = await issue();
        }
      }
      const added = listDevices().find((d) => !before.has(d.id));
      if (added) {
        console.log(
          `\n✓ ${added.name} ist gekoppelt (Gerät ${added.id}). Entfernen jederzeit mit: hollr revoke ${added.id}`,
        );
        return 0;
      }
      await Bun.sleep(400);
    }
    console.log("\nDer Code ist abgelaufen. Neu:  hollr pair");
    return 1;
  } finally {
    current.otp?.stop();
    // nothing paired (expired, rejected, aborted): drop the one-time key now, not only at expiry
    if (!listDevices().some((d) => !before.has(d.id))) removeBootstrap(current.id);
    for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.off(sig, abort);
    process.stdin.pause();
  }
}

async function main(argv: string[]): Promise<number> {
  const [cmd = "help", ...args] = argv;
  switch (cmd) {
    case "gate":
      return gate();
    case "enroll":
      return enrollCmd(args[0] ?? "");
    case "pair":
      return pair(args);
    case "devices": {
      const devices = listDevices();
      if (devices.length === 0) console.log("Noch keine Geräte gekoppelt. → hollr pair");
      for (const d of devices) console.log(`${d.id}  ${d.name.padEnd(24)}  ${d.fingerprint}`);
      return 0;
    }
    case "revoke": {
      const removed = revokeDevice(args[0] ?? "");
      console.log(
        removed.length
          ? `Entfernt: ${removed.map((d) => d.name || d.id).join(", ")}`
          : "Nichts gefunden.",
      );
      return removed.length ? 0 : 1;
    }
    case "doctor":
      return runDoctor();
    case "watch":
      return runWatch();
    case "push": {
      const [sub = "status", ...rest] = args;
      if (sub === "setup") {
        const [file = "", keyId = "", teamId = ""] = rest;
        if (!file) {
          console.log("hollr push setup <AuthKey_XXXX.p8> <KEY_ID> <TEAM_ID>");
          return 2;
        }
        setupPush(file, keyId, teamId, flag(rest, "--bundle")[0]);
        console.log("APNs-Schlüssel gespeichert. Test: hollr push test");
        return 0;
      }
      if (sub === "test") {
        const sent = await sendNotice({
          title: "Hollr",
          subtitle: (await import("node:os")).hostname(),
          body: "Test-Mitteilung – Push funktioniert.",
          thread: "hollr-test",
          kind: "done",
          data: {},
        });
        console.log(`An ${sent} von ${pushDevices().length} Gerät(en) gesendet.`);
        return sent ? 0 : 1;
      }
      const config = pushConfig();
      console.log(
        config
          ? `APNs: Key ${config.keyId}, Team ${config.teamId}, ${config.bundleId}`
          : "APNs: nicht eingerichtet (hollr push setup)",
      );
      for (const d of pushDevices())
        console.log(`  ${d.name.padEnd(20)} ${d.env.padEnd(10)} …${d.token.slice(-8)}`);
      return 0;
    }
    case "logs": {
      const n = Number(args[0] ?? 60);
      const res = Bun.spawnSync(["tail", "-n", String(n), LOG_FILE]);
      process.stdout.write(res.stdout.toString() || "(noch keine Logs)\n");
      return 0;
    }
    case "agents":
      json(await new Herdr().agents());
      return 0;
    case "tree":
      json(await new Herdr().tree());
      return 0;
    case "version":
    case "--version":
      console.log(VERSION);
      return 0;
    default:
      console.log(`hollr ${VERSION}

  hollr pair [--name LABEL] [--host ADDR] [--port N] [--link]   iPhone koppeln (QR-Code)
  hollr devices                                                 gekoppelte Geräte
  hollr revoke <id|name>                                        Gerät entfernen
  hollr doctor                                                  Server-Setup prüfen
  hollr logs [n]                                                letzte Log-Zeilen
  hollr push setup <key.p8> <KEY_ID> <TEAM_ID>                  Push-Mitteilungen einrichten
  hollr push [status|test]                                      Push prüfen
  hollr watch                                                   Wächter (läuft als systemd-Dienst)`);
      return cmd === "help" || cmd === "--help" ? 0 : 2;
  }
}

if (import.meta.main) {
  main(Bun.argv.slice(2))
    // let large outputs (timeline) drain into the SSH channel before exiting
    .then(async (code) => {
      await pendingOutput;
      process.exit(code);
    })
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
