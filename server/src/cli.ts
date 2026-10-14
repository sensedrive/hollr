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
import { existsSync } from "node:fs";
import QRCode from "qrcode";
import { runDoctor } from "./doctor";
import { runEvents } from "./events";
import { execHerdr, Herdr, installedKinds, type NewChatRequest, newChat } from "./herdr";
import { toLang } from "./i18n";
import { runLive } from "./live";
import { LOG_FILE, log } from "./log";
import { listModels, switchCommand } from "./models";
import {
  addBootstrap,
  buildPayload,
  enroll,
  listDevices,
  newBootstrapKey,
  PAIRING_TTL_SEC,
  payloadUrl,
  revokeDevice,
  upgradeDeviceKeys,
} from "./pairing";
import { webPorts } from "./ports";
import {
  pushConfig,
  pushDevices,
  registerDevice,
  sendNotice,
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
import { sysinfo } from "./sysinfo";
import { readTimeline } from "./timeline";
import { latestVersions, startTool, TOOL_NAMES, type ToolName, toolStates } from "./tools";
import { usageHistory } from "./usagehistory";
import { runWatch } from "./watch";

export const VERSION = "0.19.1";

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
    case "hello":
      json({ hollr: VERSION, host: (await import("node:os")).hostname() });
      return 0;
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
      const agent = await herdr.agent(pane);
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
      json({
        ...timeline,
        status: agent.status,
        line: statusLine(agent.cwd, footer, (timeline as { model?: string }).model),
      });
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
      };
      try {
        if (req.op === "setup") {
          // the app installs the team's APNs key it keeps in its keychain
          if (!pushConfig()) {
            setupPushKey(req.key ?? "", req.keyId ?? "", req.teamId ?? "", req.bundleId);
            log("gate", "push key installed from app");
          }
        } else if (req.op === "register") registerDevice(req as never);
        else if (req.op === "unregister") unregisterDevice(req.token ?? "");
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
      const agent = await herdr.agent(pane);
      const file = agent.sessionFile ?? findSessionFile(agent.cwd, 0);
      json({
        events: file ? await readHistory(file, Number(rest[0] ?? 60)) : [],
        status: agent.status,
      });
      return 0;
    }
    case "events":
      return await runEvents();
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
  try {
    const input = JSON.parse(await readStdinLine()) as { pub?: string; name?: string };
    const device = enroll(id, input.pub ?? "", input.name ?? "iPhone");
    json({
      ok: true,
      device: device.id,
      name: device.name,
      user: (await import("node:os")).userInfo().username,
    });
    return 0;
  } catch (err) {
    json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    return 1;
  }
}

async function pair(args: string[]): Promise<number> {
  const { seed, publicLine } = newBootstrapKey();
  const { exp } = addBootstrap(publicLine);
  const payload = buildPayload({
    seed,
    exp,
    addresses: flag(args, "--host"),
    port: Number(flag(args, "--port")[0] ?? 22),
    label: flag(args, "--name")[0],
  });
  const url = payloadUrl(payload);
  console.log(await QRCode.toString(url, { type: "utf8", errorCorrectionLevel: "L", margin: 2 }));
  console.log(
    `Mit der iPhone-Kamera oder in Hollr scannen. Gültig ${PAIRING_TTL_SEC / 60} Minuten, einmal nutzbar.`,
  );
  console.log(
    `Server: ${payload.u}@${payload.a.join(" / ")}:${payload.p}   Host-Key: ${payload.fp}`,
  );
  if (args.includes("--link")) console.log(`\nLink (wie ein Passwort behandeln):\n${url}`);
  return 0;
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
