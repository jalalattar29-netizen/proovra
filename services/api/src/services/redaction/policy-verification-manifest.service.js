/**
 * PROOVRA Phase 3A Elite Closure — Policy verification manifest.
 *
 * Bounded shape for the verification package's
 * `policy-manifest.json` entry. Surfaces every PUBLISHED policy
 * version that is bound to a scope the workspace owns. Each entry
 * carries the bounded `RedactionPolicyDocument` so an offline
 * verifier can reproduce the exact policy that gated the
 * detections.
 *
 * Hard rules:
 *   * Workspace-anchored.
 *   * NEVER includes draft / in-review / rejected versions.
 *   * Bounded `document` shape — the schemaVersion is pinned so
 *     consumer code can refuse a drift.
 */
import { REDACTION_POLICY_DOCUMENT_SCHEMA_VERSION, } from "@proovra/shared";
import { prisma as defaultPrisma } from "../../db.js";
export async function buildPolicyVerificationEntries(input) {
    const prisma = input.prisma ?? defaultPrisma;
    const assignments = await prisma.redactionPolicyAssignment.findMany({
        where: { teamId: input.teamId, revokedAtUtc: null },
        include: {
            policy: { select: { id: true, name: true } },
            policyVersion: true,
        },
    });
    const byVersion = new Map();
    for (const a of assignments) {
        if (a.policyVersion.state !== "PUBLISHED")
            continue;
        const key = a.policyVersionId;
        const existing = byVersion.get(key);
        const scopeEntry = {
            scope: a.scope,
            scopeTargetId: a.scopeTargetId,
        };
        if (existing) {
            existing.assignmentScopes.push(scopeEntry);
            continue;
        }
        byVersion.set(key, {
            policyId: a.policy.id,
            policyName: a.policy.name,
            versionOrdinal: a.policyVersion.versionOrdinal,
            policyVersionId: a.policyVersionId,
            publishedAtUtc: a.policyVersion.publishedAtUtc?.toISOString() ?? null,
            approverUserId: a.policyVersion.approvedByUserId,
            document: {
                schemaVersion: REDACTION_POLICY_DOCUMENT_SCHEMA_VERSION,
                providers: a.policyVersion.providers,
                kinds: a.policyVersion.kinds,
                ruleActions: a.policyVersion.ruleActions,
                customRules: a.policyVersion.customRules,
            },
            assignmentScopes: [scopeEntry],
        });
    }
    return Array.from(byVersion.values());
}
