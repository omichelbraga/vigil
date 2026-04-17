import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { mkdir, rename, unlink } from "fs/promises";
import { createWriteStream, type WriteStream } from "fs";
import path from "path";
import { Readable } from "stream";

import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/authz";
import { audit } from "@/lib/audit";

// Cap: 200 MB. Agent binaries are typically < 30 MB; generous headroom.
const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

const VALID_OS = new Set(["linux", "windows"]);
const VALID_ARCH = new Set(["amd64", "arm64"]);
const VERSION_RE = /^\d+\.\d+\.\d+(-[\w.]+)?$/;
const HEX_RE = /^[0-9a-fA-F]+$/;

function storageDir(): string {
  return process.env.AGENT_BINARIES_PATH || "/var/lib/vigil/agent-releases";
}

function extFor(os: string): string {
  return os === "windows" ? ".exe" : "";
}

function bad(status: number, error: string): NextResponse {
  return NextResponse.json({ error }, { status });
}

/**
 * Parse the multipart boundary marker out of the Content-Type header.
 */
function extractBoundary(contentType: string): string | null {
  const match = /boundary="?([^";]+)"?/i.exec(contentType);
  return match ? match[1] : null;
}

/**
 * Parse a multipart header block (everything between CRLFCRLF and the part data).
 * Returns { name, filename? } for the Content-Disposition, ignoring other fields.
 */
function parseHeaders(block: Buffer): {
  name: string | null;
  filename: string | null;
} {
  const text = block.toString("utf8");
  const lines = text.split(/\r\n/);
  let name: string | null = null;
  let filename: string | null = null;
  for (const line of lines) {
    if (/^content-disposition/i.test(line)) {
      const nameMatch = /name="([^"]*)"/.exec(line);
      if (nameMatch) name = nameMatch[1];
      const fileMatch = /filename="([^"]*)"/.exec(line);
      if (fileMatch) filename = fileMatch[1];
    }
  }
  return { name, filename };
}

const CRLF = Buffer.from([0x0d, 0x0a]);
const CRLF_CRLF = Buffer.from([0x0d, 0x0a, 0x0d, 0x0a]);

interface StreamingContext {
  fields: Map<string, string>;
  hasher: ReturnType<typeof createHash>;
  bytesWritten: number;
  fileWriter: WriteStream | null;
  currentPart: {
    name: string | null;
    filename: string | null;
    buffer: Buffer;
    headerDone: boolean;
  } | null;
  done: boolean;
  error: Error | null;
}

/**
 * Tiny streaming multipart parser. State machine:
 *   [pre]    - before first boundary
 *   [header] - reading part headers until CRLFCRLF
 *   [body]   - streaming body bytes until boundary
 *
 * For file parts (`filename` in Content-Disposition), bytes stream straight
 * to disk with an inline SHA-256 hash so large uploads never land in RAM.
 * For field parts, content is buffered (kept small — field values are tiny).
 */
class MultipartStreamParser {
  private buffer: Buffer = Buffer.alloc(0);
  private boundary: Buffer;
  private state: "pre" | "header" | "body" = "pre";
  private ctx: StreamingContext;
  private tmpFilePath: string;

  constructor(
    boundaryToken: string,
    ctx: StreamingContext,
    tmpFilePath: string,
  ) {
    // Match "\r\n--boundary" anywhere in the body. The leading CRLF is
    // synthesized for the very first part in feed() below.
    this.boundary = Buffer.from(`\r\n--${boundaryToken}`, "utf8");
    this.ctx = ctx;
    this.tmpFilePath = tmpFilePath;
  }

