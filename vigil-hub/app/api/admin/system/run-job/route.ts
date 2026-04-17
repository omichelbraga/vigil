import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/authz";
import { audit } from "@/lib/audit";
import { runCertChecks } from "@/lib/cert-monitor";
import { runExpiryChecks } from "@/lib/expiry-monitor";
import { markJobRun, type JobName } from "@/lib/system-metrics";

export const runtime = "nodejs";

const KNOWN_JOBS: readonly JobName[] = ["cert", "expiry"] as const;

function isKnownJob(value: string | null): value is JobName {
  return value !== null && (KNOWN_JOBS as readonly string[]).includes(value);
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const authz = await requireAdmin(req);
  if (!authz.ok) return authz.response;

  const name = req.nextUrl.searchParams.get("name");
  if (!isKnownJob(name)) {
    return NextResponse.json(
      { error: "Invalid job name. Expected one of: cert, expiry" },
      { status: 400 },
    );
  }

  const startedAt = Date.now();
  let ok = true;
  let errorMessage: string | null = null;

  try {
    if (name === "cert") {
      await runCertChecks();
    } else {
      await runExpiryChecks();
    }
    markJobRun(name);
  } catch (err) {
    ok = false;
    errorMessage = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error(`[admin/system/run-job] ${name} failed:`, err);
  }

  const durationMs = Date.now() - startedAt;

  await audit(req, authz.user.id, `admin.system.run_job.${name}`, {
    entityType: "system",
    metadata: {
      job: name,
      durationMs,
      ok,
      ...(errorMessage ? { error: errorMessage } : {}),
    },
  });

  if (!ok) {
    return NextResponse.json(
      { ok: false, durationMs, error: errorMessage },
      { status: 500 },
    );
  }
  return NextResponse.json({ ok: true, durationMs });
}
