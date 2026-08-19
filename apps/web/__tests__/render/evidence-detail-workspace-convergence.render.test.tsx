/**
 * WORKSPACE & CAPABILITY CONVERGENCE GATE — /evidence/[id].
 *
 * WHY THIS FILE EXISTS
 * ---------------------------------------------------------------------------
 * The Evidence Detail redesign has to be ONE implementation. Every workspace
 * kind — Personal, Small-Business/Organization, Enterprise — must mount the
 * same route file, the same shell, the same tab authority and the same right
 * rail. Capability may decide WHICH MODULES appear and WHICH ACTIONS are
 * offered; it may never decide which design system renders.
 *
 * That property cannot be proven by reading source, because the branches are
 * runtime: the route reads `useEnterpriseSurfaceAccess()` and
 * `usePlanFeatureGate()`, both of which resolve from the server-projected
 * platform-context envelope. So this file drives the REAL page component
 * through six envelopes and asserts the matrix directly.
 *
 * THE SIX CONTEXTS
 *   personal      PERSONAL space, no enterprise flag, no intake entitlement
 *   organization  ORGANIZATION space, small-business plan, no enterprise flag
 *   enterprise    ORGANIZATION space, `flags.isEnterpriseWorkspace === true`
 *   platformAdmin PERSONAL space, `platform.isPlatformAdmin === true`
 *   legacy        an envelope with NO `flags` and NO `planFeatures` keys —
 *                 an older backend, or a degraded projection
 *   missing       no envelope at all (loading / failed projection)
 *
 * FAIL-CLOSED is the point of the last two: an unknown projection must never
 * fall into Enterprise affordances. Enterprise is never inferred from the plan
 * string, the workspace label, the record contents or any incidental field —
 * only from the canonical projection, which is why `legacy` below carries
 * `accountPlan: "ENTERPRISE"` and a workspace literally named "Enterprise
 * Holdings" while still being required to render as a non-enterprise surface.
 */

import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor, act } from "@testing-library/react";

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

const EVIDENCE_ID = "ev-convergence-1";

/** Every request the route (and its children) make, in order. */
let requestLog: string[] = [];

vi.mock("../../lib/api", () => ({
  apiFetch: async (path: string) => {
    requestLog.push(path);
    return respond(path);
  },
  readApiToken: () => null,
  apiBaseUrl: () => "https://api.test.invalid",
  ApiError: class ApiError extends Error {},
}));

vi.mock("../../lib/api/intelligence", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchEvidenceIntelligence: async () => ({
    evidenceId: EVIDENCE_ID,
    entities: [],
    extractedText: [],
    similarities: [],
  }),
}));

vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: EVIDENCE_ID }),
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
  useSearchParams: () => new URLSearchParams(""),
  usePathname: () => `/evidence/${EVIDENCE_ID}`,
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

import { PlatformContextProvider } from "../../lib/platform-context";
import {
  AUTHORITY_SCHEMA_VERSION,
  CAPABILITY_SCHEMA_VERSION,
  NAVIGATION_SCHEMA_VERSION,
} from "../../lib/platform-context/types";
import { ToastProvider } from "../../components/ui";
import { ConfirmActionProvider } from "../../components/ui/ConfirmActionModal";
import EvidenceDetailPage from "../../app/(app)/evidence/[id]/page";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * One record fixture, shared by every context. Holding the RECORD constant is
 * deliberate: any difference the matrix observes must come from the capability
 * projection, never from the data.
 */
