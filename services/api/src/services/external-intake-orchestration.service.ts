/**
 * Phase 5 — External intake orchestration.
 *
 * End-to-end submission service that wires Phase 4's WorkflowIntakeLink /
 * WorkflowIntakeSession into the existing authenticated evidence pipeline:
 *
 *   1. createOrLoadExternalEvidence       — idempotently create an Evidence
 *      row owned by the link creator, marked as captureMethod=EXTERNAL_INTAKE_UPLOAD.
 *   2. addExternalEvidencePart            — create an EvidencePart and return
 *      a presigned PUT URL so the contributor can upload bytes directly to S3.
 *   3. updateExternalEvidencePartMapping  — map a staged part to a workflow
 *      step / role / contributor note (pre-upload metadata).
 *   4. submitExternalIntake               — call the existing completeEvidence
 *      to verify uploads, build the fingerprint, sign, and emit the same
 *      downstream pipeline that authenticated capture triggers. Then transition
 *      the WorkflowIntakeSession to SUBMITTED, link evidenceId, increment
 *      link.usedCount, and emit the EXTERNAL_INTAKE_SUBMITTED custody event.
 *
 * Reuse statement:
 *   - createEvidence() is called unmodified. We post-update three columns to
 *     mark the external origin (captureMethod, submittedByEmail, submittedByUserId).
 *   - presignPutObject() from storage.ts is called for upload URLs.
 *   - completeEvidence() from evidence-complete.service.ts is the SINGLE entry
 *     into the integrity/signing pipeline. The external path does not bypass
 *     it. Report-v2, OTS, TSA, anchor publishing, custody chain run exactly
 *     as for authenticated evidence.
 *   - appendCustodyEvent() emits the new EXTERNAL_INTAKE_* events into the
 *     existing custody hash chain — no parallel audit system.
 *
 * Privacy boundary:
 *   - Contributor IP / user-agent never leave the WorkflowIntakeSession row.
 *     They are HMAC'd at session open and never surfaced over any public
 *     route.
 *   - Internal notes, reviewer comments, AI advisory, legal notes are not
 *     read or written by this service. They do not exist for external
 *     submissions until an authenticated reviewer adds them later.
 *   - The submitter's contributed email (if non-anonymous) goes onto
 *     Evidence.submittedByEmail. Existing public-verify / report-v2
 *     pipelines mask it via maskPublicEmail per the Phase 1 baseline.
 */

import { Prisma } from "@prisma/client";
import type {
  PrismaClient,
  WorkflowIntakeLink as DbWorkflowIntakeLink,
  WorkflowIntakeSession as DbWorkflowIntakeSession,
  Evidence as DbEvidence,
  EvidencePart as DbEvidencePart,
} from "@prisma/client";
import * as prismaPkg from "@prisma/client";

import { prisma as defaultPrisma } from "../db.js";
import { presignPutObject } from "../storage.js";
import { createEvidence } from "./evidence.service.js";
import { completeEvidence } from "./evidence-complete.service.js";
import { appendCustodyEvent } from "./custody-events.service.js";
import { transitionIntakeSession } from "./workflow-intake-session.service.js";
import { linkResponseFromIntakeSession } from "./evidence-request.service.js";
import { emitWebhookEvent } from "./integrations/webhook-dispatcher.js";
// Phase T — propagate canonical template identity onto Evidence rows
// minted via the external-intake path. The WorkflowIntakeLink already
// snapshots the slug, version, and (when DB-backed) the template id at
// link-creation time; we honour that snapshot verbatim. Stamping is
// strictly wrapped in try/catch so a propagation failure cannot break
// the bytes-presign flow.
import {
  resolveTemplateTrioForIntakeLink,
  templateIdentityAuditMetadata,
} from "./templates/identity-resolver.service.js";
import { appendPlatformAuditLog } from "./platform-audit-log.service.js";

// -----------------------------------------------------------------------------
// Error type
// -----------------------------------------------------------------------------

export type ExternalIntakeOrchestrationErrorCode =
  | "session_not_open_for_upload"
  | "consent_not_accepted"
  | "link_revoked"
  | "link_expired"
  | "session_terminal"
  | "session_expired"
  | "evidence_not_found"
  | "part_not_found"
  | "part_not_in_session"
  | "part_index_taken"
  | "submission_not_ready"
  | "submission_already_submitted"
  | "location_required"
  | "internal_error";

