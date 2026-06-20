/**
 * PROOVRA — shared-billing PLAN_CAPABILITIES unit test.
 *
 * Pure unit test, no DB I/O. Locks the numeric caps + ENTERPRISE entry
 * introduced by the pricing-hardening change set so that downstream
 * consumers (services/api enforcement + apps/web pricing UI) cannot
 * silently drift.
 */

import { describe, expect, it } from "vitest";
import {
  PLAN_CAPABILITIES,
  getPlanCapabilities,
  getPlanStorageLimitBytes,
  planHasEnterpriseFeature,
} from "@proovra/shared-billing";

const GB = 1024n * 1024n * 1024n;
const MB = 1024n * 1024n;

describe("PLAN_CAPABILITIES", () => {
  it("includes every plan tier", () => {
    expect(Object.keys(PLAN_CAPABILITIES).sort()).toEqual(
      ["ENTERPRISE", "FREE", "PAYG", "PRO", "TEAM"],
    );
  });

  it("FREE: 3 records, 250 MB, no AI", () => {
    const f = PLAN_CAPABILITIES.FREE;
    expect(f.maxEvidenceRecords).toBe(3);
    expect(f.maxEvidenceRecordsPerMonth).toBeNull();
    expect(f.includedStorageBytes).toBe(250n * MB);
    expect(f.aiAdvisoryMonthlyOperations).toBe(0);
  });

  it("PAYG: no record cap, 5 GB, 50 AI ops, credit-bound", () => {
    const p = PLAN_CAPABILITIES.PAYG;
    expect(p.maxEvidenceRecords).toBeNull();
    expect(p.maxEvidenceRecordsPerMonth).toBeNull();
    expect(p.includedStorageBytes).toBe(5n * GB);
    expect(p.aiAdvisoryMonthlyOperations).toBe(50);
    expect(p.paygCreditsRequiredPerCompletion).toBe(1);
  });

  it("PRO: 100 lifetime records, 100 GB, 100 AI ops, €19", () => {
    const p = PLAN_CAPABILITIES.PRO;
    expect(p.maxEvidenceRecords).toBe(100);
    expect(p.maxEvidenceRecordsPerMonth).toBeNull();
    expect(p.includedStorageBytes).toBe(100n * GB);
    expect(p.aiAdvisoryMonthlyOperations).toBe(100);
    expect(p.monthlyPriceCents).toBe(1900);
    expect(p.allowsPersonalWorkspace).toBe(true);
    expect(p.reportsIncluded).toBe(true);
    expect(p.verificationPackageIncluded).toBe(true);
  });

  it("TEAM: 500 monthly records, 500 GB, 500 AI ops, €79", () => {
    const t = PLAN_CAPABILITIES.TEAM;
    expect(t.maxEvidenceRecords).toBeNull();
    expect(t.maxEvidenceRecordsPerMonth).toBe(500);
    expect(t.includedStorageBytes).toBe(500n * GB);
    expect(t.aiAdvisoryMonthlyOperations).toBe(500);
    expect(t.monthlyPriceCents).toBe(7900);
    expect(t.allowsTeamWorkspace).toBe(true);
    expect(t.teamWorkspaceRequired).toBe(true);
  });

  it("ENTERPRISE: no record cap, custom AI, all governance features enabled", () => {
    const e = PLAN_CAPABILITIES.ENTERPRISE;
    expect(e.maxEvidenceRecords).toBeNull();
    expect(e.maxEvidenceRecordsPerMonth).toBeNull();
    expect(e.aiAdvisoryMonthlyOperations).toBeNull();
    expect(e.monthlyPriceCents).toBeNull();
    expect(e.enterpriseFeatures.ssoScim).toBe(true);
    expect(e.enterpriseFeatures.mfaEnforcement).toBe(true);
    expect(e.enterpriseFeatures.legalHold).toBe(true);
    expect(e.enterpriseFeatures.retentionPolicy).toBe(true);
    expect(e.enterpriseFeatures.organizationAuditLogs).toBe(true);
    expect(e.enterpriseFeatures.objectLock).toBe(true);
    expect(e.enterpriseFeatures.accessReviews).toBe(true);
    expect(e.enterpriseFeatures.sessionGovernance).toBe(true);
  });

  it("non-Enterprise plans have NO enterprise features enabled", () => {
    for (const plan of ["FREE", "PAYG", "PRO", "TEAM"] as const) {
      const caps = PLAN_CAPABILITIES[plan];
      for (const flag of Object.values(caps.enterpriseFeatures)) {
        expect(flag).toBe(false);
      }
    }
  });
});

describe("helpers", () => {
  it("getPlanCapabilities returns the right entry", () => {
    expect(getPlanCapabilities("PRO").maxEvidenceRecords).toBe(100);
    expect(getPlanCapabilities("TEAM").maxEvidenceRecordsPerMonth).toBe(500);
    expect(getPlanCapabilities("ENTERPRISE").enterpriseFeatures.ssoScim).toBe(
      true,
    );
  });

  it("getPlanStorageLimitBytes mirrors the catalog", () => {
    expect(getPlanStorageLimitBytes("PRO")).toBe(100n * GB);
    expect(getPlanStorageLimitBytes("TEAM")).toBe(500n * GB);
    expect(getPlanStorageLimitBytes("ENTERPRISE")).toBe(500n * GB);
  });

  it("planHasEnterpriseFeature gates correctly", () => {
    expect(planHasEnterpriseFeature("FREE", "ssoScim")).toBe(false);
    expect(planHasEnterpriseFeature("PRO", "legalHold")).toBe(false);
    expect(planHasEnterpriseFeature("TEAM", "objectLock")).toBe(false);
    expect(planHasEnterpriseFeature("ENTERPRISE", "ssoScim")).toBe(true);
    expect(planHasEnterpriseFeature("ENTERPRISE", "objectLock")).toBe(true);
  });
});
