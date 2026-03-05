import { createServer } from "http";
import { parse } from "url";
import next from "next";
import { setupWebSocket } from "./lib/ws-server";
import { runCertChecks } from "./lib/cert-monitor";

const dev = process.env.NODE_ENV !== "production";
const hostname = "0.0.0.0";
const port = parseInt(process.env.PORT || "3000", 10);

const app = next({ dev, hostname, port });
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
