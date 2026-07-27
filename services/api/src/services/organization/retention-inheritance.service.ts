/**
 * Phase B0 — Deterministic retention policy inheritance.
 *
 * Resolution order (highest-precedence first):
 *
 *   1. Team-level `EvidenceRetentionPolicy` (the operational
 *      retention policy a workspace administrator already set).
 *      Whenever this exists and is ACTIVE, the workspace's effective
 *      retention is the team-level value — the workspace remains
 *      the operational owner.
 *
 *   2. Organization-level `OrganizationPolicy` with
 *      `key = "retention.default"`. The org admin publishes this
 *      via `POST /v1/orgs/:id/policies/retention`. Workspaces under
 *      the org inherit it ONLY when they have no team-level policy.
 *
 *   3. Fallback `null` (no policy applied). The workspace operates
 *      with indefinite retention until an operator publishes one.
 *
 * Hard rules:
 *   * No loops are possible — there is no chain beyond Team → Org.
 *   * No ambiguity — the resolver returns exactly one of
 *     `team_policy` / `org_policy_inherited` / `none`.
 *   * The resolver is read-only. It never creates a team-level
 *     policy by copying an inherited org template; inheritance is
 *     virtual at lookup time.
 *   * PHASE 6 §9.4 (2026-07-22) — the org template's `immutable: true`
 *     flag is now ENFORCED as a mandatory floor via the canonical
 *     policy-precedence engine (`governance/policy-precedence.ts`):
 *     a WEAKER team-level policy (shorter retention than the immutable
 *     org template; `null` = indefinite is the strongest value) cannot
 *     displace it — the effective retention is raised to the floor and
 *     the resolution is flagged `mandatoryFloorApplied` so surfaces
 *     render "enforced by organization". Team policies at least as
 *     strong as the floor keep winning (child may strengthen, never
 *     weaken — §9.4 rule 2).
 *
 * Used by:
 *   * `services/governance-lifecycle/retention-engine.service.ts`
 *     when computing the effective retention deadline for an
 *     evidence row in a workspace that has no own policy.
 *   * `apps/web/app/(app)/governance/retention/page.tsx` (read-only
 *     surface) to render "Inherited from organization" badges.
 */

import type { PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../../db.js";
// PHASE 6 §9.4 — canonical precedence engine (first adopter).
import {
  resolveEffectivePolicyValue,
  strongerRetentionDays,
} from "../governance/policy-precedence.js";

const RETENTION_POLICY_KEY = "retention.default";

export type RetentionTemplateValue = {
  retentionDays: number | null;
  immutable: boolean;
  description: string | null;
};

export type RetentionResolution =
  | {
      source: "team_policy";
      teamId: string;
      policyId: string;
      retentionDays: number | null;
      immutable: boolean;
      /**
       * PHASE 6 §9.4 — true when the team policy was WEAKER than an
       * immutable org template and the effective `retentionDays` was
       * raised to the org floor (the team row itself is untouched —
       * enforcement is virtual at resolution time, like inheritance).
       */
      mandatoryFloorApplied?: boolean;
    }
  | {
      source: "org_policy_inherited";
      teamId: string;
      organizationId: string;
      template: RetentionTemplateValue;
    }
  | {
      source: "none";
      teamId: string;
    };

function readRetentionTemplate(
  raw: unknown,
): RetentionTemplateValue | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const retentionDays =
    obj.retentionDays === null
      ? null
      : typeof obj.retentionDays === "number"
        ? obj.retentionDays
        : null;
  if (obj.retentionDays !== null && typeof obj.retentionDays !== "number") {
    // Malformed; treat as no template.
    return null;
  }
  return {
    retentionDays,
    immutable: obj.immutable === true,
    description:
      typeof obj.description === "string"
        ? obj.description
        : obj.description === null
          ? null
          : null,
  };
}

/**
 * Resolve the effective retention policy for a workspace
 * (`teamId`). Returns the team-level policy when present;
 * otherwise the inherited org-level template; otherwise `none`.
 *
 * Never throws. A DB error in either lookup yields `source: "none"`
 * so the caller falls back to indefinite retention (the
 * pre-A1 behaviour).
 */
export async function resolveTeamRetentionPolicy(
  teamId: string,
  client: PrismaClient = defaultPrisma,
): Promise<RetentionResolution> {
  // Step 1 — look for a team-level ACTIVE policy.
  let teamPolicy: {
    id: string;
    retentionDays: number | null;
    immutable: boolean;
  } | null = null;
  try {
    const row = await client.evidenceRetentionPolicy.findFirst({
      where: { teamId, status: "ACTIVE" },
      select: { id: true, retentionDays: true, immutable: true },
      orderBy: { createdAt: "desc" },
    });
    teamPolicy = row ?? null;
  } catch {
    teamPolicy = null;
  }
  // Step 2 — look up the team's organization and any org-level
  // template. Needed even when a team policy exists: an IMMUTABLE org
  // template is a mandatory floor over the team value (§9.4).
  let organizationId: string | null = null;
  try {
    const team = await client.team.findUnique({
      where: { id: teamId },
      select: { organizationId: true },
    });
    organizationId = team?.organizationId ?? null;
  } catch {
    organizationId = null;
  }

  let template: RetentionTemplateValue | null = null;
  if (organizationId) {
    try {
      const orgPolicy = await client.organizationPolicy.findUnique({
        where: {
          organization_policies_org_key_uniq: {
            organizationId,
            key: RETENTION_POLICY_KEY,
          },
        },
        select: { value: true },
      });
      template = readRetentionTemplate(orgPolicy?.value ?? null);
    } catch {
      template = null;
    }
  }

  if (teamPolicy) {
    // PHASE 6 §9.4 — canonical precedence: the workspace value wins
    // unless a mandatory (immutable) org floor is stronger.
    if (template?.immutable) {
      const effective = resolveEffectivePolicyValue<number | null>(
        [
          {
            scope: "ORGANIZATION",
            value: template.retentionDays,
            mandatory: true,
          },
          { scope: "WORKSPACE", value: teamPolicy.retentionDays },
        ],
        strongerRetentionDays,
      );
      if (effective.defined && effective.parentPrevailed) {
        return {
          source: "team_policy",
          teamId,
          policyId: teamPolicy.id,
          retentionDays: effective.value,
          immutable: teamPolicy.immutable,
          mandatoryFloorApplied: true,
        };
      }
    }
    return {
      source: "team_policy",
      teamId,
      policyId: teamPolicy.id,
      retentionDays: teamPolicy.retentionDays,
      immutable: teamPolicy.immutable,
    };
  }

  if (!organizationId || !template) {
    return { source: "none", teamId };
  }

  return {
    source: "org_policy_inherited",
    teamId,
    organizationId,
    template,
  };
}