function makeWorkspace(): unknown {
  const iso = (s: string) => s;
  return {
    evidence: {
      id: EVIDENCE_ID,
      title: "incident-bundle.zip",
      displayTitle: "Incident bundle",
      status: "REPORTED",
      verificationStatus: "RECORDED_INTEGRITY_VERIFIED",
      createdAt: iso("2026-07-04T03:47:43Z"),
      updatedAt: iso("2026-07-04T05:23:22Z"),
      deletedAt: null,
      locked: true,
      archived: false,
      mimeType: "application/zip",
      sizeBytes: "20688281",
      sha256: "a".repeat(64),
      originalFileName: "incident-bundle.zip",
      itemCount: 3,
      parts: [],
      contentItems: [],
    },
    parts: [],
    legalBoundary:
      "PROOVRA verifies recorded preservation state only. It does not independently prove factual truth, authorship, context, intent, evidentiary weight, or legal admissibility.",
    workspaceCapabilitySnapshot: {
      workspaceType: "TEAM",
      workspaceName: "Fixture workspace",
      plan: "FIXTURE",
      reportsIncluded: true,
      verificationPackageIncluded: true,
      publicVerifyIncluded: true,
      billingStatus: null,
      storageUsedLabel: null,
      storageLimitLabel: null,
      storageRemainingLabel: null,
      seatsIncluded: null,
      seatsUsed: null,
      seatsRemaining: null,
      overSeatLimit: null,
      discussionEnabled: true,
      discussionReadOnly: false,
    },
    sourceContext: {
      sourceType: "folder_upload",
      captureMethod: "WEB_UPLOAD",
      captureMethodLabel: "PROOVRA Web Upload",
      importedUpload: true,
      nativeCapture: false,
      folderUpload: true,
      deviceTimeIso: iso("2026-07-04T00:48:10Z"),
      capturedAtUtc: iso("2026-07-04T03:47:43Z"),
      uploadedAtUtc: iso("2026-07-04T03:47:54Z"),
      createdAt: iso("2026-07-04T03:47:43Z"),
      locationIncluded: false,
      sourceLabels: ["Folder upload (multiple files)"],
      clientSignalsSummary: {
        screenshotLike: false,
        screenshotLikeStatus: "COLLECTED_FALSE",
        genericMime: false,
        oldLastModified: false,
        folderPathPresent: false,
        folderPathStatus: "COLLECTED_FALSE",
        duplicateSignals: [],
      },
      metadataAvailability: {
        nativeMetadataRecorded: false,
        captureLocationRecorded: false,
        clientSignalsRecorded: true,
      },
      limitations: [],
    },
    reviewDecision: {
      status: "RECORDED_INTEGRITY_VERIFIED",
      label: "Needs Review",
      summary: "Reviewer status is an internal workflow marker.",
      issues: [],
      nextActions: [],
      privateNote: null,
    },
    reviewerAlerts: [],
    custodyLifecycle: {
      forensicEventCount: 2,
      accessEventCount: 1,
      forensicEvents: [
        {
          sequence: 1,
          atUtc: iso("2026-07-04T03:47:43Z"),
          eventType: "EVIDENCE_CREATED",
          payloadSummary: "Evidence created",
          prevEventHash: null,
          eventHash: "h1",
          category: "forensic",
        },
        {
          sequence: 2,
          atUtc: iso("2026-07-04T03:47:54Z"),
          eventType: "SIGNATURE_APPLIED",
          payloadSummary: "Signature applied",
          prevEventHash: "h1",
          eventHash: "h2",
          category: "forensic",
        },
      ],
      accessEvents: [
        {
          sequence: 3,
          atUtc: iso("2026-07-12T15:44:02Z"),
          eventType: "REPORT_DOWNLOADED",
          payloadSummary: "Report downloaded",
          prevEventHash: "h2",
          eventHash: "h3",
          category: "access",
        },
      ],
      chronologyNote: "Integrity-relevant lifecycle chronology.",
    },
    custodyDisplayCounts: {
      forensicAtReportGeneration: 2,
      currentForensicEvents: 2,
      accessAfterReportGeneration: 1,
      currentAccessEvents: 1,
      reportGeneratedAtUtc: iso("2026-07-04T05:23:22Z"),
    },
    sourceCaptureLocation: {
      statusLabel: "No location metadata recorded",
      description: "No authorized location metadata is recorded.",
      lat: null,
      lng: null,
      accuracyMeters: null,
      capturedAtUtc: null,
      deviceTimeIso: null,
      source: "PROOVRA secure capture",
      externalMapUrl: null,
      legalBoundary: "Location metadata is device/browser-reported.",
    },
    preservationMatrix: {
      verificationStatus: "RECORDED_INTEGRITY_VERIFIED",
      verificationStatusLabel: "Recorded integrity state verified",
      recordedIntegrityVerifiedAtUtc: iso("2026-07-04T03:47:54Z"),
      sha256Recorded: true,
      fingerprintHashRecorded: true,
      fingerprintCanonicalHashMatches: true,
      signature: { recorded: true, valid: true, keyId: "k1", keyVersion: 1 },
      tsa: {
        status: "RECORDED",
        provider: "fixture-tsa",
        timestampAvailable: true,
        digestMatchesTimestampInput: true,
        digestCheckConclusive: true,
        genTimeUtc: iso("2026-07-04T03:47:54Z"),
        failureReason: null,
        timestampedDigestLabel: "Canonical fingerprint",
      },
      ots: {
        status: "ANCHORED",
        effectiveStatus: "ANCHORED",
        proofPresent: true,
        hashMatches: true,
        anchoredAtUtc: iso("2026-07-04T05:53:39Z"),
        upgradedAtUtc: iso("2026-07-04T05:53:39Z"),
        lastUpdatedAtUtc: iso("2026-07-04T05:53:39Z"),
        calendar: "fixture-calendar",
        bitcoinTxid: null,
        failureReason: null,
        pendingReason: null,
      },
      custodyChain: { valid: true, mode: "HASH_CHAIN", reason: null },
      storage: {
        immutable: true,
        mode: "COMPLIANCE",
        retainUntil: null,
        legalHold: null,
        region: "eu-central-1",
        verified: true,
      },
      anchor: { mode: "active", provider: "opentimestamps", configured: true },
      report: {
        available: true,
        version: 2,
        generatedAtUtc: iso("2026-07-04T05:23:22Z"),
        reviewerSummaryVersion: 2,
        verificationPackageVersion: 2,
        pending: false,
        pdfSignature: {
          status: "SIGNED",
          signedAtUtc: iso("2026-07-04T05:23:22Z"),
          signerKeyId: "k1",
          warning: null,
        },
      },
      verificationPackage: {
        available: true,
        version: 2,
        generatedAtUtc: iso("2026-07-04T05:23:22Z"),
        packageType: "full_evidence_package",
        pending: false,
        unavailable: false,
        unavailableReason: null,
        blocked: false,
        blockedOutcome: null,
        blockedReason: null,
        blockedAtUtc: null,
        manifestSignature: { status: "SIGNED", signerKeyId: "k1" },
        manifestPresent: true,
        signedManifestPresent: true,
        manifestDigestPresent: true,
        checksumIndexPresent: true,
        auditExportIncluded: true,
        custodyExportIncluded: true,
        accessExportIncluded: true,
      },
    },
    relationships: {
      caseId: null,
      caseName: null,
      relatedEvidenceCount: 0,
      multipart: true,
      itemCount: 3,
      note: null,
      items: [],
    },
    reviewWorkflow: {
      status: null,
      statusLabel: "Not started",
      priority: "NORMAL",
      teamId: "team-fixture",
      assignedTo: null,
      dueAt: null,
      dueAtUtc: null,
      updatedAt: iso("2026-07-04T05:23:22Z"),
      operationalSummary: "Operational summary",
    },
    classification: {
      evidenceType: "MIXED",
      evidenceTypeLabel: "Mixed Media Evidence Package",
      captureMethod: "WEB_UPLOAD",
      captureMethodLabel: "PROOVRA Web Upload",
      intakeTemplate: null,
      workspaceType: "TEAM",
      workspaceName: "Fixture workspace",
      matterType: null,
    },
    integrityDrift: {
      available: true,
      reportGeneratedAtUtc: iso("2026-07-04T05:23:22Z"),
      reportVersion: 2,
      titleDiffersFromReportSnapshot: false,
      itemCountDiffersFromReportSnapshot: false,
      postReportForensicEvents: 0,
      postReportAccessEvents: 1,
      note: "PDF report is a fixed generated artifact.",
    },
    snapshot: {
      reportGeneratedAtUtc: iso("2026-07-04T05:23:22Z"),
      reportVersion: 2,
      verificationPackageGeneratedAtUtc: iso("2026-07-04T05:23:22Z"),
      verificationPackageVersion: 2,
      currentStatus: "REPORTED",
      statusAtReportGeneration: "REPORTED",
      fixedArtifactNote: "Fixed generated materials reflect the state recorded when produced.",
    },
    publicVerificationSummary: {
      state: "PUBLISHED",
      publicationState: "PUBLISHED",
      enabled: true,
      configured: true,
      published: true,
      sharePath: `/verify/${EVIDENCE_ID}`,
      routeAccessible: true,
      publicViewCount: 1,
      authenticatedViewCount: 0,
      lastPublicViewAt: iso("2026-07-10T02:22:02Z"),
      reportDownloadCount: 4,
      verificationPackageDownloadCount: 4,
      analyticsAvailable: true,
      disabledReason: null,
    },
    artifactStatus: {
      evidenceId: EVIDENCE_ID,
      status: "REPORTED",
      finalized: true,
      report: {
        state: "AVAILABLE",
        available: true,
        version: 2,
        generatedAtUtc: iso("2026-07-04T05:23:22Z"),
        disabledReason: null,
      },
      verificationPackage: {
        state: "AVAILABLE",
        available: true,
        version: 2,
        generatedAtUtc: iso("2026-07-04T05:23:22Z"),
        disabledReason: null,
      },
    },
    artifactVersions: {
      trustDecision: null,
      reports: [
        { version: 2, generatedAtUtc: iso("2026-07-04T05:23:22Z"), sizeBytes: "6093110", latest: true, immutableRecorded: true },
      ],
      verificationPackages: [
        {
          version: 2,
          generatedAtUtc: iso("2026-07-04T05:23:22Z"),
          packageType: "full_evidence_package",
          sizeBytes: "20688281",
          latest: true,
          immutableRecorded: true,
        },
      ],
    },
  };
}


