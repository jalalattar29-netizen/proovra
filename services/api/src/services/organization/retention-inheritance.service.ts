/**
 * Phase B0 — retention inheritance, as a PROJECTION of the one decision.
 *
 * Resolution order (highest-precedence first):
 *
 *   1. The workspace's own ACTIVE `EvidenceRetentionPolicy` at WORKSPACE
 *      scope — the workspace remains the operational owner.
 *   2. The organization's `OrganizationPolicy` with
 *      `key = "retention.default"`, inherited ONLY when the workspace has no
 *      policy of its own (`POST /v1/orgs/:id/policies/retention`).
 *   3. `none` — no policy at any tier; indefinite retention applies.
 *
 * PV-DUP-002 — THIS IS NO LONGER A SECOND RESOLVER.
 *
 * It used to run its own queries: "any ACTIVE policy row, newest first" for
 * step 1 (so a CASE-only policy was reported as governing the whole
 * workspace), its own floor arithmetic, and a try/catch around every read so a
 * database failure answered `none`. The retention engine asked it the same
 * question and got a different answer; the retention page rendered both.
 *
 * It now asks `resolveEffectiveRetentionPolicy` for the workspace-level
 * decision — the call with no evidence type, case or jurisdiction — and
 * reshapes that answer. The engine reads the organization template once
 * (`retention-template.ts`) and applies the §9.4 mandatory floor there, so the
 * two panels cannot disagree about the governing value, and a failed read
 * surfaces as a failure instead of "no policy applies".
 *
 * Hard rules:
 *   * No loops — there is no chain beyond Workspace → Organization.
 *   * Exactly one of `team_policy` / `org_policy_inherited` / `none`.
 *   * Read-only. Inheritance is virtual at lookup time; no workspace policy
 *     row is ever created by copying an inherited template, and a raised
 *     floor never rewrites the workspace row.
 *
 * Used by `GET /v1/governance/retention/inheritance`, rendered by
 * `apps/web/components/governance/RetentionInheritanceSummary.tsx`.
 */

import type { PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../../db.js";
import { resolveEffectiveRetentionPolicy } from "../governance-lifecycle/retention-engine.service.js";
import type { RetentionTemplateValue } from "./retention-template.js";

export type { RetentionTemplateValue } from "./retention-template.js";

export type RetentionResolution =
  | {
      source: "team_policy";
      teamId: string;
      policyId: string;
      retentionDays: number | null;
      immutable: boolean;
      /**
       * PHASE 6 §9.4 — true when the workspace policy was WEAKER than an
       * immutable org template and the effective `retentionDays` was
       * raised to the org floor (the workspace row itself is untouched —
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

/**
 * The workspace-level retention verdict with its provenance. Throws on a
 * database failure — a caller must never render that as "no policy".
 */
export async function resolveTeamRetentionPolicy(
  teamId: string,
  client: PrismaClient = defaultPrisma,
): Promise<RetentionResolution> {
  const decision = await resolveEffectiveRetentionPolicy({ teamId }, client);

  if (decision.source === "team_policy" && decision.policy) {
    return {
      source: "team_policy",
      teamId,
      policyId: decision.policy.id,
      retentionDays: decision.effectiveRetentionDays,
      immutable: decision.policy.immutable,
      ...(decision.mandatoryFloorApplied ? { mandatoryFloorApplied: true } : {}),
    };
  }
  if (decision.source === "org_policy_inherited" && decision.inheritedTemplate) {
    return {
      source: "org_policy_inherited",
      teamId,
      organizationId: decision.inheritedTemplate.organizationId,
      template: {
        retentionDays: decision.inheritedTemplate.retentionDays,
        immutable: decision.inheritedTemplate.immutable,
        description: decision.inheritedTemplate.description,
      },
    };
  }
  return { source: "none", teamId };
}
