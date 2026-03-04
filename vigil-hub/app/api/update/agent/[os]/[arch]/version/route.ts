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

  // Look for the latest active release matching os/arch
  // Using a raw query approach via Prisma: check if AgentRelease model exists
  // If not, we fall back to environment-based version info
  try {
    // Attempt to query AgentRelease table (may not exist yet in early versions)
    const release = await (db as any).agentRelease.findFirst({
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
        size: true,
        releaseNotes: true,
        createdAt: true,
      },
    });

    if (!release) {
      return NextResponse.json(
        { error: "No release available for this platform" },
        { status: 404 },
      );
    }

    return NextResponse.json(release);
  } catch {
    // AgentRelease model may not exist yet — return version from env or 404
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
