/* eslint-disable @typescript-eslint/no-explicit-any -- recipes read Prisma delegates of many shapes. */
/**
 * What each route needs that schema and Zod cannot say: the state a row must hold,
 * the second row it links to, the person it is for. Every recipe runs on the control's
 * tenant and again on the victim's and the attacker's, so an attack meets a row in the
 * state the control proved valid.
 *
 * `$Name` is a row or a person of the side making the request. `$Actor` is whoever
 * runs the control on that side. A function is computed per side.
 *
 * `unreachable` names a route no local control can answer, and why. Those stay
 * unproven in the results; only real refusals are recorded for them.
 */
import { createHash, randomUUID } from "node:crypto";

import { REQUIRED_RECIPES } from "./write-sweep-token-hints.js";
import type { RouteHint, RowSet } from "./write-sweep-engine.js";

const uniq = () => randomUUID().slice(0, 12);
const hex64 = () => createHash("sha256").update(randomUUID()).digest("hex");
const hashed = (raw: string) => createHash("sha256").update(raw).digest("hex");
const days = (n: number) => new Date(Date.now() + n * 86_400_000);
const iso = (n: number) => days(n).toISOString();

/** A raw token on the side, with its stored hash. */
const rawToken = (name: string) => (s: RowSet) => {
  const raw = `sweep-${randomUUID()}`;
  s.put(name, raw);
  return hashed(raw);
};

/** A sealed authenticator on the actor, its row readable as `$Factor`. */
async function actorFactor(s: RowSet): Promise<void> {
  await s.factory.tools.enrollTotp(s.actorId);
  const row = await s.prisma.mfaFactor.findFirst({ where: { userId: s.actorId, kind: "TOTP" }, select: { id: true } });
  s.put("Factor", row.id);
}

// -----------------------------------------------------------------------------
// Shared recipes
// -----------------------------------------------------------------------------

/** A workspace OWNER has no reach into a group they do not lead. */
const LEAD: RouteHint = {
  make: { Lead: { model: "CollaborationTeamMember", data: { userId: "$Actor", role: "LEAD", status: "ACTIVE" } } },
  ensure: ["Lead"],
};
const withLead = (hint: RouteHint): RouteHint => ({
  ...hint,
  make: { ...LEAD.make, ...hint.make },
  ensure: [...(LEAD.ensure ?? []), ...(hint.ensure ?? [])],
});

const SIU_PROFILE = { model: "CaseSiuProfile", data: { caseId: "$Case", claimType: "auto", investigationStatus: "intake" } };
const SIU_ITEM = {
  model: "CaseSiuChecklistItem",
  data: { siuProfileId: "$Profile", templateItemId: "item-1", label: "x", acceptedKindsJson: [] },
};
const siu = (hint: RouteHint): RouteHint => ({
  ...hint,
  make: { Profile: SIU_PROFILE, ...hint.make },
  ensure: ["Profile", ...(hint.ensure ?? [])],
});

const CAPTURE = {
  status: "ACTIVE",
  acquisitionMode: "PROOVRA_MOBILE_APP",
  expiresAtUtc: days(1),
};

const REQUEST = {
  requestType: "OTHER",
  title: "sweep request",
  recipientMode: "INTERNAL_USER",
};

const ASSIGNED = { assignedToUserId: "$Actor" };

const VERSION = (data: Record<string, unknown>): RouteHint => ({ rows: { RedactionVersion: data } });

const CRITERIA: RouteHint = {
  make: { CriteriaVersion: { model: "ReviewerCriteriaVersion", data: { criteriaSetId: "$ReviewerCriteriaSet", version: 1, title: "x" } } },
  ensure: ["CriteriaVersion"],
};

const INCIDENT_BY_DECISION = {
  OperationalIncident: {
    scope: "WORKSPACE",
    sourceId: "review.escalation_storm",
    fingerprint: (s: RowSet) => `reviewer:escalation_storm:${s.tenant.teamId}:${uniq()}`,
    category: "REPORT",
    status: "OPEN",
    title: "x",
    safeSummary: "x",
  },
};

const REPORT_INCIDENT = {
  OperationalIncident: {
    scope: "WORKSPACE",
    category: "REPORT",
    sourceId: "pipeline.report_generation_failed",
    fingerprint: async (s: RowSet) => `REPORT:${await s.id("Evidence")}:v1:GENERATION_FAILED`,
    relatedEvidenceId: "$Evidence",
    title: "x",
    safeSummary: "x",
    status: "OPEN",
  },
};

const RELEASE_HOLD = { EvidenceLegalHold: { releaseApprovalRequired: false } };

const CHAIN = {
  fromOrganizationId: "$Organization",
  toOrganizationId: "$Organization",
  toOrganizationSlug: "sweep",
  evidenceIds: [],
};

const CAMPAIGN = (state: string) => ({
  AccessReviewCampaign: { kind: "PERIODIC", state, name: "x", scheduledStartUtc: days(0), scheduledEndUtc: days(1) },
});

const TRUST_OWNER = { klass: "tenant", actor: "owner" } as const;
const IDENTITY_ADMIN = { klass: "tenant", actor: "owner" } as const;

const DESTRUCTION = {
  DestructionRequest: {
    state: "REQUESTED",
    evidenceIds: ["$Evidence"],
    reason: "x",
    requestedByUserId: "$Admin",
    approverUserIds: async (s: RowSet) => [{ userId: s.actorId, approvedAtUtc: null }],
  },
};


/** A workspace the actor owns outright, readable as `$Owned`. */
async function ownedTeam(s: RowSet, extra: Record<string, unknown> = {}): Promise<string> {
  const team = await s.prisma.team.create({
    data: { name: "owned", ownerUserId: s.actorId, organizationId: s.tenant.orgId, workspaceKind: "OWNED", isPersonal: false, ...extra },
    select: { id: true },
  });
  await s.prisma.teamMember.create({ data: { teamId: team.id, userId: s.actorId, role: "OWNER", status: "ACTIVE" } });
  s.put("Owned", team.id);
  return team.id;
}

