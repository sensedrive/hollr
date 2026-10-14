/**
 * Dev tool: pairs like the iPhone app would.
 *   bun scripts/fake-pair.ts '<hollr://pair?c=...>' <out-dir>
 * Writes <out-dir>/device (OpenSSH key) and prints the ssh command to use it.
 */
import { createPrivateKey, createPublicKey, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parsePayloadUrl } from "../src/pairing";

function u32(n: number) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
}
const str = (b: Buffer | string) => {
  const buf = Buffer.isBuffer(b) ? b : Buffer.from(b);
  return Buffer.concat([u32(buf.length), buf]);
};

function publicFromSeed(seed: Buffer): Buffer {
  const der = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
  const pub = createPublicKey(createPrivateKey({ key: der, format: "der", type: "pkcs8" }));
  return Buffer.from(pub.export({ format: "jwk" }).x as string, "base64url");
}

/** OpenSSH "openssh-key-v1" private key file for an Ed25519 seed. */
function opensshPrivateKey(seed: Buffer, comment: string): string {
  const pub = publicFromSeed(seed);
  const pubBlob = Buffer.concat([str("ssh-ed25519"), str(pub)]);
  const check = randomBytes(4);
  let priv = Buffer.concat([
    check,
    check,
    str("ssh-ed25519"),
    str(pub),
    str(Buffer.concat([seed, pub])),
    str(comment),
  ]);
  const pad = 8 - (priv.length % 8);
  if (pad < 8)
    priv = Buffer.concat([priv, Buffer.from(Array.from({ length: pad }, (_, i) => i + 1))]);
  const body = Buffer.concat([
    Buffer.from("openssh-key-v1\0"),
    str("none"),
    str("none"),
    str(Buffer.alloc(0)),
    u32(1),
    str(pubBlob),
    str(priv),
  ]);
  const b64 = body.toString("base64").replace(/.{70}/g, "$&\n");
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${b64}\n-----END OPENSSH PRIVATE KEY-----\n`;
}

const [url, outDir = "fake-phone"] = Bun.argv.slice(2);
if (!url) throw new Error("usage: fake-pair.ts <hollr://pair?c=...> [out-dir]");
const p = parsePayloadUrl(url);
mkdirSync(outDir, { recursive: true });
const bootstrap = join(outDir, "bootstrap");
writeFileSync(bootstrap, opensshPrivateKey(Buffer.from(p.s, "base64url"), "bootstrap"), {
  mode: 0o600,
});

const deviceSeed = randomBytes(32);
const device = join(outDir, "device");
writeFileSync(device, opensshPrivateKey(deviceSeed, "device"), { mode: 0o600 });
const devPub = publicFromSeed(deviceSeed);
const devLine = `ssh-ed25519 ${Buffer.concat([str("ssh-ed25519"), str(devPub)]).toString("base64")}`;

const host = p.a[0];
const knownHosts = join(outDir, "known_hosts");
const ssh = (key: string, cmd: string, input?: string) =>
  Bun.spawnSync(
    [
      "ssh",
      "-i",
      key,
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      `UserKnownHostsFile=${knownHosts}`,
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-p",
      String(p.p),
      `${p.u}@${host}`,
      cmd,
    ],
    { stdin: input ? Buffer.from(input) : "ignore" },
  );

const enroll = ssh(bootstrap, "enroll", JSON.stringify({ pub: devLine, name: "Fake iPhone" }));
console.log("enroll:", enroll.stdout.toString().trim(), enroll.stderr.toString().trim());
const hello = ssh(device, "hello");
console.log("hello:", hello.stdout.toString().trim());
const shell = ssh(device, "cat /etc/passwd | head -1");
console.log("shell attempt:", shell.stdout.toString().trim().slice(0, 120));
const reuse = ssh(bootstrap, "enroll", JSON.stringify({ pub: devLine, name: "again" }));
console.log(
  "bootstrap reuse (should fail):",
  reuse.exitCode,
  reuse.stdout.toString().trim() || reuse.stderr.toString().trim().slice(0, 80),
);
