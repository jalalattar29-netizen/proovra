/**
 * Phase 5 — External intake orchestration.
 *
 * End-to-end submission service that wires Phase 4's WorkflowIntakeLink /
 * WorkflowIntakeSession into the existing authenticated evidence pipeline:
 *
 *   1. createOrLoadExternalEvidence       — idempotently create an Evidence
 *      row owned by the link creator, with acquisitionMode=SECURE_INTAKE_LINK.
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
 *   - createEvidence() is called with acquisitionMode SECURE_INTAKE_LINK. We post-update columns to
 *     record the submitter (submittedByEmail, submittedByUserId).
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

import { evaluateFinalizationGovernance } from "./governance/finalization-governance.service.js";
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
import {
  EvidencePartWriteRefused,
  writeEvidencePart,
} from "./evidence/evidence-part-writer.service.js";
import { headObject, presignPutObject } from "../storage.js";
import { createEvidence } from "./evidence.service.js";
import { completeEvidence } from "./evidence-complete.service.js";
import { appendCustodyEvent } from "./custody-events.service.js";
import { swallowCustodyAppendError } from "./custody-events-observability.js";
import { bump } from "./ops/metrics.service.js";
import {
  releaseIntakeLinkUse,
  reserveIntakeLinkUse,
  transitionIntakeSession,
  WorkflowIntakeSessionError,
} from "./workflow-intake-session.service.js";
import { releaseEvidenceReservationTx } from "@proovra/shared-runtime";
import { linkResponseFromIntakeSession } from "./evidence-request.service.js";
import { emitWebhookEvent } from "./integrations/webhook-dispatcher.js";
// Client-signal helpers — server-side canonical source. The intake
// path computes screenshotLike from the original filename on every
// part create (we never trust a client-sent boolean), and the
// folder-path sanitiser rejects anything that looks like an
// absolute OS path so a malicious or buggy client cannot leak the
// user's home directory.
import {
  buildIntakeClientSignals,
  sanitizeClientDeviceTimeIso,
  sanitizeClientTimezone,
  sanitizeClientTimezoneOffsetMinutes,
} from "@proovra/shared";
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
import { emitTenantAudit } from "./audit/tenant-audit.service.js";

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
  // ET-INT-02 — a declared part never received its bytes (an interrupted or
  // failed upload). Recoverable by the contributor: upload that file again.
  | "part_not_uploaded"
  | "submission_not_ready"
  | "submission_already_submitted"
  | "location_required"
  // The receiving workspace's policy refuses finalization (2026-09-29, D3).
  | "finalization_blocked_by_policy"
  // ET-INT-09 — the link's per-submission file cap (checked under the record lock).
  | "max_files_reached"
  // ET-INT-06 — the stored parts exceed the link's maxBytesPerSession.
  | "session_bytes_exceeded"
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
  /**
   * Browser-supplied `file.webkitRelativePath`. Only present when the
   * contributor used a directory picker; the server sanitises this
   * to a safe top-level folder name before persistence (full local
   * paths are rejected). Never trusted verbatim.
   */
  webkitRelativePath?: string | null;
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

/**
 * THE STORAGE WIDTHS, NAMED ONCE.
 *
 * `evidence_parts.original_file_name` is VARCHAR(255) and `mime_type` is
 * VARCHAR(128). Values that came from the contributor's own device were
 * reaching the insert longer than that, and Postgres answered P2000 — which
 * the route's catch-all turned into a 500 and the contributor read as "We hit
 * a problem on our side. Please try again in a moment." Retrying produced the
 * identical failure, because the input was identical, so the intake simply
 * could not be completed.
 *
 * The old bound here was `.slice(0, 256)` — one character past the column, so
 * EVERY name of 256 characters or more failed, and always at exactly the same
 * length. Bounds are declared next to each other now so the next person can
 * see them disagree.
 */