/**
 * Contract-shaped responses for every endpoint this route and its children
 * touch. Shapes come from the consuming components' own types — a `{}`
 * catch-all would crash them and turn a convergence assertion into a
 * fixture assertion.
 */
function respond(path: string): unknown {
  if (path.includes("/review-workspace")) return makeWorkspace();
  if (path.startsWith("/v1/cases?")) return { items: [] };
  if (path.includes("/reviewer-workflow/events")) return { items: [] };
  if (path.includes("/admin/runtime/readiness")) {
    return { status: "HEALTHY", subsystems: [], generatedAtUtc: "2026-07-04T05:23:22Z" };
  }
  if (path.includes("/governance-snapshot")) {
    return {
      evidenceId: EVIDENCE_ID,
      teamId: "team-fixture",
      generatedAtUtc: "2026-07-04T05:23:22Z",
      lifecycle: { state: "ACTIVE", label: "Active", isTerminal: false },
      review: {
        workflowId: null,
        status: null,
        slaStatus: null,
        activeEscalationId: null,
        activeEscalationSeverity: null,
      },
      legalHold: {
        hasActiveDirectHold: false,
        hasActiveCaseHold: false,
        directHoldCount: 0,
        caseHoldCount: 0,
        blocksExport: false,
      },
      retention: { bound: false, immutable: false, expired: false, retentionUntilUtc: null },
      destruction: { activeReviewId: null, activeReviewStatus: null, eligible: false, blockedReason: null },
      export: { eligible: true, outcome: "ELIGIBLE", reason: "", label: "Eligible" },
      package: { eligible: true, outcome: "ELIGIBLE", reason: "", label: "Eligible" },
      immutableStorage: { driftDetected: false, driftIncidentId: null, driftLabel: null },
      incidents: [],
      warnings: [],
    };
  }
  if (path.includes("/media-intelligence")) {
    return { evidenceId: EVIDENCE_ID, signals: [], catalog: [], derivedAssets: [], catalogVersion: 1, analyzerAvailable: true };
  }
  if (path.includes("/operational-timeline")) {
    return { evidenceId: EVIDENCE_ID, entries: [], truncated: false };
  }
  if (path.includes("/derived-assets")) {
    return { evidenceId: EVIDENCE_ID, assets: [] };
  }
  if (path.includes("/v1/governance/evidence/")) {
    return {
      legalHold: null,
      retention: { retentionUntilUtc: null, policyDefaultDays: null },
      policy: {
        source: "default",
        evidenceDeletionMode: "ALLOWED",
        requireReviewBeforeReport: false,
        requireReviewBeforePackage: false,
        requireReviewBeforePublicVerify: false,
        allowReportDownload: true,
        allowPackageDownload: true,
        allowPublicVerify: true,
      },
    };
  }
  return { items: [] };
}

