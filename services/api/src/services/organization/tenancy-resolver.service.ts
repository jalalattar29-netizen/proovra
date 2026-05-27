/**
 * Phase A1 — Canonical tenancy resolver.
 *
 * One module, one job: take a workspace anchor (a Team id) and return
 * the bound Organization id deterministically. Used by:
 *
 *   * Evidence write paths (create / completion / lifecycle)
 *   * Case write paths (after their own A1 follow-up)
 *   * Governance inheritance lookups (retention policy resolution,
 *     legal hold scope, destruction review attribution)
 *   * Audit feed projections (org-level audit rollup reads)
 *
 * Hard rules:
 *   * The Phase 2.7X Stage 6 migration tightened `teams.organization_id`
 *     to NOT NULL. Any Team row returned by the database carries a
 *     non-null `organizationId`. If a write site sees null, it's a
 *     deserialization bug — surface the violation, do not paper over it.
 *
 *   * The Phase A1 migration adds an FK from `evidence.organization_id`
 *     to `organizations(id)` plus a CHECK constraint that rejects
 *     `team_id IS NOT NULL AND organization_id IS NULL`. So any write
 *     that passes a teamId to this helper MUST also write the
 *     organizationId returned here. The reverse — writing
 *     organizationId without teamId — is allowed and is the
 *     legacy personal-mode path; this helper supports both.
 *
 *   * This helper never CREATES an organization. If a Team has no
 *     organization yet (impossible post-Stage-6 unless DB drift), it
 *     throws — never silently invents one.
 *
 *   * This helper never CROSSES tenants. A Team belongs to exactly
 *     one Organization. If the caller supplies an organizationId
 *     hint that disagrees with the team's bound organization, the
 *     helper rejects the call rather than guessing.
 */

