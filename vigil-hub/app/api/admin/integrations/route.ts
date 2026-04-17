import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/authz";
import { loadIntegrationSummaries } from "@/lib/integrations";

/**
 * GET /api/admin/integrations
 * Returns a summary of every integration kind (configured, enabled,
 * last-delivery). Drives the /admin/integrations card grid.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  const summaries = await loadIntegrationSummaries();
  return NextResponse.json({ integrations: summaries });
}