export class ExternalIntakeOrchestrationError extends Error {
  constructor(
    public readonly code: ExternalIntakeOrchestrationErrorCode,
    public readonly details?: Record<string, unknown>,
  ) {
    super(code);
    this.name = "ExternalIntakeOrchestrationError";
  }
}

// -----------------------------------------------------------------------------
// Inputs
// -----------------------------------------------------------------------------

type SessionLinkPair = {
  link: DbWorkflowIntakeLink;
  session: DbWorkflowIntakeSession;
};

export type AddExternalPartInput = SessionLinkPair & {
  partIndex: number;
  mimeType: string;
  originalFileName?: string | null;
  sizeBytesHint?: number | null;
  checksumSha256Base64?: string | null;
  contentMd5Base64?: string | null;
  checklistStepId?: string | null;
  privateRole?: string | null;
  privateNote?: string | null;
  durationMs?: number | null;
};

export type UpdateExternalPartMappingInput = SessionLinkPair & {
  partId: string;
  checklistStepId?: string | null;
  privateRole?: string | null;
  privateNote?: string | null;
};

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function assertSessionUploadEligible(session: DbWorkflowIntakeSession): void {
  if (session.status === "SUBMITTED") {
    throw new ExternalIntakeOrchestrationError("submission_already_submitted");
  }
  const terminal = ["EXPIRED", "REVOKED", "ABANDONED"];
  if (terminal.includes(session.status)) {
    throw new ExternalIntakeOrchestrationError("session_terminal");
  }
  if (session.expiresAtUtc.getTime() <= Date.now()) {
    throw new ExternalIntakeOrchestrationError("session_expired");
  }
  if (!session.consentAcceptedAtUtc) {
    throw new ExternalIntakeOrchestrationError("consent_not_accepted");
  }
}

function safeOriginalFileName(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value
    .replace(/\\/g, "/")
    .split("/")
    .pop() ?? "";
  const trimmed = cleaned.replace(/^\.+/, "").trim();
  if (!trimmed) return null;
  return trimmed.slice(0, 256);
}

function evidenceTypeFromMime(mime: string): prismaPkg.EvidenceType {
  const m = mime.toLowerCase();
  if (m.startsWith("image/")) return prismaPkg.EvidenceType.PHOTO;
  if (m.startsWith("video/")) return prismaPkg.EvidenceType.VIDEO;
  if (m.startsWith("audio/")) return prismaPkg.EvidenceType.AUDIO;
  return prismaPkg.EvidenceType.DOCUMENT;
}

function workflowTemplateSnapshotFromLink(
  link: DbWorkflowIntakeLink,
): Prisma.InputJsonValue {
  // Already JSON-shaped via Phase 4 createWorkflowIntakeLink. We re-attach
  // here so Evidence.intakePlanJson carries the exact requirements the
  // contributor saw at intake time.
  const value = link.workflowTemplateSnapshot;
  if (value === null || value === undefined) return {} as Prisma.InputJsonValue;
  return value as Prisma.InputJsonValue;
}

// -----------------------------------------------------------------------------
// Step 1: create or load the Evidence backing an external session
//
// Idempotent. The first call creates the Evidence row, links it to the
// session, and marks captureMethod=EXTERNAL_INTAKE_UPLOAD. Subsequent calls
// return the existing Evidence so the contributor can resume a session
// (uploading more parts before submission).
// -----------------------------------------------------------------------------