  async feed(chunk: Buffer): Promise<void> {
    if (this.ctx.error) return;
    if (this.state === "pre" && this.buffer.length === 0) {
      // Prepend a synthetic CRLF so the first "--boundary" in the body
      // matches the same `\r\n--boundary` marker used everywhere else.
      this.buffer = Buffer.concat([CRLF, chunk]);
    } else {
      this.buffer = Buffer.concat([this.buffer, chunk]);
    }

    while (!this.ctx.error) {
      if (this.state === "pre") {
        const idx = this.buffer.indexOf(this.boundary);
        if (idx < 0) return;
        const past = idx + this.boundary.length;
        // "--" after boundary marks the end of the multipart stream.
        if (
          this.buffer.length >= past + 2 &&
          this.buffer[past] === 0x2d &&
          this.buffer[past + 1] === 0x2d
        ) {
          this.ctx.done = true;
          return;
        }
        // Else: expect a CRLF before the next part's headers.
        if (this.buffer.length < past + 2) return;
        this.buffer = this.buffer.subarray(past + 2);
        this.state = "header";
        this.ctx.currentPart = {
          name: null,
          filename: null,
          buffer: Buffer.alloc(0),
          headerDone: false,
        };
        continue;
      }

      if (this.state === "header") {
        const idx = this.buffer.indexOf(CRLF_CRLF);
        if (idx < 0) return;
        const headerBlock = this.buffer.subarray(0, idx);
        const parsed = parseHeaders(headerBlock);
        if (!this.ctx.currentPart) {
          this.ctx.error = new Error("parser state error");
          return;
        }
        this.ctx.currentPart.name = parsed.name;
        this.ctx.currentPart.filename = parsed.filename;
        this.ctx.currentPart.headerDone = true;
        this.buffer = this.buffer.subarray(idx + CRLF_CRLF.length);

        if (parsed.filename !== null) {
          if (this.ctx.fileWriter) {
            this.ctx.error = new Error("multiple file parts not allowed");
            return;
          }
          this.ctx.fileWriter = createWriteStream(this.tmpFilePath);
        }
        this.state = "body";
        continue;
      }

      if (this.state === "body") {
        const idx = this.buffer.indexOf(this.boundary);
        if (idx < 0) {
          // Flush everything except a tail that could be the start of the
          // boundary marker.
          const safe = this.buffer.length - this.boundary.length;
          if (safe > 0) {
            const chunkToEmit = this.buffer.subarray(0, safe);
            await this.emitBody(chunkToEmit);
            this.buffer = this.buffer.subarray(safe);
          }
          return;
        }
        const payload = this.buffer.subarray(0, idx);
        await this.emitBody(payload);
        await this.closePart();
        this.buffer = this.buffer.subarray(idx);
        this.state = "pre";
        continue;
      }
    }
  }

  async finish(): Promise<void> {
    if (this.ctx.fileWriter) {
      await new Promise<void>((resolve) => {
        this.ctx.fileWriter!.end(() => resolve());
      });
      this.ctx.fileWriter = null;
    }
  }

  private async emitBody(chunk: Buffer): Promise<void> {
    if (chunk.length === 0 || !this.ctx.currentPart) return;
    const part = this.ctx.currentPart;
    if (part.filename !== null) {
      this.ctx.bytesWritten += chunk.length;
      if (this.ctx.bytesWritten > MAX_UPLOAD_BYTES) {
        this.ctx.error = new Error(
          `file exceeds ${MAX_UPLOAD_BYTES} byte limit`,
        );
        return;
      }
      this.ctx.hasher.update(chunk);
      const writer = this.ctx.fileWriter;
      if (writer && !writer.write(chunk)) {
        await new Promise<void>((resolve) =>
          writer.once("drain", () => resolve()),
        );
      }
    } else {
      // Field part — safe to buffer; cap at 1 MB as defence-in-depth.
      if (part.buffer.length + chunk.length > 1_000_000) {
        this.ctx.error = new Error("field value too large");
        return;
      }
      part.buffer = Buffer.concat([part.buffer, chunk]);
    }
  }

  private async closePart(): Promise<void> {
    if (!this.ctx.currentPart) return;
    const part = this.ctx.currentPart;
    if (part.filename === null && part.name) {
      this.ctx.fields.set(part.name, part.buffer.toString("utf8"));
    }
    if (part.filename !== null && this.ctx.fileWriter) {
      await new Promise<void>((resolve) => {
        this.ctx.fileWriter!.end(() => resolve());
      });
      this.ctx.fileWriter = null;
    }
    this.ctx.currentPart = null;
  }
}

