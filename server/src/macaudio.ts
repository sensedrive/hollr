/**
 * Live audio on macOS. omp talks to CoreAudio's *default* devices there (no PulseAudio), so for the
 * length of a call the Mac's defaults point at two BlackHole loopback devices:
 *   phone → sox → "BlackHole 2ch"  → default input  → omp's microphone
 *   omp → default output → "BlackHole 16ch" → sox (in a herdr tab, see SpeakerCapture) → phone
 * The previous defaults are saved to a file first and restored afterwards – also after a crash
 * (the next call or `hollr doctor` puts them back).
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { type Herdr, LIVE_AUDIO_TAB } from "./herdr";
import { log } from "./log";

export const MIC_DEVICE = "BlackHole 2ch";
export const SPEAKER_DEVICE = "BlackHole 16ch";
export const MAC_SETUP =
  "brew install sox switchaudio-osx && brew install --cask blackhole-2ch blackhole-16ch";

const stateFile = () => join(homedir(), ".local", "state", "hollr", "mac-audio-defaults.json");

function run(args: string[]): string {
  try {
    const res = Bun.spawnSync(args, { stdout: "pipe", stderr: "ignore", timeout: 5000 });
    return res.exitCode === 0 ? res.stdout.toString().trim() : "";
  } catch {
    return "";
  }
}

const has = (cmd: string) => run(["sh", "-c", `command -v ${cmd}`]) !== "";

function devices(type: "input" | "output"): string[] {
  return run(["SwitchAudioSource", "-a", "-t", type]).split("\n").filter(Boolean);
}

/** What is missing for live calls on this Mac ([] = ready). */
export function macAudioMissing(): string[] {
  const missing: string[] = [];
  if (!has("sox")) missing.push("sox");
  if (!has("SwitchAudioSource")) missing.push("switchaudio-osx");
  else {
    if (!devices("output").includes(MIC_DEVICE)) missing.push(MIC_DEVICE);
    if (!devices("input").includes(SPEAKER_DEVICE)) missing.push(SPEAKER_DEVICE);
  }
  return missing;
}

const current = (type: "input" | "output" | "system") => run(["SwitchAudioSource", "-c", "-t", type]);
const select = (type: "input" | "output" | "system", name: string) =>
  run(["SwitchAudioSource", "-t", type, "-s", name]);

/** Puts back the defaults a previous (crashed) call left switched. */
export function restoreMacDefaults(): boolean {
  try {
    const saved = JSON.parse(readFileSync(stateFile(), "utf8")) as {
      input?: string;
      output?: string;
    };
    if (saved.input) select("input", saved.input);
    if (saved.output) select("output", saved.output);
    rmSync(stateFile(), { force: true });
    return true;
  } catch {
    return false;
  }
}

const pcm = ["-t", "raw", "-r", "24000", "-e", "signed-integer", "-b", "16", "-c", "1"];

/** Shell command for the capture tab: sox recording what omp plays into BlackHole 16ch as mono
 * 24 kHz into `fifo`. omp doesn't always use channels 1/2 (seen: only channel 3), and a plain
 * downmix divides by 16 – so sum all channels unscaled (`remix -m`); only omp plays there.
 * `exec`: the tab closes when sox ends; the leading space keeps it out of the shell history. */
export function speakerCaptureCommand(sox: string, fifo: string): string {
  const args = [sox, "-q", "-t", "coreaudio", SPEAKER_DEVICE, ...pcm, fifo, "remix", "-m", "1-16"];
  return ` exec ${args.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(" ")}`;
}

/**
 * Records omp's voice where macOS allows it. Recording – a loopback device too – needs the
 * microphone permission, and macOS grants none to processes started by sshd (TCC: "Policy disallows
 * prompt for sshd-keygen-wrapper"): CoreAudio then delivers pure silence, without an error. omp
 * itself records fine because it runs under herdr, which carries the permission of the terminal
 * app herdr was started from. So sox runs in a background herdr tab next to omp and hands the
 * audio over through a FIFO; the tab goes away with sox.
 */
export class SpeakerCapture {
  readonly fifo: string;
  private tab?: string;

