import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/authz";
import {
  configuredSigningPubkey,
  verifyReleaseSignature,
} from "@/lib/release-signing";

export interface AdminAgentReleaseRow {
  id: string;
  os: string;
  arch: string;
  version: string;
  artifactType: string; // "exe-update" | "msi-installer"
  sha256: string;
  filename: string;
  filePath: string | null;
  fileSize: string | null; // bigint as string for JSON safety
  isActive: boolean;
  signature: string | null;
  signedBy: string | null;
  signatureValid: boolean;
  uploadedBy: string | null;
  uploadedByEmail: string | null;
  uploadedAt: string;
  downloadUrl: string;
}

export interface RunningVersionMap {
  [osArch: string]: { [version: string]: number };
}

export interface AdminAgentReleasesResponse {
  releases: AdminAgentReleaseRow[];
  runningVersions: RunningVersionMap;
  signingKey: { fingerprint: string } | null;
}

/**
 * GET /api/admin/agent-releases
 *
 * Returns all uploaded agent binaries plus a histogram of currently-connected
 * agents' self-reported versions, so operators can spot drift at a glance.
 * Admin-only.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const authz = await requireAdmin(req);
  if (!authz.ok) return authz.response;

  const [releases, agents] = await Promise.all([
    db.agentRelease.findMany({
      orderBy: [{ os: "asc" }, { arch: "asc" }, { createdAt: "desc" }],
    }),
    db.agent.findMany({
      where: { isActive: true, version: { not: null } },
      select: { os: true, version: true },
    }),
  ]);

  const uploaderIds = Array.from(
    new Set(
      releases
        .map((r) => r.uploadedBy)
        .filter((v): v is string => typeof v === "string" && v.length > 0),
    ),
  );
  const uploaders = uploaderIds.length
    ? await db.user.findMany({
        where: { id: { in: uploaderIds } },
        select: { id: true, email: true },
      })
    : [];
  const uploaderById = new Map(uploaders.map((u) => [u.id, u.email]));

  const signingKey = configuredSigningPubkey();

  const rows: AdminAgentReleaseRow[] = releases.map((r) => {
    let signatureValid = false;
    if (r.signature && signingKey) {
      signatureValid = verifyReleaseSignature({
        sha256Hex: r.sha256,
        signatureHex: r.signature,
        pubkeyHex: signingKey.pubkeyHex,
      });
    }
    return {
      id: r.id,
      os: r.os,
      arch: r.arch,
      version: r.version,
      artifactType: r.artifactType,
      sha256: r.sha256,
      filename: r.filename,
      filePath: r.filePath,
      fileSize: r.fileSize === null ? null : r.fileSize.toString(),
      isActive: r.isActive,
      signature: r.signature,
      signedBy: r.signedBy,
      signatureValid,
      uploadedBy: r.uploadedBy,
      uploadedByEmail: r.uploadedBy
        ? uploaderById.get(r.uploadedBy) ?? null
        : null,
      uploadedAt: r.createdAt.toISOString(),
      downloadUrl: `/api/admin/agent-releases/${encodeURIComponent(r.id)}/download`,
    };
  });

  // Running-version histogram from connected agents.
  const runningVersions: RunningVersionMap = {};
  for (const a of agents) {
    if (!a.os || !a.version) continue;
    // Agent self-reports os as-is; group under normalized os-arch key if arch
    // unknown, we bucket under "<os>-unknown". The UI filters to os-arch pairs
    // present in releases.
    const key = a.os.toLowerCase();
    if (!runningVersions[key]) runningVersions[key] = {};
    runningVersions[key][a.version] = (runningVersions[key][a.version] ?? 0) + 1;
  }

  const payload: AdminAgentReleasesResponse = {
    releases: rows,
    runningVersions,
    signingKey: signingKey ? { fingerprint: signingKey.fingerprint } : null,
  };

  return NextResponse.json(payload);
}
