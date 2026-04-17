import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/authz";
import { audit } from "@/lib/audit";
import { silenceCheckOnAgent } from "@/lib/ws-server";

function isUUID(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  const { id } = await params;
  if (!isUUID(id)) {
    return NextResponse.json({ error: "Invalid check id" }, { status: 400 });
  }

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object" || typeof (body as { until?: unknown }).until !== "string") {
    return NextResponse.json(
      { error: "Body must be { until: ISO-8601 string }" },
      { status: 400 },
    );
  }
  const untilRaw = (body as { until: string }).until;
  const until = new Date(untilRaw);
  if (Number.isNaN(until.getTime())) {
    return NextResponse.json({ error: "Invalid until timestamp" }, { status: 400 });
  }
  if (until.getTime() <= Date.now()) {
    return NextResponse.json(
      { error: "until must be in the future" },
      { status: 400 },
    );
  }

  const existing = await db.check.findUnique({
    where: { id },
    select: { id: true, name: true, agentId: true },
  });
  if (!existing) {
    return NextResponse.json({ error: "Check not found" }, { status: 404 });
  }

  const updated = await db.check.update({
    where: { id },
    data: { silencedUntil: until },
    select: { id: true, name: true, silencedUntil: true },
  });

  // Best-effort: also tell the agent to stop running this check locally.
  // If the agent is offline, the Hub-side suppression (silencedUntil) still
  // holds — it'll skip alerting on any results that sneak in.
  let pushedToAgent = false;
  if (existing.agentId) {
    pushedToAgent = silenceCheckOnAgent(existing.agentId, id, until);
  }

  await audit(req, auth.user.id, "check.silence", {
    entityType: "check",
    entityId: id,
    metadata: {
      until: until.toISOString(),
      name: existing.name,
      pushedToAgent,
    },
  });

  return NextResponse.json({
    id: updated.id,
    name: updated.name,
    silencedUntil: updated.silencedUntil?.toISOString() ?? null,
    pushedToAgent,
  });
}
