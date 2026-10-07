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
import { projectOutputProgress } from "@proovra/shared";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor, act, fireEvent } from "@testing-library/react";

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

const EVIDENCE_ID = "ev-convergence-1";

/** Every request the route (and its children) make, in order. */
let requestLog: string[] = [];

/** The tenant service status the fixture answers (default: all healthy). */
let runtimeBody: unknown = { status: "HEALTHY" };
/** Overrides the report's canonical action (the fixture's own is NONE: nothing needed). */
let reportActionOverride: string | null = null;
/** Overrides the separate new-version offer (the fixture's own offers none). */
let newVersionActionOverride: string | null = null;
/** Overrides the report's canonical state (the fixture's own is READY). */
let reportStateOverride: string | null = null;
/** The artifact status as a test edits it: the known blocks, plus any field. */
type StatusDoc = {
  outputs: { report: Record<string, unknown>; verificationPackage: Record<string, unknown>; [k: string]: unknown };
  report: Record<string, unknown>;
  verificationPackage: Record<string, unknown>;
  [k: string]: unknown;
};
/** Rewrites the whole artifact status (review workspace AND /artifacts/status alike). */
let statusPatch: ((status: StatusDoc) => void) | null = null;
/** Runs when the updated report is confirmed (the server's state change). */
let onNewVersionPost: (() => void) | null = null;
/** The id in the route (the record on screen). */
let routeEvidenceId = EVIDENCE_ID;