type ContextKey =
  | "personal"
  | "organization"
  | "enterprise"
  | "platformAdmin"
  | "legacy"
  | "missing";

/**
 * Envelope builder. `flags` and `planFeatures` are the ONLY levers; the plan
 * string and workspace name are deliberately misleading in the `legacy` case.
 */
function makeEnvelope(key: ContextKey): unknown {
  const base = {
    authoritySchemaVersion: AUTHORITY_SCHEMA_VERSION,
    capabilitySchemaVersion: CAPABILITY_SCHEMA_VERSION,
    navigationSchemaVersion: NAVIGATION_SCHEMA_VERSION,
    capabilities: { EVIDENCE_VIEW: true },
    diagnostics: { requestId: `test-${key}` },
  };
  const space = (type: "PERSONAL" | "ORGANIZATION", id: string, displayName: string) => ({
    workspace: { id, name: displayName, status: "active", scope: type },
    activeSpace: { type, id, displayName, roleLabel: "Owner" },
    contextOptions: {
      personalSpace: null,
      ownedWorkspaces: [],
      organizations: [],
      activeContext: { workspaceId: id, kind: type, organizationId: null, displayName },
    },
  });

  switch (key) {
    case "personal":
      return {
        ...base,
        ...space("PERSONAL", "ws-personal", "Personal Space"),
        account: { accountPlan: "FREE", accountStatus: "active" },
        flags: { isEnterpriseWorkspace: false },
        platform: { isPlatformAdmin: false },
        planFeatures: { intakeIncluded: false },
      };
    case "organization":
      return {
        ...base,
        ...space("ORGANIZATION", "ws-smb", "Northgate Claims"),
        account: { accountPlan: "BUSINESS", accountStatus: "active" },
        flags: { isEnterpriseWorkspace: false },
        platform: { isPlatformAdmin: false },
        planFeatures: { intakeIncluded: true },
      };
    case "enterprise":
      return {
        ...base,
        ...space("ORGANIZATION", "ws-ent", "Meridian Legal"),
        account: { accountPlan: "ENTERPRISE", accountStatus: "active" },
        flags: { isEnterpriseWorkspace: true },
        platform: { isPlatformAdmin: false },
        planFeatures: { intakeIncluded: true },
      };
    case "platformAdmin":
      return {
        ...base,
        ...space("PERSONAL", "ws-admin", "Personal Space"),
        account: { accountPlan: "FREE", accountStatus: "active" },
        flags: { isEnterpriseWorkspace: false },
        platform: { isPlatformAdmin: true },
        planFeatures: {},
      };
    case "legacy":
      // No `flags`, no `platform`, no `planFeatures` — and every incidental
      // field screaming "enterprise". The gate must ignore all of it.
      return {
        ...base,
        ...space("ORGANIZATION", "ws-legacy", "Enterprise Holdings"),
        account: { accountPlan: "ENTERPRISE", accountStatus: "active" },
      };
    case "missing":
      return null;
  }
}