  constructor(
    private readonly herdr: Herdr,
    private readonly workspace: string,
    private readonly sox: string,
    dir = tmpdir(),
    private readonly shellStartMs = 400,
  ) {
    this.fifo = join(dir, `hollr-speaker-${process.pid}.fifo`);
  }

  async start(): Promise<void> {
    rmSync(this.fifo, { force: true });
    const made = Bun.spawnSync(["mkfifo", "-m", "600", this.fifo], { stderr: "pipe" });
    if (made.exitCode !== 0) throw new Error(`mkfifo: ${made.stderr.toString().trim()}`);
    const { tab, pane } = await this.herdr.openTab(this.workspace, LIVE_AUDIO_TAB);
    this.tab = tab;
    await Bun.sleep(this.shellStartMs); // let the shell come up
    await this.herdr.run(pane, speakerCaptureCommand(this.sox, this.fifo));
  }

  /** omp's voice as it arrives (waits for sox to open the FIFO). Killing it ends sox (EPIPE). */
  reader(): Subprocess<"ignore", "pipe", "ignore"> {
    return Bun.spawn(["cat", this.fifo], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  }

  async stop(): Promise<void> {
    const tab = this.tab;
    this.tab = undefined;
    // usually gone already (sox exits once its reader is killed)
    if (tab) await this.herdr.closeTab(tab).catch(() => {});
    rmSync(this.fifo, { force: true });
  }
}

export class MacAudioSession {
  private readonly capture: SpeakerCapture;

  /** `workspace`: omp's herdr workspace, where the speaker capture tab opens. */
  constructor(
    private readonly herdr: Herdr,
    private readonly pane: string,
    workspace: string,
  ) {
    this.capture = new SpeakerCapture(
      herdr,
      workspace,
      run(["sh", "-c", "command -v sox"]) || "sox",
    );
  }

  async create(): Promise<void> {
    // keep the defaults from before a crashed call, not the BlackHole ones it left behind
    if (!existsSync(stateFile())) {
      const input = current("input");
      const output = current("output");
      mkdirSync(join(stateFile(), ".."), { recursive: true });
      writeFileSync(stateFile(), JSON.stringify({ input, output }));
    }
    select("input", MIC_DEVICE);
    select("output", SPEAKER_DEVICE);
    // The volume slider/keys act on the default output – BlackHole now. At 69 % omp reached the
    // phone ~20 dB too quiet (peaks ~0.04): nothing to hear. AppleScript sets the alert ("system")
    // device too, i.e. the Mac's speakers – point that at BlackHole for the moment.
    const system = current("system");
    select("system", SPEAKER_DEVICE);
    run(["osascript", "-e", "set volume output volume 100 without output muted"]);
    if (system) select("system", system);
    // without it the call still works, omp just isn't heard
    await this.capture
      .start()
      .catch((e) => log("live", this.pane, "speaker capture failed", String(e)));
  }

  /** Whether omp is live in the pane (its footer) – CoreAudio has no per-app streams. */
  async attach(_pid: number): Promise<{ capturing: boolean; playing: boolean }> {
    const live = await this.herdr.liveActive(this.pane).catch(() => false);
    return { capturing: live, playing: live };
  }

  /** sox writing phone audio into BlackHole 2ch (comes out of its input side as omp's mic).
   * Playing needs no permission, so this one runs right here. */
  spawnMicWriter(): Subprocess<"pipe", "ignore", "pipe"> {
    return Bun.spawn(["sox", "-q", ...pcm, "-", "-t", "coreaudio", MIC_DEVICE], {
      stdin: "pipe",
      stdout: "ignore",
      stderr: "pipe",
    });
  }

  spawnSpeakerReader(): Subprocess<"ignore", "pipe", "ignore"> {
    return this.capture.reader();
  }

  async destroy(): Promise<void> {
    await this.capture.stop();
    const saved = (() => {
      try {
        return JSON.parse(readFileSync(stateFile(), "utf8")) as { input?: string; output?: string };
      } catch {
        return undefined;
      }
    })();
    restoreMacDefaults();
    // CoreAudio sometimes settles late (omp releasing its devices): check once more and correct
    if (saved) {
      await Bun.sleep(700);
      if (saved.input && current("input") !== saved.input) select("input", saved.input);
      if (saved.output && current("output") !== saved.output) select("output", saved.output);
    }
  }
}