vi.mock("../../lib/api", () => ({
  apiFetch: async (path: string, init?: { method?: string; body?: string }) => {
    requestLog.push(init?.method === "POST" ? `POST ${path}` : path);
    if (init?.method === "POST" && path.endsWith("/reports/regenerate")) {
      const body = JSON.parse(init.body ?? "{}") as { intent?: string };
      if (body.intent === "NEW_VERSION") onNewVersionPost?.();
      return { outcome: "ENQUEUED", enqueued: true, requestId: "req-attn-1" };
    }
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
  useParams: () => ({ id: routeEvidenceId }),
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
  useSearchParams: () => new URLSearchParams(""),
  usePathname: () => `/evidence/${EVIDENCE_ID}`,
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

import { PlatformContextProvider } from "../../lib/platform-context";
import { resetServiceStatusForTests } from "../../lib/useServiceStatus";
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
      source: "Reported by the submitting browser",
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
      /*
        THE CANONICAL THREE-AXIS PROJECTION, WHICH THIS FIXTURE WAS MISSING.

        `artifactStatus.outputs` became the thing the page renders on
        2026-09-08 and this fixture was not updated with it, so
        `describeReportArtifactStatus` — `outputs.report.state` — threw
        "Cannot read properties of undefined (reading 'report')" on every one of
        this file's 39 cases. It went unseen because `test:render` was invoked
        by no workflow and no aggregate script: 1,099 render tests that ran only
        when somebody remembered the command.

        Verified pre-existing rather than assumed: the same expression is in
        `_lib.tsx` at 214315a5, the last fully green commit, and this file's
        last change was 2026-09-08.

        The shape below is the server's own (`EvidenceOutputProjection`), for a
        record whose report and package are both generated and downloadable —
        which is what the legacy blocks beside it already say.
      */
      outputs: {
        report: {
          eligibility: "ELIGIBLE",
          ineligibilityReason: null,
          notApplicableReason: null,
          generation: "SUCCEEDED",
          terminalReasonClass: null,
          terminalReasonCode: null,
          attemptCount: 1,
          requestedAtUtc: iso("2026-07-04T05:23:00Z"),
          completedAtUtc: iso("2026-07-04T05:23:22Z"),
          availability: "AVAILABLE",
          state: "READY",
          action: "NONE",
          actionUnavailableReason: "NOT_REQUIRED",
          operation: null,
          version: 2,
          latestAvailableVersion: 2,
        },
        verificationPackage: {
          eligibility: "ELIGIBLE",
          ineligibilityReason: null,
          notApplicableReason: null,
          generation: "SUCCEEDED",
          terminalReasonClass: null,
          terminalReasonCode: null,
          attemptCount: 1,
          requestedAtUtc: iso("2026-07-04T05:23:00Z"),
          completedAtUtc: iso("2026-07-04T05:23:22Z"),
          availability: "AVAILABLE",
          state: "READY",
          action: "NONE",
          actionUnavailableReason: "NOT_REQUIRED",
          operation: null,
          version: 2,
          latestAvailableVersion: 2,
        },
        newVersion: {
          action: "NONE",
          reason: "PERMISSION_DENIED",
          currentVersion: 2,
          nextVersion: 3,
          estimate: null,
        },
        pollIntervalMs: null,
      },
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
      trustDecision: {
      verdict: "VERIFIED",
      level: "standard",
      tone: "success",
      presentationState: "VERIFIED_PENDING_ANCHORING",
      presentationTone: "success",
      anchoringState: "PENDING",
      score: 80,
      maxScore: 100,
      scoreLabel: "80 / 100",
      verdictLabel: "Recorded integrity verified",
      shortLabel: "Verified",
      title: "Recorded integrity verified",
      confidenceLabel: "High",
      anchoringStatusLabel: "Anchoring pending",
      summary:
        "Every deterministic preservation signal this record carries was recorded and re-verified.",
      primaryReason: "Canonical fingerprint recomputed and matched the recorded hash.",
      reviewerAction: "No reviewer action is required for the preservation record.",
      degradedButUsable: false,
      relianceLevel: "high",
      passedSignals: 5,
      degradedSignals: 2,
      failedSignals: 0,
      signals: [
        {
          key: "core_integrity",
          label: "Core integrity",
          status: "passed",
          tone: "success",
          points: 25,
          maxPoints: 25,
          summary: "Core integrity was evaluated from the recorded preservation state.",
          detail:
            "Derived from the material recorded at preservation time. This is a deterministic observation, not a judgement about the content.",
        },
        {
          key: "signature",
          label: "Digital signature",
          status: "passed",
          tone: "success",
          points: 15,
          maxPoints: 15,
          summary: "Digital signature was evaluated from the recorded preservation state.",
          detail:
            "Derived from the material recorded at preservation time. This is a deterministic observation, not a judgement about the content.",
        },
        {
          key: "trusted_timestamp",
          label: "Trusted timestamp",
          status: "passed",
          tone: "success",
          points: 15,
          maxPoints: 15,
          summary: "Trusted timestamp was evaluated from the recorded preservation state.",
          detail:
            "Derived from the material recorded at preservation time. This is a deterministic observation, not a judgement about the content.",
        },
        {
          key: "bitcoin_anchoring",
          label: "Bitcoin anchoring",
          status: "pending",
          tone: "warning",
          points: 0,
          maxPoints: 10,
          summary: "Bitcoin anchoring was evaluated from the recorded preservation state.",
          detail:
            "Derived from the material recorded at preservation time. This is a deterministic observation, not a judgement about the content.",
        },
        {
          key: "immutable_storage",
          label: "Immutable storage",
          status: "passed",
          tone: "success",
          points: 10,
          maxPoints: 10,
          summary: "Immutable storage was evaluated from the recorded preservation state.",
          detail:
            "Derived from the material recorded at preservation time. This is a deterministic observation, not a judgement about the content.",
        },
        {
          key: "custody_chain",
          label: "Custody chain",
          status: "passed",
          tone: "success",
          points: 10,
          maxPoints: 10,
          summary: "Custody chain was evaluated from the recorded preservation state.",
          detail:
            "Derived from the material recorded at preservation time. This is a deterministic observation, not a judgement about the content.",
        },
        {
          key: "identity",
          label: "Submitter identity",
          status: "partial",
          tone: "warning",
          points: 5,
          maxPoints: 10,
          summary: "Submitter identity was evaluated from the recorded preservation state.",
          detail:
            "Derived from the material recorded at preservation time. This is a deterministic observation, not a judgement about the content.",
        },
        {
          key: "verification_package",
          label: "Verification package",
          status: "missing",
          tone: "neutral",
          points: 0,
          maxPoints: 5,
          summary: "Verification package was evaluated from the recorded preservation state.",
          detail:
            "Derived from the material recorded at preservation time. This is a deterministic observation, not a judgement about the content.",
        },
      ],
    },
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
  if (path.includes("/review-workspace")) {
    const w = makeWorkspace() as {
      artifactStatus: { outputs: { report: { action: string } } };
    };
    if (reportActionOverride) w.artifactStatus.outputs.report.action = reportActionOverride;
    if (newVersionActionOverride) {
      (w.artifactStatus.outputs as unknown as { newVersion: { action: string; reason: string | null } }).newVersion = {
        ...(w.artifactStatus.outputs as unknown as { newVersion: object }).newVersion,
        action: newVersionActionOverride,
        reason: null,
      } as { action: string; reason: string | null };
    }
    if (reportStateOverride) {
      (w.artifactStatus.outputs.report as unknown as { state: string }).state = reportStateOverride;
    }
    statusPatch?.(w.artifactStatus as unknown as StatusDoc);
    return w;
  }
  if (path.endsWith("/artifacts/status")) {
    const status = (makeWorkspace() as { artifactStatus: StatusDoc }).artifactStatus;
    statusPatch?.(status);
    return status;
  }
  if (path.startsWith("/v1/cases?")) return { items: [] };
  if (path.includes("/reviewer-workflow/events")) return { items: [] };
  // ADM-P1-003 / OWN-1 — the shell reads the tenant-safe status enum.
  if (path.includes("/v1/runtime/status")) {
    if (runtimeBody instanceof Error) throw runtimeBody;
    return runtimeBody;
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
if (path.includes("/technical-metadata")) {
    return { technicalMetadata: { perParts: [

      {
        partIndex: 0,
        filename: "fire-scene-video-001.mp4",
        role: "Lead",
        mappingLabel: "Recorded as part 1 of the submitted bundle.",
        mimeType: "video/mp4",
        sizeBytes: 140000,
        width: 4032,
        height: 3024,
        durationMs: 18400,
        pageCount: null,
        codec: "h264",
        container: "mp4",
        metadataStatusLabel: "Not recorded",
        sha256: "0101010101010101010101010101010101010101010101010101010101010101",
      },
      {
        partIndex: 1,
        filename: "fire-scene-image-002.jpg",
        role: "Supporting",
        mappingLabel: "Recorded as part 2 of the submitted bundle.",
        mimeType: "image/jpeg",
        sizeBytes: 149137,
        width: 4032,
        height: 3024,
        durationMs: null,
        pageCount: null,
        codec: null,
        container: null,
        metadataStatusLabel: "Recorded",
        sha256: "0202020202020202020202020202020202020202020202020202020202020202",
      },
      {
        partIndex: 2,
        filename: "fire-scene-pdf-003.pdf",
        role: "Supporting",
        mappingLabel: "Recorded as part 3 of the submitted bundle.",
        mimeType: "application/pdf",
        sizeBytes: 158274,
        width: null,
        height: null,
        durationMs: null,
        pageCount: 5,
        codec: null,
        container: null,
        metadataStatusLabel: "Recorded",
        sha256: "0303030303030303030303030303030303030303030303030303030303030303",
      },
      {
        partIndex: 3,
        filename: "fire-scene-video-004.mp4",
        role: "Supporting",
        mappingLabel: "Recorded as part 4 of the submitted bundle.",
        mimeType: "video/mp4",
        sizeBytes: 167411,
        width: 4032,
        height: 3024,
        durationMs: 18790,
        pageCount: null,
        codec: "h264",
        container: "mp4",
        metadataStatusLabel: "Recorded",
        sha256: "0404040404040404040404040404040404040404040404040404040404040404",
      },
      {
        partIndex: 4,
        filename: "scene-north-elevation-post-suppression-overview-with-very-long-descriptive-filename-and-no-spaces-000004.jpg",
        role: "Supporting",
        mappingLabel: "Recorded as part 5 of the submitted bundle.",
        mimeType: "image/jpeg",
        sizeBytes: 176548,
        width: 4032,
        height: 3024,
        durationMs: null,
        pageCount: null,
        codec: null,
        container: null,
        metadataStatusLabel: "Recorded",
        sha256: "0505050505050505050505050505050505050505050505050505050505050505",
      },
      {
        partIndex: 5,
        filename: "fire-scene-pdf-006.pdf",
        role: "Supporting",
        mappingLabel: "Recorded as part 6 of the submitted bundle.",
        mimeType: "application/pdf",
        sizeBytes: 185685,
        width: null,
        height: null,
        durationMs: null,
        pageCount: 4,
        codec: null,
        container: null,
        metadataStatusLabel: "Not recorded",
        sha256: "0606060606060606060606060606060606060606060606060606060606060606",
      },
      {
        partIndex: 6,
        filename: "fire-scene-video-007.mp4",
        role: "Supporting",
        mappingLabel: "Recorded as part 7 of the submitted bundle.",
        mimeType: "video/mp4",
        sizeBytes: 194822,
        width: 4032,
        height: 3024,
        durationMs: 19180,
        pageCount: null,
        codec: "h264",
        container: "mp4",
        metadataStatusLabel: "Recorded",
        sha256: "0707070707070707070707070707070707070707070707070707070707070707",
      },
      {
        partIndex: 7,
        filename: "fire-scene-image-008.jpg",
        role: "Supporting",
        mappingLabel: "Recorded as part 8 of the submitted bundle.",
        mimeType: "image/jpeg",
        sizeBytes: 203959,
        width: 4032,
        height: 3024,
        durationMs: null,
        pageCount: null,
        codec: null,
        container: null,
        metadataStatusLabel: "Recorded",
        sha256: "0808080808080808080808080808080808080808080808080808080808080808",
      },
      {
        partIndex: 8,
        filename: "fire-scene-pdf-009.pdf",
        role: "Supporting",
        mappingLabel: "Recorded as part 9 of the submitted bundle.",
        mimeType: "application/pdf",
        sizeBytes: 213096,
        width: null,
        height: null,
        durationMs: null,
        pageCount: 3,
        codec: null,
        container: null,
        metadataStatusLabel: "Recorded",
        sha256: "0909090909090909090909090909090909090909090909090909090909090909",
      },
      {
        partIndex: 9,
        filename: "fire-scene-video-010.mp4",
        role: "Supporting",
        mappingLabel: "Recorded as part 10 of the submitted bundle.",
        mimeType: "video/mp4",
        sizeBytes: 222233,
        width: 4032,
        height: 3024,
        durationMs: 19570,
        pageCount: null,
        codec: "h264",
        container: "mp4",
        metadataStatusLabel: "Recorded",
        sha256: "0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a",
      },
      {
        partIndex: 10,
        filename: "fire-scene-image-011.jpg",
        role: "Supporting",
        mappingLabel: "Recorded as part 11 of the submitted bundle.",
        mimeType: "image/jpeg",
        sizeBytes: 231370,
        width: 4032,
        height: 3024,
        durationMs: null,
        pageCount: null,
        codec: null,
        container: null,
        metadataStatusLabel: "Not recorded",
        sha256: "0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b",
      },
      {
        partIndex: 11,
        filename: "fire-scene-pdf-012.pdf",
        role: "Supporting",
        mappingLabel: "Recorded as part 12 of the submitted bundle.",
        mimeType: "application/pdf",
        sizeBytes: 240507,
        width: null,
        height: null,
        durationMs: null,
        pageCount: 6,
        codec: null,
        container: null,
        metadataStatusLabel: "Recorded",
        sha256: "0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c",
      },
      {
        partIndex: 12,
        filename: "fire-scene-video-013.mp4",
        role: "Supporting",
        mappingLabel: "Recorded as part 13 of the submitted bundle.",
        mimeType: "video/mp4",
        sizeBytes: 249644,
        width: 4032,
        height: 3024,
        durationMs: 19960,
        pageCount: null,
        codec: "h264",
        container: "mp4",
        metadataStatusLabel: "Recorded",
        sha256: "0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d",
      },
      {
        partIndex: 13,
        filename: "fire-scene-image-014.jpg",
        role: "Supporting",
        mappingLabel: "Recorded as part 14 of the submitted bundle.",
        mimeType: "image/jpeg",
        sizeBytes: 258781,
        width: 4032,
        height: 3024,
        durationMs: null,
        pageCount: null,
        codec: null,
        container: null,
        metadataStatusLabel: "Recorded",
        sha256: "0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e",
      },
      {
        partIndex: 14,
        filename: "fire-scene-pdf-015.pdf",
        role: "Supporting",
        mappingLabel: "Recorded as part 15 of the submitted bundle.",
        mimeType: "application/pdf",
        sizeBytes: 267918,
        width: null,
        height: null,
        durationMs: null,
        pageCount: 5,
        codec: null,
        container: null,
        metadataStatusLabel: "Recorded",
        sha256: "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f",
      },
      {
        partIndex: 15,
        filename: "fire-scene-video-016.mp4",
        role: "Supporting",
        mappingLabel: "Recorded as part 16 of the submitted bundle.",
        mimeType: "video/mp4",
        sizeBytes: 277055,
        width: 4032,
        height: 3024,
        durationMs: 20350,
        pageCount: null,
        codec: "h264",
        container: "mp4",
        metadataStatusLabel: "Not recorded",
        sha256: "1010101010101010101010101010101010101010101010101010101010101010",
      },
      {
        partIndex: 16,
        filename: "fire-scene-image-017.jpg",
        role: "Supporting",
        mappingLabel: "Recorded as part 17 of the submitted bundle.",
        mimeType: "image/jpeg",
        sizeBytes: 286192,
        width: 4032,
        height: 3024,
        durationMs: null,
        pageCount: null,
        codec: null,
        container: null,
        metadataStatusLabel: "Recorded",
        sha256: "1111111111111111111111111111111111111111111111111111111111111111",
      },
      {
        partIndex: 17,
        filename: "fire-scene-pdf-018.pdf",
        role: "Supporting",
        mappingLabel: "Recorded as part 18 of the submitted bundle.",
        mimeType: "application/pdf",
        sizeBytes: 295329,
        width: null,
        height: null,
        durationMs: null,
        pageCount: 4,
        codec: null,
        container: null,
        metadataStatusLabel: "Recorded",
        sha256: "1212121212121212121212121212121212121212121212121212121212121212",
      },
      {
        partIndex: 18,
        filename: "fire-scene-video-019.mp4",
        role: "Supporting",
        mappingLabel: "Recorded as part 19 of the submitted bundle.",
        mimeType: "video/mp4",
        sizeBytes: 304466,
        width: 4032,
        height: 3024,
        durationMs: 20740,
        pageCount: null,
        codec: "h264",
        container: "mp4",
        metadataStatusLabel: "Recorded",
        sha256: "1313131313131313131313131313131313131313131313131313131313131313",
      },
      {
        partIndex: 19,
        filename: "fire-scene-image-020.jpg",
        role: "Supporting",
        mappingLabel: "Recorded as part 20 of the submitted bundle.",
        mimeType: "image/jpeg",
        sizeBytes: 313603,
        width: 4032,
        height: 3024,
        durationMs: null,
        pageCount: null,
        codec: null,
        container: null,
        metadataStatusLabel: "Recorded",
        sha256: "1414141414141414141414141414141414141414141414141414141414141414",
      },
      {
        partIndex: 20,
        filename: "fire-scene-pdf-021.pdf",
        role: "Supporting",
        mappingLabel: "Recorded as part 21 of the submitted bundle.",
        mimeType: "application/pdf",
        sizeBytes: 322740,
        width: null,
        height: null,
        durationMs: null,
        pageCount: 3,
        codec: null,
        container: null,
        metadataStatusLabel: "Not recorded",
        sha256: "1515151515151515151515151515151515151515151515151515151515151515",
      },
      {
        partIndex: 21,
        filename: "fire-scene-video-022.mp4",
        role: "Supporting",
        mappingLabel: "Recorded as part 22 of the submitted bundle.",
        mimeType: "video/mp4",
        sizeBytes: 331877,
        width: 4032,
        height: 3024,
        durationMs: 21130,
        pageCount: null,
        codec: "h264",
        container: "mp4",
        metadataStatusLabel: "Recorded",
        sha256: "1616161616161616161616161616161616161616161616161616161616161616",
      },
      {
        partIndex: 22,
        filename: "fire-scene-image-023.jpg",
        role: "Supporting",
        mappingLabel: "Recorded as part 23 of the submitted bundle.",
        mimeType: "image/jpeg",
        sizeBytes: 341014,
        width: 4032,
        height: 3024,
        durationMs: null,
        pageCount: null,
        codec: null,
        container: null,
        metadataStatusLabel: "Recorded",
        sha256: "1717171717171717171717171717171717171717171717171717171717171717",
      },
    ] } };
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
  | "team"
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
        planFeatures: { intakeIncluded: true, reviewerOperationsIncluded: true },
      };
    case "team":
      // F-02. TEAM is NOT an enterprise workspace and DOES include reviewer
      // operations (plan-catalog.ts:462) - the case the page used to get
      // wrong, and the one no fixture here covered.
      return {
        ...base,
        ...space("ORGANIZATION", "ws-team", "Harbour Investigations"),
        account: { accountPlan: "TEAM", accountStatus: "active" },
        flags: { isEnterpriseWorkspace: false },
        platform: { isPlatformAdmin: false },
        planFeatures: { intakeIncluded: true, reviewerOperationsIncluded: true },
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

/*
 * The reviewer-ops axis is the ENTITLEMENT, not the workspace tier.
 *
 * These were named ENTERPRISE / NON_ENTERPRISE, which is what the page gated
 * on and is not what the server enforces: reviewer operations are included for
 * TEAM and above (PlanCapabilities.reviewerOperationsIncluded) and
 * reviewer-workspace.routes.ts:430 checks that field. `team` therefore belongs
 * with `enterprise`, and `organization` - whose plan does not include them -
 * belongs with `personal`.
 */
const REVIEWER_OPS_CONTEXTS: ContextKey[] = ["enterprise", "platformAdmin", "team"];
const NO_REVIEWER_OPS_CONTEXTS: ContextKey[] = ["personal", "organization", "legacy"];
const ENTERPRISE_CONTEXTS: ContextKey[] = ["enterprise", "platformAdmin"];
const NON_ENTERPRISE_CONTEXTS: ContextKey[] = ["personal", "organization", "legacy", "team"];
const LOADED_CONTEXTS: ContextKey[] = [...NON_ENTERPRISE_CONTEXTS, ...ENTERPRISE_CONTEXTS];

beforeEach(() => {
  requestLog = [];
  runtimeBody = { status: "HEALTHY" };
  reportActionOverride = null;
  newVersionActionOverride = null;
  reportStateOverride = null;
  statusPatch = null;
  onNewVersionPost = null;
  routeEvidenceId = EVIDENCE_ID;
  resetServiceStatusForTests();
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

  it.each(REVIEWER_OPS_CONTEXTS)("%s reaches the reviewer-ops panels", async (key) => {
    await openReviewTab(key);
    expect(document.querySelector("[data-evidence-review-enterprise-panels]")).not.toBeNull();
  });

  it.each(NO_REVIEWER_OPS_CONTEXTS)("%s does not reach the reviewer-ops panels", async (key) => {
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

// ---------------------------------------------------------------------------
// 8. Service status — the record is not a platform status surface
// ---------------------------------------------------------------------------

describe("service status — Evidence never renders the platform diagnostic panel", () => {
  const caps = (over: Record<string, string> = {}) => ({
    uploads: "HEALTHY",
    artifactGeneration: "HEALTHY",
    downloads: "HEALTHY",
    search: "HEALTHY",
    reviewAutomation: "HEALTHY",
    ...over,
  });
  const VARIANTS: Record<string, unknown> = {
    healthy: { status: "HEALTHY", capabilities: caps(), checkedAt: "2026-09-26T00:00:00Z" },
    "generation degraded": { status: "DEGRADED", capabilities: caps({ artifactGeneration: "DEGRADED" }) },
    "downloads unavailable": { status: "DEGRADED", capabilities: caps({ downloads: "UNAVAILABLE" }) },
    "search degraded only": { status: "DEGRADED", capabilities: caps({ search: "DEGRADED" }) },
    unknown: { status: "UNAVAILABLE", capabilities: caps({ artifactGeneration: "UNKNOWN" }) },
    "legacy server DEGRADED": { status: "DEGRADED" },
    "status read fails": new Error("network"),
  };
  const PANEL = /degraded mode|partial or stale|subsystem\(s\)|Failing subsystems/i;

  async function openArtifacts() {
    const tab = [...document.querySelectorAll("[role='tab']")].find(
      (el) => el.textContent?.trim() === "Artifacts",
    ) as HTMLButtonElement;
    await act(async () => {
      tab.click();
    });
    // Let the shared status store settle (first read is scheduled on idle).
    await act(async () => {
      await new Promise((r) => setTimeout(r, 900));
    });
  }

  it.each(Object.keys(VARIANTS))(
    "%s: no platform panel, no empty subsystem list, no admin link — on the record or its Artifacts",
    async (name) => {
      runtimeBody = VARIANTS[name];
      await mountLoaded("personal");
      await openArtifacts();
      const text = document.body.textContent ?? "";
      expect(text).not.toMatch(PANEL);
      expect(document.querySelector("[data-empty-state-code='runtime_degraded']")).toBeNull();
      const adminLinks = [...document.querySelectorAll("a")]
        .map((a) => a.getAttribute("href") ?? "")
        .filter((h) => h.startsWith("/admin"));
      expect(adminLinks).toEqual([]);
      // A search-only or unmeasured status says nothing on the record at all.
      if (name === "search degraded only" || name === "unknown" || name === "status read fails" || name === "healthy") {
        expect(document.querySelector("[data-service-notice]")).toBeNull();
      }
    },
    15_000,
  );

  it("a generation incident is said beside Create new version, without calling the evidence stale — and the report download stays enabled", async () => {
    newVersionActionOverride = "CREATE_NEW_VERSION";
    runtimeBody = VARIANTS["generation degraded"];
    await mountLoaded("personal");
    await openArtifacts();
    const notice = document.querySelector("[data-service-notice='artifactGeneration']");
    expect(notice?.textContent).toMatch(/generation is delayed/);
    expect(notice?.textContent).not.toMatch(/stale|corrupt|incomplete|partial/i);
    // Beside the control it affects.
    expect(notice?.closest("[data-evidence-section='reports-ready-actions']")).not.toBeNull();
    const report = document.querySelector(
      "[data-evidence-artifact-download='report']",
    ) as HTMLButtonElement | null;
    expect(report).not.toBeNull();
    expect(report!.disabled).toBe(false);
    expect(document.querySelector("[data-service-notice='downloads']")).toBeNull();
  }, 15_000);

  it("a record's own generation failure stays visible beside a service notice — neither hides the other", async () => {
    reportStateOverride = "RETRYABLE_FAILURE";
    reportActionOverride = "RETRY";
    runtimeBody = VARIANTS["generation degraded"];
    await mountLoaded("personal");
    await openArtifacts();
    const failure = document.querySelector("[data-evidence-section='reports-retryable-failure']");
    expect(failure?.textContent).toMatch(/Report generation failed/);
    // The platform notice is beside the Retry control, inside the record's
    // own failure panel — it does not replace or explain away the failure.
    expect(failure?.querySelector("[data-service-notice='artifactGeneration']")).not.toBeNull();
    expect(document.querySelector("[data-evidence-generate-verb='RETRY']")).not.toBeNull();
  }, 15_000);

  it("healthy status: the record's own failure is still shown, with no service notice", async () => {
    reportStateOverride = "RETRYABLE_FAILURE";
    reportActionOverride = "RETRY";
    await mountLoaded("personal");
    await openArtifacts();
    expect(document.querySelector("[data-evidence-section='reports-retryable-failure']")).not.toBeNull();
    expect(document.querySelector("[data-service-notice]")).toBeNull();
  }, 15_000);

  it("a downloads incident is said at the downloads, not over the record", async () => {
    runtimeBody = VARIANTS["downloads unavailable"];
    await mountLoaded("personal");
    await openArtifacts();
    const notice = document.querySelector("[data-service-notice='downloads']");
    expect(notice?.textContent).toMatch(/Downloads are temporarily unavailable/);
    expect(document.querySelector(".evidence-detail-hero [data-service-notice]")).toBeNull();
  }, 15_000);
});

// ---------------------------------------------------------------------------
// Evidence output attention — ONE value across Overview, the tab, the banner
// and Artifacts (2026-10-06)
// ---------------------------------------------------------------------------

describe("evidence output attention — one canonical value across the page", () => {
  const OFFER = {
    revision: "ofr1.test.sig",
    createdAtUtc: "2026-10-06T10:00:00Z",
    expiresAtUtc: "2099-01-01T00:00:00Z",
    operation: "NEW_VERSION",
    targetVersion: 3,
    reasonRequired: true,
    creditEffect: { kind: "NONE" },
    storageEffect: { estimatedBytes: "1000", fitsStorage: true, storageBytesUsed: null, storageBytesLimit: null },
  };
  const TRUST = {
    tsa: { status: "STAMPED", validated: true, validatedAtUtc: "2026-10-06T10:00:00Z", failureCode: null, genTimeUtc: null },
    ots: { status: "ANCHORED", anchorCheck: "PROOF_STRUCTURE", anchoredAtUtc: "2026-10-06T10:05:00Z" },
  };
  const pairOf = (v: number, withPackage = true) => ({
    reportVersion: v,
    generatedAtUtc: "2026-07-04T05:23:22Z",
    sizeBytes: "1000",
    sha256: "c".repeat(64),
    immutableRecorded: true,
    issueKind: v > 1 ? "UPDATED" : null,
    issueReason: null,
    latest: true,
    digestMismatch: false,
    package: withPackage
      ? {
          version: v,
          generatedAtUtc: "2026-07-04T05:23:22Z",
          sizeBytes: "2000",
          sha256: "d".repeat(64),
          embeddedReportSha256: "c".repeat(64),
          sealed: true,
          immutableRecorded: true,
          pairing: "REPORT_VERSION",
        }
      : null,
  });
  const fresh = (newer: boolean) => ({
    reportVersion: 2,
    reportGeneratedAtUtc: "2026-07-04T05:23:22Z",
    hasNewerFacts: newer,
    changes: newer
      ? [
          { code: "TSA_VALIDATED_AFTER_REPORT", atUtc: "2026-10-06T10:00:00Z" },
          { code: "OTS_ANCHORED_AFTER_REPORT", atUtc: "2026-10-06T10:05:00Z" },
        ]
      : [],
  });
  const activeReq = (state: string, progressStage: string | null) => ({
    requestId: "req-attn-1",
    intent: "NEW_VERSION",
    artifactType: "REPORT",
    state,
    stage: null,
    progressStage,
    targetVersion: 3,
    terminalReasonCode: null,
    attemptCount: 1,
    createdAtUtc: "2026-10-06T10:10:00Z",
    updatedAtUtc: "2026-10-06T10:10:05Z",
    completedAtUtc: state === "SUCCEEDED" ? "2026-10-06T10:11:00Z" : null,
    recent: true,
    progress: projectOutputProgress({ state, stage: null, progressStage, artifactType: "REPORT" }),
  });

  const UPDATE_AVAILABLE = (st: StatusDoc) => {
    st.outputs.trust = TRUST;
    st.outputs.freshness = fresh(true);
    st.outputs.offer = OFFER;
    st.outputs.newVersion = { action: "CREATE_NEW_VERSION", reason: null, currentVersion: 2, nextVersion: 3, estimate: null };
    st.outputs.activeRequest = null;
    st.versions = { versions: [pairOf(2)], unpairedPackages: [] };
  };
  const IN_PROGRESS = (st: StatusDoc) => {
    UPDATE_AVAILABLE(st);
    st.outputs.offer = null;
    st.outputs.newVersion = { action: "NONE", reason: "IN_PROGRESS", currentVersion: 2, nextVersion: 3, estimate: null };
    st.outputs.activeRequest = activeReq("PROCESSING", "RENDERING_REPORT");
    st.outputs.pollIntervalMs = 40;
  };
  const CURRENT_V3 = (st: StatusDoc) => {
    st.outputs.trust = TRUST;
    st.outputs.freshness = { ...fresh(false), reportVersion: 3 };
    st.outputs.offer = null;
    st.outputs.newVersion = { action: "NONE", reason: "NOT_REQUIRED", currentVersion: 3, nextVersion: 4, estimate: null };
    st.outputs.report.version = 3;
    st.outputs.report.latestAvailableVersion = 3;
    st.outputs.verificationPackage.version = 3;
    st.outputs.verificationPackage.latestAvailableVersion = 3;
    st.outputs.activeRequest = activeReq("SUCCEEDED", "VERIFYING_PACKAGE");
    st.outputs.pollIntervalMs = null;
    st.report.version = 3;
    st.verificationPackage.version = 3;
    st.versions = { versions: [{ ...pairOf(2), latest: false }, pairOf(3)], unpairedPackages: [] };
  };
  const PACKAGE_MISSING = (st: StatusDoc) => {
    st.outputs.trust = TRUST;
    st.outputs.freshness = fresh(false);
    st.outputs.verificationPackage = {
      ...st.outputs.verificationPackage,
      state: "ELIGIBLE_NOT_GENERATED",
      action: "RECOVER",
      actionUnavailableReason: null,
      operation: "PACKAGE_RECOVERY",
      availability: "NO_ARTIFACT",
      version: null,
      latestAvailableVersion: 1,
    };
    st.verificationPackage = { ...st.verificationPackage, available: false, version: null, generatedAtUtc: null };
    st.versions = { versions: [pairOf(2, false)], unpairedPackages: [] };
  };

  const card = () => document.querySelector("[data-testid='evidence-outputs-card']") as HTMLElement | null;
  const artifactsTab = () => document.querySelector("[data-evidence-tab='artifacts']") as HTMLButtonElement;
  const indicator = () => document.querySelector("[data-testid='artifacts-tab-indicator']");
  const banner = () => document.querySelector("[data-testid='output-attention-banner']");

  /** Overview card, tab name, tab indicator and banner — read from ONE render. */
  function surfaces() {
    return {
      card: card()?.getAttribute("data-output-attention") ?? null,
      tabName: artifactsTab().getAttribute("aria-label"),
      indicator: indicator()?.getAttribute("data-output-attention") ?? null,
      banner: banner()?.getAttribute("data-output-attention") ?? null,
    };
  }

  it("CURRENT: a calm card, no tab indicator, no banner", async () => {
    statusPatch = (st) => {
      st.outputs.trust = TRUST;
      st.outputs.freshness = fresh(false);
      st.versions = { versions: [pairOf(2)], unpairedPackages: [] };
    };
    await mountLoaded("personal");
    expect(surfaces()).toEqual({ card: "CURRENT", tabName: null, indicator: null, banner: null });
    expect(card()!.textContent).toMatch(/All generated outputs reflect the latest verified facts./);
    expect(artifactsTab().textContent?.trim()).toBe("Artifacts");
  }, 15_000);

  it("UPDATE_AVAILABLE: card + tab agree, no banner, and the Artifacts primary action is the same decision", async () => {
    statusPatch = UPDATE_AVAILABLE;
    await mountLoaded("personal");
    expect(surfaces()).toEqual({
      card: "UPDATE_AVAILABLE",
      tabName: "Artifacts — update available",
      indicator: "UPDATE_AVAILABLE",
      banner: null,
    });
    await act(async () => {
      artifactsTab().click();
    });
    const generate = document.querySelector("[data-testid='evidence-new-version']") as HTMLButtonElement;
    expect(generate.getAttribute("data-output-attention")).toBe("UPDATE_AVAILABLE");
    expect(generate.className).toContain("app-primary-action");
    expect(document.querySelector("[data-testid='truth-freshness']")).not.toBeNull();
    // Still the same answer on the tab while Artifacts is open.
    expect(artifactsTab().getAttribute("aria-label")).toBe("Artifacts — update available");
  }, 15_000);

  it("Generate updated report on Overview opens THE dialog; closing returns focus to the card button", async () => {
    statusPatch = UPDATE_AVAILABLE;
    await mountLoaded("personal");
    const trigger = document.querySelector("[data-testid='evidence-outputs-generate']") as HTMLButtonElement;
    await act(async () => {
      trigger.focus();
      trigger.click();
    });
    const dialog = await waitFor(() => {
      const d = document.querySelector("[data-testid='updated-report-dialog']");
      expect(d).not.toBeNull();
      return d as HTMLElement;
    });
    expect(dialog.textContent).toMatch(/Generate report v3/);
    // Only one dialog exists on the page.
    expect(document.querySelectorAll("[data-testid='updated-report-dialog']")).toHaveLength(1);
    await act(async () => {
      fireEvent.keyDown(dialog, { key: "Escape" });
    });
    await waitFor(() => expect(document.querySelector("[data-testid='updated-report-dialog']")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  }, 15_000);

  it("UPDATE_AVAILABLE → IN_PROGRESS → CURRENT, every surface following the durable state", async () => {
    statusPatch = UPDATE_AVAILABLE;
    // The server's state change on Confirm: the durable request now exists.
    onNewVersionPost = () => {
      statusPatch = IN_PROGRESS;
    };
    await mountLoaded("personal");
    await act(async () => {
      (document.querySelector("[data-testid='evidence-outputs-generate']") as HTMLButtonElement).click();
    });
    const reason = await waitFor(() => {
      const r = document.querySelector("[data-testid='updated-report-reason']") as HTMLTextAreaElement | null;
      expect(r).not.toBeNull();
      return r!;
    });
    await act(async () => {
      fireEvent.change(reason, { target: { value: "TSA validated and OTS anchored after v2" } });
    });
    const confirm = document.querySelector("[data-testid='updated-report-confirm']") as HTMLButtonElement;
    await waitFor(() => expect(confirm.disabled).toBe(false));
    await act(async () => {
      confirm.click();
    });
    // The signed revision travelled with the confirmation.
    await waitFor(() => expect(requestLog).toContain(`POST /v1/evidence/${EVIDENCE_ID}/reports/regenerate`));
    await waitFor(() => expect(surfaces().card).toBe("IN_PROGRESS"));
    expect(surfaces()).toEqual({
      card: "IN_PROGRESS",
      tabName: "Artifacts — generation in progress",
      indicator: "IN_PROGRESS",
      banner: null,
    });
    expect(card()!.textContent).toMatch(/Generating report v3/);
    // The worker finishes: the page's own poll carries every surface to CURRENT.
    statusPatch = CURRENT_V3;
    await waitFor(() => expect(surfaces().card).toBe("CURRENT"), { timeout: 5000 });
    expect(surfaces()).toEqual({ card: "CURRENT", tabName: null, indicator: null, banner: null });
    expect(document.querySelector("[data-testid='evidence-outputs-report']")?.textContent).toBe("v3");
  }, 20_000);

  it("View progress opens Artifacts and focuses the durable progress card", async () => {
    statusPatch = IN_PROGRESS;
    await mountLoaded("personal");
    await act(async () => {
      (document.querySelector("[data-testid='evidence-outputs-view-progress']") as HTMLButtonElement).click();
    });
    expect(artifactsTab().getAttribute("aria-selected")).toBe("true");
    const progress = document.querySelector("[data-testid='output-progress']");
    expect(progress).not.toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(progress));
    // The Overview did not render a second progress implementation.
    expect(document.querySelectorAll("[data-testid='output-progress']")).toHaveLength(1);
  }, 15_000);

  it("RECOVERY: card, tab, banner and the Artifacts panel all name the same package recovery; Review lands on it", async () => {
    statusPatch = PACKAGE_MISSING;
    await mountLoaded("personal");
    expect(surfaces()).toEqual({
      card: "RECOVERY_AVAILABLE",
      tabName: "Artifacts — action required",
      indicator: "RECOVERY_AVAILABLE",
      banner: "RECOVERY_AVAILABLE",
    });
    expect(banner()!.textContent).toMatch(/Verification package v2 could not be completed./);
    expect(document.querySelector("[data-testid='evidence-outputs-recover']")?.textContent).toBe("Recover verification package");
    await act(async () => {
      (document.querySelector("[data-testid='output-attention-banner-review']") as HTMLButtonElement).click();
    });
    expect(artifactsTab().getAttribute("aria-selected")).toBe("true");
    const panel = document.querySelector("[data-evidence-section='package-recovery']");
    expect(panel).not.toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(panel));
    // The Artifacts panel offers the very verb the card offered.
    expect(panel!.querySelector("[data-evidence-generate-verb='RECOVER']")?.textContent).toBe("Recover verification package");
    // The banner stays across tabs while the state holds.
    expect(banner()).not.toBeNull();
  }, 15_000);

  it("Recover on the card posts the server's verb through the existing recovery path", async () => {
    statusPatch = PACKAGE_MISSING;
    await mountLoaded("personal");
    await act(async () => {
      (document.querySelector("[data-testid='evidence-outputs-recover']") as HTMLButtonElement).click();
    });
    await waitFor(() => expect(requestLog).toContain(`POST /v1/evidence/${EVIDENCE_ID}/reports/regenerate`));
  }, 15_000);

  it("a status for another record is never painted on this one", async () => {
    // The route shows a different record than the one the responses describe
    // (a late answer for the previous evidence).
    routeEvidenceId = "ev-convergence-OTHER";
    statusPatch = PACKAGE_MISSING;
    await mountLoaded("personal");
    expect(surfaces()).toEqual({ card: null, tabName: null, indicator: null, banner: null });
  }, 15_000);
});
