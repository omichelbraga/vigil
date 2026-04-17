import { processAlert } from "../lib/alert-engine";

(async () => {
  console.log("[synth] firing synthetic CRITICAL for Spooler on MIKE-PC-HOST …");
  await processAlert({
    checkId: "synthetic-spooler-test",
    checkName: "Spooler",
    agentId: "synthetic-agent",
    agentName: "MIKE-PC-HOST",
    status: "critical",
    message: "Service Spooler is stopped (SYNTHETIC TEST — dispatch validation)",
  });
  console.log("[synth] processAlert returned");
  await new Promise((r) => setTimeout(r, 3000));
  process.exit(0);
})();
