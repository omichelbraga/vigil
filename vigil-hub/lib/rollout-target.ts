import { db } from "./db";
import type { AgentRelease } from "@prisma/client";

/**
 * Filter spec for picking which agents a RolloutJob targets. All provided
 * fields are AND-ed; within arrays (tags/agentIds) we use OR semantics.
 *
 * Stored verbatim as the `targetFilter` JSON column on RolloutJob.
 */
export interface RolloutTargetFilter {
  /** Match Agent.os (case-insensitive equality) */
  os?: string;
  /** Match AgentInventory.arch (case-insensitive equality) */
  arch?: string;
  /** Any overlap with Agent.tags */
  tags?: string[];
  /** Explicit allowlist — if provided, agents NOT in the list are excluded */
  agentIds?: string[];
}

/** Lightweight shape returned by the resolver — enough for the runner. */
export interface ResolvedAgent {
  id: string;
  name: string;
  os: string | null;
  version: string | null;
  hostname: string | null;
  tags: string[];
  autoUpdate: boolean;
  arch: string | null;
}

/**
 * Input validation for a target filter payload arriving from the network.
 * Returns a parsed filter + any validation error (to be returned as 400).
 */
export function parseTargetFilter(
  raw: unknown,
): { ok: true; filter: RolloutTargetFilter } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "targetFilter must be an object" };
  }
  const obj = raw as Record<string, unknown>;
  const filter: RolloutTargetFilter = {};

  if (obj.os !== undefined) {
    if (typeof obj.os !== "string" || obj.os.length === 0 || obj.os.length > 32) {
      return { ok: false, error: "targetFilter.os must be a short non-empty string" };
    }
    filter.os = obj.os;
  }
  if (obj.arch !== undefined) {
    if (typeof obj.arch !== "string" || obj.arch.length === 0 || obj.arch.length > 32) {
      return { ok: false, error: "targetFilter.arch must be a short non-empty string" };
    }
    filter.arch = obj.arch;
  }
  if (obj.tags !== undefined) {
    if (!Array.isArray(obj.tags) || obj.tags.some((t) => typeof t !== "string" || t.length === 0)) {
      return { ok: false, error: "targetFilter.tags must be a non-empty string array" };
    }
    if (obj.tags.length > 64) {
      return { ok: false, error: "targetFilter.tags max 64 entries" };
    }
    filter.tags = obj.tags as string[];
  }
  if (obj.agentIds !== undefined) {
    if (
      !Array.isArray(obj.agentIds) ||
      obj.agentIds.some((a) => typeof a !== "string" || a.length === 0)
    ) {
      return { ok: false, error: "targetFilter.agentIds must be a non-empty string array" };
    }
    if (obj.agentIds.length > 1024) {
      return { ok: false, error: "targetFilter.agentIds max 1024 entries" };
    }
    filter.agentIds = obj.agentIds as string[];
  }
  return { ok: true, filter };
}

/**
 * Resolve target agents for a rollout. AND semantics across fields,
 * intersection semantics inside `tags`.
 *
 * Exclusions:
 *   - isActive = false
 *   - autoUpdate = false (v1 always honours the flag)
 *   - already running `release.version`
 *   - has an in-flight (pending|in_progress) RolloutAttempt for this job (see `excludeJobId`)
 */
export async function resolveTargetAgents(
  filter: RolloutTargetFilter,
  release: Pick<AgentRelease, "id" | "version" | "os" | "arch">,
  opts: { excludeJobId?: string } = {},
): Promise<ResolvedAgent[]> {
  // Base query — always AND the release os/arch so we can't push a linux binary to a windows agent.
  const whereClauses: Record<string, unknown>[] = [
    { isActive: true },
    { autoUpdate: true },
    // Narrow to platform — os lives on Agent directly.
    { os: release.os },
  ];

  if (filter.os) {
    whereClauses.push({ os: filter.os });
  }
  if (filter.tags && filter.tags.length > 0) {
    whereClauses.push({ tags: { hasSome: filter.tags } });
  }
  if (filter.agentIds && filter.agentIds.length > 0) {
    whereClauses.push({ id: { in: filter.agentIds } });
  }

  // Pull candidates + inventory for arch + open attempts for this job.
  const rows = await db.agent.findMany({
    where: { AND: whereClauses },
    select: {
      id: true,
      name: true,
      os: true,
      version: true,
      hostname: true,
      tags: true,
      autoUpdate: true,
      inventory: { select: { arch: true } },
      rolloutAttempts: opts.excludeJobId
        ? {
            where: {
              jobId: opts.excludeJobId,
              status: { in: ["pending", "in_progress", "success"] },
            },
            select: { id: true, status: true },
          }
        : undefined,
    },
  });

  return rows
    .filter((r) => {
      // Arch filter (from inventory)
      if (filter.arch) {
        const arch = r.inventory?.arch ?? null;
        if (!arch || arch.toLowerCase() !== filter.arch.toLowerCase()) return false;
      } else {
        // Even without an explicit arch filter, honour the release's own arch.
        const arch = r.inventory?.arch ?? null;
        if (arch && arch.toLowerCase() !== release.arch.toLowerCase()) return false;
      }
      // Already on target version?
      if (r.version && r.version === release.version) return false;
      // In-flight attempt on this job? (skip — runner owns the progression)
      if (opts.excludeJobId && r.rolloutAttempts && r.rolloutAttempts.length > 0) return false;
      return true;
    })
    .map((r) => ({
      id: r.id,
      name: r.name,
      os: r.os,
      version: r.version,
      hostname: r.hostname,
      tags: r.tags,
      autoUpdate: r.autoUpdate,
      arch: r.inventory?.arch ?? null,
    }));
}

/**
 * Count total matching targets for a filter (used to compute progress bars
 * without loading the full agent list). Applies the same exclusions as the
 * resolver but does NOT exclude in-flight attempts — callers summing progress
 * want the full cohort, not the remaining cohort.
 */
export async function countTargetAgents(
  filter: RolloutTargetFilter,
  release: Pick<AgentRelease, "os" | "arch" | "version">,
): Promise<number> {
  const whereClauses: Record<string, unknown>[] = [
    { isActive: true },
    { autoUpdate: true },
    { os: release.os },
  ];
  if (filter.os) whereClauses.push({ os: filter.os });
  if (filter.tags && filter.tags.length > 0) {
    whereClauses.push({ tags: { hasSome: filter.tags } });
  }
  if (filter.agentIds && filter.agentIds.length > 0) {
    whereClauses.push({ id: { in: filter.agentIds } });
  }

  const rows = await db.agent.findMany({
    where: { AND: whereClauses },
    select: {
      id: true,
      version: true,
      inventory: { select: { arch: true } },
    },
  });
  return rows.filter((r) => {
    if (filter.arch) {
      const arch = r.inventory?.arch ?? null;
      if (!arch || arch.toLowerCase() !== filter.arch.toLowerCase()) return false;
    } else {
      const arch = r.inventory?.arch ?? null;
      if (arch && arch.toLowerCase() !== release.arch.toLowerCase()) return false;
    }
    return true;
  }).length;
}