export async function createOrLoadExternalEvidence(
  pair: SessionLinkPair,
  seed: {
    mimeType: string;
    originalFileName?: string | null;
  },
  client: PrismaClient = defaultPrisma,
): Promise<DbEvidence> {
  assertSessionUploadEligible(pair.session);

  if (pair.session.evidenceId) {
    const existing = await client.evidence.findUnique({
      where: { id: pair.session.evidenceId },
    });
    if (existing) return existing;
    // Evidence was deleted out from under us — fall through and re-create.
  }

  // The Evidence is owned by the workspace admin who created the intake
  // link. That user is guaranteed to be a member of the workspace, which
  // satisfies createEvidence()'s team-membership check without modifying
  // that service.
  const createResult = await createEvidence({
    ownerUserId: pair.link.createdByUserId,
    teamId: pair.link.teamId,
    type: evidenceTypeFromMime(seed.mimeType),
    mimeType: seed.mimeType,
    originalFileName: safeOriginalFileName(seed.originalFileName),
    captureFileName: null,
    intakePlanJson: workflowTemplateSnapshotFromLink(pair.link),
  });

  // createEvidence returns a presign-response shape; pull the full row.
  const evidence = await client.evidence.findUniqueOrThrow({
    where: { id: createResult.id },
  });

  // Post-update: mark the external origin. These three columns describe
  // who/how the evidence arrived; they do not affect the integrity pipeline
  // (fingerprint / signature / OTS / TSA / anchor are computed from the
  // bytes, not from these fields).
  const externalSubmitterEmail = pair.session.submitterEmail ?? null;
  const updatedEvidence = await client.evidence.update({
    where: { id: evidence.id },
    data: {
      captureMethod: prismaPkg.CaptureMethod.EXTERNAL_INTAKE_UPLOAD,
      submittedByEmail: externalSubmitterEmail,
      // submittedByUserId stays null — the contributor has no User row.
    },
  });

  // Phase T — stamp the canonical template-identity trio (slug + version
  // + optional db id) onto the Evidence row from the WorkflowIntakeLink
  // snapshot. The link already carries the canonical values from the
  // moment the workspace admin created it; we never recompute policy or
  // re-derive snapshots. Entirely wrapped in try/catch — a stamping
  // failure must not break the upload-presign flow. Audit emission
  // reuses the existing platform audit chain.
  try {
    const trio = await resolveTemplateTrioForIntakeLink({
      link: {
        workflowTemplateId: pair.link.workflowTemplateId ?? null,
        workflowTemplateSlug: pair.link.workflowTemplateSlug,
        workflowTemplateVersion: pair.link.workflowTemplateVersion,
        teamId: pair.link.teamId,
      },
      client,
    });
    if (trio.templateSlug) {
      await client.evidence.update({
        where: { id: evidence.id },
        data: {
          templateSlug: trio.templateSlug,
          templateVersion: trio.templateVersion,
          templateDbId: trio.templateDbId,
        },
      });
      void appendPlatformAuditLog({
        // External-intake submissions have no authenticated user; use the
        // link creator (workspace admin) as the actor for audit purposes.
        userId: pair.link.createdByUserId,
        action: "evidence.template_identity.stamped",
        category: "evidence",
        severity: "info",
        source: "external_intake",
        outcome: "success",
        resourceType: "evidence",
        resourceId: evidence.id,
        metadata: templateIdentityAuditMetadata({
          evidenceId: evidence.id,
          source: "external_intake",
          trio,
        }),
      }).catch(() => {
        /* audit emission must never break external intake */
      });
    }
  } catch {
    /* propagation-only: never break the bytes pipeline */
  }

  // Link the session to the freshly-minted evidence so a resumed upload
  // hits the same Evidence on the next presign request.
  await client.workflowIntakeSession.update({
    where: { id: pair.session.id },
    data: { evidenceId: evidence.id },
  });

  // Phase 9.5 — external intake evidence also receives workspace
  // retention policy. Same failure-safe wrapper as authenticated create.
  try {
    const { applyRetentionPolicyOnCreate } = await import(
      "./governance.service.js"
    );
    await applyRetentionPolicyOnCreate({
      evidenceId: evidence.id,
      teamId: pair.link.teamId,
      existingRetentionUntilUtc: updatedEvidence.retentionUntilUtc ?? null,
    });
  } catch {
    /* observability-only — evidence creation already succeeded */
  }

  // Emit the two intake-history custody events at the moment Evidence first
  // exists for this session. They land in the chain before any UPLOAD_*
  // events, so reviewers see the full lineage. Only fired on FIRST creation
  // — re-entry through this function returns the existing Evidence above
  // and never reaches this point.
  try {
    await appendCustodyEvent({
      evidenceId: evidence.id,
      eventType: prismaPkg.CustodyEventType.EXTERNAL_INTAKE_LINK_USED,
      payload: {
        intakeLinkId: pair.link.id,
        intakeSessionId: pair.session.id,
        intakeMode: pair.link.intakeMode,
      },
    });
    if (pair.session.consentAcceptedAtUtc) {
      await appendCustodyEvent({
        evidenceId: evidence.id,
        eventType: prismaPkg.CustodyEventType.EXTERNAL_INTAKE_CONSENT_ACCEPTED,
        payload: {
          intakeLinkId: pair.link.id,
          intakeSessionId: pair.session.id,
          consentPolicyVersion: pair.link.consentPolicyVersion,
        },
      });
    }
  } catch {
    // Custody-event emission must not abort the upload-presign flow.
    // The chain hashing is forward-only so a later operator can append
    // a remediation event. We rely on the existing logger upstream.
  }

  return updatedEvidence;
}