const PART_ORIGINAL_FILE_NAME_MAX = 255;
const PART_MIME_TYPE_MAX = 128;

/**
 * How much of the file name may appear in the STORAGE KEY.
 *
 * Object stores bound each path SEGMENT to 255 bytes. The last segment here
 * is `000-<name>`, so a name allowed up to the column's 255 produced a 259-byte
 * segment and S3 answered `XMinioInvalidObjectName` — the contributor saw
 * "Upload failed (400)" after the record had already been created.
 *
 * The key does not need the whole name. It needs to be unique (the evidence id
 * and part index already guarantee that) and recognisable to a human reading a
 * bucket listing. The DISPLAY name stays whole at 255; only the key is short,
 * which is the right separation anyway — where a file lives should not be
 * decided by what somebody's phone called it.
 */
const PART_KEY_FILE_NAME_MAX = 120;

/** The file-name fragment that goes into the object key. */
function storageKeyFileNameFragment(fileName: string | null): string | null {
  if (!fileName) return null;
  if (fileName.length <= PART_KEY_FILE_NAME_MAX) return fileName;
  const dot = fileName.lastIndexOf(".");
  const ext = dot > 0 && fileName.length - dot <= 12 ? fileName.slice(dot) : "";
  const stem = ext ? fileName.slice(0, dot) : fileName;
  return stem.slice(0, PART_KEY_FILE_NAME_MAX - ext.length) + ext;
}

/**
 * The contributor's file name, reduced to something the column can hold.
 *
 * A file name is presentation metadata, not evidence: a long one must never
 * cost somebody their upload. It is truncated rather than rejected — and the
 * EXTENSION is kept, because a reviewer looking at "IMG_2026…" with the
 * ".heic" chopped off has lost the one part of the name that says what the
 * file is.
 */
