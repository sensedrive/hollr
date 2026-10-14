// Builds self-contained hollr binaries (no bun/node needed on the server).
import { $ } from "bun";

const targets = (Bun.argv[2]?.split(",") ?? ["linux-x64", "linux-arm64", "darwin-arm64"]).filter(
  Boolean,
);
await $`mkdir -p dist`;
for (const t of targets) {
  const out = `dist/hollr-${t}`;
  await $`bun build src/cli.ts --compile --minify --target=bun-${t} --outfile ${out}`.quiet();
  console.log(`built ${out}`);
}
