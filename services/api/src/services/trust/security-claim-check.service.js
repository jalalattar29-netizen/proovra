/**
 * PROOVRA Phase 4A Closure — Security claim drift detection.
 *
 * Per-control drift detection for the Security Documentation Center.
 * Walks each `SECURITY_SECTIONS` control, loads the corresponding
 * SECURITY-kind Trust Center article (when seeded), and verifies
 * whether the `implementationReferences` paths declared on the
 * article actually exist on disk.
 *
 * Hard rules:
 *   * Honest verdicts only — when a referenced module is missing
 *     the projection downgrades the control to PARTIAL / PLANNED /
 *     UNAVAILABLE; we NEVER report IMPLEMENTED for an absent
 *     reference.
 *   * Workspace-anchored: every read + upsert is scoped by teamId.
 *   * Bounded vocabulary from `@proovra/shared/trust-and-governance.ts`.
 *   * Standing limitations for known structural gaps (SCIM, KMS,
 *     DELETION workflows, MONITORING module) are recorded explicitly
 *     so the Security Center never silently lies about coverage.
 */
import { existsSync } from "node:fs";
import * as path from "node:path";
import { SECURITY_CONTROL_CONFIDENCE, SECURITY_SECTIONS, } from "@proovra/shared";
import { prisma as defaultPrisma } from "../../db.js";
const HONEST_OVERRIDES = {
    SCIM: {
        confidence: "UNAVAILABLE",
        limitation: "scim_provisioning_via_idp_only",
        implementedOverride: false,
    },
    KMS: {
        confidence: "PARTIAL",
        limitation: "kms_used_via_aws_sdk_no_dedicated_module",
        implementedOverride: true,
    },
    DELETION: {
        confidence: "PLANNED",
        limitation: "deletion_workflows_planned",
        implementedOverride: false,
    },
    MONITORING: {
        confidence: "PARTIAL",
        limitation: "sentry_otel_coexistence_no_dedicated_monitoring_module",
        implementedOverride: true,
    },
};
export async function runSecurityClaimChecks(input) {
    const prisma = input.prisma ?? defaultPrisma;
    const now = new Date();
    const ownerUserId = input.systemUserId ?? null;
    // Load every SECURITY-kind article in one shot (workspace-anchored)
    // — bounded by the 18-section catalog, so this is small and safe.
    const articles = await prisma.trustCenterArticle.findMany({
        where: { teamId: input.teamId, kind: "SECURITY" },
        select: { section: true, implementationReferences: true },
    });
    const articleBySection = new Map();
    for (const row of articles) {
        articleBySection.set(row.section, {
            implementationReferences: normaliseReferences(row.implementationReferences),
        });
    }
    const projections = [];
    for (const controlKey of SECURITY_SECTIONS) {
        const article = articleBySection.get(controlKey);
        const documented = !!article;
        const refs = article?.implementationReferences ?? [];
        const refScan = scanReferences(refs);
        const override = HONEST_OVERRIDES[controlKey];
        const implementationReferencesOk = refs.length > 0 && refScan.missing.length === 0;
        let implemented;
        if (override?.implementedOverride !== undefined) {
            implemented = override.implementedOverride;
        }
        else {
            implemented = refScan.existing.length > 0;
        }
        const confidence = override
            ? override.confidence
            : deriveConfidence({
                documented,
                referenceCount: refs.length,
                existingCount: refScan.existing.length,
                missingCount: refScan.missing.length,
            });
        const limitation = override?.limitation ?? null;
        const projection = {
            controlKey,
            documented,
            implemented,
            implementationReferencesOk,
            confidence,
            evidencePaths: refScan.existing,
            limitation,
            ownerUserId,
            lastVerifiedAtUtc: now.toISOString(),
        };
        await prisma.securityClaimCheck.upsert({
            where: {
                teamId_controlKey: {
                    teamId: input.teamId,
                    controlKey,
                },
            },
            create: {
                teamId: input.teamId,
                controlKey,
                documented,
                implemented,
                implementationReferencesOk,
                evidencePaths: refScan.existing,
                limitation,
                ownerUserId,
                lastVerifiedAt: now,
            },
            update: {
                documented,
                implemented,
                implementationReferencesOk,
                evidencePaths: refScan.existing,
                limitation,
                ownerUserId,
                lastVerifiedAt: now,
            },
        });
        projections.push(projection);
    }
    return projections.sort((a, b) => a.controlKey.localeCompare(b.controlKey));
}
export async function listSecurityClaimChecks(input) {
    const prisma = input.prisma ?? defaultPrisma;
    const rows = await prisma.securityClaimCheck.findMany({
        where: { teamId: input.teamId },
        orderBy: { controlKey: "asc" },
    });
    if (rows.length === 0)
        return [];
    return rows.map((r) => {
        const controlKey = r.controlKey;
        const evidencePaths = Array.isArray(r.evidencePaths)
            ? r.evidencePaths
            : [];
        return {
            controlKey,
            documented: r.documented,
            implemented: r.implemented,
            implementationReferencesOk: r.implementationReferencesOk,
            confidence: deriveConfidenceFromRow({
                controlKey,
                documented: r.documented,
                implemented: r.implemented,
                implementationReferencesOk: r.implementationReferencesOk,
                evidencePathsCount: evidencePaths.length,
            }),
            evidencePaths,
            limitation: r.limitation ?? null,
            ownerUserId: r.ownerUserId ?? null,
            // Fall back to creation timestamp when never explicitly verified — keeps projection non-null per SecurityClaimCheckProjection contract.
            lastVerifiedAtUtc: (r.lastVerifiedAt ?? r.createdAt).toISOString(),
        };
    });
}
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function normaliseReferences(raw) {
    if (!Array.isArray(raw))
        return [];
    const out = [];
    for (const entry of raw) {
        if (typeof entry !== "string")
            continue;
        const trimmed = entry.trim();
        if (!trimmed)
            continue;
        out.push(trimmed);
    }
    return out;
}
/**
 * Strip a `#anchor` suffix (e.g. `schema.prisma#Evidence`) for the
 * existence check — the anchor is documentation-only.
 */
