import { createServer } from "http";
import { parse } from "url";
import next from "next";
import { setupWebSocket } from "./lib/ws-server";
import { runCertChecks } from "./lib/cert-monitor";

// Catch unhandled errors so they appear in /tmp/vigil-hub.log
process.on("unhandledRejection", (reason) => {
  console.error("[vigil-hub] Unhandled rejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[vigil-hub] Uncaught exception:", err);
});

const dev = process.env.NODE_ENV !== "production";
const hostname = "0.0.0.0";
const port = parseInt(process.env.PORT || "3000", 10);

// Disable Turbopack (unstable in programmatic mode — use webpack)
const app = next({ dev, hostname, port, turbopack: false } as Parameters<typeof next>[0]);
const handle = app.getRequestHandler();

app.prepare().then(() => {
  const server = createServer(async (req, res) => {
    const parsedUrl = parse(req.url || "/", true);
    await handle(req, res, parsedUrl);
  });

  setupWebSocket(server);

  // Run cert checks on startup + every hour
  runCertChecks().catch(console.error);
  setInterval(() => runCertChecks().catch(console.error), 60 * 60 * 1000);

  server.listen(port, hostname, () => {
    console.log(`> Vigil Hub ready on http://${hostname}:${port}`);
  });
});