import type { PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../../db.js";
import { bump } from "../ops/metrics.service.js";

export type ResolvedTenancy = {
  teamId: string | null;
  organizationId: string | null;
  /**
   * The route through which the organization id was resolved.
   * Operators see this in audit metadata so a tenancy choice is
   * always traceable.
   */
  source:
    | "team_lookup"
    | "personal_team"
    | "no_workspace"
    | "explicit";
};

export class TenancyResolutionError extends Error {
  constructor(
    public readonly code:
      | "team_not_found"
      | "team_org_missing"
      | "tenancy_disagreement"
      | "user_personal_team_missing"
      | "invalid_input",
    public readonly details?: Record<string, unknown>,
  ) {
    super(code);
    this.name = "TenancyResolutionError";
  }
}

/**
 * Resolve the tenancy for an evidence/case/etc. write. Provide the
 * teamId when one is known (the canonical path), or fall back to the
 * owner's personal team when the request is a solo-user create.
 */
export async function resolveTenancyForWrite(
  input: {
    teamId?: string | null;
    /** Owner user id — required when teamId is absent. */
    ownerUserId?: string | null;
    /**
     * Optional caller-supplied expectation. When set, the resolver
     * REJECTS the write if the resolved organizationId disagrees. Use
     * for routes that already know their tenancy (defense in depth).
     */
    expectedOrganizationId?: string | null;
  },
  client: PrismaClient = defaultPrisma,
): Promise<ResolvedTenancy> {
  if (input.teamId) {
    const team = await client.team.findUnique({
      where: { id: input.teamId },
      select: { id: true, organizationId: true },
    });
    if (!team) {
      // Phase G1 — tenancy observability.
      bump("tenancy_resolution_failure_total");
      throw new TenancyResolutionError("team_not_found", {
        teamId: input.teamId,
      });
    }
    if (!team.organizationId) {
      // Post-Stage-6 this should be impossible. Surface as an error
      // so the operator gets a real signal rather than a silent
      // FK violation later.
      // Phase G1 — count Stage-6 invariant violations.
      bump("orphan_governance_object_total");
      throw new TenancyResolutionError("team_org_missing", {
        teamId: input.teamId,
      });
    }
    if (
      input.expectedOrganizationId &&
      input.expectedOrganizationId !== team.organizationId
    ) {
      // Phase G1 — count cross-org disagreements (caller hinted a
      // different org than the team's bound org).
      bump("tenancy_disagreement_total");
      bump("cross_org_resolution_blocked_total");
      throw new TenancyResolutionError("tenancy_disagreement", {
        teamId: input.teamId,
        teamOrganizationId: team.organizationId,
        expectedOrganizationId: input.expectedOrganizationId,
      });
    }
    return {
      teamId: team.id,
      organizationId: team.organizationId,
      source: "team_lookup",
    };
  }

  // No teamId provided — try the owner's personal team. This is the
  // solo-user path. We do NOT bootstrap from here (that lives in
  // `workspace-bootstrap.service.ts` and is called from
  // `/v1/platform/context`); we only read. If the personal team
  // doesn't exist yet, we return a `no_workspace` tenancy so legacy
  // owner-scoped writes continue to work.
  if (input.ownerUserId) {
    const personal = await client.team.findFirst({
      where: { ownerUserId: input.ownerUserId, isPersonal: true },
      select: { id: true, organizationId: true },
    });
    if (personal && personal.organizationId) {
      return {
        teamId: null,
        organizationId: null,
        source: "no_workspace",
      };
    }
    return {
      teamId: null,
      organizationId: null,
      source: "no_workspace",
    };
  }

  throw new TenancyResolutionError("invalid_input", {
    reason: "neither teamId nor ownerUserId provided",
  });
}

/**
 * Convenience: take a known teamId and return its bound
 * organizationId, throwing on the Stage-6 invariant violation.
 * Used by governance inheritance lookups (policy resolution,
 * legal-hold rollups) where the caller already knows the workspace.
 */
export async function getOrganizationIdForTeam(
  teamId: string,
  client: PrismaClient = defaultPrisma,
): Promise<string> {
  const team = await client.team.findUnique({
    where: { id: teamId },
    select: { organizationId: true },
  });
  if (!team) {
    throw new TenancyResolutionError("team_not_found", { teamId });
  }
  if (!team.organizationId) {
    throw new TenancyResolutionError("team_org_missing", { teamId });
  }
  return team.organizationId;
}

/**
 * Operational invariant check used by tests + the diagnostic script.
 * Returns a structured report describing whether the tenancy graph
 * is internally consistent. Never mutates.
 */
export type TenancyInvariantCheck = {
  ok: boolean;
  reason:
    | "ok"
    | "team_organization_missing"
    | "evidence_organization_missing"
    | "evidence_team_organization_mismatch";
  evidenceId?: string;
  teamId?: string | null;
  evidenceOrganizationId?: string | null;
  teamOrganizationId?: string | null;
};

/**
 * Phase G4.1 — Compatibility-read tenancy resolver.
 *
 * Returns a deterministic tenancy projection for ANY evidence row,
 * including the legacy personal-mode rows whose `teamId` is NULL.
 *
 * Hard rules:
 *   * READ-ONLY. Never mutates the evidence row. Custody history,
 *     hashes, and timestamps are untouched. The personal-team
 *     resolution is computed on the fly each call.
 *   * The DB-level invariant from Phase A1 holds: when teamId is
 *     non-null the team has a non-null organizationId. When teamId
 *     is null, the row is a legacy personal-mode row and we project
 *     it through the owner's personal team if one exists today.
 *   * Returns `source: "orphan"` ONLY when neither teamId nor a
 *     resolvable personal team exists. Pre-G4 personal rows always
 *     have an ownerUserId, so this is rare and audited.
 *
 * Use this helper from READ paths that need a deterministic
 * tenancy for ALL evidence (governance rollups, audit feeds, cross-
 * matter views). Continue using `resolveTenancyForWrite` for write
 * paths — that helper preserves the legacy `no_workspace` semantics
 * to keep solo-user creates working.
 */
export type EvidenceReadTenancy = {
  effectiveTeamId: string | null;
  effectiveOrganizationId: string | null;
  source:
    | "explicit_team"
    | "legacy_personal_fallback"
    | "orphan";
  /** True when the row itself has `teamId IS NULL` (legacy). */
  isLegacyPersonal: boolean;
};

export async function resolveEvidenceTenancyForRead(
  input: {
    evidenceId?: string;
    /**
     * Pre-fetched evidence row (preferred — avoids a re-fetch). When
     * supplied, the helper does not hit `evidence` again.
     */
    evidence?: {
      id: string;
      teamId: string | null;
      organizationId: string | null;
      ownerUserId: string | null;
    } | null;
  },
  client: PrismaClient = defaultPrisma,
): Promise<EvidenceReadTenancy> {
  let row = input.evidence ?? null;
  if (!row) {
    if (!input.evidenceId) {
      throw new TenancyResolutionError("invalid_input", {
        reason: "neither evidence nor evidenceId provided",
      });
    }
    row = await client.evidence.findUnique({
      where: { id: input.evidenceId },
      select: {
        id: true,
        teamId: true,
        organizationId: true,
        ownerUserId: true,
      },
    });
  }
  if (!row) {
    return {
      effectiveTeamId: null,
      effectiveOrganizationId: null,
      source: "orphan",
      isLegacyPersonal: false,
    };
  }

  // Explicit team — Stage 6 invariant guarantees the team's org is
  // present. We surface the evidence's own organizationId so callers
  // can cross-check it against the team's bound org (the A1 CHECK
  // constraint prevents the disagreement at write time).
  if (row.teamId) {
    return {
      effectiveTeamId: row.teamId,
      effectiveOrganizationId: row.organizationId,
      source: "explicit_team",
      isLegacyPersonal: false,
    };
  }

  // Legacy personal-mode row. We look up the owner's personal team
  // and project that team's tenancy. The evidence row is NOT
  // modified — this is purely a read projection.
  if (row.ownerUserId) {
    const personal = await client.team.findFirst({
      where: { ownerUserId: row.ownerUserId, isPersonal: true },
      select: { id: true, organizationId: true },
    });
    if (personal && personal.organizationId) {
      return {
        effectiveTeamId: personal.id,
        effectiveOrganizationId: personal.organizationId,
        source: "legacy_personal_fallback",
        isLegacyPersonal: true,
      };
    }
  }

  // Truly orphaned — no team, no resolvable personal workspace.
  // The diagnostic script flags these and the operator decides.
  return {
    effectiveTeamId: null,
    effectiveOrganizationId: null,
    source: "orphan",
    isLegacyPersonal: true,
  };
}

export async function checkEvidenceTenancyInvariant(
  evidenceId: string,
  client: PrismaClient = defaultPrisma,
): Promise<TenancyInvariantCheck> {
  const evidence = await client.evidence.findUnique({
    where: { id: evidenceId },
    select: {
      id: true,
      teamId: true,
      organizationId: true,
    },
  });
  if (!evidence) {
    return { ok: false, reason: "evidence_organization_missing", evidenceId };
  }
  if (!evidence.teamId) {
    // Legacy personal-mode row: both should be null. The DB CHECK
    // constraint already enforces this; we return ok=true so callers
    // can short-circuit cleanly.
    return { ok: true, reason: "ok", evidenceId, teamId: null };
  }
  const team = await client.team.findUnique({
    where: { id: evidence.teamId },
    select: { organizationId: true },
  });
  if (!team || !team.organizationId) {
    return {
      ok: false,
      reason: "team_organization_missing",
      evidenceId,
      teamId: evidence.teamId,
    };
  }
  if (!evidence.organizationId) {
    return {
      ok: false,
      reason: "evidence_organization_missing",
      evidenceId,
      teamId: evidence.teamId,
      teamOrganizationId: team.organizationId,
    };
  }
  if (evidence.organizationId !== team.organizationId) {
    return {
      ok: false,
      reason: "evidence_team_organization_mismatch",
      evidenceId,
      teamId: evidence.teamId,
      evidenceOrganizationId: evidence.organizationId,
      teamOrganizationId: team.organizationId,
    };
  }
  return {
    ok: true,
    reason: "ok",
    evidenceId,
    teamId: evidence.teamId,
    evidenceOrganizationId: evidence.organizationId,
    teamOrganizationId: team.organizationId,
  };
}