// -----------------------------------------------------------------------------
// Step 2: create a part + return a presigned PUT URL
// -----------------------------------------------------------------------------

export type AddedExternalPartResult = {
  part: DbEvidencePart;
  upload: {
    bucket: string;
    key: string;
    putUrl: string;
    checksumRequired: boolean;
    contentMd5Required: boolean;
    expiresInSeconds: number;
  };
};

export async function addExternalEvidencePart(
  input: AddExternalPartInput,
  client: PrismaClient = defaultPrisma,
): Promise<AddedExternalPartResult> {
  assertSessionUploadEligible(input.session);

  // Load or create the backing Evidence once.
  const evidence = await createOrLoadExternalEvidence(
    { link: input.link, session: input.session },
    { mimeType: input.mimeType, originalFileName: input.originalFileName },
    client,
  );

  const bucket =
    typeof evidence.storageBucket === "string" && evidence.storageBucket.length > 0
      ? evidence.storageBucket
      : process.env.S3_BUCKET;
  if (!bucket) {
    throw new ExternalIntakeOrchestrationError("internal_error", {
      reason: "S3_BUCKET_NOT_CONFIGURED",
    });
  }

  const partIndex = Math.max(0, Math.floor(input.partIndex));
  const fileName = safeOriginalFileName(input.originalFileName);
  const key = `evidence/${evidence.id}/parts/${String(partIndex).padStart(3, "0")}-${
    fileName ?? `part-${partIndex + 1}`
  }`;

  // Insert the part record. Unique constraint on (evidenceId, partIndex) is
  // enforced at the DB level; we surface a clean error code if the index
  // is already taken.
  let part: DbEvidencePart;
  try {
    part = await client.evidencePart.create({
      data: {
        evidenceId: evidence.id,
        partIndex,
        storageBucket: bucket,
        storageKey: key,
        originalFileName: fileName,
        mimeType: input.mimeType,
        durationMs: input.durationMs ?? null,
        privateRole: input.privateRole?.slice(0, 120) ?? null,
        privateNote: input.privateNote?.slice(0, 1000) ?? null,
        checklistStepId: input.checklistStepId?.slice(0, 120) ?? null,
        sourceLabel: "external_intake",
        // External submitter is not a User; uploadedByUserId tracks the
        // workspace admin who is the owner-of-record for traceability.
        uploadedByUserId: input.link.createdByUserId,
        uploadedAtUtc: null,
      },
    });
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      throw new ExternalIntakeOrchestrationError("part_index_taken", {
        partIndex,
      });
    }
    throw err;
  }

  // Make sure the session has transitioned to UPLOAD_STARTED so the
  // lifecycle stays observable. Idempotent if already there.
  if (input.session.status === "OPENED") {
    await transitionIntakeSession({
      sessionId: input.session.id,
      expectedLinkId: input.link.id,
      to: "UPLOAD_STARTED",
    });
  }

  const putUrl = await presignPutObject({
    bucket: part.storageBucket,
    key: part.storageKey,
    contentType: part.mimeType ?? input.mimeType,
    checksumSha256Base64: input.checksumSha256Base64 ?? null,
    contentMd5Base64: input.contentMd5Base64 ?? null,
    expiresInSeconds: 600,
  });

  return {
    part,
    upload: {
      bucket: part.storageBucket,
      key: part.storageKey,
      putUrl,
      checksumRequired: Boolean(input.checksumSha256Base64),
      contentMd5Required: Boolean(input.contentMd5Base64),
      expiresInSeconds: 600,
    },
  };
}

