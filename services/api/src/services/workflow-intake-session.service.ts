/**
 * Phase 4 — Workflow intake session lifecycle service.
 *
 * Handles the contributor-facing redemption flow:
 *   1. validateIntakeToken — resolves a raw token to an active link.
 *   2. openIntakeSession — moves a session into OPENED (or creates one if
 *      this is the first redemption of the link).
 *   3. recordConsent — captures the contributor's consent acceptance.
 *   4. transitionSession — applies a guarded status change.
 *   5. abandonSession / expireSession / revokeSession — terminal moves.
 *
 * What this service does NOT do (Phase 5+):
 *   - Initiate S3 presigning. The session becomes attached to a
 *     CaptureSession only when a future upload-orchestration layer wires
 *     it in.
 *   - Generate Evidence rows. Submission writes evidenceId here once the
 *     existing evidence pipeline finalizes the underlying CaptureSession.
 *
 * Forensic guarantees:
 *   - Status transitions go through the canonical state machine in
 *     @proovra/shared/workflow-intake-link.ts. Illegal transitions throw
 *     and are surfaced to the caller as 409 errors.
 *   - Every transition that materializes a contributor-visible action
 *     emits a CustodyEvent when an Evidence row already exists; otherwise
 *     a row-level audit (link.used_count, session.openedAtUtc, etc.) is
 *     written.
 */

