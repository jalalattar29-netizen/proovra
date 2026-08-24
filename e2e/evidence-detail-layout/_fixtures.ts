/**
 * The server, as Evidence Detail sees it — by route interception.
 *
 * WHY NOT A REAL STACK
 * ---------------------------------------------------------------------------
 * What this project measures is GEOMETRY and COMPUTED STYLE: whether a section
 * heading and its description occupy separate rows, whether they share a
 * logical start edge, and whether either clips or overflows at six widths in
 * two directions. None of that is a property of the database; all of it is a
 * property of the real production bundle, the real stylesheet order and a real
 * layout engine.
 *
 * So the API is intercepted and the WEB TIER is real. The record below is the
 * same contract-shaped projection the jsdom convergence suite drives the route
 * with, so a shape that would crash a consumer cannot silently pass here as an
 * empty section.
 */

import type { Page } from "@playwright/test";

import {
  AUTHORITY_SCHEMA_VERSION,
  CAPABILITY_SCHEMA_VERSION,
  NAVIGATION_SCHEMA_VERSION,
} from "../../apps/web/lib/platform-context/types";

export const EVIDENCE_ID = "ev-convergence-1";
export const WORKSPACE_ID = "55555555-5555-4555-8555-555555555555";

export type EvidenceContext = "personal" | "organization" | "enterprise";

export function envelopeFor(context: EvidenceContext): Record<string, unknown> {
  const enterprise = context === "enterprise";
  const type = context === "personal" ? "PERSONAL" : "ORGANIZATION";
  const displayName = context === "personal" ? "Personal Space" : "Meridian Legal";
  return {
    authoritySchemaVersion: AUTHORITY_SCHEMA_VERSION,
    capabilitySchemaVersion: CAPABILITY_SCHEMA_VERSION,
    navigationSchemaVersion: NAVIGATION_SCHEMA_VERSION,
    capabilities: {
      EVIDENCE_VIEW: true,
      EVIDENCE_MANAGE: true,
      REPORTS_VIEW: true,
    },
    diagnostics: { requestId: `evidence-layout-${context}` },
    workspace: {
      id: WORKSPACE_ID,
      name: displayName,
      status: "active",
      scope: type,
    },
    activeSpace: { type, id: WORKSPACE_ID, displayName, roleLabel: "Owner" },
    contextOptions: {
      personalSpace: null,
      ownedWorkspaces: [],
      organizations: [],
      activeContext: {
        workspaceId: WORKSPACE_ID,
        kind: type,
        organizationId: null,
        displayName,
      },
    },
    account: {
      accountPlan: enterprise ? "ENTERPRISE" : "PRO",
      accountStatus: "active",
    },
    flags: { isEnterpriseWorkspace: enterprise },
    platform: { isPlatformAdmin: false },
    planFeatures: { intakeIncluded: true, reportsIncluded: true },
    user: { id: "user-1", email: "reviewer@example.invalid", name: "Reviewer" },
  };
}

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
/** Intercept every API call the route and its children make. */
/**
 * A per-test override of the fixture's Evidence record.
 *
 * EVIDENCE LIFECYCLE CONVERGENCE (2026-08-24) — Evidence Detail's lifecycle
 * section renders four mutually exclusive shapes (ACTIVE / ARCHIVED / TRASHED /
 * DESTROYED), and which one appears is decided ENTIRELY by the server's
 * canonical `lifecycle` projection. Which is exactly why the browser gate needs
 * to drive it: source inspection proves the component reads the projection, and
 * only a real engine proves that each projection paints the right controls and
 * the right retention copy.
 */
export type EvidenceOverride = Record<string, unknown>;

export async function installApi(
  page: Page,
  context: EvidenceContext,
  evidenceOverride?: EvidenceOverride,
): Promise<void> {
  const envelope = envelopeFor(context);
  await page.route("**/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname + url.search;
    const json = (body: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(body),
      });

    if (url.pathname.endsWith("/v1/platform/context")) return json(envelope);
    if (
      url.pathname.endsWith("/v1/auth/me") ||
      url.pathname.endsWith("/v1/users/me")
    ) {
      return json({ id: "user-1", email: "reviewer@example.invalid" });
    }
    const body = respond(path);
    if (
      evidenceOverride &&
      body &&
      typeof body === "object" &&
      "evidence" in (body as Record<string, unknown>)
    ) {
      const w = body as { evidence: Record<string, unknown> };
      return json({ ...w, evidence: { ...w.evidence, ...evidenceOverride } });
    }
    return json(body);
  });
}

/** Load Evidence Detail on its Technical Appendix tab, settled. */
export async function openTechnicalAppendix(
  page: Page,
  context: EvidenceContext,
): Promise<void> {
  await installApi(page, context);
  await page.goto(`/evidence/${EVIDENCE_ID}?tab=technical`);
  // The appendix self-fetches its own projection, so waiting for the section
  // means the measured tree is the settled one rather than the first paint.
  await page.waitForSelector('[data-evidence-section="technical-appendix"]', {
    timeout: 30_000,
  });
  await page.waitForSelector('[data-testid="evidence-technical-appendix"]', {
    timeout: 30_000,
  });
  await page.waitForFunction(() =>
    Boolean(document.querySelector(".ta-grid")),
  );
}

/** Switch the document to RTL, the way a locale would. */
export async function setDirection(
  page: Page,
  dir: "ltr" | "rtl",
): Promise<void> {
  await page.evaluate((d) => {
    document.documentElement.setAttribute("dir", d);
  }, dir);
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => r(null))),
  );
}

export const VIEWPORTS = [
  { name: "1440", width: 1440, height: 900 },
  { name: "1024", width: 1024, height: 800 },
  { name: "768", width: 768, height: 1024 },
  { name: "430", width: 430, height: 932 },
  { name: "390", width: 390, height: 844 },
] as const;

export const DIRECTIONS = ["ltr", "rtl"] as const;
