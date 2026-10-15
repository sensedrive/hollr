/**
 * One live voice session: phone <-> SSH exec channel <-> virtual devices <-> omp /live.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { encodeFrame, encodeJson, FRAME_AUDIO, FRAME_JSON, FrameDecoder } from "./frames";
import type { Herdr } from "./herdr";
import { log } from "./log";
import { MAC_SETUP, MacAudioSession, macAudioMissing, restoreMacDefaults } from "./macaudio";
import { cleanupStale, PulseSession, pulseAvailable } from "./pulse";

/** Virtual mic/speaker for one call: PulseAudio on Linux, BlackHole on macOS. */
interface AudioRoute {
  create(): Promise<void>;
  attach(pid: number): Promise<{ capturing: boolean; playing: boolean }>;
  spawnMicWriter(): {
    stdin: { write(data: Uint8Array): unknown };
    kill(): void;
    exited?: Promise<number>;
  };
  spawnSpeakerReader(): { stdout: AsyncIterable<Uint8Array>; kill(): void };
  destroy(): Promise<void>;
}

import { findSessionFile, SessionTail } from "./sessionlog";

export interface LiveIO {
  input: AsyncIterable<Uint8Array>;
  write: (bytes: Uint8Array) => void;
}

type Control = { t?: string; on?: boolean; text?: string; keys?: string[] };

const SILENCE_20MS = new Uint8Array(960); // 24 kHz * 2 bytes * 0.02 s
/** The phone sends audio or a ping every 5 s even when muted – silence this long = gone. */
export const INPUT_TIMEOUT_MS = 20_000;

