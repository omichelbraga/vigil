import * as tls from "tls";
import { db } from "./db";

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

  for (const monitor of monitors) {
    try {
      const info = await checkDomain(monitor.host, monitor.port);

      let status: string;
      if (info.daysUntilExpiry <= 0) {
        status = "expired";
      } else if (info.daysUntilExpiry <= monitor.warnDays) {
        status = "expiring";
      } else {
        status = "valid";
      }

      await db.certMonitor.update({
        where: { id: monitor.id },
        data: {
          lastChecked: new Date(),
          expiresAt: info.validTo,
          issuer: info.issuer,
          status,
        },
      });
    } catch (err) {
      await db.certMonitor.update({
        where: { id: monitor.id },
        data: {
          lastChecked: new Date(),
          status: "error",
        },
      });
      console.error(`Cert check failed for ${monitor.host}:`, err);
    }
  }
}
