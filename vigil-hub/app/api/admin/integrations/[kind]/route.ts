import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/authz";
import { audit } from "@/lib/audit";
import {
  applyIntegrationPatch,
  isIntegrationKind,
  loadIntegrationDetail,
} from "@/lib/integrations";
import { assertExternalUrl } from "@/lib/url-safety";

interface RouteContext {
  params: Promise<{ kind: string }>;
}

/**
 * GET /api/admin/integrations/[kind]
 * Returns the full config for a single integration. Secrets are redacted;
 * callers must re-submit any secret field they intend to change.
 */
export async function GET(
  req: NextRequest,
  ctx: RouteContext,
): Promise<NextResponse> {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  const { kind } = await ctx.params;
  if (!isIntegrationKind(kind)) {
    return NextResponse.json({ error: `Unknown integration: ${kind}` }, { status: 404 });
  }

  const detail = await loadIntegrationDetail(kind);
  return NextResponse.json(detail);
}

/**
 * PATCH /api/admin/integrations/[kind]
 * Update the enabled flag and/or config fields. Secrets must be resubmitted
 * in plaintext; the redaction sentinel (••••••••) means "leave existing".
 *
 * SSRF guard: when the config contains a URL field (slack/teams/discord/webhook),
 * we validate that the URL is not targeting internal networks before writing.
 */
export async function PATCH(
  req: NextRequest,
  ctx: RouteContext,
): Promise<NextResponse> {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  const { kind } = await ctx.params;
  if (!isIntegrationKind(kind)) {
    return NextResponse.json({ error: `Unknown integration: ${kind}` }, { status: 404 });
  }

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const { enabled, config } = body as {
    enabled?: unknown;
    config?: unknown;
  };

  if (enabled !== undefined && typeof enabled !== "boolean") {
    return NextResponse.json(
      { error: "enabled must be a boolean" },
      { status: 400 },
    );
  }
  if (config !== undefined && (typeof config !== "object" || config === null)) {
    return NextResponse.json(
      { error: "config must be an object" },
      { status: 400 },
    );
  }

  const configObj = (config ?? {}) as Record<string, unknown>;

  // SSRF validation for URL-bearing kinds.
  if (typeof configObj.url === "string" && configObj.url.length > 0) {
    try {
      await assertExternalUrl(configObj.url);
    } catch (err) {
      return NextResponse.json(
        {
          error: `URL rejected: ${err instanceof Error ? err.message : "invalid URL"}`,
        },
        { status: 400 },
      );
    }
  }
  if (
    kind === "azure_kv" &&
    typeof configObj.vault_url === "string" &&
    configObj.vault_url.length > 0
  ) {
    try {
      await assertExternalUrl(configObj.vault_url);
    } catch (err) {
      return NextResponse.json(
        {
          error: `Vault URL rejected: ${err instanceof Error ? err.message : "invalid URL"}`,
        },
        { status: 400 },
      );
    }
  }

  try {
    const detail = await applyIntegrationPatch(kind, {
      enabled: enabled as boolean | undefined,
      config: config as Record<string, unknown> | undefined,
    });

    await audit(req, auth.user.id, "integration.update", {
      entityType: "integration",
      entityId: kind,
      metadata: {
        kind,
        enabled: detail.enabled,
        // Note: individual secret values are not logged — only field names.
        changedFields: Object.keys(configObj),
      },
    });

    return NextResponse.json(detail);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[admin/integrations] PATCH failed", {
      kind,
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: "Failed to update integration" },
      { status: 500 },
    );
  }
}
