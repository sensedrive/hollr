/**
 * Live audio on macOS. omp talks to CoreAudio's *default* devices there (no PulseAudio), so for the
 * length of a call the Mac's defaults point at two BlackHole loopback devices:
 *   phone → sox → "BlackHole 2ch"  → default input  → omp's microphone
 *   omp → default output → "BlackHole 16ch" → sox → phone
 * The previous defaults are saved to a file first and restored afterwards – also after a crash
 * (the next call or `hollr doctor` puts them back).
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";

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

const current = (type: "input" | "output") => run(["SwitchAudioSource", "-c", "-t", type]);
const select = (type: "input" | "output", name: string) =>
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

export class MacAudioSession {
  /** `probe` tells whether omp is live in the pane (its footer) – CoreAudio has no per-app streams. */
  constructor(private readonly probe: () => Promise<boolean>) {}

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
  }

  async attach(_pid: number): Promise<{ capturing: boolean; playing: boolean }> {
    const live = await this.probe().catch(() => false);
    return { capturing: live, playing: live };
  }

  /** sox writing phone audio into BlackHole 2ch (comes out of its input side as omp's mic). */
  spawnMicWriter(): Subprocess<"pipe", "ignore", "ignore"> {
    return Bun.spawn(["sox", "-q", ...pcm, "-", "-t", "coreaudio", MIC_DEVICE], {
      stdin: "pipe",
      stdout: "ignore",
      stderr: "ignore",
    });
  }

  /** sox recording what omp plays into BlackHole 16ch as mono 24 kHz. omp doesn't always use
   * channels 1/2 (seen: only channel 3), and a plain downmix divides by 16 – so sum all channels
   * unscaled (`remix -m`); only omp plays there, nothing else adds up. */
  spawnSpeakerReader(): Subprocess<"ignore", "pipe", "ignore"> {
    return Bun.spawn(
      ["sox", "-q", "-t", "coreaudio", SPEAKER_DEVICE, ...pcm, "-", "remix", "-m", "1-16"],
      {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
      },
    );
  }

  async destroy(): Promise<void> {
    restoreMacDefaults();
  }
}