function lockDir(): string {
  const base = Bun.env.XDG_RUNTIME_DIR || tmpdir();
  const dir = join(base, "hollr");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Returns the lock file, or undefined if another phone is live. `stale` = a previous call died. */
function acquireLock(pane: string): { file: string; stale: boolean } | undefined {
  const file = join(lockDir(), `${pane.replace(/[^\w]/g, "_")}.lock`);
  let stale = false;
  if (existsSync(file)) {
    const pid = Number(readFileSync(file, "utf8"));
    try {
      if (pid && pid !== process.pid) {
        process.kill(pid, 0);
        return undefined; // another phone is live on this pane
      }
    } catch {
      stale = true;
    }
  }
  writeFileSync(file, String(process.pid));
  return { file, stale };
}

export async function runLive(
  pane: string,
  herdr: Herdr,
  io: LiveIO,
  timeoutMs = INPUT_TIMEOUT_MS,
): Promise<void> {
  let broken = false;
  const write = (bytes: Uint8Array) => {
    if (broken) return;
    try {
      io.write(bytes);
    } catch {
      broken = true; // phone gone (EPIPE) – cleanup happens via end()
    }
  };
  const send = (msg: Record<string, unknown>) => write(encodeJson(msg));
  const fail = (code: string, message: string) => {
    log("live", pane, "error", code, message);
    send({ t: "error", code, message });
  };
  log("live", pane, "start");

  const acquired = acquireLock(pane);
  if (!acquired) return fail("busy", "Auf dieser Session ist schon jemand live.");
  const lock = acquired.file;

  const agent = await herdr.agent(pane).catch(() => undefined);
  if (!agent) {
    rmSync(lock, { force: true });
    return fail("not_found", `Agent ${pane} nicht gefunden.`);
  }
  if (agent.kind !== "omp") {
    rmSync(lock, { force: true });
    return fail("unsupported", `Live gibt es nur für omp (Agent ist ${agent.kind}).`);
  }
  // macOS: omp uses the default CoreAudio devices – switched to BlackHole for the call
  const mac = platform() === "darwin";
  if (mac) {
    const missing = macAudioMissing();
    if (missing.length) {
      rmSync(lock, { force: true });
      return fail(
        "mac_setup",
        `Für Live-Sprache braucht der Mac einmalig virtuelle Audiogeräte (fehlt: ${missing.join(", ")}). Am Mac im Terminal: ${MAC_SETUP}`,
      );
    }
    restoreMacDefaults(); // a crashed call left the Mac switched
    // omp already live at the Mac itself: that's someone sitting there, don't take it over
    if (!acquired.stale && (await herdr.liveState(pane).catch(() => undefined))) {
      rmSync(lock, { force: true });
      return fail(
        "busy",
        "omp ist am Mac gerade selbst live – dort beenden (Esc), dann hier starten.",
      );
    }
  }
  const pid = await herdr.agentPid(pane, "omp");
  if (!pid || (!mac && !(await pulseAvailable()))) {
    rmSync(lock, { force: true });
    return fail(
      "no_audio",
      "PulseAudio läuft nicht oder omp-Prozess nicht gefunden. `hollr doctor` ausführen.",
    );
  }

  if (!mac) await cleanupStale();
  const pulse: AudioRoute = mac
    ? new MacAudioSession(() => herdr.liveActive(pane))
    : new PulseSession(String(process.pid));
  let ending = false;
  // a crashed previous call left /live running – treat it as ours so it gets stopped
  let startedLive = acquired.stale;
  let muted = false;
  let lastMicAt = Date.now();
  const timers: Array<ReturnType<typeof setInterval>> = [];
  const startedAt = Date.now();
  let tail: SessionTail | undefined;
  const followSession = (file?: string) => {
    if (!file || tail?.file === file) return;
    tail?.stop();
    tail = new SessionTail(file, (e) => send(e), startedAt);
    tail.start();
  };

  await pulse.create();
  // the process that feeds the phone's audio to omp: if it ever exits mid-call, start it again
  // (otherwise omp keeps "listening" to nothing) – and log why it went away
  const spawnMic = () => {
    const proc = pulse.spawnMicWriter();
    const err = (proc as { stderr?: unknown }).stderr;
    if (err instanceof ReadableStream)
      void new Response(err)
        .text()
        .then((t) => t.trim() && log("live", pane, "mic stderr", t.slice(0, 300)));
    void (proc as { exited?: Promise<number> }).exited?.then((code) => {
      if (ending) return;
      log("live", pane, "mic writer exited", { code });
      mic.current = spawnMic();
    });
    return proc;
  };
  const mic = {
    current: spawnMic(),
    write(data: Uint8Array) {
      try {
        this.current.stdin.write(data);
      } catch {}
    },
    kill() {
      this.current.kill();
    },
  };
  const speaker = pulse.spawnSpeakerReader();

  // ends the read loop even while it waits for input that never comes (dead network)
  let stopInput = () => {};
  const inputStopped = new Promise<IteratorReturnResult<undefined>>((resolve) => {
    stopInput = () => resolve({ done: true, value: undefined });
  });

  // every caller waits for the same cleanup (restoring devices must finish before the process exits)
  let ended: Promise<void> | undefined;
  const end = (reason: string): Promise<void> => {
    ended ??= finish(reason);
    return ended;
  };
  const finish = async (reason: string) => {
    ending = true;
    stopInput();
    log("live", pane, "end", reason, { startedLive, ms: Date.now() - startedAt });
    for (const t of timers) clearInterval(t);
    tail?.stop();
    try {
      const state = await pulse.attach(pid);
      if (startedLive && state.capturing) {
        await herdr.sendKeys(pane, ["ctrl+l"]); // omp default for app.live.toggle
        for (let i = 0; i < 10 && (await pulse.attach(pid)).capturing; i++) await Bun.sleep(200);
        if ((await pulse.attach(pid)).capturing) await herdr.sendKeys(pane, ["esc"]);
        for (let i = 0; i < 25 && (await pulse.attach(pid)).capturing; i++) await Bun.sleep(200);
      }
    } catch {}
    speaker.kill();
    mic.kill();
    await pulse.destroy();
    rmSync(lock, { force: true });
    send({ t: "phase", phase: "ended", reason });
  };

  // sshd sends SIGHUP/SIGTERM when the phone disconnects – always clean up
  for (const sig of ["SIGHUP", "SIGTERM", "SIGINT", "SIGPIPE"] as const) {
    process.on(sig, () => void end("disconnected").finally(() => process.exit(0)));
  }

  // omp speaker -> phone
  void (async () => {
    for await (const chunk of speaker.stdout) {
      if (ending) break;
      write(encodeFrame(FRAME_AUDIO, chunk));
    }
  })();

  // Keep the virtual mic fed: the realtime model's clock runs on input audio,
  // so mute and network gaps are filled with silence instead of nothing.
  timers.push(
    setInterval(() => {
      if (ending) return;
      if (muted || Date.now() - lastMicAt > 100) mic.write(SILENCE_20MS);
    }, 20),
  );

  // Start /live (or take over a session that is already live)
  send({ t: "phase", phase: "connecting", agent });
  let state = await pulse.attach(pid);
  if (!state.capturing) {
    await herdr.run(pane, "/live");
    startedLive = true;
    for (let i = 0; i < 75 && !state.capturing; i++) {
      await Bun.sleep(200);
      state = await pulse.attach(pid);
    }
  }
  if (!state.capturing) {
    // don't leave a half-started /live behind (it would keep listening on the server)
    if (startedLive && (await herdr.liveState(pane).catch(() => undefined)))
      await herdr.sendKeys(pane, ["esc"]).catch(() => {});
    // error first: after "ended" the phone stops listening
    fail(
      "start_failed",
      "omp /live ist nicht gestartet. Ist der Agent gerade beschäftigt oder nicht eingeloggt?",
    );
    return void (await end("start_failed"));
  }
  log("live", pane, "live", { pid, took: Date.now() - startedAt });
  send({ t: "phase", phase: "live" });
  followSession(agent.sessionFile);

  // Keep routing new omp streams, watch agent status and whether live is still on
  let lastStatus = agent.status;
  let ompState: string | undefined;
  timers.push(
    setInterval(async () => {
      if (ending) return;
      const s = await pulse.attach(pid).catch(() => ({ capturing: true, playing: false }));
      if (!s.capturing) return void end("live_stopped");
      const a = await herdr.agent(pane).catch(() => undefined);
      // a fresh omp session only gets its file on the first message
      followSession(a?.sessionFile ?? findSessionFile(agent.cwd, startedAt));
      if (a && a.status !== lastStatus) {
        lastStatus = a.status;
        send({ t: "status", status: a.status });
      }
      // omp's own live state (listening / speaking / working / muted)
      const state = await herdr.liveState(pane).catch(() => undefined);
      if (state && state !== ompState) {
        ompState = state;
        send({ t: "omp", state });
      }
    }, 1000),
  );

  // phone -> omp mic + control
  const decoder = new FrameDecoder();
  const input = io.input[Symbol.asyncIterator]();
  // heartbeat: a dropped network never closes the channel, sshd would wait ~2 h
  let lastInputAt = Date.now();
  // only for clients that ping: older apps send nothing while muted and would be cut off
  let pings = false;
  timers.push(
    setInterval(() => {
      if (pings && !ending && Date.now() - lastInputAt > timeoutMs) void end("disconnected");
    }, 1000),
  );
  try {
    while (true) {
      const next = await Promise.race([input.next(), inputStopped]);
      if (next.done || ending) break;
      const chunk = next.value;
      lastInputAt = Date.now();
      for (const frame of decoder.push(chunk)) {
        if (frame.type === FRAME_AUDIO) {
          if (!muted) {
            mic.write(frame.data);
            lastMicAt = Date.now();
          }
        } else if (frame.type === FRAME_JSON) {
          const c = frame.data as Control;
          if (c.t === "stop") return void (await end("hangup"));
          if (c.t === "mute") {
            // same as pressing Space in omp: toggles omp's own live mute
            const want = Boolean(c.on);
            const isMuted =
              (ompState ?? (await herdr.liveState(pane).catch(() => undefined))) === "muted";
            if (want !== isMuted) await herdr.sendKeys(pane, ["space"]).catch(() => {});
            muted = want;
          }
          if (c.t === "prompt" && c.text) await herdr.prompt(pane, c.text).catch(() => {});
          if (c.t === "keys" && Array.isArray(c.keys))
            await herdr.sendKeys(pane, c.keys).catch(() => {});
          if (c.t === "ping") {
            pings = true;
            send({ t: "pong" });
          }
        }
      }
    }
  } finally {
    await end("disconnected");
  }
}
