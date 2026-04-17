import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import argon2 from "argon2";
import { createReadStream, statSync } from "fs";
import { Readable } from "stream";
import path from "path";

const VALID_OS = ["linux", "darwin", "windows"];
const VALID_ARCH = ["amd64", "arm64"];

async function verifyAgentToken(req: NextRequest): Promise<string | null> {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return null;
  }

  const token = authHeader.slice(7);
  if (!token) return null;

  // Find all active agents and verify token against each hash
  const agents = await db.agent.findMany({
    where: { isActive: true },
    select: { id: true, tokenHash: true },
  });

  for (const agent of agents) {
    try {
      const valid = await argon2.verify(agent.tokenHash, token);
      if (valid) return agent.id;
    } catch {
      // Hash verification failed, try next
    }
  }

  return null;
}

export async function GET(
  req: NextRequest,
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

  // Verify agent bearer token
  const agentId = await verifyAgentToken(req);
  if (!agentId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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
        filePath: true,
        filename: true,
        sha256: true,
      },
    });

    if (!release || !release.filePath) {
      return NextResponse.json(
        { error: "No release binary available for this platform" },
        { status: 404 },
      );
    }

    // Verify the file exists
    const filePath = path.resolve(release.filePath);
    let fileSize: number;
    try {
      const stat = statSync(filePath);
      fileSize = stat.size;
    } catch {
      return NextResponse.json(
        { error: "Release binary not found on disk" },
        { status: 404 },
      );
    }

    // Stream the file
    const fileStream = createReadStream(filePath);
    const webStream = Readable.toWeb(fileStream) as ReadableStream;

    const ext = os === "windows" ? ".exe" : "";
    const fileName =
      release.filename || `vigil-agent-${release.version}-${os}-${arch}${ext}`;

    const headers = new Headers({
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${fileName}"`,
      "Content-Length": String(fileSize),
    });

    if (release.sha256) {
      headers.set("X-Checksum-SHA256", release.sha256);
    }

    return new Response(webStream, { status: 200, headers });
  } catch {
    // AgentRelease model may not exist yet
    // Fall back to file-system based lookup
    const releasesDir = process.env.AGENT_RELEASES_DIR;
    if (!releasesDir) {
      return NextResponse.json(
        { error: "Agent releases not configured" },
        { status: 404 },
      );
    }

    const ext = os === "windows" ? ".exe" : "";
    const fileName = `vigil-agent-${os}-${arch}${ext}`;
    const filePath = path.resolve(releasesDir, fileName);

    let fileSize: number;
    try {
      const stat = statSync(filePath);
      fileSize = stat.size;
    } catch {
      return NextResponse.json(
        { error: "No release binary available for this platform" },
        { status: 404 },
      );
    }

    const fileStream = createReadStream(filePath);
    const webStream = Readable.toWeb(fileStream) as ReadableStream;

    return new Response(webStream, {
      status: 200,
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "Content-Length": String(fileSize),
      },
    });
  }
}
