import { processAlert } from "../lib/alert-engine";
import { db } from "../lib/db";

(async () => {
  // Resolve a real agent so the Incident FK constraint is satisfied.
  // Prefers MIKE-PC-HOST (the historical synthetic target) if present, else
  // whichever active agent exists.
  const agent =
    (await db.agent.findFirst({ where: { name: "MIKE-PC-HOST" } })) ??
    (await db.agent.findFirst({ where: { isActive: true, NOT: { tokenHash: "hub-internal" } } }));
  if (!agent) {
    console.error("[synth] no agent found in DB; cannot fire synthetic alert.");
    await db.$disconnect();
    process.exit(1);
  }

  console.log(`[synth] firing synthetic CRITICAL for Spooler on ${agent.name} …`);
  await processAlert({
    checkId: "synthetic-spooler-test",
    checkName: "Spooler",
    agentId: agent.id,
    agentName: agent.name,
    status: "critical",
    message: "Service Spooler is stopped (SYNTHETIC TEST — dispatch validation)",
  });
  console.log("[synth] processAlert returned");
  await new Promise((r) => setTimeout(r, 3000));
  await db.$disconnect();
  process.exit(0);
})();
