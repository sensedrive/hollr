/**
 * Dev tool: behaves like the iPhone app over SSH.
 *   bun scripts/fake-phone.ts <ssh-target> <pane> <speech.wav (24 kHz mono s16)> [out.wav]
 * Streams the clip (padded with silence, paced in real time) into `hollr gate live`,
 * prints events and saves what omp says.
 */
import { encodeFrame, encodeJson, FRAME_AUDIO, FRAME_JSON, FrameDecoder } from "../src/frames";

const [target, pane, clipPath, outPath = "hollr-out.wav"] = Bun.argv.slice(2);
if (!target || !pane || !clipPath) {
  console.error("usage: fake-phone.ts <ssh-target> <pane> <clip.wav> [out.wav]");
  process.exit(2);
}

function pcmFromWav(buf: Buffer): Buffer {
  const idx = buf.indexOf("data");
  return buf.subarray(idx + 8);
}

function wav(pcm: Buffer, rate = 24_000): Buffer {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

const clip = pcmFromWav(Buffer.from(await Bun.file(clipPath).arrayBuffer()));
const proc = Bun.spawn(
  [
    "ssh",
    "-o",
    "BatchMode=yes",
    target,
    `SSH_ORIGINAL_COMMAND="live ${pane}" ~/.local/bin/hollr gate`,
  ],
  { stdin: "pipe", stdout: "pipe", stderr: "inherit" },
);

const received: Buffer[] = [];
let live = false;
let finalAt = 0;
const started = Date.now();
const log = (...a: unknown[]) =>
  console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s]`, ...a);

void (async () => {
  const dec = new FrameDecoder();
  for await (const chunk of proc.stdout) {
    for (const f of dec.push(chunk)) {
      if (f.type === FRAME_AUDIO) received.push(Buffer.from(f.data));
      else if (f.type === FRAME_JSON) {
        const m = f.data as Record<string, unknown>;
        log(JSON.stringify(m).slice(0, 200));
        if (m.t === "phase" && m.phase === "live") live = true;
        if (m.t === "answer" && m.final) finalAt ||= Date.now();
      }
    }
  }
})();

const CHUNK = 960; // 20 ms
let pos = -1;
while (true) {
  await Bun.sleep(20);
  if (live && pos < 0) {
    pos = 0;
    log("live – sending speech in 2s");
  }
  let data = Buffer.alloc(CHUNK);
  if (pos >= 0) {
    const speechStart = 100 * CHUNK; // 2 s
    const rel = pos - speechStart;
    if (rel >= 0 && rel < clip.length) data = Buffer.from(clip.subarray(rel, rel + CHUNK));
    pos += CHUNK;
  }
  if (live) proc.stdin.write(encodeFrame(FRAME_AUDIO, data));
  const muteAt = Number(Bun.env.MUTE_AT_MS ?? 0);
  if (muteAt && live && pos === Math.round(muteAt / 20) * CHUNK) {
    log("→ mute on");
    proc.stdin.write(encodeJson({ t: "mute", on: true }));
  }
  if (muteAt && live && pos === Math.round((muteAt + 3000) / 20) * CHUNK) {
    log("→ mute off");
    proc.stdin.write(encodeJson({ t: "mute", on: false }));
  }
  if (finalAt && Date.now() - finalAt > 12_000) break;
  if (Date.now() - started > Number(Bun.env.MAX_MS ?? 150_000)) break;
}
proc.stdin.write(encodeJson({ t: "stop" }));
proc.stdin.flush();
await Bun.sleep(4000);
proc.stdin.end();
await proc.exited;
const pcm = Buffer.concat(received);
await Bun.write(outPath, wav(pcm));
log(`saved ${outPath} (${(pcm.length / 48000).toFixed(1)}s of omp audio)`);