import { Prisma } from "@prisma/client";
import type {
  PrismaClient,
  WorkflowIntakeLink as DbWorkflowIntakeLink,
  WorkflowIntakeSession as DbWorkflowIntakeSession,
} from "@prisma/client";
import {
  canTransitionWorkflowIntakeSession,
  isTerminalWorkflowIntakeSessionStatus,
  WorkflowIntakeConsentSnapshot,
  WorkflowIntakeConsentSnapshotSchema,
  WorkflowIntakeMode,
  WorkflowIntakeSessionStatus,
  isAnonymousWorkflowIntakeMode,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../db.js";
import {
  constantTimeEqualHex,
  hmacForIntake,
  lookupHashForIntakeToken,
} from "./workflow-intake-token.service.js";

// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------

export type WorkflowIntakeSessionErrorCode =
  | "feature_disabled"
  | "token_invalid"
  | "link_not_found"
  | "link_revoked"
  | "link_expired"
  | "link_exhausted"
  // ONE_TIME link reopened after the contributor already submitted.
  // Distinguished from `link_exhausted` so the public page can render
  // a friendly "you already submitted" completion message instead of
  // a generic "this link no longer works" error. Triggered when
  // usedCount >= 1 AND maxUses === 1 AND link.status === EXPIRED.
  | "link_already_submitted"
  | "session_not_found"
  | "session_link_mismatch"
  | "session_expired"
  | "session_revoked"
  | "session_terminal"
  | "transition_not_allowed"
  | "consent_not_accepted"
  | "consent_invalid_payload"
  | "intake_mode_mismatch";

export class WorkflowIntakeSessionError extends Error {
  constructor(
    public readonly code: WorkflowIntakeSessionErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "WorkflowIntakeSessionError";
  }
}

// -----------------------------------------------------------------------------
// Token validation
// -----------------------------------------------------------------------------

export type ValidatedIntakeToken = {
  link: DbWorkflowIntakeLink;
  reason: "ok";
};

export async function validateIntakeToken(
  rawToken: string,
  client: PrismaClient = defaultPrisma,
): Promise<ValidatedIntakeToken> {
  const lookup = lookupHashForIntakeToken(rawToken);
  if (!lookup) throw new WorkflowIntakeSessionError("token_invalid");

  const link = await client.workflowIntakeLink.findUnique({
    where: { tokenHash: lookup.tokenHash },
  });
  if (!link) throw new WorkflowIntakeSessionError("token_invalid");

  // Defense-in-depth: confirm hash match in constant time. Postgres unique
  // index already guarantees match but the explicit check protects against
  // theoretical row-poisoning scenarios where the column was tampered with.
  if (!constantTimeEqualHex(link.tokenHash, lookup.tokenHash)) {
    throw new WorkflowIntakeSessionError("token_invalid");
  }

  if (link.status === "REVOKED") {
    throw new WorkflowIntakeSessionError("link_revoked");
  }
  const now = new Date();
  if (link.expiresAtUtc.getTime() <= now.getTime()) {
    throw new WorkflowIntakeSessionError("link_expired");
  }
  if (link.status === "EXPIRED") {
    throw new WorkflowIntakeSessionError("link_expired");
  }
  if (link.usedCount >= link.maxUses) {
    // Distinguish "already submitted" (the common, friendly case for
    // ONE_TIME links a contributor reopens) from generic exhaustion.
    // ONE_TIME links by convention have maxUses === 1; once submitted
    // their usedCount is 1 and status flips to EXPIRED in the
    // `transitionIntakeSession → SUBMITTED` block. Surfacing this as
    // its own error lets the public page render a "Submission
    // completed" read-only screen instead of a hostile "link expired"
    // message.
    if (link.maxUses === 1 && link.usedCount >= 1) {
      throw new WorkflowIntakeSessionError("link_already_submitted");
    }
    throw new WorkflowIntakeSessionError("link_exhausted");
  }

  return { link, reason: "ok" };
}

// -----------------------------------------------------------------------------
// Public projection — exposed to anonymous contributors. NEVER returns the
// workspace internals or any hashed identifier.
// -----------------------------------------------------------------------------

export type ExternalIntakeLinkPublicStep = {
  id: string;
  title: string;
  description: string;
  purposeLabel: string;
  required: boolean;
  acceptedKinds: string[];
};

export type ExternalIntakeLinkPublicView = {
  workflowTemplateSlug: string;
  workflowTemplateName: string;
  workflowTemplateDescription: string;
  workflowTemplateLocationRequirement: string;
  workflowTemplatePlanMode: string;
  steps: ExternalIntakeLinkPublicStep[];
  intakeMode: WorkflowIntakeMode;
  isAnonymous: boolean;
  consentPolicyVersion: string | null;
  consentDisclosureText: string | null;
  allowedAcceptedKinds: string[];
  maxFileCountPerSession: number | null;
  expiresAtUtc: string;
  // Operator-chosen location-collection policy for THIS link. Drives
  // the contributor page geolocation UX (NONE = no prompt, OPTIONAL =
  // Share/Skip, REQUIRED = blocks submit until granted). Stored as
  // the raw string so future enum values flow through without a code
  // change; the web client narrows via the shared type-guard.
  locationPolicy: string;
};

const ACCEPTED_KIND_SET = new Set(["PHOTO", "VIDEO", "AUDIO", "DOCUMENT"]);

function projectSnapshotSteps(
  snapshot: { steps?: unknown } | null | undefined,
): ExternalIntakeLinkPublicStep[] {
  if (!snapshot || !Array.isArray(snapshot.steps)) return [];
  const out: ExternalIntakeLinkPublicStep[] = [];
  for (const raw of snapshot.steps) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.id !== "string" || r.id.length === 0) continue;
    if (typeof r.title !== "string" || r.title.length === 0) continue;
    if (typeof r.purposeLabel !== "string") continue;
    const acceptedKinds = Array.isArray(r.acceptedKinds)
      ? r.acceptedKinds.filter(
          (k): k is string => typeof k === "string" && ACCEPTED_KIND_SET.has(k),
        )
      : [];
    out.push({
      id: r.id.slice(0, 120),
      title: r.title.slice(0, 180),
      description:
        typeof r.description === "string" ? r.description.slice(0, 2000) : "",
      purposeLabel: r.purposeLabel.slice(0, 120),
      required: r.required === true,
      acceptedKinds,
    });
  }
  return out;
}

export function projectIntakeLinkForExternalView(
  link: DbWorkflowIntakeLink,
): ExternalIntakeLinkPublicView {
  // Pull display fields from the snapshot — never from the live template
  // (the contributor must see what was promised at link creation).
  const snapshot = link.workflowTemplateSnapshot as {
    name?: string;
    description?: string;
    locationRequirement?: string;
    planMode?: string;
    steps?: unknown;
  } | null;

  return {
    workflowTemplateSlug: link.workflowTemplateSlug,
    workflowTemplateName: typeof snapshot?.name === "string"
      ? snapshot.name
      : link.workflowTemplateSlug,
    workflowTemplateDescription:
      typeof snapshot?.description === "string" ? snapshot.description : "",
    workflowTemplateLocationRequirement:
      typeof snapshot?.locationRequirement === "string"
        ? snapshot.locationRequirement
        : "optional",
    workflowTemplatePlanMode:
      typeof snapshot?.planMode === "string" ? snapshot.planMode : "FLEXIBLE",
    steps: projectSnapshotSteps(snapshot),
    intakeMode: link.intakeMode as WorkflowIntakeMode,
    isAnonymous: isAnonymousWorkflowIntakeMode(
      link.intakeMode as WorkflowIntakeMode,
    ),
    consentPolicyVersion: link.consentPolicyVersion,
    consentDisclosureText: link.consentDisclosureText,
    allowedAcceptedKinds: link.allowedAcceptedKinds,
    maxFileCountPerSession: link.maxFileCountPerSession,
    expiresAtUtc: link.expiresAtUtc.toISOString(),
    locationPolicy: link.locationPolicy,
  };
}

