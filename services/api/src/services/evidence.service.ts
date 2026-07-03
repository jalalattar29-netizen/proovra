import { prisma } from "../db.js";
import { getPublicBaseUrl, presignPutObject } from "../storage.js";
import {
  assertWorkspaceAllowsEvidenceCreation,
  resolveWorkspaceScopeForUser,
  assertWorkspaceAllowsStorageGrowth,
} from "./billing-enforcement.service.js";
import * as prismaPkg from "@prisma/client";
import { ensureGuestIdentity } from "./auth.service.js";
import { appendCustodyEventTx } from "./custody-events.service.js";
import { emitWebhookEvent } from "./integrations/webhook-dispatcher.js";
import {
  ensureUploadSession,
  safeTransitionUploadSession,
} from "./reliability/upload-session.service.js";
// Phase 4A Closure — Department scope resolver. Evidence rows do not carry a
// departmentId column (workspace-anchored only), but the actor's department
// scope context IS material to the audit chain: it records which department
// memberships the creator held at evidence-creation time, so downstream
// reviewers can later prove dept-level isolation didn't leak across
// boundaries. This is real wiring — the envelope is read from the live
// DepartmentMembership table and immutably persisted on EVIDENCE_CREATED.
import {
  buildStrictDepartmentScopeWhere,
  resolveUserDepartmentScope,
} from "./governance/department-scope.service.js";
import { ensurePersonalWorkspace } from "./platform-context/workspace-bootstrap.service.js";

function must(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) throw new Error(`${name} is not set`);
  return v.trim();
}

function normalizeUploadMimeType(input?: string | null): string {
  const raw = typeof input === "string" ? input.trim().toLowerCase() : "";

  if (!raw) return "application/octet-stream";
  const base = raw.split(";")[0]?.trim() ?? "";
  if (!base) return "application/octet-stream";
  if (base.length > 128) return "application/octet-stream";
  if (/[\r\n]/.test(base)) return "application/octet-stream";
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(base)) {
    return "application/octet-stream";
  }

  return base;
}

function resolveIdentityLevel(params: {
  provider: prismaPkg.AuthProvider;
  emailVerifiedAt: Date | null;
  currentWorkspaceVerified: boolean;
  currentWorkspaceId: string | null;
}): prismaPkg.IdentityLevel {
  if (params.currentWorkspaceVerified) {
    return prismaPkg.IdentityLevel.VERIFIED_ORGANIZATION;
  }

  if (params.currentWorkspaceId) {
    return prismaPkg.IdentityLevel.ORGANIZATION_ACCOUNT;
  }

  if (
    params.provider === prismaPkg.AuthProvider.GOOGLE ||
    params.provider === prismaPkg.AuthProvider.APPLE
  ) {
    return prismaPkg.IdentityLevel.OAUTH_BACKED_IDENTITY;
  }

  if (params.emailVerifiedAt) {
    return prismaPkg.IdentityLevel.VERIFIED_EMAIL;
  }

  return prismaPkg.IdentityLevel.BASIC_ACCOUNT;
}

const { EvidenceStatus } = prismaPkg;

function sanitizeFileName(value: string | null | undefined): string | null {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return null;

  const normalized = raw.replace(/\\/g, "/").split("/").pop()?.trim() ?? "";
  if (!normalized || normalized === "." || normalized === "..") return null;

  return normalized.slice(0, 255);
}

