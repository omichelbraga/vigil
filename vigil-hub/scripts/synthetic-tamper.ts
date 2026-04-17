/**
 * Synthetic tamper test for P6.4 (signed check results).
 *
 * Mints a temporary agent record, pins a known ed25519 pubkey, then:
 *   1. Sends a `check_result` with a *valid* signature (should be accepted +
 *      written to the `check_results` table).
 *   2. Sends a `check_result` with a *tampered* signature (should be dropped
 *      and an audit row `agent.invalid_signature` written).
 *   3. Cleans up the temp agent.
 *
 * Run with:  cd vigil-hub && tsx scripts/synthetic-tamper.ts
 */

import { WebSocket } from "ws";
import argon2 from "argon2";
import crypto, { generateKeyPairSync, sign as cryptoSign } from "crypto";
import { db } from "../lib/db";
import { canonicalJson } from "../lib/signature-verify";

const HUB_WS_URL = process.env.VIGIL_HUB_WS_URL ?? "ws://127.0.0.1:3000";

async function main(): Promise<void> {
  const agentName = `tamper-test-${Date.now()}`;
  const rawToken = crypto.randomUUID();
  const tokenHash = await argon2.hash(rawToken, { type: argon2.argon2id });

  // Create the agent directly in the DB. `status = 'active'` — skip the
  // approval workflow so the WS connect doesn't 403.
  const agent = await db.agent.create({
    data: {
      name: agentName,
      tokenHash,
      isActive: true,
      status: "active",
    },
  });
  const fullToken = `${agent.id}:${rawToken}`;
  console.log(`[tamper] created agent ${agentName} (id=${agent.id})`);

  // Generate an ed25519 keypair in Node (separate from the agent's real key).
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const rawPubkey = publicKey.export({ format: "der", type: "spki" }).subarray(12); // strip SPKI wrapper
  const pubkeyHex = Buffer.from(rawPubkey).toString("hex");

  // Pin the pubkey so the Hub immediately enforces signature verification.
  await db.agent.update({
    where: { id: agent.id },
    data: {
      resultSigningPubkey: pubkeyHex,
      resultSigningPubkeyPinnedAt: new Date(),
    },
  });
  console.log(`[tamper] pinned pubkey ${pubkeyHex.slice(0, 16)}…`);

  // Create a matching check so the Hub doesn't drop our result as "no
  // monitor configured".
  const check = await db.check.create({
    data: {
      agentId: agent.id,
      name: "tamper-probe",
      type: "http",
      enabled: true,
      config: { url: "http://127.0.0.1/" },
      intervalSecs: 30,
    },
  });
  console.log(`[tamper] created check ${check.id}`);

  // Connect over WS.
  const wsUrl = `${HUB_WS_URL.replace(/\/$/, "")}/ws/agent`;
  const ws = new WebSocket(wsUrl, {
    headers: { Authorization: `Bearer ${fullToken}` },
  });

  const signBody = (body: Record<string, unknown>): Record<string, unknown> => {
    const canonical = canonicalJson(body);
    const sig = cryptoSign(null, Buffer.from(canonical, "utf8"), privateKey);
    return { ...body, signature: sig.toString("hex") };
  };

  ws.on("open", () => {
    console.log("[tamper] ws open — sending signed register");

    const register = signBody({
      type: "register",
      protocol_version: 2,
      agent_name: agentName,
      version: "tamper-0.0.1",
      os: "linux",
      hostname: "tamper-host",
      public_key: pubkeyHex,
    });
    ws.send(JSON.stringify(register));

    setTimeout(() => {
      console.log("[tamper] sending VALID check_result");
      const valid = signBody({
        type: "check_result",
        check_name: "tamper-probe",
        status: "ok",
        latency_ms: 5,
        message: "SYNTHETIC (valid)",
      });
      ws.send(JSON.stringify(valid));
    }, 500);

    setTimeout(() => {
      console.log("[tamper] sending TAMPERED check_result (bogus signature)");
      ws.send(
        JSON.stringify({
          type: "check_result",
          check_name: "tamper-probe",
          status: "critical",
          latency_ms: 99,
          message: "SYNTHETIC (tampered — should be dropped)",
          signature: "00".repeat(64),
        }),
      );
    }, 1500);

    setTimeout(async () => {
      ws.close();
      // Give the Hub a moment to persist before we snapshot.
      await new Promise((r) => setTimeout(r, 1500));

      const validRows = await db.checkResult.count({
        where: { agentId: agent.id, message: { contains: "valid" } },
      });
      const tamperedRows = await db.checkResult.count({
        where: { agentId: agent.id, message: { contains: "tampered" } },
      });
      const audit = await db.auditLog.findMany({
        where: {
          action: "agent.invalid_signature",
          createdAt: { gte: new Date(Date.now() - 60_000) },
        },
        orderBy: { createdAt: "desc" },
      });

      console.log("----------------------------------------------------");
      console.log(`valid    check_results inserted: ${validRows}`);
      console.log(`tampered check_results inserted: ${tamperedRows}`);
      console.log(`agent.invalid_signature audit rows (last 60s): ${audit.length}`);
      if (audit.length > 0) {
        console.log("latest audit metadata:", audit[0].metadata);
      }
      console.log("----------------------------------------------------");

      // Clean up.
      await db.checkResult.deleteMany({ where: { agentId: agent.id } });
      await db.check.deleteMany({ where: { agentId: agent.id } });
      await db.agent.delete({ where: { id: agent.id } });
      console.log("[tamper] cleaned up temp agent");

      const ok = validRows === 1 && tamperedRows === 0 && audit.length >= 1;
      console.log(ok ? "RESULT: PASS" : "RESULT: FAIL");
      process.exit(ok ? 0 : 1);
    }, 3500);
  });

  ws.on("close", (code, reason) =>
    console.log(`[tamper] ws close code=${code} reason=${reason.toString()}`),
  );
  ws.on("error", (err) => console.error(`[tamper] ws error: ${err.message}`));
}

main().catch((err) => {
  console.error("[tamper] fatal:", err);
  process.exit(1);
});