// -----------------------------------------------------------------------------
// Open / create session
// -----------------------------------------------------------------------------

export type OpenIntakeSessionInput = {
  link: DbWorkflowIntakeLink;
  submitterIp?: string | null;
  submitterUserAgent?: string | null;
  pseudonym?: string | null;
  submitterDisplayName?: string | null;
  submitterEmail?: string | null;
};

export async function openIntakeSession(
  input: OpenIntakeSessionInput,
  client: PrismaClient = defaultPrisma,
): Promise<DbWorkflowIntakeSession> {
  const now = new Date();
  const submitterIpHash = input.submitterIp
    ? hmacForIntake(input.submitterIp)
    : null;
  const userAgent = input.submitterUserAgent?.slice(0, 512) ?? null;

  // For ANONYMOUS / PSEUDONYMOUS, ignore submitter identity fields except
  // the pseudonym. For ONE_TIME / REUSABLE, the contributor can opt in.
  const anonymous = isAnonymousWorkflowIntakeMode(
    input.link.intakeMode as WorkflowIntakeMode,
  );
  const displayName = anonymous ? null : input.submitterDisplayName ?? null;
  const email = anonymous ? null : input.submitterEmail ?? null;
  const pseudonym =
    input.link.intakeMode === "EXTERNAL_PSEUDONYMOUS"
      ? input.pseudonym?.slice(0, 80) ?? null
      : null;

  return client.workflowIntakeSession.create({
    data: {
      intakeLinkId: input.link.id,
      status: "OPENED",
      openedAtUtc: now,
      expiresAtUtc: input.link.expiresAtUtc,
      submitterIpHash,
      submitterUserAgent: userAgent,
      submitterDisplayName: displayName,
      submitterEmail: email,
      pseudonym,
    },
  });
}

// -----------------------------------------------------------------------------
// Record consent
// -----------------------------------------------------------------------------

export type RecordConsentInput = {
  sessionId: string;
  expectedLinkId: string;
  consent: unknown;
};

export async function recordIntakeConsent(
  input: RecordConsentInput,
  client: PrismaClient = defaultPrisma,
): Promise<DbWorkflowIntakeSession> {
  const parsed = WorkflowIntakeConsentSnapshotSchema.safeParse(input.consent);
  if (!parsed.success) {
    throw new WorkflowIntakeSessionError("consent_invalid_payload");
  }

  const session = await client.workflowIntakeSession.findUnique({
    where: { id: input.sessionId },
  });
  if (!session) throw new WorkflowIntakeSessionError("session_not_found");
  if (session.intakeLinkId !== input.expectedLinkId) {
    throw new WorkflowIntakeSessionError("session_link_mismatch");
  }
  if (isTerminalWorkflowIntakeSessionStatus(session.status)) {
    throw new WorkflowIntakeSessionError("session_terminal");
  }

  const consent: WorkflowIntakeConsentSnapshot = parsed.data;

  return client.workflowIntakeSession.update({
    where: { id: session.id },
    data: {
      consentAcceptedAtUtc: new Date(consent.acceptedAtUtc),
      consentSnapshotJson: consent as unknown as Prisma.InputJsonValue,
    },
  });
}

// -----------------------------------------------------------------------------
// Status transition
// -----------------------------------------------------------------------------

export type TransitionIntakeSessionInput = {
  sessionId: string;
  expectedLinkId: string;
  to: WorkflowIntakeSessionStatus;
  requireConsent?: boolean;
};