// -----------------------------------------------------------------------------
// Update part mapping (called when contributor maps a staged file to a
// workflow step or attaches a contributor note).
// -----------------------------------------------------------------------------

export async function updateExternalEvidencePartMapping(
  input: UpdateExternalPartMappingInput,
  client: PrismaClient = defaultPrisma,
): Promise<DbEvidencePart> {
  assertSessionUploadEligible(input.session);

  const part = await client.evidencePart.findUnique({
    where: { id: input.partId },
  });
  if (!part) throw new ExternalIntakeOrchestrationError("part_not_found");
  if (part.evidenceId !== input.session.evidenceId) {
    throw new ExternalIntakeOrchestrationError("part_not_in_session");
  }

  const data: Prisma.EvidencePartUpdateInput = {};
  if (input.checklistStepId !== undefined) {
    data.checklistStepId =
      input.checklistStepId?.slice(0, 120) ?? null;
  }
  if (input.privateRole !== undefined) {
    data.privateRole = input.privateRole?.slice(0, 120) ?? null;
  }
  if (input.privateNote !== undefined) {
    data.privateNote = input.privateNote?.slice(0, 1000) ?? null;
  }

  if (Object.keys(data).length === 0) return part;

  return client.evidencePart.update({
    where: { id: input.partId },
    data,
  });
}

// -----------------------------------------------------------------------------
// Step 3: submit — finalize Evidence + transition session
// -----------------------------------------------------------------------------

/**
 * Contributor-provided location captured by the public intake page.
 * Always optional at the input layer; the policy check (NONE / OPTIONAL
 * / REQUIRED) decides whether absence is fatal.
 *
 * Coordinates are validated server-side regardless of what the browser
 * sent — bad numbers are rejected up front so we never persist garbage
 * onto Evidence. Raw lat/lng are kept OUT of the platform audit log
 * for privacy; the audit row stores only the consent state + an
 * accuracy band, not the coordinates themselves.
 */
export type ExternalIntakeLocationInput = {
  /** GRANTED | DENIED | UNAVAILABLE | NOT_REQUESTED — contributor's decision. */
  consentState: string;
  latitude?: number | null;
  longitude?: number | null;
  accuracyMeters?: number | null;
  capturedAtUtc?: string | null;
  /** Stable provenance tag; only BROWSER_GEOLOCATION is wired today. */
  source?: string | null;
};

export type SubmitExternalIntakeInput = SessionLinkPair & {
  location?: ExternalIntakeLocationInput | null;
};

export type SubmitExternalIntakeResult = {
  session: DbWorkflowIntakeSession;
  evidenceId: string;
};

/**
 * Validate that every required workflow step has at least one part mapped.
 * Reads the link's snapshot — never the live workflow template — so the
 * contributor cannot get held to a requirement that did not exist when the
 * link was created.
 */
function assertSubmissionReady(
  link: DbWorkflowIntakeLink,
  parts: DbEvidencePart[],
): void {
  const snapshot = link.workflowTemplateSnapshot as
    | {
        planMode?: string;
        steps?: Array<{ id?: unknown; required?: unknown }>;
      }
    | null
    | undefined;

  if (!snapshot || !Array.isArray(snapshot.steps)) return;

  if (snapshot.planMode !== "CHECKLIST_REQUIRED") return;

  const mappedStepIds = new Set(
    parts
      .map((p) => p.checklistStepId)
      .filter((s): s is string => typeof s === "string" && s.length > 0),
  );

  const missingRequired: string[] = [];
  for (const step of snapshot.steps) {
    if (
      step &&
      typeof step === "object" &&
      step.required === true &&
      typeof step.id === "string"
    ) {
      if (!mappedStepIds.has(step.id)) missingRequired.push(step.id);
    }
  }

  if (missingRequired.length > 0) {
    throw new ExternalIntakeOrchestrationError("submission_not_ready", {
      missingRequiredSteps: missingRequired,
    });
  }
}

/**
 * Coordinate sanity check. Browser geolocation always supplies finite
 * numbers in valid ranges; anything outside that is rejected so the
 * gate never accepts garbage from a forged payload. Returns the
 * canonical (lat, lng, accuracy) tuple or null if any field is unusable.
 *
 * Accuracy is clamped to >=0 and <= 100000m — anything beyond that is
 * essentially "no useful position" and we treat the location as absent
 * for gate purposes.
 */
