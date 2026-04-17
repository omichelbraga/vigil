import * as tls from "tls";
import { db } from "./db";
import { processAlert } from "./alert-engine";
import { assertExternalHostname } from "./url-safety";

interface CertInfo {
  subject: string;
  issuer: string;
  validTo: Date;
  daysUntilExpiry: number;
  isSelfSigned: boolean;
}

/** Check a domain's TLS certificate */
export async function checkDomain(
  domain: string,
  port: number = 443
): Promise<CertInfo> {
  // Defensive SSRF guard: legacy rows may pre-date the /api/certs POST check.
  await assertExternalHostname(domain);
  return new Promise((resolve, reject) => {
    const socket = tls.connect(
      {
        host: domain,
        port,
        servername: domain,
        rejectUnauthorized: false, // We want to inspect even invalid certs
        timeout: 10000,
      },
      () => {
        const cert = socket.getPeerCertificate();
        socket.destroy();

        if (!cert || !cert.valid_to) {
          reject(new Error(`No certificate returned from ${domain}:${port}`));
          return;
        }

        const validTo = new Date(cert.valid_to);
        const now = new Date();
        const daysUntilExpiry = Math.floor(
          (validTo.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
        );

        const rawSubject =
          typeof cert.subject === "object"
            ? cert.subject.CN || JSON.stringify(cert.subject)
            : String(cert.subject);
        const subject = Array.isArray(rawSubject) ? rawSubject[0] : String(rawSubject);
        const rawIssuer =
          typeof cert.issuer === "object"
            ? cert.issuer.CN || cert.issuer.O || JSON.stringify(cert.issuer)
            : String(cert.issuer);
        const issuer = Array.isArray(rawIssuer) ? rawIssuer[0] : String(rawIssuer);

        const isSelfSigned = subject === issuer;

        resolve({
          subject,
          issuer,
          validTo,
          daysUntilExpiry,
          isSelfSigned,
        });
      }
    );

    socket.on("error", (err) => {
      socket.destroy();
      reject(err);
    });

    socket.on("timeout", () => {
      socket.destroy();
      reject(new Error(`Connection to ${domain}:${port} timed out`));
    });
  });
}

/** Run certificate checks for all enabled CertMonitor entries */
export async function runCertChecks(): Promise<void> {
  const monitors = await db.certMonitor.findMany({
    where: { enabled: true },
  });

  // Get or create a "hub" agent for cert alert attribution
  let hubAgent = await db.agent.findFirst({ where: { name: "Vigil Hub" } });
  if (!hubAgent) {
    hubAgent = await db.agent.create({
      data: { name: "Vigil Hub", tokenHash: "hub-internal", isActive: true },
    });
  }

  for (const monitor of monitors) {
    try {
      const info = await checkDomain(monitor.host, monitor.port);

      // Normalize to standard alert statuses
      let alertStatus: string;
      let alertMessage: string;
      if (info.daysUntilExpiry <= 0) {
        alertStatus = "critical";
        alertMessage = `Certificate for ${monitor.host} has EXPIRED (${Math.abs(info.daysUntilExpiry)} days ago)`;
      } else if (info.daysUntilExpiry <= monitor.warnDays) {
        alertStatus = "warning";
        alertMessage = `Certificate for ${monitor.host} expires in ${info.daysUntilExpiry} days (${info.validTo.toLocaleDateString()})`;
      } else {
        alertStatus = "ok";
        alertMessage = `Certificate valid — ${info.daysUntilExpiry} days remaining`;
      }

      // Store cert-friendly status labels
      const displayStatus = alertStatus === "critical" ? "expired"
        : alertStatus === "warning" ? "expiring"
        : "valid";

      await db.certMonitor.update({
        where: { id: monitor.id },
        data: {
          lastChecked: new Date(),
          expiresAt: info.validTo,
          issuer: info.issuer,
          status: displayStatus,
        },
      });

      // Fire alert for warning/critical only — no recovery notification for certs
      if (alertStatus !== "ok") {
        await processAlert({
          checkId: monitor.id,
          checkName: `${monitor.host}:${monitor.port} cert`,
          agentId: hubAgent.id,
          agentName: "Vigil Hub",
          status: alertStatus,
          message: alertMessage,
          skipRecovery: true,
        });
      } else {
        // Silently resolve any open incident without sending notification
        const openIncident = await db.alertHistory.findFirst({
          where: { checkId: monitor.id, status: "fired" },
        });
        if (openIncident) {
          await db.alertHistory.update({
            where: { id: openIncident.id },
            data: { status: "resolved", resolvedAt: new Date() },
          });
        }
      }

    } catch (err) {
      await db.certMonitor.update({
        where: { id: monitor.id },
        data: { lastChecked: new Date(), status: "error" },
      });
      if (hubAgent) {
        await processAlert({
          checkId: monitor.id,
          checkName: `${monitor.host}:${monitor.port} cert`,
          agentId: hubAgent.id,
          agentName: "Vigil Hub",
          status: "critical",
          message: `Certificate check failed for ${monitor.host}: ${err}`,
          skipRecovery: true,
        });
      }
      console.error(`Cert check failed for ${monitor.host}:`, err);
    }
  }
}
