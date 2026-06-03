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
 *   * The org template's `immutable: true` flag tells the calling
 *     resolver to treat the inherited value as a floor — workspaces
 *     may not scale retention DOWN. Today this is informational
 *     only; the retention engine will consume it in a follow-up.
 *
 * Used by:
 *   * `services/governance-lifecycle/retention-engine.service.ts`
 *     when computing the effective retention deadline for an
 *     evidence row in a workspace that has no own policy.
 *   * `apps/web/app/(app)/governance/retention/page.tsx` (read-only
 *     surface) to render "Inherited from organization" badges.
 */
import { prisma as defaultPrisma } from "../../db.js";
const RETENTION_POLICY_KEY = "retention.default";
function readRetentionTemplate(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
        return null;
    const obj = raw;
    const retentionDays = obj.retentionDays === null
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
        description: typeof obj.description === "string"
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
export async function resolveTeamRetentionPolicy(teamId, client = defaultPrisma) {
    // Step 1 — look for a team-level ACTIVE policy.
    let teamPolicy = null;
    try {
        const row = await client.evidenceRetentionPolicy.findFirst({
            where: { teamId, status: "ACTIVE" },
            select: { id: true, retentionDays: true, immutable: true },
            orderBy: { createdAt: "desc" },
        });
        teamPolicy = row ?? null;
    }
    catch {
        teamPolicy = null;
    }
    if (teamPolicy) {
        return {
            source: "team_policy",
            teamId,
            policyId: teamPolicy.id,
            retentionDays: teamPolicy.retentionDays,
            immutable: teamPolicy.immutable,
        };
    }
    // Step 2 — look up the team's organization and check for an
    // org-level template.
    let organizationId = null;
    try {
        const team = await client.team.findUnique({
            where: { id: teamId },
            select: { organizationId: true },
        });
        organizationId = team?.organizationId ?? null;
    }
    catch {
        organizationId = null;
    }
    if (!organizationId) {
        return { source: "none", teamId };
    }
    let template = null;
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
    }
    catch {
        template = null;
    }
    if (!template) {
        return { source: "none", teamId };
    }
    return {
        source: "org_policy_inherited",
        teamId,
        organizationId,
        template,
    };
}
