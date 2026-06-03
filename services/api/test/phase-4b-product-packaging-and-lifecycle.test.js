/**
 * PROOVRA Phase 4B — Product Packaging & Lifecycle contract tests.
 *
 * ~60 assertions across 18 describe blocks.
 * All service calls use Prisma stubs — no real DB required.
 */
import fs from "node:fs";
import path from "node:path";
import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
// Stub S3 storage operations so archive-tier service doesn't need real AWS creds.
vi.mock("../src/storage.js", async (importOriginal) => {
    const actual = await importOriginal();
    return { ...actual, copyObjectStorageClass: vi.fn().mockResolvedValue(undefined), restoreObject: vi.fn().mockResolvedValue(undefined), headObjectStorageClass: vi.fn().mockResolvedValue("STANDARD") };
});
import { PRODUCT_LINES, ENTITLEMENT_KEYS, EXCHANGE_PACKAGE_KINDS, EXCHANGE_PACKAGE_STATES, CHAIN_TRANSFER_STATES, WEBHOOK_EVENT_KINDS, WEBHOOK_DELIVERY_STATES, RETENTION_POLICY_TEMPLATES, LEGAL_HOLD_KINDS, LEGAL_HOLD_STATES, ARCHIVE_TIERS, DESTRUCTION_STATES, LIFECYCLE_DASHBOARD_SCHEMA_VERSION, } from "@proovra/shared";
import { resolveEntitlement, assertFeatureEntitlement, assertQuotaEntitlement, recordEntitlementUsage, upsertEntitlementGrant, listEntitlements, applyProductLine, DEFAULT_ENTITLEMENTS, PLAN_LINE_ENTITLEMENTS, } from "../src/services/packaging/entitlement.service.js";
import { createWebhookEndpoint, emitWebhookEvent, verifyIncomingSignature, deliverWebhookDelivery, deactivateWebhookEndpoint, listWebhookEndpoints, } from "../src/services/packaging/webhooks/webhook-platform.service.js";
import { createExchangePackage, markPackageReady, generateSignedUrl, listPackages, revokePackage, } from "../src/services/exchange/evidence-exchange.service.js";
import { initiateChainTransfer, acceptChainTransfer, completeChainTransfer, rejectChainTransfer, listChainTransfers, } from "../src/services/exchange/chain-transfer.service.js";
import { createRetentionPolicy, resolveEffectiveRetention, gateRetention, listRetentionPolicies, } from "../src/services/lifecycle/retention-engine.service.js";
import { createLegalHold, releaseLegalHold, isUnderLegalHold, assertNoLegalHoldOrBlock, listLegalHolds, countActiveHolds, } from "../src/services/lifecycle/legal-hold.service.js";
import { transitionEvidenceTier, projectArchiveCostsByTier, listArchiveTransitions, currentTierFor, COST_PER_GB_PER_MONTH_USD_MICROS, } from "../src/services/lifecycle/archive-tier.service.js";
import { createDestructionRequest, recordApproval, executeDestruction, certifyDestruction, listDestructionRequests, } from "../src/services/lifecycle/destruction-governance.service.js";
import { projectLifecycleDashboard } from "../src/services/lifecycle/lifecycle-dashboard.service.js";
import { buildLifecycleManifestEntry, buildRetentionManifestEntry, buildLegalHoldManifestEntry, buildArchiveManifestEntry, buildDestructionManifestEntry, buildExchangeManifestEntry, buildTransferManifestEntry, } from "../src/services/lifecycle/lifecycle-manifest.service.js";
// ---------------------------------------------------------------------------
// Prisma stub factory
// ---------------------------------------------------------------------------
function makePrismaStub(overrides = {}) {
    const base = {
        entitlementGrant: {
            findUnique: async () => null,
            upsert: async (args) => ({
                id: "grant-1",
                ...args.create,
            }),
        },
        entitlementUsage: {
            findUnique: async () => null,
            upsert: async () => ({}),
        },
        lifecycleWebhookEndpoint: {
            create: async (args) => ({
                id: "ep-1",
                ...args.data,
                createdAt: new Date(),
                deactivatedAtUtc: null,
                subscribedEvents: args.data.subscribedEvents,
            }),
            findFirst: async () => null,
            findMany: async () => [],
            update: async () => ({}),
        },
        lifecycleWebhookDelivery: {
            create: async (args) => ({
                id: "delivery-1",
                ...args.data,
            }),
            findUnique: async () => null,
            findFirst: async () => null,
            update: async () => ({}),
        },
        evidenceExchangePackage: {
            create: async (args) => ({
                id: "pkg-1",
                ...args.data,
            }),
            findFirst: async () => null,
            findMany: async () => [],
            update: async () => ({}),
        },
        evidenceExchangePackageDelivery: {
            create: async (args) => ({
                id: "delivery-1",
                ...args.data,
            }),
            findFirst: async () => null,
            update: async () => ({}),
        },
        chainTransfer: {
            create: async (args) => ({
                id: "xfer-1",
                ...args.data,
            }),
            findFirst: async () => null,
            findMany: async () => [],
            update: async () => ({}),
        },
        retentionPolicyConfig: {
            create: async (args) => ({
                id: "policy-1",
                ...args.data,
            }),
            findFirst: async () => null,
            findMany: async () => [],
            count: async () => 0,
            update: async () => ({}),
            groupBy: async () => [],
        },
        legalHold: {
            create: async (args) => ({
                id: "hold-1",
                ...args.data,
            }),
            findFirst: async () => null,
            findMany: async () => [],
            count: async () => 0,
            update: async () => ({}),
            groupBy: async () => [],
        },
        archiveTierTransition: {
            create: async (args) => ({
                id: "trans-1",
                transitionedAtUtc: new Date(),
                costEstimateUsdMicros: BigInt(args.data.costEstimateUsdMicros ?? 0),
                ...args.data,
            }),
            findFirst: async () => null,
            findMany: async () => [],
            count: async () => 0,
            update: async () => ({}),
        },
        destructionRequest: {
            create: async (args) => ({
                id: "dreq-1",
                ...args.data,
            }),
            findFirst: async () => null,
            findMany: async () => [],
            count: async () => 0,
            update: async () => ({}),
        },
        destructionCertificate: {
            create: async (args) => ({
                id: "cert-1",
                ...args.data,
            }),
            findFirst: async () => null,
        },
        evidence: {
            findUnique: async () => null,
            findFirst: async () => null,
            findMany: async () => [],
        },
        intelligenceActivityEvent: {
            create: async () => ({}),
            count: async () => 0,
        },
        user: {
            findUnique: async () => null,
        },
        $executeRaw: async () => 0,
        ...overrides,
    };
    return base;
}
// ===========================================================================
// 1. Shared closure contracts
// ===========================================================================
describe("1. Shared closure contracts — bounded enums", () => {
    it("PRODUCT_LINES has exactly 3 entries", () => {
        expect(PRODUCT_LINES).toHaveLength(3);
        expect(PRODUCT_LINES).toContain("CAPTURE_AND_VERIFY");
        expect(PRODUCT_LINES).toContain("INVESTIGATIONS");
        expect(PRODUCT_LINES).toContain("ENTERPRISE");
    });
    it("ENTITLEMENT_KEYS has >= 27 entries", () => {
        expect(ENTITLEMENT_KEYS.length).toBeGreaterThanOrEqual(27);
    });
    it("EXCHANGE_PACKAGE_KINDS has exactly 9 entries", () => {
        expect(EXCHANGE_PACKAGE_KINDS).toHaveLength(9);
    });
    it("EXCHANGE_PACKAGE_STATES has exactly 6 entries", () => {
        expect(EXCHANGE_PACKAGE_STATES).toHaveLength(6);
    });
    it("CHAIN_TRANSFER_STATES has exactly 7 entries", () => {
        expect(CHAIN_TRANSFER_STATES).toHaveLength(7);
    });
    it("WEBHOOK_EVENT_KINDS has exactly 16 entries", () => {
        expect(WEBHOOK_EVENT_KINDS).toHaveLength(16);
    });
    it("WEBHOOK_DELIVERY_STATES has exactly 5 entries", () => {
        expect(WEBHOOK_DELIVERY_STATES).toHaveLength(5);
    });
    it("RETENTION_POLICY_TEMPLATES has exactly 4 entries", () => {
        expect(RETENTION_POLICY_TEMPLATES).toHaveLength(4);
    });
    it("LEGAL_HOLD_KINDS has exactly 4 entries", () => {
        expect(LEGAL_HOLD_KINDS).toHaveLength(4);
    });
    it("LEGAL_HOLD_STATES has exactly 3 entries", () => {
        expect(LEGAL_HOLD_STATES).toHaveLength(3);
    });
    it("ARCHIVE_TIERS has exactly 4 entries", () => {
        expect(ARCHIVE_TIERS).toHaveLength(4);
    });
    it("DESTRUCTION_STATES has exactly 7 entries", () => {
        expect(DESTRUCTION_STATES).toHaveLength(7);
    });
    it("LIFECYCLE_DASHBOARD_SCHEMA_VERSION is the canonical string", () => {
        expect(LIFECYCLE_DASHBOARD_SCHEMA_VERSION).toBe("PROOVRA_LIFECYCLE_DASHBOARD_V1");
    });
});
// ===========================================================================
// 2. Prisma schema + migration
// ===========================================================================
describe("2. Prisma schema + migration", () => {
    const schemaPath = path.join(__dirname, "../prisma/schema.prisma");
    const migrationPath = path.join(__dirname, "../prisma/migrations/20261230000000_phase_4b_packaging_and_lifecycle/migration.sql");
    const schema = fs.readFileSync(schemaPath, "utf8");
    const migration = fs.readFileSync(migrationPath, "utf8");
    const expectedModels = [
        "EntitlementGrant",
        "EntitlementUsage",
        "EvidenceExchangePackage",
        "EvidenceExchangePackageDelivery",
        "ChainTransfer",
        "LifecycleWebhookEndpoint",
        "LifecycleWebhookDelivery",
        "RetentionPolicyConfig",
        "LegalHold",
        "ArchiveTierTransition",
        "DestructionRequest",
        "DestructionCertificate",
    ];
    it("schema.prisma declares all 12 Phase 4B models", () => {
        for (const model of expectedModels) {
            expect(schema).toMatch(new RegExp(`model ${model}\\s*\\{`));
        }
    });
    const expectedTables = [
        "entitlement_grants",
        "entitlement_usage",
        "evidence_exchange_packages",
        "evidence_exchange_package_deliveries",
        "chain_transfers",
        "webhook_endpoints",
        "webhook_deliveries",
        "retention_policy_configs",
        "legal_holds",
        "archive_tier_transitions",
        "destruction_requests",
        "destruction_certificates",
    ];
    it("migration has plain CREATE TABLE for all 12 tables", () => {
        for (const table of expectedTables) {
            expect(migration).toContain(`CREATE TABLE "${table}"`);
        }
    });
    it("migration has >= 10 information_schema guard blocks", () => {
        const count = (migration.match(/information_schema/g) ?? []).length;
        expect(count).toBeGreaterThanOrEqual(10);
    });
});
// ===========================================================================
// 3. Service module surface
// ===========================================================================
describe("3. Service module surface — typeof checks", () => {
    it("entitlement service exports all documented functions + constants", () => {
        expect(typeof resolveEntitlement).toBe("function");
        expect(typeof assertFeatureEntitlement).toBe("function");
        expect(typeof assertQuotaEntitlement).toBe("function");
        expect(typeof recordEntitlementUsage).toBe("function");
        expect(typeof upsertEntitlementGrant).toBe("function");
        expect(typeof listEntitlements).toBe("function");
        expect(typeof applyProductLine).toBe("function");
        expect(typeof DEFAULT_ENTITLEMENTS).toBe("object");
        expect(typeof PLAN_LINE_ENTITLEMENTS).toBe("object");
    });
    it("webhook-platform service exports all documented functions", () => {
        expect(typeof createWebhookEndpoint).toBe("function");
        expect(typeof emitWebhookEvent).toBe("function");
        expect(typeof verifyIncomingSignature).toBe("function");
        expect(typeof deliverWebhookDelivery).toBe("function");
        expect(typeof deactivateWebhookEndpoint).toBe("function");
        expect(typeof listWebhookEndpoints).toBe("function");
    });
    it("evidence-exchange service exports all documented functions", () => {
        expect(typeof createExchangePackage).toBe("function");
        expect(typeof markPackageReady).toBe("function");
        expect(typeof generateSignedUrl).toBe("function");
        expect(typeof listPackages).toBe("function");
        expect(typeof revokePackage).toBe("function");
    });
    it("chain-transfer service exports all documented functions", () => {
        expect(typeof initiateChainTransfer).toBe("function");
        expect(typeof acceptChainTransfer).toBe("function");
        expect(typeof completeChainTransfer).toBe("function");
        expect(typeof rejectChainTransfer).toBe("function");
        expect(typeof listChainTransfers).toBe("function");
    });
    it("retention-engine service exports all documented functions", () => {
        expect(typeof createRetentionPolicy).toBe("function");
        expect(typeof resolveEffectiveRetention).toBe("function");
        expect(typeof gateRetention).toBe("function");
        expect(typeof listRetentionPolicies).toBe("function");
    });
    it("legal-hold service exports all documented functions", () => {
        expect(typeof createLegalHold).toBe("function");
        expect(typeof releaseLegalHold).toBe("function");
        expect(typeof isUnderLegalHold).toBe("function");
        expect(typeof assertNoLegalHoldOrBlock).toBe("function");
        expect(typeof listLegalHolds).toBe("function");
        expect(typeof countActiveHolds).toBe("function");
    });
    it("archive-tier service exports all documented functions", () => {
        expect(typeof transitionEvidenceTier).toBe("function");
        expect(typeof projectArchiveCostsByTier).toBe("function");
        expect(typeof listArchiveTransitions).toBe("function");
        expect(typeof currentTierFor).toBe("function");
    });
    it("destruction-governance service exports all documented functions", () => {
        expect(typeof createDestructionRequest).toBe("function");
        expect(typeof recordApproval).toBe("function");
        expect(typeof executeDestruction).toBe("function");
        expect(typeof certifyDestruction).toBe("function");
        expect(typeof listDestructionRequests).toBe("function");
    });
    it("lifecycle-dashboard service exports projectLifecycleDashboard", () => {
        expect(typeof projectLifecycleDashboard).toBe("function");
    });
    it("lifecycle-manifest service exports all 7 builder functions", () => {
        expect(typeof buildLifecycleManifestEntry).toBe("function");
        expect(typeof buildRetentionManifestEntry).toBe("function");
        expect(typeof buildLegalHoldManifestEntry).toBe("function");
        expect(typeof buildArchiveManifestEntry).toBe("function");
        expect(typeof buildDestructionManifestEntry).toBe("function");
        expect(typeof buildExchangeManifestEntry).toBe("function");
        expect(typeof buildTransferManifestEntry).toBe("function");
    });
});
// ===========================================================================
// 4. Entitlement enforcement
// ===========================================================================
describe("4. Entitlement enforcement", () => {
    it("FEATURE_LEGAL_HOLD=false → ENTITLEMENT_REQUIRED", async () => {
        const prisma = makePrismaStub();
        const result = await assertFeatureEntitlement({
            prisma: prisma,
            teamId: "team-1",
            key: "FEATURE_LEGAL_HOLD",
        });
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.denial).toBe("ENTITLEMENT_REQUIRED");
        }
    });
    it("FEATURE_REVIEWER_WORKSPACE=true (default) → ok", async () => {
        const prisma = makePrismaStub();
        const result = await assertFeatureEntitlement({
            prisma: prisma,
            teamId: "team-1",
            key: "FEATURE_REVIEWER_WORKSPACE",
        });
        expect(result.ok).toBe(true);
    });
    it("assertQuotaEntitlement consumed=5+limit=5+requested=1 → QUOTA_EXCEEDED", async () => {
        const prisma = makePrismaStub({
            entitlementGrant: {
                findUnique: async () => ({
                    id: "g1",
                    key: "QUOTA_EXPORT_PACKAGES_PER_MONTH",
                    kind: "QUOTA",
                    valueBool: null,
                    valueNumber: BigInt(5),
                    source: "PLAN",
                    productLine: null,
                    grantedAtUtc: new Date(),
                    expiresAtUtc: null,
                }),
                upsert: async (args) => ({ id: "g1", ...args.create }),
            },
            entitlementUsage: {
                findUnique: async () => ({ consumed: BigInt(5) }),
                upsert: async () => ({}),
            },
        });
        const result = await assertQuotaEntitlement({
            prisma: prisma,
            teamId: "team-1",
            key: "QUOTA_EXPORT_PACKAGES_PER_MONTH",
            requested: 1,
        });
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.denial).toBe("QUOTA_EXCEEDED");
        }
    });
});
// ===========================================================================
// 5. Retention engine resolves effective years
// ===========================================================================
describe("5. Retention engine resolves effective years", () => {
    it("WORKSPACE template=INSURANCE_7Y → 7 years", async () => {
        const prisma = makePrismaStub({
            retentionPolicyConfig: {
                findMany: async () => [
                    {
                        id: "p1",
                        years: 7,
                        scopeKind: "WORKSPACE",
                        scopeTargetId: null,
                        isOverride: false,
                        exceptions: [],
                    },
                ],
            },
            evidence: {
                findUnique: async () => ({ caseId: null, departmentId: null }),
                findFirst: async () => null,
                findMany: async () => [],
            },
        });
        const result = await resolveEffectiveRetention({
            prisma: prisma,
            teamId: "team-1",
            evidenceId: "ev-1",
        });
        expect(result.effectiveYears).toBe(7);
    });
    it("CASE override=true wins over WORKSPACE", async () => {
        const prisma = makePrismaStub({
            retentionPolicyConfig: {
                findMany: async () => [
                    {
                        id: "p1",
                        years: 7,
                        scopeKind: "WORKSPACE",
                        scopeTargetId: null,
                        isOverride: false,
                        exceptions: [],
                    },
                    {
                        id: "p2",
                        years: 3,
                        scopeKind: "CASE",
                        scopeTargetId: "case-1",
                        isOverride: true,
                        exceptions: [],
                    },
                ],
            },
            evidence: {
                findUnique: async () => ({ caseId: "case-1", departmentId: null }),
                findFirst: async () => null,
                findMany: async () => [],
            },
        });
        const result = await resolveEffectiveRetention({
            prisma: prisma,
            teamId: "team-1",
            evidenceId: "ev-1",
            caseId: "case-1",
        });
        expect(result.effectiveYears).toBe(3);
        expect(result.isOverride).toBe(true);
    });
});
// ===========================================================================
// 6. Retention gate
// ===========================================================================
describe("6. Retention gate", () => {
    it("evidence 3y old + 7y policy → RETENTION_NOT_EXPIRED", async () => {
        const threeYearsAgo = new Date(Date.now() - 3 * 365.25 * 24 * 3600 * 1000);
        const prisma = makePrismaStub({
            retentionPolicyConfig: {
                findMany: async () => [
                    {
                        id: "p1",
                        years: 7,
                        scopeKind: "WORKSPACE",
                        scopeTargetId: null,
                        isOverride: false,
                        exceptions: [],
                    },
                ],
                count: async () => 0,
                findFirst: async () => null,
                create: async () => ({ id: "p1" }),
                update: async () => ({}),
                groupBy: async () => [],
            },
            evidence: {
                findUnique: async () => ({
                    id: "ev-1",
                    createdAt: threeYearsAgo,
                    caseId: null,
                    departmentId: null,
                }),
                findFirst: async () => null,
                findMany: async () => [],
            },
        });
        const result = await gateRetention({
            prisma: prisma,
            teamId: "team-1",
            evidenceId: "ev-1",
            action: "DELETE",
        });
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.denial).toBe("RETENTION_NOT_EXPIRED");
        }
    });
    it("evidence 8y old + 7y policy → ok to delete", async () => {
        const eightYearsAgo = new Date(Date.now() - 8 * 365.25 * 24 * 3600 * 1000);
        const prisma = makePrismaStub({
            retentionPolicyConfig: {
                findMany: async () => [
                    {
                        id: "p1",
                        years: 7,
                        scopeKind: "WORKSPACE",
                        scopeTargetId: null,
                        isOverride: false,
                        exceptions: [],
                    },
                ],
                count: async () => 0,
                findFirst: async () => null,
                create: async () => ({ id: "p1" }),
                update: async () => ({}),
                groupBy: async () => [],
            },
            evidence: {
                findUnique: async () => ({
                    id: "ev-1",
                    createdAt: eightYearsAgo,
                    caseId: null,
                    departmentId: null,
                }),
                findFirst: async () => null,
                findMany: async () => [],
            },
        });
        const result = await gateRetention({
            prisma: prisma,
            teamId: "team-1",
            evidenceId: "ev-1",
            action: "DELETE",
        });
        expect(result.ok).toBe(true);
    });
});
// ===========================================================================
// 7. Legal hold blocks delete
// ===========================================================================
describe("7. Legal hold blocks delete", () => {
    const activeLegalHold = {
        id: "hold-1",
        teamId: "team-1",
        kind: "EVIDENCE",
        scopeTargetId: "ev-1",
        name: "Test hold",
        reason: "Litigation",
        state: "ACTIVE",
        createdByUserId: "user-1",
        createdAt: new Date(),
        releasedByUserId: null,
        releasedAtUtc: null,
        expiresAtUtc: null,
    };
    function makePrismaWithActiveHold() {
        return makePrismaStub({
            legalHold: {
                create: async () => ({ id: "hold-1" }),
                findFirst: async () => activeLegalHold,
                findMany: async () => [activeLegalHold],
                count: async () => 1,
                update: async () => ({}),
                groupBy: async () => [],
            },
        });
    }
    it("isUnderLegalHold returns underHold=true for evidence with active EVIDENCE hold", async () => {
        const prisma = makePrismaWithActiveHold();
        const result = await isUnderLegalHold({
            prisma: prisma,
            teamId: "team-1",
            evidenceId: "ev-1",
        });
        expect(result.underHold).toBe(true);
        expect(result.holdIds).toContain("hold-1");
    });
    it("assertNoLegalHoldOrBlock → LEGAL_HOLD_BLOCKED when evidence is under hold", async () => {
        const prisma = makePrismaWithActiveHold();
        const result = await assertNoLegalHoldOrBlock({
            prisma: prisma,
            teamId: "team-1",
            evidenceId: "ev-1",
            action: "DELETE",
        });
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.denial).toBe("LEGAL_HOLD_BLOCKED");
        }
    });
});
// ===========================================================================
// 8. Destruction dual approval
// ===========================================================================
describe("8. Destruction dual approval", () => {
    it("first approval → allApproved=false, state=REQUESTED", async () => {
        const approverChain = [
            { userId: "approver-1", approvedAtUtc: null },
            { userId: "approver-2", approvedAtUtc: null },
        ];
        const prisma = makePrismaStub({
            destructionRequest: {
                findFirst: async () => ({
                    id: "dreq-1",
                    state: "REQUESTED",
                    approverUserIds: approverChain,
                    evidenceIds: ["ev-1"],
                }),
                update: async () => ({}),
                create: async (args) => ({ id: "dreq-1", ...args.data }),
                count: async () => 0,
                findMany: async () => [],
            },
            intelligenceActivityEvent: {
                create: async () => ({}),
                count: async () => 0,
            },
        });
        const result = await recordApproval({
            prisma: prisma,
            teamId: "team-1",
            requestId: "dreq-1",
            approverUserId: "approver-1",
        });
        expect(result.allApproved).toBe(false);
        expect(result.state).toBe("REQUESTED");
    });
    it("second approval → allApproved=true, state=APPROVED", async () => {
        const approverChain = [
            { userId: "approver-1", approvedAtUtc: "2026-01-01T00:00:00Z" },
            { userId: "approver-2", approvedAtUtc: null },
        ];
        const prisma = makePrismaStub({
            destructionRequest: {
                findFirst: async () => ({
                    id: "dreq-1",
                    state: "REQUESTED",
                    approverUserIds: approverChain,
                    evidenceIds: ["ev-1"],
                }),
                update: async () => ({}),
                create: async (args) => ({ id: "dreq-1", ...args.data }),
                count: async () => 0,
                findMany: async () => [],
            },
            intelligenceActivityEvent: {
                create: async () => ({}),
                count: async () => 0,
            },
        });
        const result = await recordApproval({
            prisma: prisma,
            teamId: "team-1",
            requestId: "dreq-1",
            approverUserId: "approver-2",
        });
        expect(result.allApproved).toBe(true);
        expect(result.state).toBe("APPROVED");
    });
});
// ===========================================================================
// 9. Destruction blocked by legal hold
// ===========================================================================
describe("9. Destruction blocked by legal hold", () => {
    it("createDestructionRequest when evidence is under legal hold → LEGAL_HOLD_BLOCKED", async () => {
        // The destruction-governance service calls isEvidenceUnderAnyLegalHold
        // from governance/case-legal-hold.service.ts which queries:
        //   1. evidence.findUnique (must return a row or it short-circuits to false)
        //   2. evidenceLegalHold.findFirst with status=ACTIVE
        const prisma = makePrismaStub({
            evidence: {
                findUnique: async () => ({ id: "ev-1", caseId: null }),
                findFirst: async () => null,
                findMany: async () => [],
            },
            evidenceLegalHold: {
                count: async () => 1,
                findFirst: async () => ({ id: "lh-1", evidenceId: "ev-1", status: "ACTIVE" }),
                findMany: async () => [{ id: "lh-1", evidenceId: "ev-1", status: "ACTIVE" }],
            },
            destructionRequest: {
                create: async (args) => ({ id: "dreq-1", ...args.data }),
                findFirst: async () => null,
                findMany: async () => [],
                count: async () => 0,
                update: async () => ({}),
            },
            intelligenceActivityEvent: {
                create: async () => ({}),
                count: async () => 0,
            },
        });
        const result = await createDestructionRequest({
            prisma: prisma,
            teamId: "team-1",
            evidenceIds: ["ev-1"],
            reason: "Test destruction",
            requestedByUserId: "user-1",
            requiredApproverUserIds: ["approver-1", "approver-2"],
        });
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.denial).toBe("LEGAL_HOLD_BLOCKED");
        }
    });
});
// ===========================================================================
// 10. Destruction certificate
// ===========================================================================
describe("10. Destruction certificate", () => {
    it("certifyDestruction on COMPLETED request → state=CERTIFIED + SHA-256 hash", async () => {
        const executedAt = new Date();
        const prisma = makePrismaStub({
            destructionRequest: {
                findFirst: async () => ({
                    id: "dreq-1",
                    teamId: "team-1",
                    state: "COMPLETED",
                    evidenceIds: ["ev-1", "ev-2"],
                    executedAtUtc: executedAt,
                    approverUserIds: [{ userId: "approver-1", approvedAtUtc: "2026-01-01T00:00:00Z" }],
                }),
                update: async () => ({}),
                create: async (args) => ({ id: "dreq-1", ...args.data }),
                count: async () => 0,
                findMany: async () => [],
            },
            destructionCertificate: {
                create: async (args) => ({
                    id: "cert-1",
                    ...args.data,
                }),
                findFirst: async () => null,
            },
            intelligenceActivityEvent: {
                create: async () => ({}),
                count: async () => 0,
            },
            evidenceLegalHold: {
                count: async () => 0,
                findFirst: async () => null,
                findMany: async () => [],
            },
        });
        const result = await certifyDestruction({
            prisma: prisma,
            teamId: "team-1",
            requestId: "dreq-1",
        });
        expect(result.ok).toBe(true);
        expect(result.certificateId).toBe("cert-1");
        // SHA-256 hex is 64 chars
        expect(result.certificateHash).toHaveLength(64);
        expect(/^[0-9a-f]{64}$/.test(result.certificateHash)).toBe(true);
    });
});
// ===========================================================================
// 11. Archive tier transitions + costs
// ===========================================================================
describe("11. Archive tier transitions + costs", () => {
    it("transitionEvidenceTier HOT→COLD inserts row with costEstimateUsdMicros", async () => {
        let insertedCost;
        const prisma = makePrismaStub({
            evidence: {
                findUnique: async () => ({
                    id: "ev-1",
                    teamId: "team-1",
                    sizeBytes: BigInt(1_000_000_000), // 1 GB
                    storageBucket: "proovra-evidence",
                    storageKey: "ev-1/original",
                }),
                findFirst: async () => null,
                findMany: async () => [],
            },
            archiveTierTransition: {
                create: async (args) => {
                    insertedCost = args.data.costEstimateUsdMicros;
                    return {
                        id: "trans-1",
                        ...args.data,
                        transitionedAtUtc: new Date(),
                        costEstimateUsdMicros: BigInt(args.data.costEstimateUsdMicros ?? 0),
                    };
                },
                findFirst: async () => null,
                findMany: async () => [],
                count: async () => 0,
                update: async () => ({}),
            },
        });
        const result = await transitionEvidenceTier({
            prisma: prisma,
            teamId: "team-1",
            evidenceId: "ev-1",
            toTier: "COLD",
        });
        expect(result.ok).toBe(true);
        // 1 GB at COLD = 4000 micros
        expect(result.costEstimateUsdMicros).toBe(COST_PER_GB_PER_MONTH_USD_MICROS.COLD);
        // The service stores BigInt in the DB; insertedCost is a BigInt — compare via Number()
        expect(Number(insertedCost)).toBe(COST_PER_GB_PER_MONTH_USD_MICROS.COLD);
    });
    it("projectArchiveCostsByTier returns per-tier breakdown", async () => {
        const prisma = makePrismaStub({
            evidence: {
                findMany: async () => [
                    { id: "ev-1", sizeBytes: BigInt(1_000_000_000) },
                ],
                findUnique: async () => null,
                findFirst: async () => null,
            },
            archiveTierTransition: {
                findMany: async () => [
                    { evidenceId: "ev-1", toTier: "WARM", costEstimateUsdMicros: BigInt(12500) },
                ],
                create: async () => ({}),
                findFirst: async () => null,
                count: async () => 0,
            },
        });
        const result = await projectArchiveCostsByTier({
            prisma: prisma,
            teamId: "team-1",
        });
        expect(result).toHaveProperty("HOT");
        expect(result).toHaveProperty("WARM");
        expect(result).toHaveProperty("COLD");
        expect(result).toHaveProperty("DEEP_ARCHIVE");
        expect(result.WARM.evidenceCount).toBe(1);
    });
});
// ===========================================================================
// 12. Webhook signing + delivery
// ===========================================================================
describe("12. Webhook signing + delivery", () => {
    it("createWebhookEndpoint inserts row with 32-byte secret", async () => {
        let capturedSecret;
        const prisma = makePrismaStub({
            lifecycleWebhookEndpoint: {
                create: async (args) => {
                    capturedSecret = args.data.secret;
                    return { id: "ep-1", ...args.data, createdAt: new Date(), deactivatedAtUtc: null };
                },
                findFirst: async () => null,
                findMany: async () => [],
                update: async () => ({}),
            },
        });
        const result = await createWebhookEndpoint({
            prisma: prisma,
            teamId: "team-1",
            url: "https://example.com/webhook",
            subscribedEvents: ["EVIDENCE_CREATED"],
            createdByUserId: "user-1",
        });
        expect(result.ok).toBe(true);
        // Base64 of 32 bytes = 44 chars with padding
        expect(capturedSecret).toBeDefined();
        const decoded = Buffer.from(capturedSecret, "base64");
        expect(decoded).toHaveLength(32);
    });
    it("verifyIncomingSignature accepts the HMAC computed over the same payload", () => {
        const secret = "c2VjcmV0LWtleS0zMi1ieXRlcy1wYWRkZWQ="; // some base64 string
        const rawBody = JSON.stringify({ event: "EVIDENCE_CREATED", foo: "bar" });
        const key = Buffer.from(secret, "base64");
        const expected = createHmac("sha256", key).update(rawBody, "utf8").digest("hex");
        const ok = verifyIncomingSignature({ rawBody, signature: expected, secret });
        expect(ok).toBe(true);
    });
    it("verifyIncomingSignature rejects tampered payload", () => {
        const secret = "c2VjcmV0LWtleS0zMi1ieXRlcy1wYWRkZWQ=";
        const rawBody = JSON.stringify({ event: "EVIDENCE_CREATED" });
        const key = Buffer.from(secret, "base64");
        const sig = createHmac("sha256", key).update(rawBody, "utf8").digest("hex");
        const ok = verifyIncomingSignature({
            rawBody: rawBody + "tampered",
            signature: sig,
            secret,
        });
        expect(ok).toBe(false);
    });
});
// ===========================================================================
// 13. Webhook delivery state machine
// ===========================================================================
describe("13. Webhook delivery state machine", () => {
    function makeDeliveryStub(overrideDelivery) {
        return makePrismaStub({
            lifecycleWebhookDelivery: {
                findUnique: async () => ({
                    id: "delivery-1",
                    teamId: "team-1",
                    state: "PENDING",
                    attemptCount: 0,
                    eventKind: "EVIDENCE_CREATED",
                    signature: "a".repeat(64),
                    payload: { event: "EVIDENCE_CREATED" },
                    endpoint: { id: "ep-1", url: "https://example.com/webhook", state: "ACTIVE" },
                    ...overrideDelivery,
                }),
                update: async (args) => args.data,
                create: async () => ({ id: "delivery-1" }),
                findFirst: async () => null,
            },
        });
    }
    it("200 response → DELIVERED", async () => {
        let updatedState;
        const prisma = makePrismaStub({
            lifecycleWebhookDelivery: {
                findUnique: async () => ({
                    id: "del-1",
                    teamId: "team-1",
                    state: "PENDING",
                    attemptCount: 0,
                    eventKind: "EVIDENCE_CREATED",
                    signature: "a".repeat(64),
                    payload: {},
                    endpoint: { id: "ep-1", url: "https://example.com/hook", state: "ACTIVE" },
                }),
                update: async (args) => {
                    updatedState = args.data.state;
                    return args.data;
                },
                create: async () => ({ id: "del-1" }),
                findFirst: async () => null,
            },
        });
        // Patch globalThis.fetch to simulate 200
        const origFetch = globalThis.fetch;
        globalThis.fetch = async () => ({ status: 200, text: async () => "ok" });
        try {
            const result = await deliverWebhookDelivery({
                prisma: prisma,
                deliveryId: "del-1",
            });
            expect(result.ok).toBe(true);
            expect(updatedState).toBe("DELIVERED");
        }
        finally {
            globalThis.fetch = origFetch;
        }
    });
    it("500 + attemptCount<8 → RETRYING with nextRetryAtUtc", async () => {
        let updatedState;
        const prisma = makePrismaStub({
            lifecycleWebhookDelivery: {
                findUnique: async () => ({
                    id: "del-2",
                    teamId: "team-1",
                    state: "PENDING",
                    attemptCount: 3,
                    eventKind: "EVIDENCE_CREATED",
                    signature: "a".repeat(64),
                    payload: {},
                    endpoint: { id: "ep-1", url: "https://example.com/hook", state: "ACTIVE" },
                }),
                update: async (args) => {
                    updatedState = args.data.state;
                    return args.data;
                },
                create: async () => ({ id: "del-2" }),
                findFirst: async () => null,
            },
        });
        const origFetch = globalThis.fetch;
        globalThis.fetch = async () => ({ status: 500, text: async () => "error" });
        try {
            const result = await deliverWebhookDelivery({
                prisma: prisma,
                deliveryId: "del-2",
            });
            expect(result.ok).toBe(false);
            expect(updatedState).toBe("RETRYING");
            expect(result.nextRetryAtUtc).toBeInstanceOf(Date);
        }
        finally {
            globalThis.fetch = origFetch;
        }
    });
    it("500 + attemptCount>=8 → DEAD_LETTERED", async () => {
        let updatedState;
        const prisma = makePrismaStub({
            lifecycleWebhookDelivery: {
                findUnique: async () => ({
                    id: "del-3",
                    teamId: "team-1",
                    state: "PENDING",
                    attemptCount: 8,
                    eventKind: "EVIDENCE_CREATED",
                    signature: "a".repeat(64),
                    payload: {},
                    endpoint: { id: "ep-1", url: "https://example.com/hook", state: "ACTIVE" },
                }),
                update: async (args) => {
                    updatedState = args.data.state;
                    return args.data;
                },
                create: async () => ({ id: "del-3" }),
                findFirst: async () => null,
            },
        });
        const origFetch = globalThis.fetch;
        globalThis.fetch = async () => ({ status: 500, text: async () => "error" });
        try {
            const result = await deliverWebhookDelivery({
                prisma: prisma,
                deliveryId: "del-3",
            });
            expect(result.ok).toBe(false);
            expect(updatedState).toBe("DEAD_LETTERED");
        }
        finally {
            globalThis.fetch = origFetch;
        }
    });
});
// ===========================================================================
// 14. Chain transfer state machine
// ===========================================================================
describe("14. Chain transfer state machine", () => {
    it("initiateChainTransfer → INITIATED state stored", async () => {
        let storedState;
        const prisma = makePrismaStub({
            chainTransfer: {
                create: async (args) => {
                    storedState = args.data.state;
                    return { id: "xfer-1", ...args.data };
                },
                findFirst: async () => null,
                findMany: async () => [],
                update: async () => ({}),
            },
        });
        const result = await initiateChainTransfer({
            prisma: prisma,
            teamId: "team-1",
            fromOrganizationId: "org-1",
            toOrganizationSlug: "org-two",
            evidenceIds: ["ev-1"],
            initiatedByUserId: "user-1",
        });
        expect(result.ok).toBe(true);
        expect(storedState).toBe("INITIATED");
    });
    it("acceptChainTransfer on INITIATED → ACCEPTED", async () => {
        let updatedState;
        const prisma = makePrismaStub({
            chainTransfer: {
                findFirst: async () => ({
                    id: "xfer-1",
                    state: "INITIATED",
                    fromOrganizationId: "org-1",
                    toOrganizationSlug: "org-two",
                }),
                update: async (args) => {
                    updatedState = args.data.state;
                    return args.data;
                },
                create: async () => ({ id: "xfer-1" }),
                findMany: async () => [],
            },
        });
        const result = await acceptChainTransfer({
            prisma: prisma,
            teamId: "team-1",
            transferId: "xfer-1",
            acceptingUserId: "user-2",
        });
        expect(result.ok).toBe(true);
        expect(updatedState).toBe("ACCEPTED");
    });
    it("completeChainTransfer on ACCEPTED → COMPLETED", async () => {
        let updatedState;
        const prisma = makePrismaStub({
            chainTransfer: {
                findFirst: async () => ({ id: "xfer-1", state: "ACCEPTED" }),
                update: async (args) => {
                    updatedState = args.data.state;
                    return args.data;
                },
                create: async () => ({ id: "xfer-1" }),
                findMany: async () => [],
            },
        });
        const result = await completeChainTransfer({
            prisma: prisma,
            teamId: "team-1",
            transferId: "xfer-1",
            packageId: "pkg-1",
        });
        expect(result.ok).toBe(true);
        expect(updatedState).toBe("COMPLETED");
    });
});
// ===========================================================================
// 15. Evidence exchange package lifecycle
// ===========================================================================
describe("15. Evidence exchange package lifecycle", () => {
    it("createExchangePackage → DRAFT state", async () => {
        let storedState;
        const prisma = makePrismaStub({
            evidenceExchangePackage: {
                create: async (args) => {
                    storedState = args.data.state;
                    return { id: "pkg-1", ...args.data };
                },
                findFirst: async () => null,
                findMany: async () => [],
                update: async () => ({}),
            },
        });
        const result = await createExchangePackage({
            prisma: prisma,
            teamId: "team-1",
            kind: "EVIDENCE",
            evidenceIds: ["ev-1"],
            createdByUserId: "user-1",
        });
        expect(result.ok).toBe(true);
        expect(storedState).toBe("DRAFT");
    });
    it("markPackageReady → state=READY", async () => {
        let updatedState;
        const prisma = makePrismaStub({
            evidenceExchangePackage: {
                findFirst: async () => ({ id: "pkg-1", state: "DRAFT" }),
                update: async (args) => {
                    updatedState = args.data.state;
                    return args.data;
                },
                create: async () => ({ id: "pkg-1" }),
                findMany: async () => [],
            },
        });
        const result = await markPackageReady({
            prisma: prisma,
            teamId: "team-1",
            packageId: "pkg-1",
            storageKey: "s3/key/pkg-1.zip",
            packageSha256: "a".repeat(64),
            packageSizeBytes: 1024,
        });
        expect(result.ok).toBe(true);
        expect(updatedState).toBe("READY");
    });
    it("generateSignedUrl on READY package persists signedUrl + expiresAtUtc", async () => {
        let persistedUrl;
        let persistedExpiry;
        const prisma = makePrismaStub({
            evidenceExchangePackage: {
                findFirst: async () => ({ id: "pkg-1", state: "READY", packageSha256: "a".repeat(64) }),
                update: async (args) => {
                    persistedUrl = args.data.signedUrl;
                    persistedExpiry = args.data.signedUrlExpiresAtUtc;
                    return args.data;
                },
                create: async () => ({ id: "pkg-1" }),
                findMany: async () => [],
            },
        });
        const result = await generateSignedUrl({
            prisma: prisma,
            teamId: "team-1",
            packageId: "pkg-1",
            ttlSeconds: 3600,
            baseUrl: "https://download.example.com/exchange/",
        });
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(typeof result.signedUrl).toBe("string");
            expect(result.signedUrl).toContain("pkg-1");
            expect(typeof result.expiresAtUtc).toBe("string");
        }
        expect(persistedUrl).toBeDefined();
        expect(persistedExpiry).toBeInstanceOf(Date);
    });
});
// ===========================================================================
// 16. Lifecycle dashboard
// ===========================================================================
describe("16. Lifecycle dashboard", () => {
    it("dashboard projection has correct schemaVersion and 6 metric groups", async () => {
        const prisma = makePrismaStub();
        const result = await projectLifecycleDashboard({
            prisma: prisma,
            teamId: "team-1",
        });
        expect(result.schemaVersion).toBe("PROOVRA_LIFECYCLE_DASHBOARD_V1");
        expect(result).toHaveProperty("retention");
        expect(result).toHaveProperty("legalHolds");
        expect(result).toHaveProperty("archive");
        expect(result).toHaveProperty("destruction");
        expect(result).toHaveProperty("upcomingExpirations");
        expect(result).toHaveProperty("violations");
        // 6 metric groups confirmed
        const groups = ["retention", "legalHolds", "archive", "destruction", "upcomingExpirations", "violations"];
        expect(groups.every((g) => g in result)).toBe(true);
    });
});
// ===========================================================================
// 17. Verification package wires 7 lifecycle manifests
// ===========================================================================
describe("17. Verification package wires 7 lifecycle manifests", () => {
    const vpPath = path.join(__dirname, "../../worker/src/verification-package.ts");
    const lcPath = path.join(__dirname, "../../worker/src/verification-package-lifecycle.ts");
    it("verification-package.ts imports + calls buildLifecycleAndExchangeManifests", () => {
        const src = fs.readFileSync(vpPath, "utf8");
        expect(src).toContain("buildLifecycleAndExchangeManifests");
    });
    it("verification-package-lifecycle.ts declares all 7 path strings under lifecycle/ prefix", () => {
        const src = fs.readFileSync(lcPath, "utf8");
        const expectedPaths = [
            "lifecycle/lifecycle-manifest.json",
            "lifecycle/retention-manifest.json",
            "lifecycle/legal-hold-manifest.json",
            "lifecycle/archive-manifest.json",
            "lifecycle/destruction-manifest.json",
            "lifecycle/exchange-manifest.json",
            "lifecycle/transfer-manifest.json",
        ];
        for (const p of expectedPaths) {
            expect(src).toContain(p);
        }
    });
});
// ===========================================================================
// 18. Routes + server + nav
// ===========================================================================
describe("18. Routes + server + nav", () => {
    const routesPath = path.join(__dirname, "../src/routes/product-and-lifecycle.routes.ts");
    const serverPath = path.join(__dirname, "../src/server.ts");
    const navPath = path.join(__dirname, "../src/services/platform-context/navigation-registry.ts");
    const routesSrc = fs.readFileSync(routesPath, "utf8");
    const serverSrc = fs.readFileSync(serverPath, "utf8");
    const navSrc = fs.readFileSync(navPath, "utf8");
    it("routes file declares entitlements endpoint with requireAuth preHandler", () => {
        expect(routesSrc).toContain("/v1/packaging/entitlements");
        expect(routesSrc).toContain("requireAuth");
    });
    it("routes file declares legal-holds endpoint", () => {
        expect(routesSrc).toMatch(/\/v1\/lifecycle\/legal-holds/);
    });
    it("routes file declares destruction endpoints", () => {
        expect(routesSrc).toMatch(/\/v1\/lifecycle\/destruction/);
    });
    it("routes file declares archive endpoints", () => {
        expect(routesSrc).toMatch(/\/v1\/lifecycle\/archive/);
    });
    it("routes file declares lifecycle dashboard endpoint", () => {
        expect(routesSrc).toMatch(/\/v1\/lifecycle\/dashboard/);
    });
    it("server.ts imports productAndLifecycleRoutes", () => {
        expect(serverSrc).toContain("productAndLifecycleRoutes");
    });
    it("server.ts registers productAndLifecycleRoutes", () => {
        expect(serverSrc).toMatch(/register.*productAndLifecycleRoutes|productAndLifecycleRoutes.*register/);
    });
    it("navigation-registry.ts includes workspace.evidence_lifecycle entry", () => {
        expect(navSrc).toContain("workspace.evidence_lifecycle");
    });
    it("navigation-registry.ts includes workspace.packaging entry", () => {
        expect(navSrc).toContain("workspace.packaging");
    });
});