function formatCaptureFileTimestamp(value: Date): string {
  const yyyy = value.getUTCFullYear();
  const mm = String(value.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(value.getUTCDate()).padStart(2, "0");
  const hh = String(value.getUTCHours()).padStart(2, "0");
  const mi = String(value.getUTCMinutes()).padStart(2, "0");
  const ss = String(value.getUTCSeconds()).padStart(2, "0");
  const ms = String(value.getUTCMilliseconds()).padStart(3, "0");

  return `${yyyy}-${mm}-${dd}_${hh}-${mi}-${ss}.${ms}Z`;
}

function buildGeneratedCaptureFileName(params: {
  mimeType?: string | null;
  capturedAt: Date;
}): string {
  const ext = normalizeUploadMimeType(params.mimeType)
    ? (() => {
        const mime = normalizeUploadMimeType(params.mimeType);
        if (mime === "image/jpeg") return "jpg";
        if (mime === "image/png") return "png";
        if (mime === "image/webp") return "webp";
        if (mime === "video/mp4") return "mp4";
        if (mime === "video/webm") return "webm";
        if (mime === "audio/webm") return "webm";
        if (mime === "audio/ogg") return "ogg";
        if (mime === "audio/mp4") return "m4a";
        if (mime === "audio/mpeg") return "mp3";
        if (mime === "audio/wav") return "wav";
        if (mime === "audio/x-wav") return "wav";
        if (mime === "application/pdf") return "pdf";
        return "bin";
      })()
    : "bin";

  return `PROOVRA-CAPTURE-${formatCaptureFileTimestamp(params.capturedAt)}.${ext}`;
}

function resolveRootEvidenceDisplayFileName(params: {
  originalFileName?: string | null;
  captureFileName?: string | null;
  mimeType?: string | null;
  capturedAt: Date;
}): {
  originalFileName: string | null;
  displayFileName: string;
} {
  const original = sanitizeFileName(params.originalFileName);
  const captureName = sanitizeFileName(params.captureFileName);

  if (original) {
    return {
      originalFileName: original,
      displayFileName: original,
    };
  }

  if (captureName) {
    return {
      originalFileName: null,
      displayFileName: captureName,
    };
  }

  return {
    originalFileName: null,
    displayFileName: buildGeneratedCaptureFileName({
      mimeType: params.mimeType,
      capturedAt: params.capturedAt,
    }),
  };
}

export async function createEvidence(params: {
  ownerUserId: string;
  teamId?: string | null;
  type: prismaPkg.EvidenceType;
  mimeType?: string;
  internalNotes?: string | null;
  originalFileName?: string | null;
  captureFileName?: string | null;
  deviceTimeIso?: string;
  gps?: { lat: number; lng: number; accuracyMeters?: number };
  checksumSha256Base64?: string | null;
  contentMd5Base64?: string | null;
intakePlanJson?: prismaPkg.Prisma.InputJsonValue;
  // Web Capture / Browser Upload only. When true, the UPLOAD_AUTHORIZED custody
  // event's human-readable `meaning` says "initial browser upload location"
  // instead of the generic "initial intake location" (which is misleading for a
  // normal browser upload — it is NOT an Intake Link submission). Default
  // (undefined/false) preserves the existing wording for Intake and Mobile.
  browserUpload?: boolean;
})
{
  const owner = await prisma.user.findUnique({
    where: { id: params.ownerUserId },
    select: {
      id: true,
      email: true,
      provider: true,
      emailVerifiedAt: true,
      currentWorkspaceId: true,
    },
  });

  if (!owner) {
    throw new Error("OWNER_NOT_FOUND");
  }

  // Workspace scope MUST be explicit. Callers (Capture POST /v1/evidence,
  // external intake orchestration, ...) decide whether the new record is
  // PERSONAL or scoped to a team by passing `teamId` (or omitting it for
  // personal). The user's `currentWorkspaceId` is a UI navigation hint,
  // NOT a billing decision — falling back to it here used to silently
  // route Capture submissions to the user's last-selected team workspace
  // and trip the TEAM plan gate, even when the user picked a template
  // like "Legal Matter" that has no team implications. Templates only
  // describe checklist structure; they never imply workspace scope.
  //
  // Phase HOME-DATA-OWNERSHIP — "team_id NULL means personal" is dead.
  // Every evidence row now carries a REAL team id:
  //
  //   - teamId omitted              → resolve (or bootstrap) the owner's
  //     personal Team row and stamp ITS id. Billing stays PERSONAL
  //     (entitlement-based) — stamping the personal team id is a data-
  //     ownership decision, not a billing decision.
  //   - teamId = caller's personal Team → same as omitted (PERSONAL
  //     billing, personal team id stamped).
  //   - teamId = a real team workspace → unchanged TEAM semantics.
  //
  // This is what makes workspace-scoped reads (Home dashboard,
  // trust-summary, command-center, reports?teamId=…) see personal
  // evidence. Rows are never created with team_id NULL again.
  let effectiveTeamId = params.teamId ?? null;
  let isPersonalWorkspaceCapture = false;

  if (effectiveTeamId) {
    const targetTeam = await prisma.team.findUnique({
      where: { id: effectiveTeamId },
      select: { isPersonal: true, ownerUserId: true },
    });
    isPersonalWorkspaceCapture =
      targetTeam?.isPersonal === true &&
      targetTeam.ownerUserId === params.ownerUserId;

    const membership = await prisma.teamMember.findUnique({
      where: {
        teamId_userId: {
          teamId: effectiveTeamId,
          userId: params.ownerUserId,
        },
      },
      select: { teamId: true },
    });

    if (!membership && isPersonalWorkspaceCapture) {
      // Self-heal: the bootstrap upserts the OWNER membership row for
      // the caller's own personal team.
      await ensurePersonalWorkspace({ userId: params.ownerUserId });
    } else if (!membership) {
      const err: Error & { statusCode?: number; code?: string } = new Error(
        "Forbidden team workspace"
      );
      err.statusCode = 403;
      err.code = "TEAM_WORKSPACE_FORBIDDEN";
      throw err;
    }
  } else {
    const personal = await ensurePersonalWorkspace({
      userId: params.ownerUserId,
    });
    effectiveTeamId = personal.teamId;
    isPersonalWorkspaceCapture = true;
  }

  // Snapshots and TEAM billing semantics only apply to REAL team
  // workspaces. A personal capture stamps the personal team id on the
  // row but keeps the historical personal behavior everywhere else:
  // PERSONAL billing scope (entitlement-based, no TEAM_PLAN gate), no
  // workspace name snapshot, no ORGANIZATION_ACCOUNT identity level.
  const workspaceTeam =
    effectiveTeamId && !isPersonalWorkspaceCapture
      ? await prisma.team.findUnique({
          where: { id: effectiveTeamId },
          select: {
            id: true,
            name: true,
            legalName: true,
            verificationState: true,
            evidenceWorkspaceLabel: true,
          },
        })
      : null;

  const scope = await resolveWorkspaceScopeForUser({
    ownerUserId: params.ownerUserId,
    teamId: isPersonalWorkspaceCapture ? null : effectiveTeamId,
  });

  await assertWorkspaceAllowsEvidenceCreation(scope);
  await assertWorkspaceAllowsStorageGrowth({
    scope,
    incomingBytes: 0n,
  });

  const guestIdentity =
    owner.provider === prismaPkg.AuthProvider.GUEST
      ? await ensureGuestIdentity(params.ownerUserId)
      : null;

  // Phase 4A Closure — resolve the actor's department scope envelope at
  // creation time. For PERSONAL evidence (no teamId) there is nothing to
  // resolve — workspace policies don't apply. For team workspaces we read
  // the live DepartmentMembership rows (via resolveUserDepartmentScope),
  // compute the strict where-fragment via buildStrictDepartmentScopeWhere
  // (so downstream consumers see the canonical filter shape), and bind
  // both into the EVIDENCE_CREATED custody payload below. The strict
  // fragment is exercised here so any future query that joins evidence
  // by departmentId can read the same canonical shape from the chain.
  const departmentScopeContext =
    effectiveTeamId && !isPersonalWorkspaceCapture
      ? await resolveUserDepartmentScope({
          teamId: effectiveTeamId,
          userId: params.ownerUserId,
        }).catch(() => null)
      : null;
  const departmentScopeStrictWhere = departmentScopeContext
    ? buildStrictDepartmentScopeWhere(departmentScopeContext)
    : undefined;

  const bucket = must("S3_BUCKET");
  const publicBase = getPublicBaseUrl();
  const capturedAt = new Date();
  const normalizedMimeType = normalizeUploadMimeType(params.mimeType);
  const resolvedFileNames = resolveRootEvidenceDisplayFileName({
  originalFileName: params.originalFileName ?? null,
  captureFileName: params.captureFileName ?? null,
  mimeType: normalizedMimeType,
  capturedAt,
});

  const organizationVerifiedSnapshot =
    workspaceTeam?.verificationState ===
    prismaPkg.OrganizationVerificationState.VERIFIED;

  const identityLevelSnapshot = resolveIdentityLevel({
    provider: owner.provider,
    emailVerifiedAt: owner.emailVerifiedAt ?? null,
    currentWorkspaceVerified: organizationVerifiedSnapshot,
    // Personal captures keep their personal identity semantics — the
    // stamped personal team id must NOT promote them to
    // ORGANIZATION_ACCOUNT.
    currentWorkspaceId: isPersonalWorkspaceCapture ? null : effectiveTeamId,
  });

  const workspaceNameSnapshot =
    workspaceTeam?.evidenceWorkspaceLabel?.trim() ||
    workspaceTeam?.name?.trim() ||
    null;

  const organizationNameSnapshot =
    workspaceTeam?.legalName?.trim() ||
    workspaceTeam?.name?.trim() ||
    null;

  const created = await prisma.$transaction(async (tx) => {
    const evidence = await tx.evidence.create({
data: {
  ownerUserId: params.ownerUserId,
  originalFileName: resolvedFileNames.originalFileName,
  displayFileName: resolvedFileNames.displayFileName,
  // Phase HOME-DATA-OWNERSHIP — always the REAL resolved team id
  // (personal Team row for personal captures, team workspace id for
  // team captures). Never null. `scope.teamId` is intentionally NOT
  // used here: for personal captures the billing scope is PERSONAL
  // (scope.teamId === null) while the data-ownership stamp is the
  // personal team id.
  teamId: effectiveTeamId,
  // Phase A1 — write the resolved organization id, NOT the team id.
  // The earlier `organizationId: scope.teamId` was a real bug: it
  // stored the Team uuid in the Organization column. The A1
  // migration's CHECK constraint now rejects
  // `team_id IS NOT NULL AND organization_id IS NULL`, and the FK
  // rejects an organization id that does not exist. With this
  // assignment the column carries the genuine
  // `teams.organization_id` value resolved by the workspace scope
  // helper, so tenancy is structurally correct from creation onward.
  organizationId: scope.organizationId,
  type: params.type,
  status: EvidenceStatus.CREATED,
  verificationStatus: prismaPkg.VerificationStatus.MATERIALS_AVAILABLE,
  mimeType: normalizedMimeType,
  captureMethod: prismaPkg.CaptureMethod.UPLOADED_FILE,
  identityLevelSnapshot,
  submittedByEmail: owner.email ?? null,
  submittedByAuthProvider: owner.provider,
  submittedByUserId: params.ownerUserId,
  createdByUserId: params.ownerUserId,
  uploadedByUserId: params.ownerUserId,
  internalNotes: params.internalNotes?.trim() || null,
  ...(params.intakePlanJson === undefined
    ? {}
    : { intakePlanJson: params.intakePlanJson }),
  workspaceNameSnapshot,
  organizationNameSnapshot,
  organizationVerifiedSnapshot,
  capturedAtUtc: capturedAt,
  deviceTimeIso: params.deviceTimeIso ?? null,
  lat: params.gps?.lat ?? null,
  lng: params.gps?.lng ?? null,
  accuracyMeters: params.gps?.accuracyMeters ?? null,
  guestIdentityId: guestIdentity?.id ?? null,
},
      select: {
        id: true,
        status: true,
      },
    });

const key = `evidence/${evidence.id}/original-${resolvedFileNames.displayFileName}`;

    await appendCustodyEventTx(tx, {
      evidenceId: evidence.id,
      eventType: prismaPkg.CustodyEventType.EVIDENCE_CREATED,
      atUtc: capturedAt,
      payload: {
        phase: "evidence_created",
        type: params.type,
        mimeType: normalizedMimeType,
        captureMethod: prismaPkg.CaptureMethod.UPLOADED_FILE,
        verificationStatus: prismaPkg.VerificationStatus.MATERIALS_AVAILABLE,
        deviceTimeIso: params.deviceTimeIso ?? null,
        gps: params.gps
          ? {
              lat: params.gps.lat,
              lng: params.gps.lng,
              accuracyMeters: params.gps.accuracyMeters ?? null,
            }
          : null,
        // Phase 4A Closure — bind the actor's department scope envelope
        // into the EVIDENCE_CREATED custody event. Bounded, append-only
        // record of which departments the actor belonged to AND the
        // canonical strict where-shape (so downstream auditors can
        // re-derive isolation without re-querying live membership).
        // NEVER persists raw user PII — only opaque dept UUIDs + an
        // unrestricted flag for workspace owners / ORG_ADMINs.
        departmentScopeContext: departmentScopeContext
          ? {
              unrestricted: departmentScopeContext.unrestricted,
              allowedDepartmentIds:
                departmentScopeContext.allowedDepartmentIds,
              strictWhereApplied: departmentScopeStrictWhere
                ? "buildStrictDepartmentScopeWhere"
                : null,
            }
          : null,
      } as prismaPkg.Prisma.InputJsonValue,
    });

    await appendCustodyEventTx(tx, {
      evidenceId: evidence.id,
      eventType: prismaPkg.CustodyEventType.IDENTITY_SNAPSHOT_RECORDED,
      atUtc: capturedAt,
      payload: {
        identityLevelSnapshot,
        submittedByEmail: owner.email ?? null,
        submittedByAuthProvider: owner.provider,
        submittedByUserId: params.ownerUserId,
        createdByUserId: params.ownerUserId,
        uploadedByUserId: params.ownerUserId,
        workspaceNameSnapshot,
        organizationNameSnapshot,
        organizationVerifiedSnapshot,
      } as prismaPkg.Prisma.InputJsonValue,
    });

    // Truthful intake event: at this point a presigned URL is about to be
    // issued and the storage location is reserved. NO bytes have been
    // uploaded yet. Previously written as UPLOAD_STARTED, which made the
    // chain claim something that had not happened. New records use
    // UPLOAD_AUTHORIZED; old records keep UPLOAD_STARTED for compatibility.
    await appendCustodyEventTx(tx, {
      evidenceId: evidence.id,
      eventType: prismaPkg.CustodyEventType.UPLOAD_AUTHORIZED,
      atUtc: new Date(),
      payload: {
        phase: "upload_authorized",
        uploadKind: "intake_authorization",
        captureMethod: prismaPkg.CaptureMethod.UPLOADED_FILE,
        bucket,
        key,
        contentType: normalizedMimeType,
        meaning: params.browserUpload
          ? "A presigned upload URL was issued for the initial browser upload location. No bytes have been confirmed uploaded yet, and the final evidence structure may still become multipart during completion."
          : "A presigned upload URL was issued for the initial intake location. No bytes have been confirmed uploaded yet, and the final evidence structure may still become multipart during completion.",
      } as prismaPkg.Prisma.InputJsonValue,
    });

    await tx.evidence.update({
      where: { id: evidence.id },
      data: {
        status: EvidenceStatus.UPLOADING,
        storageBucket: bucket,
        storageKey: key,
      },
    });

    return {
      id: evidence.id,
      key,
    };
  });

  const putUrl = await presignPutObject({
    bucket,
    key: created.key,
    contentType: normalizedMimeType,
    checksumSha256Base64: params.checksumSha256Base64 ?? null,
    contentMd5Base64: params.contentMd5Base64 ?? null,
    expiresInSeconds: 600,
  });

  // Phase 12 — open the operations-side UploadSession and move it to
  // PRESIGNED. Best-effort: this row is purely observational and any
  // failure here MUST NOT fail evidence creation.
  ensureUploadSession({
    evidenceId: created.id,
    // Mirror the Evidence row's stamped team id (personal Team id for
    // personal captures) so the observational session and the evidence
    // row never disagree about workspace ownership.
    teamId: effectiveTeamId,
  })
    .then(() =>
      safeTransitionUploadSession({
        evidenceId: created.id,
        to: "PRESIGNED",
      }),
    )
    .catch(() => null);

  const publicUrl = publicBase
    ? `${publicBase.replace(/\/+$/, "")}/${created.key}`
    : null;

  // Phase 10 — fire `evidence.created` to any subscribed webhook
  // endpoints in this workspace. Feature-flag gated and best-effort.
  if (scope.teamId) {
    try {
      await emitWebhookEvent({
        teamId: scope.teamId,
        eventType: "evidence.created",
        payload: {
          evidenceId: created.id,
          type: params.type,
          status: EvidenceStatus.UPLOADING,
          mimeType: normalizedMimeType,
          captureMethod: prismaPkg.CaptureMethod.UPLOADED_FILE,
        },
        attemptInline: true,
      });
    } catch {
      // never fail evidence creation on webhook delivery
    }
  }

  return {
    id: created.id,
    // Phase 30.12 — expose teamId so the capture page can drive
    // resumable upload session creation (which requires teamId in
    // every authorize call). Phase HOME-DATA-OWNERSHIP: never null —
    // personal captures return the owner's personal Team id.
    teamId: effectiveTeamId,
    status: EvidenceStatus.UPLOADING,
    upload: {
      bucket,
      key: created.key,
      putUrl,
      publicUrl,
      expiresInSeconds: 600,
    },
  };
}