function renderContext(key: ContextKey) {
  const envelope = makeEnvelope(key);
  return render(
    <PlatformContextProvider testEnvelope={envelope as never}>
      <ToastProvider>
        <ConfirmActionProvider>
          <EvidenceDetailPage />
        </ConfirmActionProvider>
      </ToastProvider>
    </PlatformContextProvider>,
  );
}

/** Renders and waits for the route's own load to settle. */
async function mountLoaded(key: ContextKey) {
  const utils = renderContext(key);
  await waitFor(() => {
    expect(document.querySelector(".evidence-detail-hero")).not.toBeNull();
  });
  // Flush the follow-up effects (intelligence, workflow events) so the DOM the
  // matrix inspects is the settled one, not the first paint.
  await act(async () => {
    await Promise.resolve();
  });
  return utils;
}

const ENTERPRISE_CONTEXTS: ContextKey[] = ["enterprise", "platformAdmin"];
const NON_ENTERPRISE_CONTEXTS: ContextKey[] = ["personal", "organization", "legacy"];
const LOADED_CONTEXTS: ContextKey[] = [...NON_ENTERPRISE_CONTEXTS, ...ENTERPRISE_CONTEXTS];

beforeEach(() => {
  requestLog = [];
});

// ---------------------------------------------------------------------------
// 1. ONE implementation — the shell is byte-identical in structure
// ---------------------------------------------------------------------------