function normalizeIntakeLocationCoordinates(
  loc: ExternalIntakeLocationInput | null | undefined,
): { lat: number; lng: number; accuracyMeters: number | null } | null {
  if (!loc) return null;
  const lat = typeof loc.latitude === "number" ? loc.latitude : null;
  const lng = typeof loc.longitude === "number" ? loc.longitude : null;
  if (lat === null || lng === null) return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90) return null;
  if (lng < -180 || lng > 180) return null;
  let accuracyMeters: number | null = null;
  if (typeof loc.accuracyMeters === "number" && Number.isFinite(loc.accuracyMeters)) {
    if (loc.accuracyMeters >= 0 && loc.accuracyMeters <= 100_000) {
      accuracyMeters = loc.accuracyMeters;
    }
  }
  return { lat, lng, accuracyMeters };
}

/**
 * Accuracy band for the audit log. Raw accuracy values can be
 * fingerprinting-adjacent, so we bucket them. This is also more
 * useful for analytics ("most contributors land within 50m").
 */
function accuracyBand(meters: number | null): string {
  if (meters === null) return "unknown";
  if (meters <= 25) return "<=25m";
  if (meters <= 100) return "<=100m";
  if (meters <= 500) return "<=500m";
  if (meters <= 2000) return "<=2km";
  return ">2km";
}

