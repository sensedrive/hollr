/**
 * Virtual audio devices per live session (PulseAudio / pipewire-pulse).
 *
 *   phone mic ──pacat──▶ sink hollr_in_<id> ──monitor──▶ source hollr_mic_<id> ──▶ omp capture
 *   omp playback ──▶ sink hollr_spk_<id> ──monitor──pacat──▶ phone speaker
 *
 * omp opens the *default* devices; we move exactly its streams (matched by PID)
 * onto the session's devices, so several sessions can run side by side.
 */
import type { Subprocess } from "bun";
import { AUDIO_RATE } from "./frames";

export type Run = (args: string[]) => Promise<{ code: number; out: string; err: string }>;

export const runCmd: Run = async (args) => {
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, out, err };
};

interface PaStream {
  index: number;
  properties?: Record<string, string>;
}

export class PulseSession {
  readonly spk: string;
  readonly input: string;
  readonly mic: string;
  private modules: string[] = [];
  private moved = new Set<string>();

  constructor(
    readonly id: string,
    private readonly run: Run = runCmd,
  ) {
    this.spk = `hollr_spk_${id}`;
    this.input = `hollr_in_${id}`;
    this.mic = `hollr_mic_${id}`;
  }

  private async pactl(...args: string[]): Promise<string> {
    const res = await this.run(["pactl", ...args]);
    if (res.code !== 0)
      throw new Error(`pactl ${args[0]} failed: ${res.err.trim() || res.out.trim()}`);
    return res.out.trim();
  }

  async create(): Promise<void> {
    const sink = (name: string, desc: string) =>
      this.pactl(
        "load-module",
        "module-null-sink",
        `sink_name=${name}`,
        `rate=${AUDIO_RATE}`,
        "channels=1",
        `sink_properties=device.description=${desc}`,
      );
    this.modules.push(await sink(this.spk, "Hollr-Speaker"));
    this.modules.push(await sink(this.input, "Hollr-Mic-In"));
    this.modules.push(
      await this.pactl(
        "load-module",
        "module-remap-source",
        `master=${this.input}.monitor`,
        `source_name=${this.mic}`,
        "source_properties=device.description=Hollr-Mic",
      ),
    );
  }

  private async streams(kind: "source-outputs" | "sink-inputs"): Promise<PaStream[]> {
    const raw = await this.pactl("-f", "json", "list", kind);
    try {
      return JSON.parse(raw || "[]") as PaStream[];
    } catch {
      return [];
    }
  }

  /**
   * Moves all capture/playback streams of `pid` onto this session's devices.
   * Returns whether the process currently captures (= live mode is active).
   */
  async attach(pid: number): Promise<{ capturing: boolean; playing: boolean }> {
    const mine = (s: PaStream) => s.properties?.["application.process.id"] === String(pid);
    const [outs, ins] = await Promise.all([
      this.streams("source-outputs"),
      this.streams("sink-inputs"),
    ]);
    const capture = outs.filter(mine);
    const playback = ins.filter(mine);
    for (const s of capture) {
      const key = `so${s.index}`;
      if (this.moved.has(key)) continue;
      await this.pactl("move-source-output", String(s.index), this.mic).catch(() => {});
      this.moved.add(key);
    }
    for (const s of playback) {
      const key = `si${s.index}`;
      if (this.moved.has(key)) continue;
      await this.pactl("move-sink-input", String(s.index), this.spk).catch(() => {});
      this.moved.add(key);
    }
    return { capturing: capture.length > 0, playing: playback.length > 0 };
  }

  /** pacat writing phone audio into the virtual mic. */
  spawnMicWriter(): Subprocess<"pipe", "ignore", "ignore"> {
    return Bun.spawn(
      ["pacat", "--playback", "--raw", `--device=${this.input}`, ...pcmArgs(), "--latency-msec=60"],
      { stdin: "pipe", stdout: "ignore", stderr: "ignore" },
    );
  }

  /** pacat reading what omp plays. */
  spawnSpeakerReader(): Subprocess<"ignore", "pipe", "ignore"> {
    return Bun.spawn(
      [
        "pacat",
        "--record",
        "--raw",
        `--device=${this.spk}.monitor`,
        ...pcmArgs(),
        "--latency-msec=40",
      ],
      { stdin: "ignore", stdout: "pipe", stderr: "ignore" },
    );
  }

  async destroy(): Promise<void> {
    for (const m of this.modules.reverse()) await this.pactl("unload-module", m).catch(() => {});
    this.modules = [];
  }
}

function pcmArgs(): string[] {
  return ["--format=s16le", `--rate=${AUDIO_RATE}`, "--channels=1"];
}

export async function pulseAvailable(run: Run = runCmd): Promise<boolean> {
  const info = await run(["pactl", "info"]).catch(() => ({ code: 1, out: "", err: "" }));
  if (info.code === 0) return true;
  await run(["pulseaudio", "--start"]).catch(() => {});
  return (await run(["pactl", "info"]).catch(() => ({ code: 1, out: "", err: "" }))).code === 0;
}

/** Unloads modules of sessions whose gate process no longer exists (crash, dropped SSH). */
export async function cleanupStale(run: Run = runCmd): Promise<number> {
  const res = await run(["pactl", "list", "short", "modules"]);
  if (res.code !== 0) return 0;
  let removed = 0;
  for (const line of res.out.split("\n")) {
    const [index, , args = ""] = line.split("\t");
    const m = args.match(/(?:sink_name|source_name)=hollr_(?:spk|in|mic)_(\d+)/);
    if (!index || !m) continue;
    if (isAlive(Number(m[1]))) continue;
    await run(["pactl", "unload-module", index]);
    removed++;
  }
  return removed;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