describe("convergence — one shell for every workspace kind", () => {
  it.each(LOADED_CONTEXTS)("%s mounts the same shell anatomy", async (key) => {
    await mountLoaded(key);
    expect(document.querySelectorAll(".evidence-detail-hero")).toHaveLength(1);
    expect(document.querySelectorAll(".evidence-detail-layout")).toHaveLength(1);
    expect(document.querySelectorAll(".evidence-detail-main")).toHaveLength(1);
    // Exactly ONE tab authority, and it is the canonical `.app-tabs`.
    const tablists = document.querySelectorAll("nav[role='tablist']");
    expect(tablists).toHaveLength(1);
    expect(tablists[0]?.className).toContain("app-tabs");
    expect(tablists[0]?.className).toContain("evidence-detail-tabs");
  });

  it.each(LOADED_CONTEXTS)("%s mounts exactly one shared rail with the four canonical sections", async (key) => {
    await mountLoaded(key);
    const rails = document.querySelectorAll("[data-evidence-sidebar='status-and-next-action']");
    expect(rails).toHaveLength(1);
    const sections = [...rails[0]!.querySelectorAll("[data-evidence-side]")].map((el) =>
      el.getAttribute("data-evidence-side"),
    );
    expect(sections).toEqual([
      "risk-signals",
      "operational-summary",
      "attributes",
      "public-verification-shortcut",
    ]);
    const headings = [...rails[0]!.querySelectorAll(".evidence-detail-rail-heading")].map(
      (el) => el.textContent,
    );
    expect(headings).toEqual([
      "Risk Signals",
      "Review Workflow",
      "Attributes",
      "Public Verification",
    ]);
  });

  it.each(LOADED_CONTEXTS)("%s renders the same tab set from the same record projection", async (key) => {
    await mountLoaded(key);
    const tabs = [...document.querySelectorAll("[role='tab']")].map((el) => el.textContent?.trim());
    // The record fixture is identical in every context, so the tab set must be
    // too. Discussion is gated by the RECORD's capability snapshot, never by
    // workspace kind.
    expect(tabs).toEqual([
      "Overview",
      "Integrity",
      "Custody",
      "Review",
      "Artifacts",
      "Discussion",
      "Technical Appendix",
    ]);
  });
});