/**
 * POST /api/admin/agent-releases/upload
 * multipart/form-data:
 *   os, arch, version, file, signature?, signedBy?, expectedSha256?
 *
 * Streams the file body through a hand-rolled multipart parser. The binary
 * never sits in memory — bytes flow directly to disk while SHA-256 is
 * computed inline. Next.js's `req.formData()` can't be used because undici
 * caps in-memory FormData at ~20 MB, which is below the agent binary size.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const authz = await requireAdmin(req);
  if (!authz.ok) return authz.response;

  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("multipart/form-data")) {
    return bad(415, "Expected multipart/form-data");
  }

  const boundary = extractBoundary(contentType);
  if (!boundary) {
    return bad(400, "Missing multipart boundary");
  }

  const bodyStream = req.body;
  if (!bodyStream) {
    return bad(400, "Empty request body");
  }

  const dir = storageDir();
  try {
    await mkdir(dir, { recursive: true });
  } catch (err) {
    return bad(
      500,
      `Cannot create storage dir: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const tmpName = `.upload-${crypto.randomUUID()}`;
  const tmpPath = path.join(dir, tmpName);

  const ctx: StreamingContext = {
    fields: new Map(),
    hasher: createHash("sha256"),
    bytesWritten: 0,
    fileWriter: null,
    currentPart: null,
    done: false,
    error: null,
  };

  const parser = new MultipartStreamParser(boundary, ctx, tmpPath);

  try {
    const nodeReadable = Readable.fromWeb(
      bodyStream as unknown as import("stream/web").ReadableStream<Uint8Array>,
    );
    for await (const chunkUnknown of nodeReadable) {
      const chunk =
        chunkUnknown instanceof Buffer
          ? chunkUnknown
          : Buffer.from(chunkUnknown as Uint8Array);
      await parser.feed(chunk);
      if (ctx.error) break;
    }
    await parser.finish();
  } catch (err) {
    await unlink(tmpPath).catch(() => undefined);
    return bad(
      500,
      `Upload stream failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (ctx.error) {
    await unlink(tmpPath).catch(() => undefined);
    return bad(400, ctx.error.message);
  }

  const os = (ctx.fields.get("os") ?? "").trim().toLowerCase();
  const arch = (ctx.fields.get("arch") ?? "").trim().toLowerCase();
  const version = (ctx.fields.get("version") ?? "").trim();
  const signatureRaw = ctx.fields.get("signature") ?? "";
  const signedByRaw = ctx.fields.get("signedBy") ?? "";
  const expectedSha256Raw = ctx.fields.get("expectedSha256") ?? "";

  const cleanup = async (): Promise<void> => {
    await unlink(tmpPath).catch(() => undefined);
  };

  if (!VALID_OS.has(os)) {
    await cleanup();
    return bad(400, `os must be one of: ${[...VALID_OS].join(", ")}`);
  }
  if (!VALID_ARCH.has(arch)) {
    await cleanup();
    return bad(400, `arch must be one of: ${[...VALID_ARCH].join(", ")}`);
  }
  if (!VERSION_RE.test(version)) {
    await cleanup();
    return bad(400, "version must match semver (e.g. 1.2.3 or 1.2.3-beta.1)");
  }

  const signature =
    signatureRaw.length > 0 ? signatureRaw.trim().toLowerCase() : null;
  if (signature !== null && (signature.length !== 128 || !HEX_RE.test(signature))) {
    await cleanup();
    return bad(400, "signature must be 128 lowercase hex chars");
  }

  const signedBy =
    signedByRaw.length > 0 ? signedByRaw.trim().toLowerCase() : null;
  if (signedBy !== null && (signedBy.length !== 8 || !HEX_RE.test(signedBy))) {
    await cleanup();
    return bad(400, "signedBy must be 8 lowercase hex chars");
  }

  const expectedSha256 =
    expectedSha256Raw.length > 0
      ? expectedSha256Raw.trim().toLowerCase()
      : null;
  if (
    expectedSha256 !== null &&
    (expectedSha256.length !== 64 || !HEX_RE.test(expectedSha256))
  ) {
    await cleanup();
    return bad(400, "expectedSha256 must be 64 lowercase hex chars");
  }

  if (ctx.bytesWritten === 0) {
    await cleanup();
    return bad(400, "file is empty or missing");
  }

  const sha256 = ctx.hasher.digest("hex");
  if (expectedSha256 !== null && sha256 !== expectedSha256) {
    await cleanup();
    return bad(
      400,
      `SHA-256 mismatch: computed ${sha256}, expected ${expectedSha256}`,
    );
  }

  const ext = extFor(os);
  const finalName = `vigil-agent-${os}-${arch}-${version}-${sha256.slice(0, 12)}${ext}`;
  const finalPath = path.join(dir, finalName);

  try {
    await rename(tmpPath, finalPath);
  } catch (err) {
    await cleanup();
    return bad(
      500,
      `Could not finalize upload: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Reject duplicate (os, arch, version).
  const existing = await db.agentRelease.findFirst({
    where: { os, arch, version },
    select: { id: true },
  });
  if (existing) {
    await unlink(finalPath).catch(() => undefined);
    return bad(409, `Release ${os}/${arch}/${version} already exists`);
  }

  const created = await db.agentRelease.create({
    data: {
      os,
      arch,
      version,
      sha256,
      filename: finalName,
      filePath: finalPath,
      fileSize: BigInt(ctx.bytesWritten),
      isActive: false,
      signature,
      signedBy,
      uploadedBy: authz.user.id,
    },
  });

  await audit(req, authz.user.id, "agent_release.upload", {
    entityId: created.id,
    metadata: {
      os,
      arch,
      version,
      sha256,
      signed: signature !== null,
      fileSize: ctx.bytesWritten,
    },
  });

  return NextResponse.json(
    {
      id: created.id,
      os: created.os,
      arch: created.arch,
      version: created.version,
      sha256: created.sha256,
      filename: created.filename,
      filePath: created.filePath,
      fileSize: ctx.bytesWritten,
      isActive: created.isActive,
      signature: created.signature,
      signedBy: created.signedBy,
      uploadedBy: created.uploadedBy,
      uploadedAt: created.createdAt.toISOString(),
    },
    { status: 201 },
  );
}

export const runtime = "nodejs";
export const maxDuration = 300;