function safeOriginalFileName(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value
    .replace(/\\/g, "/")
    .split("/")
    .pop() ?? "";
  const trimmed = cleaned.replace(/^\.+/, "").trim();
  if (!trimmed) return null;
  if (trimmed.length <= PART_ORIGINAL_FILE_NAME_MAX) return trimmed;

  const dot = trimmed.lastIndexOf(".");
  // A "." in the first character is not an extension, and an extension long
  // enough to crowd out the name is not one either.
  const ext = dot > 0 && trimmed.length - dot <= 12 ? trimmed.slice(dot) : "";
  const stem = ext ? trimmed.slice(0, dot) : trimmed;
  return stem.slice(0, PART_ORIGINAL_FILE_NAME_MAX - ext.length) + ext;
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

  // ET-INT-09 — read the binding FRESH (the route's session object may be
  // stale when two first-part uploads race).
  const bound = await client.workflowIntakeSession.findUnique({
    where: { id: pair.session.id },
    select: { evidenceId: true },
  });
  const boundEvidenceId = bound?.evidenceId ?? pair.session.evidenceId ?? null;
  if (boundEvidenceId) {
    const existing = await client.evidence.findUnique({
      where: { id: boundEvidenceId },
    });
    if (existing && !existing.deletedAt) return existing;
    // Evidence was deleted out from under us — fall through and re-create.
  }

  // The Evidence is owned by the workspace admin who created the intake
  // link. That user is guaranteed to be a member of the workspace, which
  // satisfies createEvidence()'s team-membership check without modifying
  // that service.
  // Phase T — the link carries the canonical template-identity trio from the moment the
  // workspace admin created it, so it is resolved BEFORE the record exists and handed to
  // createEvidence: it is stamped in the INSERT and named by the RETENTION_POLICY_APPLIED
  // custody event written in the same transaction (UC-ARCH-002 moved retention there).
  // Resolution is propagation-only: a failure leaves the trio null, never breaks the upload.
  let trio: Awaited<ReturnType<typeof resolveTemplateTrioForIntakeLink>> | null = null;
  try {
    trio = await resolveTemplateTrioForIntakeLink({
      link: {
        workflowTemplateId: pair.link.workflowTemplateId ?? null,
        workflowTemplateSlug: pair.link.workflowTemplateSlug,
        workflowTemplateVersion: pair.link.workflowTemplateVersion,
        teamId: pair.link.teamId,
      },
      client,
    });
  } catch {
    trio = null;
  }

  const createResult = await createEvidence({
    ownerUserId: pair.link.createdByUserId,
    teamId: pair.link.teamId,
    type: evidenceTypeFromMime(seed.mimeType),
    mimeType: seed.mimeType,
    originalFileName: safeOriginalFileName(seed.originalFileName),
    captureFileName: null,
    intakePlanJson: workflowTemplateSnapshotFromLink(pair.link),
    // UC-0 — the canonical secure-intake ingress (also Evidence Requests).
    acquisitionMode: "SECURE_INTAKE_LINK",
    // The contributor did not sign in; the owner is the link's issuer.
    acquisitionActor: {
      kind: "INTAKE_CONTRIBUTOR",
      contributorEmailProvided: Boolean(pair.session.submitterEmail),
    },
    templateIdentity: trio?.templateSlug
      ? { templateSlug: trio.templateSlug, templateVersion: trio.templateVersion, templateDbId: trio.templateDbId }
      : null,
  });

  // createEvidence returns a presign-response shape; pull the full row.
  const evidence = await client.evidence.findUniqueOrThrow({
    where: { id: createResult.id },
  });

  // ET-INT-09 — CLAIM the session for this record: a conditional write, so of
  // two concurrent first-part uploads exactly one binds its record. The loser
  // releases its own (still empty) reservation and uses the winner's.
  const claimed = await client.workflowIntakeSession.updateMany({
    where: {
      id: pair.session.id,
      OR: [{ evidenceId: null }, ...(boundEvidenceId ? [{ evidenceId: boundEvidenceId }] : [])],
    },
    data: { evidenceId: evidence.id },
  });
  if (claimed.count !== 1) {
    await client.$transaction((tx) =>
      releaseEvidenceReservationTx(tx, {
        evidenceId: evidence.id,
        reason: "INTAKE_SESSION_RACE_LOST",
        now: new Date(),
      }),
    );
    const winner = await client.workflowIntakeSession.findUnique({
      where: { id: pair.session.id },
      select: { evidenceId: true },
    });
    const won = winner?.evidenceId
      ? await client.evidence.findUnique({ where: { id: winner.evidenceId } })
      : null;
    if (!won) throw new ExternalIntakeOrchestrationError("session_not_open_for_upload");
    return won;
  }

  // Post-update: record who submitted. These columns do not affect the
  // integrity pipeline (fingerprint / signature / OTS / TSA / anchor are
  // computed from the bytes, not from these fields).
  //
  // UC-0 — `captureMethod` is no longer set to EXTERNAL_INTAKE_UPLOAD here.
  // Completion always overwrote it with a structure value, so it never carried
  // intake origin past submission; the acquisition authority
  // (`acquisitionMode`, written by createEvidence above) now does.
  const externalSubmitterEmail = pair.session.submitterEmail ?? null;
  const updatedEvidence = await client.evidence.update({
    where: { id: evidence.id },
    data: {
      submittedByEmail: externalSubmitterEmail,
      // submittedByUserId stays null — the contributor has no User row.
      //
      // SNAPSHOT, taken once, here. The link is authoritative; this copy
      // records which customer the organization associated the submission
      // with AT THE TIME it was submitted, so a later correction on their
      // side cannot silently rewrite this record's provenance. It is also
      // what evidence search filters on, as an indexed column rather than
      // two joins through session -> link.
      //
      // Null when the organization supplied none, which is the common case.
      intakeCustomerId: pair.link.customerId ?? null,
    },
  });

  // Phase T — stamp the canonical template-identity trio (slug + version
  // + optional db id) onto the Evidence row from the WorkflowIntakeLink
  // snapshot. The link already carries the canonical values from the
  // moment the workspace admin created it; we never recompute policy or
  // re-derive snapshots. Entirely wrapped in try/catch — a stamping
  // failure must not break the upload-presign flow. Audit emission
  // reuses the existing platform audit chain.
  // The trio was stamped by createEvidence above; record that it was.
  try {
    if (trio?.templateSlug) {
      void emitTenantAudit({
        // External-intake submissions have no authenticated user; use the
        // link creator (workspace admin) as the actor for audit purposes.
        actorUserId: pair.link.createdByUserId,
        action: "evidence.template_identity.stamped",
        outcome: "success",
        sourceApp: "API",
        workspaceId: pair.link.teamId,
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

  // (ET-INT-09 — the session was bound to this record by the conditional
  // claim above.)

  // UC-ARCH-002 — workspace retention is applied by createEvidence (the
  // canonical writer) for every channel; no per-channel call here.

  // Emit the two intake-history custody events at the moment Evidence first
  // exists for this session. They land in the chain before any UPLOAD_*
  // events, so reviewers see the full lineage. Only fired on FIRST creation
  // — re-entry through this function returns the existing Evidence above
  // and never reaches this point.
  // Custody emission must not abort the upload-presign flow, but a failed
  // append is observable (ET-CUS-11/13): logged, counted and reported. The
  // chain is forward-only, so an operator can append a remediation event.
  const intakeCustodyFailure = (custodyEventType: string) => (err: unknown) =>
    swallowCustodyAppendError(err, {
      surface: "externalIntake.createEvidenceForSession",
      evidenceId: evidence.id,
      custodyEventType,
    });
  await appendCustodyEvent({
    evidenceId: evidence.id,
    eventType: prismaPkg.CustodyEventType.EXTERNAL_INTAKE_LINK_USED,
    payload: {
      intakeLinkId: pair.link.id,
      intakeSessionId: pair.session.id,
      intakeMode: pair.link.intakeMode,
    },
  }).catch(intakeCustodyFailure("EXTERNAL_INTAKE_LINK_USED"));
  if (pair.session.consentAcceptedAtUtc) {
    await appendCustodyEvent({
      evidenceId: evidence.id,
      eventType: prismaPkg.CustodyEventType.EXTERNAL_INTAKE_CONSENT_ACCEPTED,
      payload: {
        intakeLinkId: pair.link.id,
        intakeSessionId: pair.session.id,
        consentPolicyVersion: pair.link.consentPolicyVersion,
      },
    }).catch(intakeCustodyFailure("EXTERNAL_INTAKE_CONSENT_ACCEPTED"));
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
    storageKeyFileNameFragment(fileName) ?? `part-${partIndex + 1}`
  }`;

  // Insert the part record. Unique constraint on (evidenceId, partIndex) is
  // enforced at the DB level; we surface a clean error code if the index
  // is already taken.
  let part: DbEvidencePart;
  try {
    // Server-computed clientSignals. Every intake-link part gets a
    // fresh evaluation of the screenshot heuristic against its
    // ORIGINAL filename — this is canonical, not advisory: the web
    // page could omit (or lie about) the signal and the server's
    // value is the one that lands in the audit trail.
    //
    // Folder path is included only when the helper extracts a
    // non-null top-level folder name from the webkitRelativePath
    // input. The sanitizer rejects absolute OS paths, traversal
    // tokens, and anything that isn't relative; if the contributor
    // didn't use a directory picker, the field is simply omitted.
    const clientSignals = buildIntakeClientSignals({
      originalFileName: fileName,
      webkitRelativePath: input.webkitRelativePath ?? null,
    });

    // ET-INT-05 / ET-INT-14 — the ONE byte-write authority: it takes the
    // evidence lock finalize holds, so a part can never land on a record that
    // is being signed or already signed, nor on a soft-deleted record.
    let createdNow: boolean;
    ({ part, created: createdNow } = await writeEvidencePart(
      {
        evidenceId: evidence.id,
        principal: {
          kind: "INTAKE_SESSION",
          linkCreatorUserId: input.link.createdByUserId,
          sessionId: input.session.id,
        },
        partIndex,
        // ET-INT-02 — a retry of an index whose upload never completed returns
        // the SAME reserved row with a fresh upload URL (checked below); only
        // a different file on a taken index is refused.
        onExistingIndex: "RETURN_EXISTING",
        maxPartCount: input.link.maxFileCountPerSession ?? null,
        data: {
        storageBucket: bucket,
        storageKey: key,
        originalFileName: fileName,
        // Bounded for the same reason as the name above. The kind is derived
        // from the prefix, so a truncated value still classifies correctly.
        mimeType: input.mimeType.slice(0, PART_MIME_TYPE_MAX),
        durationMs: input.durationMs ?? null,
        privateRole: input.privateRole?.slice(0, 120) ?? null,
        privateNote: input.privateNote?.slice(0, 1000) ?? null,
        checklistStepId: input.checklistStepId?.slice(0, 120) ?? null,
        sourceLabel: "external_intake",
        clientSignals: clientSignals as Prisma.InputJsonValue,
        // External submitter is not a User; uploadedByUserId tracks the
        // workspace admin who is the owner-of-record for traceability.
        uploadedByUserId: input.link.createdByUserId,
        uploadedAtUtc: null,
        },
      },
      client,
    ));
    if (
      !createdNow &&
      (part.uploadedAtUtc !== null ||
        part.originalFileName !== fileName ||
        part.mimeType !== input.mimeType.slice(0, PART_MIME_TYPE_MAX))
    ) {
      throw new ExternalIntakeOrchestrationError("part_index_taken", { partIndex });
    }
  } catch (err) {
    if (err instanceof ExternalIntakeOrchestrationError) throw err;
    if (err instanceof EvidencePartWriteRefused) {
      if (err.code === "PART_INDEX_TAKEN") {
        throw new ExternalIntakeOrchestrationError("part_index_taken", { partIndex });
      }
      if (err.code === "EVIDENCE_NOT_FOUND") {
        throw new ExternalIntakeOrchestrationError("evidence_not_found");
      }
      if (err.code === "PART_COUNT_EXCEEDED") {
        throw new ExternalIntakeOrchestrationError("max_files_reached", {
          max: input.link.maxFileCountPerSession ?? null,
        });
      }
      throw new ExternalIntakeOrchestrationError("session_not_open_for_upload");
    }
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
    try {
      await transitionIntakeSession({
        sessionId: input.session.id,
        expectedLinkId: input.link.id,
        to: "UPLOAD_STARTED",
      });
    } catch (err) {
      // ET-INT-09 — a concurrent upload in this session already started it
      // (the route's session object is a snapshot); that is the state we want.
      const now = await client.workflowIntakeSession.findUnique({
        where: { id: input.session.id },
        select: { status: true },
      });
      if (now?.status !== "UPLOAD_STARTED") throw err;
    }
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

/**
 * Contributor device-clock context captured at submit time. Every
 * field is loose; the orchestration layer sanitises each value via
 * the shared helpers before persistence. The only field that
 * survives onto Evidence is `deviceTimeIso`, which lands on the
 * same column Capture writes — so the Evidence Detail page can
 * read it once and render identically for either origin.
 */
export type ExternalIntakeDeviceTimeInput = {
  deviceTimeIso?: string | null;
  timezone?: string | null;
  timezoneOffsetMinutes?: number | null;
};

export type SubmitExternalIntakeInput = SessionLinkPair & {
  location?: ExternalIntakeLocationInput | null;
  deviceTime?: ExternalIntakeDeviceTimeInput | null;
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

  // ET-INT-06 — the link's per-submission byte cap (stored, never enforced).
  // The stored objects are the truth; a part not yet written is left to the
  // finalization's own not-uploaded answer.
  if (input.link.maxBytesPerSession != null) {
    const max = BigInt(input.link.maxBytesPerSession);
    let total = 0n;
    for (const p of parts) {
      const head = await headObject({ bucket: p.storageBucket, key: p.storageKey }).catch(() => null);
      if (head) total += BigInt(head.sizeBytes ?? 0);
    }
    if (total > max) {
      throw new ExternalIntakeOrchestrationError("session_bytes_exceeded", {
        maxBytes: max.toString(),
        totalBytes: total.toString(),
      });
    }
  }

  // Persist contributor-provided location onto the Evidence row BEFORE
  // completion. completeEvidence enqueues the report-v2 + verification-
  // package jobs, and the worker reads lat/lng/accuracyMeters/locationSource
  // FRESH from the Evidence row at generation time. Writing the location
  // first therefore guarantees the report (PDF Capture Context), the public
  // verify projection, and the package's capture-context.json all observe
  // it — the previous ordering wrote it AFTER the enqueue, so the generation
  // jobs raced (and often lost) against this write and produced artifacts
  // with no location even though it was durably stored.
  //
  // completeEvidence does NOT touch lat/lng/accuracyMeters/locationSource —
  // it only writes integrity fields (sha256, signature, signingKeyId,
  // status) — so ordering the location write first never disturbs hashes /
  // signatures / file metadata. Missing location is NEVER an integrity
  // failure: the gate above already accepted the submit. This aligns intake
  // with web/mobile capture, which already persist location at Evidence-
  // creation time (before completion).
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

  // Device-time context — persisted BEFORE completeEvidence for the SAME
  // reason as location above. The canonical fingerprint is built INSIDE
  // completeEvidence (buildFingerprint reads evidence.deviceTimeIso), and the
  // verification-package metadata files (capture-context / case-metadata /
  // original-linkage) read evidence.deviceTimeIso too. Writing it AFTER
  // completion left the SIGNED fingerprint.json with deviceTimeIso:null while
  // those metadata files carried the value — an inconsistency. Ordering the
  // write first makes them consistent; it does not change the fingerprint/
  // signature LOGIC, only ensures the input exists before it is computed.
  // Sanitised through the shared helpers (ISO parseable + within clock-skew);
  // failure to sanitise => no write, no card, no error. timezone/offset are
  // accepted for forward-compat but not persisted (no column yet; no schema
  // change).
  const cleanDeviceTimeIso = sanitizeClientDeviceTimeIso(
    input.deviceTime?.deviceTimeIso ?? null,
  );
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const cleanTimezone = sanitizeClientTimezone(
    input.deviceTime?.timezone ?? null,
  );
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const cleanOffset = sanitizeClientTimezoneOffsetMinutes(
    input.deviceTime?.timezoneOffsetMinutes ?? null,
  );
  if (cleanDeviceTimeIso) {
    await client.evidence.update({
      where: { id: evidence.id },
      data: { deviceTimeIso: cleanDeviceTimeIso },
    });
  }

  // Hand off to the canonical completion authority. From this point forward
  // the evidence is treated identically to every other channel: headObject
  // verification, sha256 streaming, fingerprint, signature, TSA, and (UC-ARCH-003,
  // now true — it was claimed here while only the web route wrote them) the
  // EVIDENCE_COMPLETED custody event, the reviewer workflow and the
  // evidence.complete audit, then the report / OTS / fan-out requests.
  // The ONE finalization governance gate (2026-09-29, audit D3), on the
  // authority of the link's owner — the same policy the web upload obeys.
  // ET-INT-13 — a RETRY after the record was already finalized (an earlier
  // attempt signed it and then failed a post-commit step) neither reserves a
  // second use nor finalizes again: it only completes what is missing.
  const alreadyFinalized = evidence.status === "SIGNED" || evidence.status === "REPORTED";
  if (!alreadyFinalized) {
  const gate = await evaluateFinalizationGovernance({
    evidenceId: evidence.id,
    actorUserId: evidence.ownerUserId,
  });
  if (!gate.allowed) {
    throw new ExternalIntakeOrchestrationError("finalization_blocked_by_policy");
  }

  // ET-INT-09 — RESERVE this submission's use of the link before finalizing:
  // one conditional increment (used_count < max_uses), so concurrent submits
  // on a ONE_TIME link finalize exactly one record. The check in
  // validateIntakeToken and the increment after completion were a read and a
  // later unconditional write. A finalization that fails gives the use back.
  if (!(await reserveIntakeLinkUse(input.link.id, client))) {
    throw new WorkflowIntakeSessionError(
      input.link.maxUses === 1 ? "link_already_submitted" : "link_exhausted",
    );
  }
  try {
    await completeEvidence({
      evidenceId: evidence.id,
      ownerUserId: evidence.ownerUserId,
      // UC-ARCH-005 — the ONE door an intake record is sealed through.
      intakeSubmission: { sessionId: input.session.id },
    });
  } catch (err) {
    await releaseIntakeLinkUse(input.link.id, client);
    // ET-INT-02 — a part whose object was never written is the contributor's
    // to fix (upload it again), not "this intake can't accept evidence".
    // Both not-found shapes completion raises: a zero-size object, and a HEAD
    // that found no object (OBJECT_HEAD_FAILED with a 404 status).
    const status = (err as { statusCode?: number }).statusCode;
    if (
      err instanceof Error &&
      (err.message === "OBJECT_NOT_FOUND" || (status === 404 && err.message.startsWith("OBJECT_HEAD_FAILED")))
    ) {
      throw new ExternalIntakeOrchestrationError("part_not_uploaded");
    }
    throw err;
  }
  }

  // Audit the contributor's location decision. Coordinates are NEVER
  // logged here — only the consent state and an accuracy band. The
  // raw lat/lng live on Evidence (workspace-protected) and surface
  // via the location panel; the audit log is for compliance/forensic
  // traceability of WHAT happened, not WHERE.
  if (policy !== "NONE") {
    try {
      await emitTenantAudit({
        actorUserId: null,
        action: shouldPersistLocation
          ? "external_intake.location.attached"
          : `external_intake.location.${consentState.toLowerCase()}`,
        outcome: "success",
        sourceApp: "API",
        workspaceId: evidence.teamId,
        resourceType: "evidence",
        resourceId: evidence.id,
        metadata: {
          intakeLinkId: input.link.id,
          intakeSessionId: input.session.id,
          locationPolicy: policy,
          consentState,
          accuracyBand: accuracyBand(coords?.accuracyMeters ?? null),
          source: input.location?.source ?? null,
          locationPersisted: shouldPersistLocation,
        },
      });
    } catch {
      // Audit log failure must not abort an already-completed submission.
    }
  }

  // Emit external-specific custody event AFTER completion so it sits at the
  // end of the chain (the chain hashes events in order).
  // ET-INT-13 — FROM HERE THE RECORD IS FINALIZED: nothing below may turn the
  // contributor's answer into "failed, try again". Each step is idempotent
  // (the custody event once per session; the transition only if still open)
  // and a failure is recorded for operators, not returned to the contributor.
  const submittedAlready = await client.custodyEvent.findFirst({
    where: {
      evidenceId: evidence.id,
      eventType: prismaPkg.CustodyEventType.EXTERNAL_INTAKE_SUBMITTED,
      payload: { path: ["intakeSessionId"], equals: input.session.id },
    },
    select: { id: true },
  });
  if (!submittedAlready) await appendCustodyEvent({
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
  }).catch((err: unknown) =>
    swallowCustodyAppendError(err, {
      surface: "externalIntake.submit",
      evidenceId: evidence.id,
      custodyEventType: "EXTERNAL_INTAKE_SUBMITTED",
    }),
  );

  // Transition the session. (ET-INT-09 — the link's use was reserved before
  // finalization; the transition no longer counts it again.)
  let submitted: Awaited<ReturnType<typeof transitionIntakeSession>>;
  try {
    submitted = await transitionIntakeSession({
      sessionId: input.session.id,
      expectedLinkId: input.link.id,
      to: "SUBMITTED",
    });
  } catch {
    // ET-INT-13 — already SUBMITTED (a concurrent or earlier attempt) is the
    // state we want; anything else is recorded, and the finalized record is
    // still the contributor's answer.
    const current = await client.workflowIntakeSession
      .findUnique({ where: { id: input.session.id } })
      .catch(() => null);
    if (current?.status !== "SUBMITTED") {
      bump("external_intake_post_finalize_transition_failed_total");
    }
    submitted = current ?? input.session;
  }

  // UC-CASE-003 — a link (or the evidence request that minted it) issued FOR a
  // case puts the submitted record IN that case, through the canonical
  // case-link authority (same-workspace proof, one active link per pair,
  // link + audit in one transaction; idempotent on a retried submit). The
  // case used to be stored as a label only, so the record was outside the
  // matter's evidence list, exports and CASE-scoped legal holds.
  await attachIntakeEvidenceToCase({
    linkId: input.link.id,
    linkCaseId: (input.link as { caseId?: string | null }).caseId ?? null,
    linkCreatorUserId: input.link.createdByUserId,
    evidenceId: evidence.id,
    teamId: evidence.teamId ?? null,
    intakeSessionId: input.session.id,
    client,
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

/**
 * UC-CASE-003 — attach a finalized intake record to the case its link (or the
 * evidence request behind the link) was issued for. Never fails the
 * contributor's submission: the record is already sealed. A case that is gone,
 * in another workspace or otherwise refused is recorded in the tenant audit as
 * a skipped link (an operator can re-link), never silently dropped.
 */
async function attachIntakeEvidenceToCase(input: {
  linkId: string;
  linkCaseId: string | null;
  linkCreatorUserId: string;
  evidenceId: string;
  teamId: string | null;
  intakeSessionId: string;
  client: PrismaClient;
}): Promise<void> {
  let caseId = input.linkCaseId;
  if (!caseId) {
    const request = await input.client.evidenceRequest
      .findFirst({ where: { intakeLinkId: input.linkId, caseId: { not: null } }, select: { caseId: true } })
      .catch(() => null);
    caseId = request?.caseId ?? null;
  }
  if (!caseId) return;
  const { attachEvidenceToCase } = await import("./cases/case-evidence-link.service.js");
  try {
    const caseRow = await input.client.case.findUnique({ where: { id: caseId }, select: { teamId: true } });
    if (!caseRow || caseRow.teamId !== input.teamId) throw new Error("case_not_in_workspace");
    await attachEvidenceToCase(
      {
        caseId,
        evidenceId: input.evidenceId,
        // System attach on behalf of the link: the contributor has no account
        // and the link creator did not act now. Tenancy is proven by the
        // authority (same workspace) and by the link's own validated caseId.
        actorUserId: null,
        role: "PRIMARY",
        source: "INTAKE",
        reason: `Submitted through intake link ${input.linkId}`,
      },
      input.client,
    );
  } catch (err) {
    await emitTenantAudit({
      actorUserId: null,
      action: "external_intake.case_link_skipped",
      outcome: "error",
      sourceApp: "API",
      workspaceId: input.teamId,
      resourceType: "evidence",
      resourceId: input.evidenceId,
      metadata: {
        caseId,
        intakeLinkId: input.linkId,
        intakeSessionId: input.intakeSessionId,
        reason: err instanceof Error ? err.message.slice(0, 120) : "unknown",
      },
    }).catch(() => undefined);
  }
}