// ---------------------------------------------------------------------------
// 2. Capability drives MODULES — not the design system
// ---------------------------------------------------------------------------

describe("convergence — capability controls modules only", () => {
  async function openReviewTab(key: ContextKey) {
    await mountLoaded(key);
    const reviewTab = [...document.querySelectorAll("[role='tab']")].find(
      (el) => el.textContent?.trim() === "Review",
    ) as HTMLButtonElement;
    await act(async () => {
      reviewTab.click();
    });
  }

  it.each(ENTERPRISE_CONTEXTS)("%s reaches the reviewer-ops panels", async (key) => {
    await openReviewTab(key);
    expect(document.querySelector("[data-evidence-review-enterprise-panels]")).not.toBeNull();
  });

  it.each(NON_ENTERPRISE_CONTEXTS)("%s does not reach the reviewer-ops panels", async (key) => {
    await openReviewTab(key);
    expect(document.querySelector("[data-evidence-review-enterprise-panels]")).toBeNull();
  });

  it.each(LOADED_CONTEXTS)("%s offers the shared, non-gated review action", async (key) => {
    await openReviewTab(key);
    // Attach-to-case is capability-INVARIANT: every workspace kind gets it,
    // which is what makes the reviewer-ops difference above a module gate
    // rather than a whole-tab gate.
    expect(document.querySelector("[data-evidence-action='attach-to-case']")).not.toBeNull();
  });

  it("reviewer-ops panels use the SAME primitives as the ungated surface", async () => {
    await openReviewTab("enterprise");
    const panels = document.querySelector("[data-evidence-review-enterprise-panels]")!;
    // Every button inside the capability-gated region must be a canonical
    // action primitive. A legacy `Button` renders `.btn`/`.button` classes.
    const buttons = [...panels.querySelectorAll("button")];
    expect(buttons.length).toBeGreaterThan(0);
    for (const b of buttons) {
      expect(b.className).toMatch(
        /app-(primary|secondary|ghost)-action|app-listbox__trigger|evidence-detail-/,
      );
    }
    // And no native select survives inside the gated region.
    expect(panels.querySelector("select")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. FAIL CLOSED — unknown / legacy / missing projection
// ---------------------------------------------------------------------------

describe("convergence — unknown capability data fails closed", () => {
  it("a legacy envelope with no flags renders as NON-enterprise despite an ENTERPRISE plan string", async () => {
    await mountLoaded("legacy");
    const reviewTab = [...document.querySelectorAll("[role='tab']")].find(
      (el) => el.textContent?.trim() === "Review",
    ) as HTMLButtonElement;
    await act(async () => {
      reviewTab.click();
    });
    expect(document.querySelector("[data-evidence-review-enterprise-panels]")).toBeNull();
    // The misleading fields really are present in the envelope under test.
    const env = makeEnvelope("legacy") as { account: { accountPlan: string }; workspace: { name: string } };
    expect(env.account.accountPlan).toBe("ENTERPRISE");
    expect(env.workspace.name).toBe("Enterprise Holdings");
  });

  it("a missing envelope renders no enterprise affordance and does not throw", async () => {
    expect(() => renderContext("missing")).not.toThrow();
    expect(document.querySelector("[data-evidence-review-enterprise-panels]")).toBeNull();
  });

  it("a missing envelope issues no evidence request at all", async () => {
    renderContext("missing");
    await act(async () => {
      await Promise.resolve();
    });
    // Nothing tenant-scoped may be fetched before the projection resolves.
    expect(requestLog.filter((p) => p.includes(EVIDENCE_ID))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. No legacy design system in ANY branch
// ---------------------------------------------------------------------------

describe("convergence — no legacy design system in any capability branch", () => {
  it.each(LOADED_CONTEXTS)("%s renders no legacy primitive and no inline colour", async (key) => {
    await mountLoaded(key);
    const root = document.body;
    // Legacy barrel primitives.
    expect(root.querySelector(".btn, .button, .card, .badge, .modal")).toBeNull();
    // Native selects were replaced by AppListbox everywhere on this route.
    expect(root.querySelector("select")).toBeNull();
    // No element may carry a hard-coded colour in a style attribute; the
    // redesign moved every colour into tokens.
    const styled = [...root.querySelectorAll("[style]")].map((el) => el.getAttribute("style") ?? "");
    for (const s of styled) {
      expect(s).not.toMatch(/#[0-9a-fA-F]{3,8}/);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Tenant isolation across a context change
// ---------------------------------------------------------------------------

describe("convergence — no cross-context leakage", () => {
  it("switching context re-requests the record and never reuses the prior envelope's gate", async () => {
    const first = await mountLoaded("enterprise");
    const reviewTab = () =>
      [...document.querySelectorAll("[role='tab']")].find(
        (el) => el.textContent?.trim() === "Review",
      ) as HTMLButtonElement;
    await act(async () => {
      reviewTab().click();
    });
    expect(document.querySelector("[data-evidence-review-enterprise-panels]")).not.toBeNull();
    first.unmount();

    requestLog = [];
    await mountLoaded("personal");
    await act(async () => {
      reviewTab().click();
    });
    expect(document.querySelector("[data-evidence-review-enterprise-panels]")).toBeNull();
    // The second mount fetched for itself rather than rendering the first
    // mount's data.
    expect(requestLog.some((p) => p.includes(`/v1/evidence/${EVIDENCE_ID}/review-workspace`))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. Every tab mounts in every context
// ---------------------------------------------------------------------------

describe("convergence — every tab mounts under every capability projection", () => {
  const TABS = [
    "Overview",
    "Integrity",
    "Custody",
    "Review",
    "Artifacts",
    "Discussion",
    "Technical Appendix",
  ];

  it.each(LOADED_CONTEXTS)("%s renders all seven tab panels without error", async (key) => {
    await mountLoaded(key);
    for (const label of TABS) {
      const tab = [...document.querySelectorAll("[role='tab']")].find(
        (el) => el.textContent?.trim() === label,
      ) as HTMLButtonElement;
      expect(tab, `${key}: tab ${label}`).toBeDefined();
      await act(async () => {
        tab.click();
      });
      // The panel the tab controls must exist and be non-empty. An exception
      // inside a capability-gated child would have surfaced here.
      const panel = document.getElementById(tab.getAttribute("aria-controls")!);
      expect(panel, `${key}: panel for ${label}`).not.toBeNull();
      expect(panel!.textContent?.trim().length ?? 0).toBeGreaterThan(0);
      // The rail is mounted once regardless of which tab is active.
      expect(
        document.querySelectorAll("[data-evidence-sidebar='status-and-next-action']"),
      ).toHaveLength(1);
    }
  });
});

// ---------------------------------------------------------------------------
// 7. The gate authority itself
// ---------------------------------------------------------------------------

describe("convergence — the route reads only the canonical projection", () => {
  it("never derives enterprise from the plan string", async () => {
    // `organization` carries BUSINESS + isEnterpriseWorkspace:false, `legacy`
    // carries ENTERPRISE + no flag. Both must render identically w.r.t. the
    // gated region, which is only possible if the plan string is unread.
    for (const key of ["organization", "legacy"] as ContextKey[]) {
      const utils = await mountLoaded(key);
      const tab = [...document.querySelectorAll("[role='tab']")].find(
        (el) => el.textContent?.trim() === "Review",
      ) as HTMLButtonElement;
      await act(async () => {
        tab.click();
      });
      expect(
        document.querySelector("[data-evidence-review-enterprise-panels]"),
        `${key} must not reach reviewer ops`,
      ).toBeNull();
      utils.unmount();
    }
  });
});
