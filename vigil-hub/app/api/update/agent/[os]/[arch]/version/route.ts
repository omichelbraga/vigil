import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

const VALID_OS = ["linux", "darwin", "windows"];
const VALID_ARCH = ["amd64", "arm64"];

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ os: string; arch: string }> },
) {
  const { os, arch } = await params;

  if (!VALID_OS.includes(os)) {
    return NextResponse.json(
      { error: `Invalid OS. Must be one of: ${VALID_OS.join(", ")}` },
      { status: 400 },
    );
  }

  if (!VALID_ARCH.includes(arch)) {
    return NextResponse.json(
      { error: `Invalid arch. Must be one of: ${VALID_ARCH.join(", ")}` },
      { status: 400 },
    );
  }

  try {
    const release = await db.agentRelease.findFirst({
      where: {
        os,
        arch,
        isActive: true,
      },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        version: true,
        os: true,
        arch: true,
        sha256: true,
        fileSize: true,
        signature: true,
        signedBy: true,
        createdAt: true,
      },
    });

    if (!release) {
      return NextResponse.json(
        { error: "No release available for this platform" },
        { status: 404 },
      );
    }

    // Agent auto-updater consumes `signature` + `signedBy` to verify
    // authenticity before installing. Unsigned releases are returned with
    // null fields so older agents keep working — agents decide policy.
    return NextResponse.json({
      id: release.id,
      version: release.version,
      os: release.os,
      arch: release.arch,
      sha256: release.sha256,
      size: release.fileSize === null ? null : release.fileSize.toString(),
      signature: release.signature,
      signedBy: release.signedBy,
      createdAt: release.createdAt.toISOString(),
    });
  } catch {
    const version = process.env.AGENT_VERSION;
    if (version) {
      return NextResponse.json({
        version,
        os,
        arch,
        message: "Version info from environment (AgentRelease table not yet available)",
      });
    }

    return NextResponse.json(
      { error: "No release information available" },
      { status: 404 },
    );
  }
}