export async function submitExternalIntake(
  input: SubmitExternalIntakeInput,
  client: PrismaClient = defaultPrisma,
): Promise<SubmitExternalIntakeResult> {
  assertSessionUploadEligible(input.session);

  if (!input.session.evidenceId) {
    throw new ExternalIntakeOrchestrationError("evidence_not_found", {
      reason: "no_parts_uploaded",
    });
  }

  // Location policy gate. NONE = ignore whatever the client sent;
  // OPTIONAL = persist coordinates only when GRANTED + valid;
  // REQUIRED = submit blocked unless GRANTED + valid coordinates arrive.
  // The location field is OPTIONAL in the route schema, so a missing
  // body for a NONE link still works exactly like the pre-feature path.
  const policy = input.link.locationPolicy ?? "NONE";
  const consentState =
    typeof input.location?.consentState === "string"
      ? input.location.consentState
      : "NOT_REQUESTED";
  const coords = normalizeIntakeLocationCoordinates(input.location);
  const shouldPersistLocation =
    policy !== "NONE" && consentState === "GRANTED" && coords !== null;

  if (policy === "REQUIRED" && !shouldPersistLocation) {
    // Required policy never silently accepts a missing/denied/unavailable
    // location. UNAVAILABLE is treated identically to DENIED for the gate
    // — the public page should be surfacing a "contact requester" message
    // in that branch so the user isn't deadlocked.
    throw new ExternalIntakeOrchestrationError("location_required", {
      consentState,
      hasCoordinates: coords !== null,
    });
  }

  const evidence = await client.evidence.findUnique({
    where: { id: input.session.evidenceId },
  });
  if (!evidence) {
    throw new ExternalIntakeOrchestrationError("evidence_not_found");
  }

  const parts = await client.evidencePart.findMany({
    where: { evidenceId: evidence.id },
    orderBy: { partIndex: "asc" },
  });

  if (parts.length === 0) {
    throw new ExternalIntakeOrchestrationError("submission_not_ready", {
      reason: "no_parts",
    });
  }

  // Readiness against the workflow template snapshot.
  assertSubmissionReady(input.link, parts);

  // Hand off to the EXISTING canonical completion pipeline. From this point
  // forward the evidence is treated identically to authenticated capture:
  // headObject verification, sha256 streaming, fingerprint, signature,
  // EVIDENCE_COMPLETED custody event, report-v2 enqueue, OTS/TSA pipeline,
  // anchor publishing.
  await completeEvidence({
    evidenceId: evidence.id,
    ownerUserId: evidence.ownerUserId,
  });

  // Persist contributor-provided location onto the Evidence row, AFTER
  // completion. completeEvidence does NOT touch lat/lng/accuracyMeters/
  // locationSource — it only writes integrity fields (sha256, signature,
  // signingKeyId, status). Writing the location here keeps the policy
  // owner colocated and means hashes / signatures / file metadata are
  // never disturbed by the location feature. Missing location is NEVER
  // an integrity failure: the gate above already accepted the submit.
  if (shouldPersistLocation && coords) {
    await client.evidence.update({
      where: { id: evidence.id },
      data: {
        lat: coords.lat,
        lng: coords.lng,
        accuracyMeters: coords.accuracyMeters,
        locationSource: "INTAKE_LINK_GEOLOCATION",
      },
    });
  }

  // Audit the contributor's location decision. Coordinates are NEVER
  // logged here — only the consent state and an accuracy band. The
  // raw lat/lng live on Evidence (workspace-protected) and surface
  // via the location panel; the audit log is for compliance/forensic
  // traceability of WHAT happened, not WHERE.
  if (policy !== "NONE") {
    try {
      await appendPlatformAuditLog({
        userId: null,
        isPublic: true,
        action: shouldPersistLocation
          ? "external_intake.location.attached"
          : `external_intake.location.${consentState.toLowerCase()}`,
        category: "external_intake",
        severity: "info",
        source: "intake_link",
        outcome: shouldPersistLocation ? "success" : "skipped",
        resourceType: "evidence",
        resourceId: evidence.id,
        metadata: {
          intakeLinkId: input.link.id,
          intakeSessionId: input.session.id,
          locationPolicy: policy,
          consentState,
          accuracyBand: accuracyBand(coords?.accuracyMeters ?? null),
          source: input.location?.source ?? null,
        },
      });
    } catch {
      // Audit log failure must not abort an already-completed submission.
    }
  }

  // Emit external-specific custody event AFTER completion so it sits at the
  // end of the chain (the chain hashes events in order).
  await appendCustodyEvent({
    evidenceId: evidence.id,
    eventType: prismaPkg.CustodyEventType.EXTERNAL_INTAKE_SUBMITTED,
    payload: {
      intakeLinkId: input.link.id,
      intakeSessionId: input.session.id,
      intakeMode: input.link.intakeMode,
      workflowTemplateSlug: input.link.workflowTemplateSlug,
      workflowTemplateVersion: input.link.workflowTemplateVersion,
      partCount: parts.length,
      locationProvided: shouldPersistLocation,
      locationConsentState: policy !== "NONE" ? consentState : null,
    },
  });

  // Transition the session. This bumps link.usedCount via the existing
  // transitionIntakeSession helper.
  const submitted = await transitionIntakeSession({
    sessionId: input.session.id,
    expectedLinkId: input.link.id,
    to: "SUBMITTED",
  });

  // Phase 7 — if this intake link was created by an EvidenceRequest, wire
  // the response into the request domain so reviewers see a new
  // EvidenceRequestResponse row, deliverables advance, and the request
  // status moves to RESPONSE_RECEIVED / PARTIALLY_FULFILLED / FULFILLED.
  // Failures here must not abort the submission — the Evidence is already
  // finalized; the request linkage is operational metadata.
  try {
    await linkResponseFromIntakeSession({
      intakeLinkId: input.link.id,
      intakeSession: submitted,
      evidenceId: evidence.id,
    });
  } catch {
    // intentional swallow — see comment above. The chain hash + evidence
    // record are already durable.
  }

  // Phase 6 — fire `external_intake.submitted` after the submission has
  // crossed the persistence and custody-event boundary. Reuses the SAME
  // canonical `emitWebhookEvent` dispatcher. Payload carries IDs +
  // bounded workflow metadata only — NEVER the contributor's email, IP,
  // HMAC'd UA, intake token, or any payload bytes. The evidence + session
  // are already durable; webhook delivery failures are absorbed.
  if (evidence.teamId) {
    try {
      await emitWebhookEvent({
        teamId: evidence.teamId,
        eventType: "external_intake.submitted",
        payload: {
          evidenceId: evidence.id,
          intakeLinkId: input.link.id,
          intakeSessionId: submitted.id,
          intakeMode: input.link.intakeMode,
          workflowTemplateSlug: input.link.workflowTemplateSlug,
          workflowTemplateVersion: input.link.workflowTemplateVersion,
          partCount: parts.length,
        },
        attemptInline: true,
      });
    } catch {
      // never abort the submission on webhook delivery failure
    }
  }

  return {
    session: submitted,
    evidenceId: evidence.id,
  };
}