function stripAnchor(reference) {
    const hashIndex = reference.indexOf("#");
    return hashIndex >= 0 ? reference.slice(0, hashIndex) : reference;
}
/**
 * Resolve a workspace-relative reference against the monorepo root.
 * The detector tries `process.cwd()` first, then walks UP THREE
 * LEVELS so it works from either the API service directory
 * (`services/api`) or the monorepo root.
 */
function candidateRoots() {
    const seen = new Set();
    const out = [];
    const add = (p) => {
        const resolved = path.resolve(p);
        if (!seen.has(resolved)) {
            seen.add(resolved);
            out.push(resolved);
        }
    };
    const cwd = process.cwd();
    add(cwd);
    add(path.resolve(cwd, ".."));
    add(path.resolve(cwd, "..", ".."));
    add(path.resolve(cwd, "..", "..", ".."));
    return out;
}
function referenceExists(reference) {
    const cleaned = stripAnchor(reference);
    if (!cleaned)
        return false;
    // Absolute path: check directly.
    if (path.isAbsolute(cleaned)) {
        return existsSync(cleaned);
    }
    for (const root of candidateRoots()) {
        const candidate = path.resolve(root, cleaned);
        if (existsSync(candidate))
            return true;
    }
    return false;
}
function scanReferences(refs) {
    const existing = [];
    const missing = [];
    for (const ref of refs) {
        if (referenceExists(ref)) {
            existing.push(ref);
        }
        else {
            missing.push(ref);
        }
    }
    return { existing, missing };
}
function deriveConfidence(args) {
    if (!args.documented)
        return "UNAVAILABLE";
    if (args.referenceCount === 0)
        return "PLANNED";
    if (args.missingCount === 0)
        return "IMPLEMENTED";
    if (args.existingCount > 0)
        return "PARTIAL";
    return "PLANNED";
}
function deriveConfidenceFromRow(args) {
    const override = HONEST_OVERRIDES[args.controlKey];
    if (override)
        return override.confidence;
    if (!args.documented)
        return "UNAVAILABLE";
    if (args.implementationReferencesOk && args.evidencePathsCount > 0) {
        return "IMPLEMENTED";
    }
    if (args.evidencePathsCount > 0)
        return "PARTIAL";
    if (args.implemented)
        return "PARTIAL";
    return "PLANNED";
}
// Compile-time guard so a future renamed enum trips the typecheck.
function _assertBoundedVocabularyIntact() {
    const _c = "IMPLEMENTED";
    void _c;
    void SECURITY_CONTROL_CONFIDENCE;
}
void _assertBoundedVocabularyIntact;
