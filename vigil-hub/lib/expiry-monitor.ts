import { db } from "./db";
import { processAlert } from "./alert-engine";

export async function runExpiryChecks(): Promise<{ checked: number; results: unknown[] }> {
  const monitors = await db.expiryMonitor.findMany();

  let hubAgent = await db.agent.findFirst({ where: { name: "Vigil Hub" } });
  if (!hubAgent) {
    hubAgent = await db.agent.create({
      data: { name: "Vigil Hub", token: "hub-internal", isActive: true },
    });
  }

  const results = [];
  for (const m of monitors) {
    const days = Math.floor((m.expiresAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
    let status: string;
    let message: string;

    if (days <= 0) {
      status = "critical";
      message = `${m.name} expired ${Math.abs(days)} day(s) ago (${m.expiresAt.toLocaleDateString()})`;
    } else if (days <= m.warnDays) {
      status = "warning";
      message = `${m.name} expires in ${days} day(s) on ${m.expiresAt.toLocaleDateString()}`;
    } else {
      status = "ok";
      message = `${m.name} is valid — ${days} days remaining`;
    }

    await db.expiryMonitor.update({
      where: { id: m.id },
      data: { lastStatus: status, lastChecked: new Date() },
    });

    if (status !== "ok") {
      await processAlert({
        checkId: m.id,
        checkName: m.name,
        agentId: hubAgent.id,
        agentName: "Vigil Hub",
        status,
        message,
        skipRecovery: true,
      });
    } else {
      const open = await db.alertHistory.findFirst({ where: { checkId: m.id, status: "fired" } });
      if (open) {
        await db.alertHistory.update({ where: { id: open.id }, data: { status: "resolved", resolvedAt: new Date() } });
      }
    }

    results.push({ id: m.id, name: m.name, status, days });
  }

  return { checked: results.length, results };
}
