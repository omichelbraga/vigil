import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";

type Role = "admin" | "editor" | "viewer";
const MUTATING_ROLES: readonly Role[] = ["admin", "editor"] as const;

interface ResolveBody {
  postmortemMarkdown?: string;
}

interface ResolveResponse {
  id: string;
  status: string;
  resolvedAt: string | null;
  postmortemMarkdown: string | null;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse<ResolveResponse | { error: string }>> {
  const session = await getSession(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const role = (session.user as { role?: Role } | undefined)?.role;
  if (!role || !MUTATING_ROLES.includes(role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;

  // Optional body; tolerate empty/malformed JSON.
  const raw = await req.text();
  let body: ResolveBody = {};
  if (raw.trim().length > 0) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const candidate = (parsed as { postmortemMarkdown?: unknown }).postmortemMarkdown;
        if (typeof candidate === "string") {
          body.postmortemMarkdown = candidate;
        }
      }
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
  }

  const existing = await db.incident.findUnique({
    where: { id },
    select: { id: true, status: true },
  });
  if (!existing) {
    return NextResponse.json({ error: "Incident not found" }, { status: 404 });
  }

  const now = new Date();
  const updated = await db.incident.update({
    where: { id },
    data: {
      status: "resolved",
      resolvedAt: now,
      ...(body.postmortemMarkdown !== undefined && {
        postmortemMarkdown: body.postmortemMarkdown,
      }),
    },
    select: {
      id: true,
      status: true,
      resolvedAt: true,
      postmortemMarkdown: true,
    },
  });

  await audit(req, session.user.id, "incident.resolve", {
    entityType: "incident",
    entityId: id,
    metadata: {
      hasPostmortem: body.postmortemMarkdown !== undefined,
    },
  });

  return NextResponse.json({
    id: updated.id,
    status: updated.status,
    resolvedAt: updated.resolvedAt ? updated.resolvedAt.toISOString() : null,
    postmortemMarkdown: updated.postmortemMarkdown ?? null,
  });
}