export const WRITE_SWEEP_HINTS: Record<string, RouteHint> = {
  ...REQUIRED_RECIPES,

  // An empty list passes validation and writes nothing, which would hide a missing guard.
  "POST /v1/redaction/videos/:p/frames/batch": {
    body: { extractor: "OPERATOR_INLINE", frames: [{ frameIndex: 0, timestampMs: 0 }] },
  },
  "POST /v1/lifecycle/destruction/requests": {
    body: {
      teamId: "$Team",
      evidenceIds: ["$EvidenceTrashed"],
      reason: "sweep destruction request",
      requiredApproverUserIds: ["$Approver"],
    },
  },

  // ---------------------------------------------------------------------------
  // Collaboration teams
  // ---------------------------------------------------------------------------
  "PATCH /v1/collaboration-teams/:p": withLead({ body: { description: "renamed" } }),
  "POST /v1/collaboration-teams/:p/unarchive": withLead({}),
  "POST /v1/collaboration-teams/:p/archive": withLead({
    rows: { CollaborationTeam: { name: "sweep group" } },
    body: { confirmName: "sweep group" },
  }),
  "POST /v1/collaboration-teams/:p/members": withLead({ body: { userId: "$User", role: "MEMBER" } }),
  "POST /v1/collaboration-teams/:p/members/bulk": withLead({ body: { userIds: ["$User"] } }),
  "DELETE /v1/collaboration-teams/:p/members/:p": withLead({
    make: { Member: { model: "CollaborationTeamMember", data: { userId: "$User", role: "MEMBER", status: "ACTIVE" } } },
    path: ["$CollaborationTeam", "$Member"],
  }),
  "POST /v1/collaboration-teams/:p/lead-recovery": { body: { userId: "$Owner" } },
  "POST /v1/collaboration-teams/:p/assignments": withLead({ body: { targetType: "CASE", targetId: "$Case" } }),
  "PATCH /v1/collaboration-teams/:p/assignments/:p": withLead({
    rows: {
      CollaborationTeamAssignment: { assignedByUserId: "$Actor", targetType: "CASE", targetId: "$Case", status: "OPEN" },
    },
    body: { priority: "HIGH" },
  }),
  "POST /v1/collaboration-teams/:p/comments": withLead({ body: { targetType: "TEAM", body: "x" } }),
  "PATCH /v1/collaboration-teams/:p/comments/:p": withLead({
    rows: { CollaborationTeamComment: { authorUserId: "$Actor", targetType: "TEAM", body: "x", status: "ACTIVE" } },
    body: { body: "edited" },
  }),
  "DELETE /v1/collaboration-teams/:p/comments/:p": withLead({
    rows: { CollaborationTeamComment: { authorUserId: "$Actor", targetType: "TEAM", body: "x", status: "ACTIVE" } },
  }),
  "POST /v1/collaboration-teams/:p/invites/:p/revoke": withLead({
    rows: {
      CollaborationTeamInvite: { channel: "EMAIL", tokenHash: () => hex64(), expiresAtUtc: days(1), createdByUserId: "$Actor", status: "PENDING" },
    },
  }),
  "POST /v1/collaboration-teams/:p/invites/email": { unreachable: "Retired: always 410." },

  // ---------------------------------------------------------------------------
  // Cases
  // ---------------------------------------------------------------------------
  "POST /v1/cases": { body: { name: "sweep case", teamId: "$Team" } },
  "POST /v1/cases/:p/status": { rows: { Case: { status: "OPEN" } }, body: { toStatus: "INVESTIGATING" } },
  "DELETE /v1/cases/:p/comments/:p": { rows: { CaseComment: { caseId: "$Case", authorUserId: "$Actor", body: "x" } } },
  "POST /v1/cases/:p/comments/:p/resolve": { rows: { CaseComment: { caseId: "$Case", authorUserId: "$Actor", body: "x" } } },
  "DELETE /v1/cases/:p/evidence/:p": {
    make: { Link: { model: "CaseEvidenceLink", data: { caseId: "$Case", evidenceId: "$Evidence", linkedByUserId: "$Actor" } } },
    ensure: ["Link"],
    path: ["$Case", "$Evidence"],
  },
  "DELETE /v1/cases/:p/team-access/:p": {
    make: {
      Grant: { model: "CaseCollaborationTeamAccess", data: { caseId: "$Case", collaborationTeamId: "$CollaborationTeam", grantedByUserId: "$Actor" } },
    },
    ensure: ["Grant"],
    path: ["$Case", "$CollaborationTeam"],
  },
  "DELETE /v1/cases/:p/legacy-evidence-link/:p": { unreachable: "The legacy column is gone; the service always refuses." },

  "POST /v1/cases/:p/siu-profile/checklist/:p/map-evidence": siu({
    make: { Item: SIU_ITEM },
    ensure: ["Item"],
    path: ["$Case", "item-1"],
    body: { evidenceId: "$Evidence" },
  }),
  "POST /v1/cases/:p/siu-profile/checklist/:p/status": siu({
    make: { Item: SIU_ITEM },
    ensure: ["Item"],
    path: ["$Case", "item-1"],
    body: { status: "satisfied" },
  }),
  "POST /v1/cases/:p/siu-profile/indicators": siu({
    body: { code: "DUPLICATE_MEDIA_DETECTED", explanation: "x", severity: "info" },
  }),
  "POST /v1/cases/:p/siu-profile/follow-ups": siu({ body: { checklistItemId: "item-1" } }),
  "POST /v1/cases/:p/siu-profile/follow-ups/:p/status": siu({
    make: { Follow: { model: "CaseSiuFollowUp", data: { siuProfileId: "$Profile", checklistItemId: "item-1" } } },
    path: ["$Case", "$Follow"],
    body: { status: "sent" },
  }),
  "POST /v1/cases/:p/siu-profile/reveal-pii": siu({}),
  "POST /v1/cases/:p/siu-export": siu({
    make: { Link: { model: "CaseEvidenceLink", data: { caseId: "$Case", evidenceId: "$Evidence", linkedByUserId: "$Actor" } } },
    ensure: ["Link"],
    body: { warningExportReason: "control export" },
  }),

  // ---------------------------------------------------------------------------
  // Capture
  // ---------------------------------------------------------------------------
  "POST /v1/capture/devices": {
    body: {
      label: "x",
      deviceModel: "x",
      osVersion: "x",
      appVersion: "x",
      signatureAlgorithm: "Ed25519",
      publicKeyHex: () => hex64(),
      attestationProvider: "NONE",
    },
  },
  "POST /v1/capture/direct-sessions/:p/evidence": { rows: { CaptureSession: CAPTURE }, body: { type: "VIDEO" } },
  "POST /v1/capture/direct-sessions/:p/discard": { rows: { CaptureSession: CAPTURE } },
  "POST /v1/capture/direct-sessions/:p/parts/:p/declaration": {
    rows: { CaptureSession: { ...CAPTURE, finalizedEvidenceId: "$Evidence" }, Evidence: { status: "CREATED" } },
    path: ["$CaptureSession", "0"],
    body: { sha256: () => hex64(), clientReportedSource: "CAMERA" },
  },
  "POST /v1/capture/direct-sessions/:p/complete": {
    rows: { CaptureSession: { ...CAPTURE, status: "BOUND", finalizedEvidenceId: "$Evidence" } },
  },
  "POST /v1/capture/direct-sessions/:p/attestation": {
    rows: {
      Device: { publicKeyHex: () => hex64(), publicKeyFingerprint: () => hex64(), attestationProvider: "APPLE_APP_ATTEST" },
      CaptureSession: {
        ...CAPTURE,
        deviceId: "$Device",
        nonceSha256: (s: RowSet) => {
          const nonce = hex64();
          s.put("Nonce", nonce);
          return hashed(nonce);
        },
      },
    },
    ensure: ["CaptureSession"],
    body: {
      provider: "APPLE_APP_ATTEST",
      rawAssertionBase64: "AAAA",
      nonceHex: "$Nonce",
      assertedAtUtc: () => new Date().toISOString(),
    },
  },
  "POST /v1/capture/direct-sessions/:p/web-complete": { unreachable: "Validates a manifest over stored bytes." },
  "POST /v1/capture/direct-sessions/:p/screen-complete": { unreachable: "Validates a manifest over stored bytes." },
  "POST /v1/capture/direct-sessions/:p/continuous-complete": { unreachable: "Validates a manifest over stored bytes." },

  // ---------------------------------------------------------------------------
  // Evidence requests
  // ---------------------------------------------------------------------------
  "POST /v1/evidence-requests/:p/cancel": { rows: { EvidenceRequest: { ...REQUEST, status: "DRAFT" } }, body: { reviewerNote: "x" } },
  "POST /v1/evidence-requests/:p/close": { rows: { EvidenceRequest: { ...REQUEST, status: "FULFILLED" } }, body: { reviewerNote: "x" } },
  "POST /v1/evidence-requests/:p/needs-more-info": { rows: { EvidenceRequest: { ...REQUEST, status: "UNDER_REVIEW" } }, body: { reviewerNote: "x" } },
  "POST /v1/evidence-requests/:p/send": { rows: { EvidenceRequest: { ...REQUEST, status: "DRAFT", assignedReviewerUserId: "$Actor" } } },
  "POST /v1/evidence-requests/:p/deliverables/:p/waive": { rows: { EvidenceRequest: { ...REQUEST, status: "SENT" } } },
  "POST /v1/evidence-requests/:p/deliveries/:p/retry": {
    rows: {
      EvidenceRequest: { ...REQUEST },
      NotificationDelivery: {
        evidenceRequestId: "$EvidenceRequest",
        eventType: "x",
        channel: "EMAIL",
        provider: "RESEND",
        recipient: "a@test.proovra.local",
        templateKey: "x",
        status: "FAILED",
      },
    },
  },

  // ---------------------------------------------------------------------------
  // Evidence
  // ---------------------------------------------------------------------------
  "POST /v1/evidence/:p/archive-restore": { rows: { Evidence: { lifecycleState: "RETENTION_ARCHIVED" } } },
  "POST /v1/evidence/:p/certifications/attest": {
    make: {
      Cert: {
        model: "EvidenceCertification",
        data: { evidenceId: "$Evidence", declarationType: "CUSTODIAN", status: "REQUESTED", version: 1, statementMarkdown: "x" },
      },
    },
    ensure: ["Cert"],
    body: {
      declarationType: "CUSTODIAN",
      attestorName: "x",
      attestorTitle: "x",
      attestorEmail: "a@test.proovra.local",
      statementMarkdown: "x",
      signatureText: "x",
    },
  },
  "POST /v1/evidence/:p/certifications/revoke": {
    make: { Cert: { model: "EvidenceCertification", data: { evidenceId: "$Evidence", declarationType: "CUSTODIAN", status: "ATTESTED", version: 1 } } },
    ensure: ["Cert"],
    body: { declarationType: "CUSTODIAN", reason: "sweep reason" },
  },
  "POST /v1/evidence/:p/derived-assets/run": {
    make: { Part: { model: "EvidencePart", data: { evidenceId: "$Evidence", partIndex: 0, storageBucket: "b", storageKey: "k" } } },
    body: { teamId: "$Team", evidencePartId: "$Part", assetKind: "image_thumbnail" },
  },
  "POST /v1/evidence/:p/media-intelligence/run": { unreachable: "Needs the media pipeline running." },
  "POST /v1/evidence/claim": {
    body: {
      guestToken: async () => {
        const { signJwt } = await import("../../src/services/jwt.js");
        return signJwt(
          { sub: randomUUID(), provider: "GUEST" } as never,
          process.env.AUTH_JWT_SECRET as string,
          3600,
        );
      },
    },
  },
  "POST /v1/intelligence/evidence/:p/run/bytes": { unreachable: "Every byte operation calls a live provider; the local one takes text." },
  "POST /v1/evidence/:p/combined-recording/prepare": { unreachable: "Needs a stored multi-part screen recording." },
  "POST /v1/capture/direct-sessions/:p/parts/:p/loss": { unreachable: "Needs a live continuous capture with a declared segment." },
  "POST /v1/evidence/:p/parts": { rows: { Evidence: { status: "CREATED", lockedAt: null } }, body: { partIndex: 0 } },
  "POST /v1/evidence/:p/relationships": {
    make: { Other: { model: "Evidence" } },
    body: { targetEvidenceId: "$Other", relationshipType: "RELATED" },
  },
  "POST /v1/evidence/:p/unlock": { rows: { Evidence: { lockedAt: new Date() } } },
  "POST /v1/evidence/:p/verify-links/:p/renew": {
    rows: {
      VerificationShareToken: { evidenceId: "$Evidence", tokenHash: () => hex64(), purpose: "OWNER_SHARE", revokedAtUtc: null },
    },
  },
  "POST /v1/evidence/:p/verify-links/legacy/revoke": { rows: { Evidence: { legacyVerifyUuidUntilUtc: days(1) } } },
  "POST /v1/evidence/bulk": { body: { action: "ADD_TO_CASE", evidenceIds: ["$Evidence"], caseId: "$Case" } },
  "PUT /v1/evidence/:p/verification-disclosure": {
    body: { mode: "VERIFICATION_ONLY", showRecordedLocation: false, expectedVersion: 0 },
  },

  // ---------------------------------------------------------------------------
  // Graph, search, intelligence
  // ---------------------------------------------------------------------------
  "POST /v1/graph/relationships/manual": {
    make: {
      Other: { model: "Evidence" },
      NodeA: { model: "InvestigationGraphNode", data: { nodeKind: "EVIDENCE", externalId: "$Evidence" } },
      NodeB: { model: "InvestigationGraphNode", data: { nodeKind: "EVIDENCE", externalId: "$Other" } },
    },
    body: { teamId: "$Team", sourceNodeId: "$NodeA", targetNodeId: "$NodeB", edgeType: "MANUALLY_LINKED_TO" },
  },
  "POST /v1/search/relationships": {
    make: { Other: { model: "Evidence" } },
    body: { teamId: "$Team", sourceEvidenceId: "$Evidence", targetEvidenceId: "$Other", relationshipType: "RELATED" },
  },
  "POST /v1/intelligence/corrections": {
    make: {
      Rec: {
        model: "MediaIntelligenceRecord",
        data: { evidenceId: "$Evidence", modality: "x", kind: "x", provider: "x", providerRecordKey: () => uniq() },
      },
    },
    body: { recordId: "$Rec", kind: "OCR_TEXT", patch: {} },
  },
  "POST /v1/intelligence/evidence/:p/run/text": {
    make: {
      Policy: { model: "WorkspaceAiPolicy", data: { contentIntelligenceEnabled: true, rawContentProcessingAllowed: true } },
    },
    ensure: ["Policy"],
    body: { provider: "LOCAL_ENTITY_EXTRACTION", operation: "EXTRACT_ENTITIES", text: "x" },
  },
  "POST /v1/ai/qc/samples/:p/decision": {
    make: {
      Run: {
        model: "AiCopilotRun",
        data: {
          userId: "$Actor",
          feature: "x",
          requestId: () => randomUUID(),
          provider: "x",
          model: "x",
          promptVersion: "1",
          systemPolicyVersion: "1",
          productKnowledgeVersion: "1",
          contextSchemaVersion: "1",
          outputSchemaVersion: "1",
          workspacePolicyVersion: 1,
          processingMode: "METADATA_ONLY",
          selectedObjectVersionsJson: {},
          status: "COMPLETED",
        },
      },
    },
    path: ["$Run"],
    body: { decision: "QC_ACCEPTED" },
  },
  "POST /v1/ai/evidence/:p/copilot": {
    make: {
      Policy: { model: "WorkspaceAiPolicy", data: { caseCopilotEnabled: true, reviewerCopilotEnabled: true, contentIntelligenceEnabled: true } },
    },
    ensure: ["Policy"],
    setup: async (s) => {
      const { loadEvidenceAnalysisSnapshots } = (await import("../../src/services/ai/evidence-analysis-snapshot.service.js")) as any;
      const id = await s.id("Evidence");
      const snapshots = await loadEvidenceAnalysisSnapshots({
        ids: [id],
        teamId: s.tenant.teamId,
        scope: { scope: "evidence", scopeId: null },
        viewerUserId: s.actorId,
      });
      s.put("Revision", String(snapshots?.[0]?.revision ?? snapshots?.get?.(id)?.revision ?? "unknown"));
    },
    body: { evidenceRevision: "$Revision" },
  },
  "POST /v1/ai/reviewer/:p/copilot": { path: ["$EvidenceReviewWorkflow"], unreachable: "Needs a revision set read through the copilot's own snapshot." },
  "POST /v1/ai/case/:p/copilot": { unreachable: "Needs a revision set read through the copilot's own snapshot." },
  "POST /v1/ai/chat": { unreachable: "Needs a live AI provider configured." },
  "POST /v1/ai/capture/analyze-session": { unreachable: "Needs a live AI provider configured." },

  // ---------------------------------------------------------------------------
  // Redaction
  // ---------------------------------------------------------------------------
  "POST /v1/redaction/derivatives/:p/quarantine": {
    rows: { RedactionDerivative: { versionId: "$RedactionVersion", kind: "IMAGE" } },
    body: { reason: "sweep reason" },
  },
  "POST /v1/redaction/policies/:p/assignments": {
    make: {
      PolicyVersion: { model: "RedactionPolicyVersion", data: { policyId: "$RedactionPolicy", versionOrdinal: 1, state: "PUBLISHED" } },
    },
    body: { policyVersionId: "$PolicyVersion", scope: "GLOBAL" },
  },
  "POST /v1/redaction/versions/:p/approve": {
    ...VERSION({ state: "IN_REVIEW", authoredByUserId: "$Admin" }),
    body: { verdict: "APPROVE" },
  },
  "POST /v1/redaction/versions/:p/derivative": VERSION({ state: "APPROVED" }),
  "POST /v1/redaction/versions/:p/publish": {
    rows: {
      RedactionVersion: { state: "APPROVED" },
      RedactionDerivative: { versionId: "$RedactionVersion", kind: "IMAGE", state: "READY" },
    },
    ensure: ["RedactionDerivative"],
  },
  "POST /v1/redaction/versions/:p/regions": {
    body: { kind: "BBOX_NORMALIZED", method: "BLUR", geometry: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } },
  },
  "POST /v1/redaction/video-tracks/:p/split": {
    rows: { VideoTrack: { evidenceId: "$Evidence", kind: "FACE", startFrame: 0, endFrame: 10 } },
    body: { splitAfterFrame: 5 },
  },
  "POST /v1/redaction/video-tracks/merge": {
    make: {
      TrackA: { model: "VideoTrack", data: { evidenceId: "$Evidence", kind: "FACE", startFrame: 0, endFrame: 10 } },
      TrackB: { model: "VideoTrack", data: { evidenceId: "$Evidence", kind: "FACE", startFrame: 11, endFrame: 20 } },
    },
    body: { trackIds: ["$TrackA", "$TrackB"] },
  },

  // ---------------------------------------------------------------------------
  // Reliability and uploads
  // ---------------------------------------------------------------------------
  "POST /v1/reliability/upload-sessions/:p/mark-abandoned": {
    make: { Upload: { model: "UploadSession", data: { evidenceId: "$Evidence", status: "CREATED" } } },
    ensure: ["Upload"],
    path: ["$Evidence"],
    body: { teamId: "$Team" },
  },
  "POST /v1/reliability/upload-sessions/:p/request-review": {
    make: { Upload: { model: "UploadSession", data: { evidenceId: "$Evidence", status: "CREATED" } } },
    ensure: ["Upload"],
    path: ["$Evidence"],
    body: { teamId: "$Team" },
  },
  "POST /v1/uploads/sessions": { rows: { Evidence: { status: "CREATED" } }, body: { teamId: "$Team", evidenceId: "$Evidence", expectedPartCount: 1 } },
  "POST /v1/uploads/sessions/:p/abort": {
    rows: { EvidenceUploadSession: { evidenceId: "$Evidence", actorUserId: "$Actor", expectedPartCount: 1, multipartUploadId: null } },
    body: { teamId: "$Team", reason: "sweep reason" },
  },
  "POST /v1/uploads/sessions/:p/parts/:p/presign": {
    rows: {
      EvidenceUploadSession: {
        evidenceId: "$Evidence",
        actorUserId: "$Actor",
        expectedPartCount: 1,
        state: "UPLOADING",
        multipartUploadId: () => randomUUID(),
        storageBucket: "b",
        storageKey: "k",
      },
    },
    path: ["$EvidenceUploadSession", "0"],
    body: { teamId: "$Team" },
  },
  "POST /v1/uploads/sessions/:p/parts/:p/uploaded": {
    rows: {
      EvidenceUploadSession: {
        evidenceId: "$Evidence",
        actorUserId: "$Actor",
        expectedPartCount: 1,
        state: "UPLOADING",
        multipartUploadId: () => randomUUID(),
        storageBucket: "b",
        storageKey: "k",
      },
    },
    make: { SessionPart: { model: "EvidenceUploadSessionPart", data: { sessionId: "$EvidenceUploadSession", partIndex: 0 } } },
    ensure: ["SessionPart"],
    path: ["$EvidenceUploadSession", "0"],
    body: { teamId: "$Team" },
  },
  "POST /v1/uploads/sessions/:p/multipart/complete": { unreachable: "Runs a real multipart complete and HEAD at the object store." },

  // ---------------------------------------------------------------------------
  // Review
  // ---------------------------------------------------------------------------
  "POST /v1/review-operations/bulk": {
    ensure: ["EvidenceReviewWorkflow"],
    body: { teamId: "$Team", evidenceIds: ["$Evidence"], action: "ASSIGN", assignedToUserId: "$Actor" },
  },
  "POST /v1/review-operations/evidence/:p/claim": { ensure: ["EvidenceReviewWorkflow"], body: { teamId: "$Team" } },
  "POST /v1/review-operations/evidence/:p/decision": {
    rows: { EvidenceReviewWorkflow: { status: "IN_REVIEW", ...ASSIGNED } },
    ensure: ["EvidenceReviewWorkflow"],
    body: { decision: "APPROVE_INTERNAL", note: "sweep note" },
  },
  "POST /v1/reviewer-ops/reviews/:p/start": {
    rows: { EvidenceReviewWorkflow: { status: "ASSIGNED", ...ASSIGNED } },
    body: { teamId: "$Team" },
  },
  "POST /v1/reviewer-ops/reviews/:p/approve": {
    rows: { EvidenceReviewWorkflow: { status: "IN_REVIEW", ...ASSIGNED } },
    body: { teamId: "$Team" },
  },
  "POST /v1/reviewer-ops/reviews/:p/reject": {
    rows: { EvidenceReviewWorkflow: { status: "IN_REVIEW", ...ASSIGNED } },
    body: { teamId: "$Team", note: "sweep note" },
  },
  "POST /v1/reviewer-ops/reviews/:p/request-info": {
    rows: { EvidenceReviewWorkflow: { status: "IN_REVIEW", ...ASSIGNED } },
    body: { teamId: "$Team", note: "sweep note" },
  },
  "POST /v1/reviewer-ops/reviews/:p/resume": {
    rows: { EvidenceReviewWorkflow: { status: "IN_REVIEW", slaPausedAtUtc: new Date(), ...ASSIGNED } },
    body: { teamId: "$Team" },
  },
  "POST /v1/reviewer-ops/reviews/bulk": {
    body: { teamId: "$Team", workflowIds: ["$EvidenceReviewWorkflow"], action: "ASSIGN", assignedToUserId: "$Actor" },
  },
  "DELETE /v1/reviewer-ops/saved-views/:p": {
    rows: { SavedSearchView: { createdByUserId: "$Actor", name: () => uniq(), scope: "REVIEWER_OPS", queryJson: {} } },
    query: { teamId: "$Team" },
  },
  "PATCH /v1/reviewer-criteria/:p/draft": {
    ...CRITERIA,
    body: {
      teamId: "$Team",
      criteria: [{ key: "k", title: "x", description: "x", weight: 1 }],
    },
  },
  "POST /v1/reviewer-criteria/:p/publish": { ...CRITERIA, body: { teamId: "$Team" } },
  "POST /v1/reviewer-criteria/:p/duplicate": {
    make: {
      CriteriaVersion: {
        model: "ReviewerCriteriaVersion",
        data: { criteriaSetId: "$ReviewerCriteriaSet", version: 1, title: "x", publishedAt: new Date() },
      },
    },
    ensure: ["CriteriaVersion"],
    body: { teamId: "$Team" },
  },
  "POST /v1/coding/schemas": {
    body: {
      slug: () => `sweep-${uniq()}`,
      label: "x",
      category: "GENERAL_EVIDENCE",
      fields: [{ slug: "f-1", label: "x", fieldType: "TEXT", required: false, orderIndex: 0 }],
    },
  },
  "POST /v1/reviewer/work/:p/bind-schema": {
    rows: { CodingSchema: { name: "x", slug: () => `s-${uniq()}`, status: "PUBLISHED" } },
    body: { schemaId: "$CodingSchema" },
  },
  "POST /v1/reviewer/work/:p/code": {
    rows: {
      CodingSchema: { name: "x", slug: () => `s-${uniq()}`, status: "PUBLISHED" },
      EvidenceReviewWorkflow: { codingSchemaId: "$CodingSchema", status: "IN_REVIEW", ...ASSIGNED },
    },
    make: { Field: { model: "CodingField", data: { schemaId: "$CodingSchema", slug: "f", label: "x", fieldType: "TEXT" } } },
    body: { fieldId: "$Field", value: { text: "x" } },
  },
  "POST /v1/reviewer/work/:p/disagree": {
    make: {
      Decision: {
        model: "WorkflowReviewDecision",
        data: { workflowId: "$EvidenceReviewWorkflow", stage: "FIRST", reviewerUserId: "$Admin", decision: "APPROVE", rationale: "x" },
      },
    },
    body: { originalDecisionId: "$Decision", rationale: "sweep rationale" },
  },
  "POST /v1/reviewer/disagreements/:p/transition": {
    rows: { ReviewerDisagreement: { workflowId: "$EvidenceReviewWorkflow", state: "FILED" } },
    body: { to: "UNDER_SECOND_REVIEW", verdict: "APPROVE" },
  },
  "POST /v1/reviewer/qc/samples/:p/assign": {
    rows: { QcSample: { workflowId: "$EvidenceReviewWorkflow", state: "SAMPLED" } },
    body: { qcReviewerUserId: "$Actor" },
  },
  "POST /v1/reviewer/qc/samples/:p/verdict": {
    rows: { QcSample: { workflowId: "$EvidenceReviewWorkflow", state: "ASSIGNED", qcReviewerUserId: "$Actor" } },
    body: { verdict: "PASS" },
  },

  // ---------------------------------------------------------------------------
  // Teams and workflow
  // ---------------------------------------------------------------------------
  "PATCH /v1/teams/:p/members/:p": {
    rows: {},
    setup: async (s) => {
      await s.prisma.teamMember.updateMany({ where: { teamId: s.tenant.teamId, userId: s.tenant.admin2.id }, data: { role: "MEMBER" } });
      const row = await s.prisma.teamMember.findFirst({ where: { teamId: s.tenant.teamId, userId: s.tenant.admin2.id }, select: { id: true } });
      s.put("Target", row.id);
    },
    path: ["$Team", "$Target"],
    body: { role: "VIEWER" },
  },
  "POST /v1/teams/:p/cases/link": {
    rows: { Case: { teamId: null } },
    body: { caseId: "$Case" },
  },
  "POST /v1/teams/:p/closure": {
    setup: async (s) => void (await ownedTeam(s)),
    path: ["$Owned"],
    body: { confirmation: "close this workspace" },
  },
  "POST /v1/teams/:p/transfer-ownership": {
    setup: async (s) => {
      const id = await ownedTeam(s);
      await s.prisma.teamMember.create({ data: { teamId: id, userId: s.tenant.member.id, role: "ADMIN", status: "ACTIVE" } });
    },
    path: ["$Owned"],
    body: { newOwnerUserId: "$User" },
  },
  "POST /v1/teams/:p/reopen": {
    setup: async (s) => {
      const id = await ownedTeam(s, { closedAtUtc: new Date() });
      await s.prisma.workspaceClosureRequest.create({ data: { teamId: id, requestedByUserId: s.actorId, status: "COMPLETED" } });
    },
    path: ["$Owned"],
  },
  "DELETE /v1/teams/:p/external-grants/:p": {
    setup: async (s) => {
      const person = await s.factory.tools.newPerson();
      const row = await s.prisma.caseAccess.create({ data: { caseId: await s.id("Case"), userId: person.id } });
      s.put("Access", row.id);
    },
    path: ["$Team", "$Access"],
  },
  "DELETE /v1/teams/:p": { unreachable: "Every branch refuses: a workspace closes, it is not deleted." },
  "POST /v1/teams": { unreachable: "Retired: workspaces are not self-service." },
  "POST /v1/orgs": { unreachable: "Retired: organizations are provisioned." },
  "POST /v1/workflow/intake-links": {
    body: {
      teamId: "$Team",
      workflowTemplateSlug: "general-evidence-record",
      intakeMode: "EXTERNAL_ONE_TIME",
      expiresAtUtc: () => iso(1),
    },
  },
  "POST /v1/workflow/intake-links/:p/send": { unreachable: "Needs a real message provider." },
  "POST /v1/workflows/instances/:p/steps/:p/waive": {
    rows: { EvidenceWorkflowInstance: { status: "DRAFT", intakeMode: "x", actorRole: "x" } },
    make: {
      Step: {
        model: "EvidenceWorkflowStepInstance",
        data: { workflowInstanceId: "$EvidenceWorkflowInstance", stepKey: "step-1", title: "x", orderIndex: 0 },
      },
    },
    ensure: ["Step"],
    path: ["$EvidenceWorkflowInstance", "step-1"],
    body: { teamId: "$Team", reason: "sweep reason" },
  },

  // ---------------------------------------------------------------------------
  // Admin identity: the organization's own identity admins, not platform staff
  // ---------------------------------------------------------------------------
  "POST /v1/admin/identity/providers": {
    ...IDENTITY_ADMIN,
    body: {
      teamId: "$Team",
      provider: "GENERIC_OIDC",
      displayName: "Sweep",
      issuerUrl: "https://idp.sweep.test",
      clientId: "sweep-client",
      clientSecret: "sweep-secret-1",
    },
  },
  "POST /v1/admin/identity/providers/:p/transition": {
    ...IDENTITY_ADMIN,
    rows: { SsoConnection: { status: "PENDING" } },
    body: { teamId: "$Team", nextStatus: "ACTIVE" },
  },
  "POST /v1/admin/identity/providers/:p/policy": { ...IDENTITY_ADMIN, body: { teamId: "$Team", restrictToVerifiedDomains: false } },
  "POST /v1/admin/identity/scim/tokens": {
    ...IDENTITY_ADMIN,
    body: { teamId: "$Team", name: "sweep token", scopes: ["users.read"] },
  },
  "POST /v1/admin/identity/scim/tokens/:p/revoke": {
    ...IDENTITY_ADMIN,
    rows: { ScimProvisioningToken: { tokenHash: () => hex64() } },
    body: { teamId: "$Team" },
  },
  "POST /v1/admin/identity/scim/tokens/:p/rotate": {
    ...IDENTITY_ADMIN,
    rows: { ScimProvisioningToken: { tokenHash: () => hex64() } },
    body: { teamId: "$Team" },
  },
  "POST /v1/admin/identity/scim/groups/:p/projections": {
    ...IDENTITY_ADMIN,
    rows: {
      ScimGroup: { displayName: () => uniq(), mappedRole: "MEMBER", status: "ACTIVE" },
      ScimProvisioningToken: { tokenHash: () => hex64() },
    },
    ensure: ["ScimProvisioningToken"],
    body: { teamId: "$Team", workspaceId: "$Team", mappedRole: "ADMIN" },
  },
  "DELETE /v1/admin/identity/scim/groups/projections/:p": {
    ...IDENTITY_ADMIN,
    rows: { ScimGroup: { displayName: () => uniq(), mappedRole: "MEMBER", status: "ACTIVE" } },
    make: {
      Projection: {
        model: "ScimGroupWorkspaceProjection",
        data: { scimGroupId: "$ScimGroup", workspaceId: "$Team", mappedRole: "MEMBER", status: "ACTIVE", createdByUserId: "$Actor" },
      },
    },
    path: ["$Projection"],
    body: { teamId: "$Team" },
  },
  "POST /v1/admin/identity/elevations": {
    ...IDENTITY_ADMIN,
    body: { teamId: "$Team", userId: "$User", permission: "evidence.read", reason: "sweep reason" },
  },
  "POST /v1/admin/identity/sessions/:p/release": {
    klass: "tenant",
    rows: {
      AuthenticatedSession: { userId: "$User", sessionIdHash: () => hex64(), quarantinedAtUtc: new Date() },
    },
    body: { teamId: "$Team" },
  },
  "POST /v1/admin/audit-log": { body: { action: "sweep.manual_entry" } },
  "POST /v1/admin/billing/internal-plan-grants": {
    body: { teamId: "$Team", userId: "$User", plan: "TEAM", reason: "sweep reason", idempotencyKey: () => `sweep-${uniq()}` },
  },
  "POST /v1/admin/billing/internal-plan-grants/revoke": { body: { teamId: "$Team", userId: "$User", reason: "sweep reason" } },
  "POST /v1/admin/incidents/:p/resolve": { rows: INCIDENT_BY_DECISION, body: { note: "sweep note" } },
  "POST /v1/admin/incidents/:p/remediate": { rows: REPORT_INCIDENT, body: { reason: "sweep reason" } },
  "POST /v1/admin/orgs/:p/resume": {
    make: { Target: { model: "Organization", data: { name: "target", status: "SUSPENDED", kind: "CUSTOMER" } } },
    path: ["$Target"],
    body: { teamId: "$Team" },
  },
  "POST /v1/admin/orgs/:p/owner-invite/reissue": {
    make: {
      Target: { model: "Organization", data: { name: "target", status: "ACTIVE", pendingEnterpriseSeats: 5 } },
      TargetContract: { model: "EnterpriseContract", data: { organizationId: "$Target", status: "PENDING_ACTIVATION" } },
    },
    ensure: ["TargetContract"],
    path: ["$Target"],
    body: { teamId: "$Team", ownerEmail: () => `owner-${uniq()}@test.proovra.local` },
  },
  "POST /v1/admin/orgs/:p/terminate/cancel": {
    make: {
      Target: { model: "Organization", data: { name: "target", status: "ACTIVE" } },
      Closure: { model: "OrganizationClosureRequest", data: { organizationId: "$Target", status: "SCHEDULED", reason: "contract_termination:sweep" } },
    },
    ensure: ["Closure"],
    path: ["$Target"],
    body: { teamId: "$Team" },
  },

  // ---------------------------------------------------------------------------
  // Automation and billing
  // ---------------------------------------------------------------------------
  "POST /v1/automation/rules": {
    body: {
      teamId: "$Team",
      name: "Sweep rule",
      triggerType: "EVIDENCE_CREATED",
      actionType: "NOTIFY_USER",
      actionConfigJson: { userId: "$User", template: "sweep" },
    },
  },
  "POST /v1/billing/accounts/:p/:p/checkout-attempts/:p/recheck": {
    rows: {
      BillingCheckoutAttempt: {
        userId: "$Actor",
        product: "EVIDENCE_CREDIT",
        provider: "STRIPE",
        amountCents: 100,
        currency: "USD",
        status: "PENDING",
        checkoutState: "PROVIDER_OUTCOME_UNKNOWN",
        providerResourceId: null,
      },
    },
    path: ["PERSONAL", "$Actor", "$BillingCheckoutAttempt"],
  },
  "POST /v1/billing/accounts/:p/:p/checkout-attempts/:p/abandon": {
    rows: {
      BillingCheckoutAttempt: {
        userId: "$Actor",
        product: "EVIDENCE_CREDIT",
        provider: "STRIPE",
        amountCents: 100,
        currency: "USD",
        status: "PENDING",
        checkoutState: "PROVIDER_OUTCOME_UNKNOWN",
        providerResourceId: null,
      },
    },
    path: ["PERSONAL", "$Actor", "$BillingCheckoutAttempt"],
  },
  "POST /v1/billing/accounts/:p/:p/payments/:p/cancel": {
    rows: {
      Payment: { userId: "$Actor", teamId: null, provider: "STRIPE", providerPaymentId: () => `sweep-${uniq()}`, amountCents: 100, currency: "USD", status: "SUCCEEDED" },
    },
    path: ["PERSONAL", "$Actor", "$Payment"],
  },
  "POST /v1/billing/accounts/:p/:p/payments/:p/abandon": {
    rows: {
      Payment: { userId: "$Actor", teamId: null, provider: "STRIPE", providerPaymentId: () => `sweep-${uniq()}`, amountCents: 100, currency: "USD", status: "SUCCEEDED" },
    },
    path: ["PERSONAL", "$Actor", "$Payment"],
  },
  "POST /v1/billing/accounts/:p/:p/reconcile": { path: ["PERSONAL", "$Actor"] },
  "POST /v1/billing/accounts/:p/:p/retry-storage-cancellation": { path: ["PERSONAL", "$Actor"] },
  "POST /v1/billing/checkout/paypal/returns/canceled": { body: { subscriptionId: "I-SWEEP12345" } },
  "POST /v1/billing/subscription/cancel": {
    make: {
      Sub: {
        model: "Subscription",
        data: { userId: "$Actor", provider: "STRIPE", providerSubId: () => `sub_${uniq()}`, status: "ACTIVE", plan: "PRO", cancelAtPeriodEnd: true, currentPeriodEnd: days(10) },
      },
    },
    ensure: ["Sub"],
  },
  "POST /v1/billing/subscription/resume": {
    make: {
      Sub: {
        model: "Subscription",
        data: { userId: "$Actor", provider: "STRIPE", providerSubId: () => `sub_${uniq()}`, status: "ACTIVE", plan: "PRO", cancelAtPeriodEnd: false, currentPeriodEnd: days(10) },
      },
    },
    ensure: ["Sub"],
  },
  "POST /v1/billing/checkout/stripe": { unreachable: "Needs real Stripe." },
  "POST /v1/billing/checkout/paypal": { unreachable: "Needs real PayPal." },
  "POST /v1/billing/credits/checkout/stripe": { unreachable: "Needs real Stripe." },
  "POST /v1/billing/credits/checkout/paypal": { unreachable: "Needs real PayPal." },
  "POST /v1/billing/storage-addons/checkout/stripe": { unreachable: "Needs real Stripe." },
  "POST /v1/billing/storage-addons/checkout/paypal": { unreachable: "Needs real PayPal." },
  "POST /v1/billing/checkout/paypal/subscriptions/:p/confirm": { unreachable: "Needs a real PayPal read." },
  "POST /v1/billing/credits/checkout/paypal/:p/capture": { unreachable: "Needs a real PayPal capture." },
  "POST /v1/billing/storage-addons/cancel": { unreachable: "Cancels at the provider." },

  // ---------------------------------------------------------------------------
  // Break glass, support access, high security
  // ---------------------------------------------------------------------------
  "POST /v1/break-glass/activate": {
    make: { Emergency: { model: "OrganizationMembership", data: { userId: "$Admin", role: "ORG_ADMIN", status: "ACTIVE" } } },
    ensure: ["Emergency"],
    body: { teamId: "$Team", organizationId: "$Organization", emergencyUserId: "$Admin", reason: "sweep reason long enough" },
  },
  "POST /v1/break-glass/emergency/sessions/revoke": {
    make: {
      Grant: {
        model: "EmergencyAccessGrant",
        data: {
          emergencyUserId: "$Actor",
          grantedRole: "EMERGENCY_OPERATOR",
          reason: "sweep reason",
          status: "ACTIVE",
          requestedByUserId: "$User",
          stepUpProofId: "sweep-proof",
          expiresAtUtc: days(1),
        },
      },
    },
    body: { teamId: "$Team", organizationId: "$Organization", grantId: "$Grant", stepUpProofId: "sweep-proof", reason: "sweep reason long enough" },
  },
  "POST /v1/support-access/enter": {
    make: {
      Grant: {
        model: "SupportAccessGrant",
        data: { supportUserId: "$Actor", reason: "sweep reason", status: "ACTIVE", expiresAtUtc: days(1) },
      },
    },
    body: { teamId: "$Team", grantId: "$Grant" },
  },
  "POST /v1/support-access/revoke": {
    make: {
      Grant: {
        model: "SupportAccessGrant",
        data: { supportUserId: "$Actor", reason: "sweep reason", status: "ACTIVE", expiresAtUtc: days(1) },
      },
    },
    body: { grantId: "$Grant" },
  },
  "POST /v1/support-access/start": {
    body: {
      teamId: "$Team",
      organizationId: "$Organization",
      reason: "sweep reason long enough",
      customerApprovalUnavailableReason: "customer outage",
    },
  },
  "POST /v1/security-policy/high-security/activate": {
    rows: { OrganizationDomain: { verifiedAt: new Date() } },
    make: {
      Grant: {
        model: "EmergencyAccessGrant",
        data: {
          emergencyUserId: "$Admin",
          grantedRole: "EMERGENCY_OPERATOR",
          reason: "sweep reason",
          status: "ACTIVE",
          requestedByUserId: "$User",
          stepUpProofId: "sweep-proof",
          expiresAtUtc: days(1),
        },
      },
    },
    ensure: ["SsoConnection", "OrganizationDomain", "Grant"],
    body: { organizationId: "$Organization" },
  },

  // ---------------------------------------------------------------------------
  // Communications, exchange, external review
  // ---------------------------------------------------------------------------
  "POST /v1/communications/messages/:p/cancel-retry": {
    rows: { CommunicationMessage: { status: "RETRY_SCHEDULED" } },
    body: { teamId: "$Team" },
  },
  "POST /v1/communications/messages/:p/retry": {
    rows: { CommunicationMessage: { status: "FAILED", bodyResendable: true, purpose: "EVIDENCE_REQUEST" } },
    body: { teamId: "$Team" },
  },
  "POST /v1/communications/preferences": {
    body: { teamId: "$Team", target: { kind: "user", userId: "$User" }, smsOptOut: true },
  },
  "POST /v1/communications/verify/start": { body: { teamId: "$Team", channel: "SMS", phone: "+15555550100" } },
  "POST /v1/exchange/chain-transfers": {
    make: { Other: { model: "Organization", data: { name: "recipient", status: "ACTIVE" } } },
    body: { toOrganizationId: "$Other", evidenceIds: ["$Evidence"] },
  },
  "POST /v1/exchange/chain-transfers/:p/complete": {
    rows: { ChainTransfer: { ...CHAIN, evidenceIds: ["$Evidence"], state: "ACCEPTED", initiatedByUserId: "$Actor" } },
    body: { packageId: "$EvidenceExchangePackage" },
  },
  "POST /v1/exchange/chain-transfers/:p/reject": {
    rows: { ChainTransfer: { ...CHAIN, evidenceIds: ["$Evidence"], state: "INITIATED", initiatedByUserId: "$Actor" } },
  },
  "POST /v1/exchange/chain-transfers/:p/accept": {
    rows: { ChainTransfer: { ...CHAIN, evidenceIds: ["$Evidence"], state: "INITIATED", initiatedByUserId: "$Actor" } },
  },
  "POST /v1/exchange/packages/:p/build": {
    rows: { EvidenceExchangePackage: { kind: "EVIDENCE", state: "DRAFT", evidenceIds: ["$Evidence"] } },
  },
  "POST /v1/exchange/packages/:p/sign-url": {
    rows: { EvidenceExchangePackage: { kind: "EVIDENCE", state: "READY", evidenceIds: ["$Evidence"], packageSha256: () => hex64() } },
  },
  "POST /v1/external-review/grants": {
    body: { teamId: "$Team", scopeKind: "EVIDENCE", evidenceId: "$Evidence", reviewerEmail: () => `r-${uniq()}@test.proovra.local` },
  },
  "POST /v1/external-review/invitations": {
    body: {
      reviewerEmail: () => `r-${uniq()}@test.proovra.local`,
      role: "EXTERNAL_VIEWER",
      scope: { kind: "EVIDENCE", evidenceId: "$Evidence" },
      expiresAtUtc: () => iso(1),
    },
  },

  // ---------------------------------------------------------------------------
  // Governance
  // ---------------------------------------------------------------------------
  "POST /v1/governance/access-reviews/campaigns": {
    body: { kind: "PERIODIC", name: "Sweep", scheduledStartUtc: () => iso(0), scheduledEndUtc: () => iso(1), items: [] },
  },
  "POST /v1/governance/access-reviews/campaigns/:p/open": { rows: CAMPAIGN("DRAFT") },
  "POST /v1/governance/access-reviews/campaigns/:p/close": { rows: CAMPAIGN("OPEN") },
  "POST /v1/governance/access-reviews/items/:p/decision": {
    rows: {
      ...CAMPAIGN("OPEN"),
      AccessReviewItem: { campaignId: "$AccessReviewCampaign", subjectUserId: "$Admin", decision: "PENDING", grantRef: "sweep" },
    },
    body: { decision: "APPROVED" },
  },
  "POST /v1/governance/case-legal-holds/:p/release": {
    rows: { EvidenceLegalHold: { scope: "CASE", caseId: "$Case", evidenceId: null, releaseApprovalRequired: false } },
    body: { teamId: "$Team", releaseNote: "sweep release" },
  },
  "POST /v1/governance/legal-holds/:p/release": { rows: RELEASE_HOLD, body: { teamId: "$Team", releaseNote: "sweep release" } },
  "POST /v1/governance/cross-org-review": {
    body: { invitingOrganizationId: "$Organization", invitedOrgSlug: "sweep-org", scope: "sweep scope", subject: { kind: "EVIDENCE", id: "$Evidence" } },
  },
  "POST /v1/governance/cross-org-review/:p/accept": {
    rows: {
      CrossOrgReviewGrant: {
        state: "INVITED",
        scope: { subject: { kind: "EVIDENCE", id: "$Evidence" } },
        invitingOrganizationId: "$Organization",
        invitedOrgSlug: "sweep-org",
      },
    },
    body: { acceptingOrganizationId: "$Organization" },
  },
  "POST /v1/governance/cross-org-review/:p/decline": {
    rows: {
      CrossOrgReviewGrant: {
        state: "INVITED",
        scope: { subject: { kind: "EVIDENCE", id: "$Evidence" } },
        invitingOrganizationId: "$Organization",
        invitedOrgSlug: "sweep-org",
      },
    },
  },
  "POST /v1/governance/policies/:p/assignments": { body: { scope: "ORGANIZATION", scopeTargetId: "$Organization" } },
  "PUT /v1/governance/policy": { body: { expectedVersion: 0 } },

  // ---------------------------------------------------------------------------
  // Identity
  // ---------------------------------------------------------------------------
  "PATCH /v1/identity/capabilities/:p": {
    rows: { MemberCapabilityGrant: { permission: "evidence.read", grantedByUserId: "$Actor" } },
    body: { reason: "sweep reason" },
  },
  "PATCH /v1/identity/delegated-admin/:p": {
    rows: { MemberDelegatedAdminScope: { scopeKind: "REVIEW_ADMIN" } },
    body: { reason: "sweep reason" },
  },
  "POST /v1/identity/contributor-sessions/:p/revoke": {
    make: { Session: { model: "WorkflowIntakeSession", data: { intakeLinkId: "$WorkflowIntakeLink", status: "CREATED", expiresAtUtc: days(1), revokedAtUtc: null } } },
    rows: { WorkflowIntakeLink: { tokenHash: () => hex64() } },
    path: ["$Session"],
  },
  "POST /v1/identity/members/:p/restore": {
    setup: async (s) => {
      await s.prisma.teamMember.updateMany({ where: { teamId: s.tenant.teamId, userId: s.tenant.admin2.id }, data: { status: "SUSPENDED" } });
      const row = await s.prisma.teamMember.findFirst({ where: { teamId: s.tenant.teamId, userId: s.tenant.admin2.id }, select: { id: true } });
      s.put("Target", row.id);
    },
    path: ["$Target"],
  },
  "POST /v1/identity/data-export": {},
  "POST /v1/identity/account-closure": { actor: "member", body: { confirmation: "close my account" } },
  "POST /v1/identity-security/password": {
    setup: async (s) => {
      const { hashPassword } = await import("../../src/services/email-password-auth.service.js");
      await s.prisma.user.update({ where: { id: s.actorId }, data: { passwordHash: await hashPassword("SweepPassw0rd0") } });
    },
    body: { currentPassword: "SweepPassw0rd0", newPassword: "SweepPassw0rd1" },
  },
  "POST /v1/identity-security/step-up/check": { unreachable: "The ceremony itself: every step-up in this sweep runs it." },
  "POST /v1/identity/mfa/enroll/verify": { unreachable: "The ceremony itself, on a factor mid-enrolment." },
  "POST /v1/identity-security/contact-factors/enroll/verify": { unreachable: "Needs the code from a recorded message." },
  "POST /v1/communications/verify/check": { unreachable: "Needs the code from a recorded message." },
  "POST /v1/communications/webhooks/twilio/inbound": { unreachable: "Needs a provider signature." },
  "POST /v1/communications/webhooks/twilio/status": { unreachable: "Needs a provider signature." },
  "POST /v1/identity/data-export/:p/download": {
    rows: {
      AccountDataExportRequest: { userId: "$Actor", status: "READY", expiresAtUtc: days(1), packageJson: "{}", packageSha256: () => hex64() },
    },
  },
  "POST /v1/identity/password": { body: { newPassword: "SweepPassw0rd1" } },
  "POST /v1/identity/links/apple": { unreachable: "Needs a real provider id token." },
  "POST /v1/identity/links/google": { unreachable: "Needs a real provider id token." },
  "POST /v1/identity/mfa/recovery-codes/regenerate": { setup: actorFactor },
  "DELETE /v1/identity/links/:p": {
    setup: async (s) => {
      await s.prisma.user.update({ where: { id: s.actorId }, data: { passwordHash: "x" } });
    },
    rows: { UserIdentityLink: { userId: "$Actor", status: "ACTIVE" } },
  },
  "DELETE /v1/identity/mfa/factors/:p": {
    setup: async (s) => {
      const totp = await import("../../src/services/security/mfa-totp.js");
      const { sealSecret } = await import("../../src/services/security/mfa-secret-storage.js");
      const sealed = sealSecret(totp.generateTotpSecretBytes());
      const row = await s.prisma.mfaFactor.create({
        data: {
          userId: s.actorId,
          kind: "TOTP",
          status: "ENROLLING",
          label: "Authenticator",
          secretCiphertext: Buffer.from(sealed.ciphertext),
          secretIv: Buffer.from(sealed.iv),
          secretAuthTag: Buffer.from(sealed.authTag),
          secretKekId: sealed.kekId,
        },
      });
      s.put("Enrolling", row.id);
    },
    path: ["$Enrolling"],
  },
  "POST /v1/identity/mfa/recovery-requests/:p/verify-email": {
    rows: {
      MfaRecoveryRequest: {
        userId: "$Actor",
        status: "EMAIL_VERIFICATION_PENDING",
        expiresAt: days(1),
        emailVerificationTokenHash: rawToken("Raw"),
        emailVerificationExpiresAt: days(1),
      },
    },
    ensure: ["MfaRecoveryRequest"],
    path: ["$MfaRecoveryRequest"],
    body: { token: "$Raw" },
  },
  "POST /v1/identity/mfa/challenge/verify": {
    setup: actorFactor,
    body: { code: async (s: RowSet) => s.factory.tools.totpCode(s.actorId) },
  },
  "POST /v1/identity/mfa-admin/factors/:p/:p/:p/revoke": {
    setup: async (s) => {
      await s.factory.tools.enrollTotp(s.tenant.member.id);
      const row = await s.prisma.mfaFactor.findFirst({ where: { userId: s.tenant.member.id, kind: "TOTP" }, select: { id: true } });
      s.put("Factor", row.id);
    },
    path: ["$Team", "$User", "$Factor"],
    body: { reason: "sweep reason" },
  },
  "POST /v1/identity/mfa-admin/recovery-requests/:p/approve": {
    rows: { MfaRecoveryRequest: { userId: "$Admin", status: "PENDING_ADMIN_REVIEW", expiresAt: days(1) } },
    path: ["$MfaRecoveryRequest"],
  },
  "POST /v1/identity/mfa-admin/recovery-requests/:p/reject": {
    rows: { MfaRecoveryRequest: { userId: "$Admin", status: "PENDING_ADMIN_REVIEW", expiresAt: days(1) } },
    path: ["$MfaRecoveryRequest"],
  },
  "POST /v1/identity-security/step-up/start": { setup: actorFactor, body: { teamId: "$Team", purpose: "MEMBER_SUSPEND" } },
  "DELETE /v1/identity-security/passkeys/:p": {
    setup: async (s) => {
      await actorFactor(s);
      const row = await s.prisma.mfaFactor.create({
        data: { userId: s.actorId, kind: "PASSKEY", status: "ACTIVE", label: "key", verifiedAtUtc: new Date(), enrolledAt: new Date() },
      });
      s.put("Passkey", row.id);
    },
    path: ["$Passkey"],
    body: { workspaceId: "$Team" },
  },
  "POST /v1/identity-security/passkeys/registration/verify": { unreachable: "Needs a WebAuthn authenticator." },
  "POST /v1/identity-security/step-up/handoff/passkey": { unreachable: "Needs a WebAuthn assertion." },
  "POST /v1/identity-security/step-up/handoff/passkey/options": { unreachable: "Needs a passkey handoff over a real authenticator." },
  "POST /v1/identity-security/step-up/handoff/idp/begin": { unreachable: "Needs a real IdP challenge." },
  "POST /v1/identity-security/contact-factors/enroll/start": { body: { teamId: "$Team", destination: "+15555550100" } },

  // ---------------------------------------------------------------------------
  // Integrations and lifecycle
  // ---------------------------------------------------------------------------
  "POST /v1/integrations/webhook-deliveries/:p/cancel": {
    rows: {
      IntegrationWebhookDelivery: { eventId: () => randomUUID(), eventType: "x", payloadJson: {}, status: "RETRY_SCHEDULED" },
    },
    body: { teamId: "$Team" },
  },
  "POST /v1/integrations/webhook-deliveries/:p/retry": {
    rows: {
      IntegrationWebhookDelivery: { eventId: () => randomUUID(), eventType: "x", payloadJson: {}, status: "FAILED" },
    },
    body: { teamId: "$Team" },
  },
  "POST /v1/integrations/webhooks/endpoints": { body: { url: "https://sweep.test/hook", subscribedEvents: ["EVIDENCE_CREATED"] } },
  "POST /v1/lifecycle/archive/transition": { unreachable: "Runs a real object copy at the store." },
  "POST /v1/lifecycle/destruction/requests/:p/execute": { unreachable: "Deletes real bytes at the store." },
  "POST /v1/lifecycle/destruction/requests/:p/approve": { rows: DESTRUCTION },
  "POST /v1/lifecycle/destruction/requests/:p/reject": { rows: DESTRUCTION, body: { reason: "sweep reason" } },
  "POST /v1/lifecycle/legal-holds": { body: { kind: "EVIDENCE", scopeTargetId: "$Evidence", name: "Sweep", reason: "sweep reason" } },
  "POST /v1/lifecycle/legal-holds/:p/release-request": {
    rows: { EvidenceLegalHold: { releaseApprovalRequired: true } },
    body: { note: "sweep note" },
  },
  "POST /v1/lifecycle/legal-holds/:p/release-approval": {
    rows: { EvidenceLegalHold: { releaseApprovalRequired: true, releaseRequestedByUserId: "$Admin", releaseRequestedAtUtc: new Date() } },
  },
  "POST /v1/lifecycle/retention/policies": { body: { name: "Sweep", template: "CORPORATE_5Y", scopeKind: "WORKSPACE" } },

  // ---------------------------------------------------------------------------
  // Inbox and ops
  // ---------------------------------------------------------------------------
  "POST /v1/me/inbox/items/:p/read": { path: ["onboarding:sweep"] },
  "POST /v1/me/inbox/items/:p/unread": { path: ["onboarding:sweep"] },
  "POST /v1/me/inbox/items/:p/archive": { path: ["onboarding:sweep"] },
  "POST /v1/me/inbox/items/:p/unarchive": { path: ["onboarding:sweep"] },
  "POST /v1/me/inbox/items/:p/dismiss": { path: ["onboarding:sweep"] },
  "POST /v1/me/inbox/items/:p/undismiss": { path: ["onboarding:sweep"] },
  "POST /v1/me/inbox/items/:p/remind": { path: ["onboarding:sweep"], body: { remindAt: () => iso(1) } },
  "POST /v1/me/inbox/items/:p/snooze": { path: ["onboarding:sweep"], body: { remindAt: () => iso(1) } },

  "DELETE /v1/ops/saved-views/:p": {
    rows: { SavedSearchView: { createdByUserId: "$Actor", scope: "OPERATIONS", visibility: "PRIVATE", name: () => uniq(), queryJson: {} } },
    query: { teamId: "$Team" },
  },
  "PATCH /v1/ops/saved-views/:p": {
    rows: { SavedSearchView: { createdByUserId: "$Actor", scope: "OPERATIONS", visibility: "PRIVATE", name: () => uniq(), queryJson: {} } },
    body: {
      teamId: "$Team",
      name: "Renamed",
      expectedUpdatedAt: async (s: RowSet) =>
        (await s.prisma.savedSearchView.findUnique({ where: { id: await s.id("SavedSearchView") } }))?.updatedAt.toISOString() ?? iso(0),
    },
  },
  "POST /v1/ops/bulk-actions": {
    rows: INCIDENT_BY_DECISION,
    body: { teamId: "$Team", actionType: "BULK_ACKNOWLEDGE_INCIDENTS", targetIds: ["$OperationalIncident"] },
  },
  "POST /v1/ops/incidents/:p/remediate": {
    rows: REPORT_INCIDENT,
    body: { teamId: "$Team", actionId: "report.regenerate_artifacts" },
  },
  "POST /v1/ops/incidents/:p/resolve": { rows: INCIDENT_BY_DECISION, body: { teamId: "$Team", resolutionNote: "sweep note" } },
  "POST /v1/ops/incidents/:p/suppress": { rows: INCIDENT_BY_DECISION, body: { teamId: "$Team", reason: "sweep reason" } },
  "POST /v1/ops/incidents/:p/unsuppress": {
    rows: { OperationalIncident: { ...INCIDENT_BY_DECISION.OperationalIncident, status: "SUPPRESSED" } },
    body: { teamId: "$Team" },
  },
  "POST /v1/ops/workflows/:p/reopen": {
    rows: { OperationalWorkflow: { workflowKey: () => uniq(), workflowType: "REPORT_RETRY", status: "RESOLVED", title: "x", safeSummary: "x" } },
    body: { teamId: "$Team" },
  },
  "POST /v1/ops/media-intelligence/dlq/replay": { klass: "platform", body: { teamId: "$Team" } },
  "POST /v1/ops/media-intelligence/runs/:p/retry": { klass: "platform", unreachable: "Needs a failed job on the live queue." },
  "POST /v1/operations/exports/:p/verify": {
    rows: { Report: { evidenceId: "$Evidence", version: 1, storageBucket: "b", storageKey: "k", generatedAtUtc: days(0) } },
    path: [async (s: RowSet) => `report:${await s.id("Report")}`] as never,
    body: { teamId: "$Team" },
  },
  "POST /v1/operations/queues/:p/jobs/:p/retry": { path: ["report", "sweep-job"], unreachable: "Needs a job on the live queue.", body: { teamId: "$Team", reason: "sweep reason" } },
  "POST /v1/operations/queues/:p/jobs/:p/replay": { path: ["report", "sweep-job"], unreachable: "Needs a job on the live queue.", body: { teamId: "$Team", reason: "sweep reason" } },
  "POST /v1/operations/queues/:p/jobs/:p/cancel": { path: ["report", "sweep-job"], unreachable: "Needs a job on the live queue.", body: { teamId: "$Team", reason: "sweep reason" } },
  "POST /v1/operations/signers/:p/preview": { unreachable: "Needs a staged signer against a real key." },
  "POST /v1/operations/signers/:p/promote": { unreachable: "Needs a staged signer against a real key." },
  "POST /v1/operations/signers/:p/retire": { unreachable: "Needs a live signer; retiring it would change the shared harness." },
  "POST /v1/operations/signers/:p/revoke": { unreachable: "Needs a live signer; revoking it would change the shared harness." },
  "POST /v1/ops/media-intelligence/runs/:p/dismiss": {
    rows: { MediaIntelligenceRun: { evidenceId: "$Evidence", status: "FAILED" } },
    body: { teamId: "$Team" },
  },

  // ---------------------------------------------------------------------------
  // Organizations, packaging, SIU views
  // ---------------------------------------------------------------------------
  "POST /v1/orgs/:p/domains": { body: { domain: () => `sweep-${uniq()}.example.com` } },
  "POST /v1/orgs/:p/domains/:p/verify": { rows: { OrganizationDomain: { verifiedAt: new Date() } } },
  "POST /v1/orgs/:p/invites/bulk/resend": {
    rows: { OrganizationInvite: { tokenHash: () => hex64(), expiresAt: days(1), acceptedAt: null, revokedAt: null } },
    body: { inviteIds: ["$OrganizationInvite"] },
  },
  "POST /v1/orgs/:p/invites/csv": { body: { csv: () => `email,role\nsweep-${uniq()}@test.proovra.local,ORG_MEMBER\n` } },
  "POST /v1/orgs/:p/leave": { actor: "member" },
  "POST /v1/orgs/:p/transfer-ownership": {
    make: { Heir: { model: "OrganizationMembership", data: { userId: "$Admin", role: "ORG_ADMIN", status: "ACTIVE" } } },
    ensure: ["Heir"],
    body: { targetUserId: "$Admin" },
  },
  "POST /v1/orgs/:p/closure": { unreachable: "A contract-managed organization closes through operators, by design." },
  "POST /v1/packaging/entitlements/apply-product-line": {
    klass: "platform",
    body: { teamId: "$Team", targetWorkspaceId: "$Team", line: "CAPTURE_AND_VERIFY" },
  },
  "POST /v1/packaging/entitlements/grant": {
    klass: "platform",
    body: { teamId: "$Team", targetWorkspaceId: "$Team", key: "FEATURE_WEBHOOKS", value: true, kind: "FEATURE" },
  },
  "POST /v1/search/semantic/backfill": { klass: "platform", unreachable: "Needs a live embedding provider." },
  "POST /v1/evidence/:p/custody/attestations/sign": { klass: "platform", unreachable: "Needs a custody event and a real signing key." },
  "PATCH /v1/siu/saved-views/:p": {
    rows: { CaseSiuSavedView: { name: () => uniq(), filterJson: {}, sortJson: { key: "updatedAtUtc", direction: "desc" }, visibility: "private" } },
    query: { teamId: "$Team" },
    body: { name: "Renamed" },
  },
  "POST /v1/siu/saved-views/:p/use": {
    rows: { CaseSiuSavedView: { name: () => uniq(), filterJson: {}, sortJson: { key: "updatedAtUtc", direction: "desc" }, visibility: "private" } },
    body: { teamId: "$Team" },
  },

  // ---------------------------------------------------------------------------
  // Trust: the workspace OWNER's, not platform staff
  // ---------------------------------------------------------------------------
  "POST /v1/trust/articles": {
    ...TRUST_OWNER,
    body: { kind: "TRUST_CENTER", section: "PLATFORM_TRUST", slug: () => `sweep-${uniq()}`, title: "Sweep", summary: "Sweep", body: "Sweep" },
  },
  "POST /v1/trust/subprocessors": {
    ...TRUST_OWNER,
    body: { slug: () => `sweep-${uniq()}`, name: "Sweep", vendor: "Sweep", purpose: "Sweep", region: "EU", dataCategories: ["METADATA"], changeSummary: "Sweep" },
  },
  "POST /v1/trust/status/incidents": { ...TRUST_OWNER, body: { title: "Sweep", severity: "MINOR", componentKeys: ["API"] } },
  "POST /v1/trust/status/incidents/:p/updates": {
    ...TRUST_OWNER,
    make: { Incident: { model: "StatusIncident", data: { severity: "MINOR", state: "INVESTIGATING", title: "x", componentKeys: ["API"] } } },
    path: ["$Incident"],
    body: { state: "IDENTIFIED", body: "Sweep" },
  },
  "POST /v1/trust/status/maintenance": {
    ...TRUST_OWNER,
    body: { title: "Sweep", description: "Sweep", componentKeys: ["API"], startsAtUtc: () => iso(1), endsAtUtc: () => iso(2) },
  },
  "POST /v1/trust/drift/scan": { ...TRUST_OWNER },
  "POST /v1/trust/security-claims/scan": { ...TRUST_OWNER },

  // ---------------------------------------------------------------------------
  // The person's own
  // ---------------------------------------------------------------------------
  "POST /v1/users/legal-acceptance": {
    body: {
      acceptances: async () => {
        const { REQUIRED_LEGAL_VERSIONS } = (await import("../../src/legal/legal-versioning.js")) as any;
        return [{ policyKey: "terms", policyVersion: REQUIRED_LEGAL_VERSIONS.terms }];
      },
    },
  },
  "POST /v1/batch-analysis": { body: { name: "sweep batch", evidenceIds: ["$Evidence"] } },
  "PUT /v1/me/notification-schedule": {
    body: { teamId: "$Team", timezone: "UTC", quietHoursEnabled: true, quietStartMinute: 1, quietEndMinute: 2, quietCriticalOverride: true },
  },
};
