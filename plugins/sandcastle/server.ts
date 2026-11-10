/**
 * Sandcastle board – a Hollr plugin (server/src/plugins.ts starts it). Serves the UI and /api on 127.0.0.1,
 * reached by the apps through their SSH tunnel. /api needs the per-start token; the Host must be loopback
 * (DNS rebinding); no CORS. Ends itself after 2 h without a request.
 */
import { timingSafeEqual } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type PluginEnv, pluginEnv } from "./src/env";
import { handleApi } from "./src/http";

let env: PluginEnv;
try {
  env = pluginEnv();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}

const built = await Bun.build({ entrypoints: [join(env.dir, "ui", "app.ts")], target: "browser", minify: true });
const bundle = built.outputs[0];
if (!built.success || !bundle) {
  console.error("UI-Bau fehlgeschlagen:", ...built.logs);
  process.exit(1);
}
const appJs = await bundle.text();
const appCss = readFileSync(join(env.dir, "ui", "app.css"), "utf8");
const indexHtml = readFileSync(join(env.dir, "ui", "index.html"), "utf8");

const HEADERS = {
  "Content-Security-Policy": "default-src 'self'; img-src 'self' https: data:; style-src 'self' 'unsafe-inline'",
  "Cache-Control": "no-store",
};
const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost):\d+$/;
const IDLE_MS = 2 * 3600_000;
const token = Buffer.from(env.token);

const send = (body: string, type: string, status = 200) =>
  new Response(body, { status, headers: { ...HEADERS, "Content-Type": type } });

function authorized(req: Request): boolean {
  const given = Buffer.from((req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, ""));
  return given.length === token.length && timingSafeEqual(given, token);
}

let lastRequest = Date.now();
const stateDir = env.stateDir;

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  idleTimeout: 120,
  async fetch(req) {
    lastRequest = Date.now();
    const url = new URL(req.url);
    // the Host check comes first, for health too (DNS rebinding); only the token is waived there
    if (!LOOPBACK_HOST.test(req.headers.get("host") ?? "")) return send("forbidden", "text/plain", 403);
    if (url.pathname === "/__hollr/health") return send("ok", "text/plain");
    if (url.pathname.startsWith("/api/")) {
      if (!authorized(req)) return Response.json({ error: "unauthorized" }, { status: 401, headers: HEADERS });
      const res = await handleApi(req, url, { stateDir });
      for (const [k, v] of Object.entries(HEADERS)) res.headers.set(k, v);
      return res;
    }
    if (url.pathname === "/" || url.pathname === "/index.html") return send(indexHtml, "text/html; charset=utf-8");
    if (url.pathname === "/app.js") return send(appJs, "text/javascript; charset=utf-8");
    if (url.pathname === "/app.css") return send(appCss, "text/css; charset=utf-8");
    return send("not found", "text/plain", 404);
  },
});

const tmp = `${env.readyFile}.${process.pid}.tmp`;
writeFileSync(tmp, JSON.stringify({ port: server.port, pid: process.pid }));
renameSync(tmp, env.readyFile);
console.log(`Sandcastle-Board auf 127.0.0.1:${server.port}`);

setInterval(() => {
  if (Date.now() - lastRequest > IDLE_MS) {
    console.log("2 h ohne Anfrage – beende.");
    process.exit(0);
  }
}, 60_000);
