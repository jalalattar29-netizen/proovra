/**
 * The server, as Reports & Artifacts sees it — by route interception.
 *
 * What this project measures is GEOMETRY: whether a selector's chosen value is
 * readable in full, whether its menu is at least as wide as its trigger and
 * fits its longest option inside the viewport, and whether the toolbar ever
 * overflows or overlaps at a supported width, in each supported locale and in
 * RTL. None of that is a property of the database; all of it is a property of
 * the production bundle, the real cascade and a real layout engine. So the API
 * is intercepted and only the web tier is real.
 */

import type { Page } from "@playwright/test";

import {
  AUTHORITY_SCHEMA_VERSION,
  CAPABILITY_SCHEMA_VERSION,
  NAVIGATION_SCHEMA_VERSION,
} from "../../apps/web/lib/platform-context/types";

export const WORKSPACE_ID = "66666666-6666-4666-8666-666666666666";

export type ReportsLocale = "en" | "de" | "ar";

function envelope(): Record<string, unknown> {
  return {
    authoritySchemaVersion: AUTHORITY_SCHEMA_VERSION,
    capabilitySchemaVersion: CAPABILITY_SCHEMA_VERSION,
    navigationSchemaVersion: NAVIGATION_SCHEMA_VERSION,
    capabilities: { EVIDENCE_VIEW: true, EVIDENCE_MANAGE: true, REPORTS_VIEW: true },
    diagnostics: { requestId: "reports-layout" },
    workspace: { id: WORKSPACE_ID, name: "Meridian Legal", status: "active", scope: "ORGANIZATION" },
    activeSpace: { type: "ORGANIZATION", id: WORKSPACE_ID, displayName: "Meridian Legal", roleLabel: "Owner" },
    contextOptions: {
      personalSpace: null,
      ownedWorkspaces: [],
      organizations: [],
      activeContext: { workspaceId: WORKSPACE_ID, kind: "ORGANIZATION", organizationId: null, displayName: "Meridian Legal" },
    },
    account: { accountPlan: "PRO", accountStatus: "active" },
    flags: { isEnterpriseWorkspace: false },
    platform: { isPlatformAdmin: false },
    planFeatures: { intakeIncluded: true, reportsIncluded: true },
    user: { id: "user-1", email: "owner@example.invalid", name: "Owner" },
  };
}

function row(id: string) {
  return {
    evidenceId: id,
    teamId: WORKSPACE_ID,
    title: `Record ${id}`,
    displayFileName: null,
    originalFileName: null,
    mimeType: "image/jpeg",
    type: "PHOTO",
    status: "REPORTED",
    verificationStatus: "RECORDED_INTEGRITY_VERIFIED",
    caseId: null,
    caseTitle: null,
    intakeCustomerId: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    report: { state: "ready", updateFailed: false, version: 1, generatedAtUtc: "2026-10-02T00:00:00.000Z" },
    package: { state: "ready", version: 1, generatedAtUtc: null, blockedReason: null },
    outputs: {
      report: { state: "READY", action: "NONE", actionUnavailableReason: "NOT_REQUIRED", terminalReasonClass: null, terminalReasonCode: null, downloadable: true, operation: null },
      verificationPackage: { state: "READY", action: "NONE", actionUnavailableReason: "NOT_REQUIRED", terminalReasonClass: null, terminalReasonCode: null, downloadable: true, operation: null, latestAvailableVersion: null },
      newVersion: { action: "NONE", reason: "NOT_REQUIRED" },
      pollIntervalMs: null,
    },
    deliverable: { status: "READY", reason: "COMPLETE" },
  };
}

const SUMMARY = {
  reportsReady: 2,
  reportsPending: 0,
  reportsFailed: 0,
  reportsUpdateFailed: 0,
  reportsBlocked: 0,
  packagesReady: 2,
  packagesPending: 0,
  packagesBlocked: 0,
  packagesFailed: 0,
  reportsNotIssued: 0,
  reportsAwaitingFirstIssuance: 0,
  packagesMissingForLatestReport: 0,
  outputsEntitlementUnavailable: 0,
  totalEvidenceWithArtifacts: 2,
  totalArtifactVersions: 2,
  recordsReady: 2,
  recordsInProgress: 0,
  recordsNeedingAttention: 0,
  recordsIncomplete: 0,
  recordsNotAvailable: 0,
  recordsTotal: 2,
};

const CONSENT = JSON.stringify({
  categories: ["necessary", "preferences"],
  revision: 1,
  data: null,
  consentTimestamp: "2026-08-29T19:14:00.000Z",
  consentId: "reports-layout-consent",
  services: { necessary: [], preferences: [], analytics: [], marketing: [] },
  languageCode: "en",
  lastConsentTimestamp: "2026-08-29T19:14:00.000Z",
  expirationTime: 4102444800000,
});

/** Intercept the API and open /reports in a locale. */
export async function openReports(
  page: Page,
  locale: ReportsLocale,
  search = "",
  /** The export-eligibility body to answer with (defaults to ALLOWED). */
  eligibility: unknown = { outcome: "ALLOWED", reason: "ALLOWED", lifecycleState: "ACTIVE" },
): Promise<void> {
  await page.context().addCookies([
    { name: "proovra-locale", value: locale, domain: "127.0.0.1", path: "/" },
    { name: "proovra-locale-mode", value: "manual", domain: "127.0.0.1", path: "/" },
    { name: "cc_cookie", value: encodeURIComponent(CONSENT), domain: "127.0.0.1", path: "/" },
  ]);
  await page.route("**/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const json = (body: unknown) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    if (url.pathname.endsWith("/v1/platform/context")) return json(envelope());
    if (url.pathname.endsWith("/v1/auth/me") || url.pathname.endsWith("/v1/users/me")) {
      return json({ id: "user-1", email: "owner@example.invalid" });
    }
    if (url.pathname.endsWith("/v1/reports/artifacts")) {
      const isSummary = url.searchParams.get("summary") !== "0";
      return json({
        generatedAt: "2026-10-16T00:00:00.000Z",
        workspace: { id: WORKSPACE_ID, role: "OWNER" },
        sections: {
          summary: isSummary ? { status: "ok", data: SUMMARY } : { status: "skipped", data: null },
          artifacts: { status: "ok", items: [row("ev-1"), row("ev-2")], nextCursor: null, total: 2 },
        },
      });
    }
    if (url.pathname.endsWith("/v1/reports")) return json({ items: [], nextCursor: null });
    if (url.pathname.endsWith("/v1/governance/export-eligibility")) {
      return json(eligibility);
    }
    return json({ items: [] });
  });
  await page.goto(`/reports${search}`);
  await page.waitForSelector("[data-reports-toolbar]", { timeout: 30_000 });
  await page.waitForSelector("[data-reports-list]", { timeout: 30_000 });
}

export const VIEWPORTS = [
  { name: "wide", width: 1920, height: 1080 },
  { name: "1366", width: 1366, height: 900 },
  { name: "laptop", width: 1280, height: 800 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "390", width: 390, height: 844 },
] as const;
