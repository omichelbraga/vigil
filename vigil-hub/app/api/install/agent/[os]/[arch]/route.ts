/**
 * Token-gated first-install download. Streams the active MSI for the
 * requested (os, arch) when the caller presents a valid, unconsumed
 * enrollment token. The token is NOT consumed here — the same token is
 * passed to `msiexec /i ... VIGIL_ENROLL_TOKEN=...` and consumed when the
 * agent calls /api/enroll inside the installer custom action.
 *
 *   GET /api/install/agent/windows/amd64?token=XWZK-NBT6
 *   GET /api/install/agent/windows/amd64
 *       Authorization: Bearer XWZK-NBT6
 *
 * Why a separate endpoint from `/api/update/agent/...`? The update channel
 * is authenticated by per-agent bearer tokens (an agent must already exist).
 * For first install no agent exists yet — the only credential the host has
 * is the one-shot enrollment token an admin handed it.
 */
import { NextRequest, NextResponse } from "next/server";
import { createReadStream, statSync } from "fs";
import { Readable } from "stream";
import path from "path";

import { db } from "@/lib/db";

const VALID_OS = new Set(["windows"]); // MSI install channel is Windows-only
const VALID_ARCH = new Set(["amd64", "arm64"]);

function extractToken(req: NextRequest): string | null {
  const url = new URL(req.url);
  const fromQuery = url.searchParams.get("token");
  if (fromQuery && fromQuery.length > 0) return fromQuery;

  const auth = req.headers.get("authorization") ?? "";
  if (auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim() || null;
  }
  return null;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ os: string; arch: string }> },
): Promise<Response> {
  const { os, arch } = await params;

  if (!VALID_OS.has(os)) {
    return NextResponse.json(
      { error: `Invalid OS. The MSI install channel only serves: ${[...VALID_OS].join(", ")}` },
      { status: 400 },
    );
  }
  if (!VALID_ARCH.has(arch)) {
    return NextResponse.json(
      { error: `Invalid arch. Must be one of: ${[...VALID_ARCH].join(", ")}` },
      { status: 400 },
    );
  }

  const token = extractToken(req);
  if (!token) {
    return NextResponse.json(
      { error: "Missing enrollment token. Pass ?token=... or Authorization: Bearer ..." },
      { status: 401 },
    );
  }

  const et = await db.enrollmentToken.findUnique({ where: { token } });
  if (!et || et.usedAt || et.expiresAt < new Date()) {
    return NextResponse.json(
      { error: "Invalid or expired enrollment token" },
      { status: 401 },
    );
  }

  const release = await db.agentRelease.findFirst({
    where: {
      os,
      arch,
      isActive: true,
      artifactType: "msi-installer",
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      version: true,
      filePath: true,
      filename: true,
      sha256: true,
    },
  });

  if (!release || !release.filePath) {
    return NextResponse.json(
      {
        error:
          "No MSI installer is currently active for this platform. An admin must upload and activate a release.",
      },
      { status: 404 },
    );
  }

  const filePath = path.resolve(release.filePath);
  let fileSize: number;
  try {
    fileSize = statSync(filePath).size;
  } catch {
    return NextResponse.json(
      { error: "Release artifact missing on disk" },
      { status: 410 },
    );
  }

  const stream = Readable.toWeb(createReadStream(filePath)) as ReadableStream;
  const downloadName =
    release.filename ||
    `vigil-agent-${release.version}-${os}-${arch}.msi`;

  const headers = new Headers({
    "Content-Type": "application/x-msi",
    "Content-Disposition": `attachment; filename="${downloadName}"`,
    "Content-Length": String(fileSize),
    // Surface the hash so PowerShell scripts can Get-FileHash + compare
    // without a second round-trip.
    "X-Checksum-SHA256": release.sha256,
    // Don't let CDNs / proxies cache a token-authenticated payload.
    "Cache-Control": "no-store",
  });

  return new Response(stream, { status: 200, headers });
}

export const runtime = "nodejs";