export async function transitionIntakeSession(
  input: TransitionIntakeSessionInput,
  client: PrismaClient = defaultPrisma,
): Promise<DbWorkflowIntakeSession> {
  const session = await client.workflowIntakeSession.findUnique({
    where: { id: input.sessionId },
  });
  if (!session) throw new WorkflowIntakeSessionError("session_not_found");
  if (session.intakeLinkId !== input.expectedLinkId) {
    throw new WorkflowIntakeSessionError("session_link_mismatch");
  }

  const transition = canTransitionWorkflowIntakeSession(
    session.status as WorkflowIntakeSessionStatus,
    input.to,
  );
  if (!transition.ok) {
    if (
      transition.reason === "terminal_from_status"
    ) {
      throw new WorkflowIntakeSessionError(
        "session_terminal",
        // Include from/to in the diagnostic so a 409 in production
        // logs names the exact state pair that failed. Never reveals
        // tokens or PII — just enum values.
        `Session already in terminal state: from=${session.status} to=${input.to}`,
      );
    }
    throw new WorkflowIntakeSessionError(
      "transition_not_allowed",
      `Disallowed transition: from=${session.status} to=${input.to}`,
    );
  }

  // Consent is required before the contributor can move from OPENED into
  // any upload state. The check is enforced here rather than on every
  // route so callers cannot accidentally skip it.
  if (input.requireConsent !== false) {
    const requiresConsentForTo =
      input.to === "UPLOAD_STARTED" ||
      input.to === "UPLOAD_COMPLETED" ||
      input.to === "SUBMITTED";
    if (requiresConsentForTo && !session.consentAcceptedAtUtc) {
      throw new WorkflowIntakeSessionError("consent_not_accepted");
    }
  }

  const now = new Date();
  const data: Prisma.WorkflowIntakeSessionUpdateInput = {
    status: input.to,
  };
  switch (input.to) {
    case "OPENED":
      data.openedAtUtc = now;
      break;
    case "UPLOAD_STARTED":
      data.uploadStartedAtUtc = now;
      break;
    case "UPLOAD_COMPLETED":
      data.uploadCompletedAtUtc = now;
      break;
    case "SUBMITTED":
      data.submittedAtUtc = now;
      break;
    case "ABANDONED":
      data.abandonedAtUtc = now;
      break;
    case "REVOKED":
      data.revokedAtUtc = now;
      break;
    // EXPIRED is a passive transition: the row's expiresAtUtc has elapsed.
    // No specific column to update.
    case "EXPIRED":
    case "CREATED":
      break;
  }

  // If submission is happening, bump the link's usedCount. For ONE_TIME
  // links (those with maxUses === 1) we additionally flip the link to
  // EXPIRED so any in-flight attempts to open a new session fail fast,
  // independent of the usedCount >= maxUses check in validateIntakeToken.
  if (input.to === "SUBMITTED") {
    const link = await client.workflowIntakeLink.findUnique({
      where: { id: session.intakeLinkId },
      select: { maxUses: true, status: true },
    });
    const isOneTime = link?.maxUses === 1;
    await client.workflowIntakeLink.update({
      where: { id: session.intakeLinkId },
      data: {
        usedCount: { increment: 1 },
        ...(isOneTime && link?.status === "ACTIVE"
          ? { status: "EXPIRED" as const }
          : {}),
      },
    });
  }

  return client.workflowIntakeSession.update({
    where: { id: session.id },
    data,
  });
}

// -----------------------------------------------------------------------------
// Get session
// -----------------------------------------------------------------------------

export async function getIntakeSession(
  id: string,
  client: PrismaClient = defaultPrisma,
): Promise<DbWorkflowIntakeSession | null> {
  return client.workflowIntakeSession.findUnique({ where: { id } });
}

// -----------------------------------------------------------------------------
// Public projection — for the contributor's view of their own session.
// NEVER returns workspace internals.
// -----------------------------------------------------------------------------

export function projectIntakeSessionForExternalView(
  session: DbWorkflowIntakeSession,
): {
  id: string;
  status: WorkflowIntakeSessionStatus;
  openedAtUtc: string | null;
  uploadStartedAtUtc: string | null;
  uploadCompletedAtUtc: string | null;
  submittedAtUtc: string | null;
  abandonedAtUtc: string | null;
  expiresAtUtc: string;
  consentAcceptedAtUtc: string | null;
} {
  return {
    id: session.id,
    status: session.status as WorkflowIntakeSessionStatus,
    openedAtUtc: session.openedAtUtc?.toISOString() ?? null,
    uploadStartedAtUtc: session.uploadStartedAtUtc?.toISOString() ?? null,
    uploadCompletedAtUtc:
      session.uploadCompletedAtUtc?.toISOString() ?? null,
    submittedAtUtc: session.submittedAtUtc?.toISOString() ?? null,
    abandonedAtUtc: session.abandonedAtUtc?.toISOString() ?? null,
    expiresAtUtc: session.expiresAtUtc.toISOString(),
    consentAcceptedAtUtc: session.consentAcceptedAtUtc?.toISOString() ?? null,
  };
}
