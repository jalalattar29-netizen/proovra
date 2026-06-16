/**
 * Phase 4 — Workflow Intake Link primitives.
 *
 * Canonical, provider-agnostic types that describe an *external contributor
 * intake link* and its *session lifecycle*. The same shapes are used for
 * insurance claim intake, legal witness uploads, journalism source-safe
 * intake, investigation field uploads, compliance contributions, and any
 * future vertical — there are no insurance/legal/journalism-specific types
 * in this module on purpose.
 *
 * What this module does NOT do:
 *   - It does not implement token issuance/verification (that lives in the
 *     API package because it depends on a server-side HMAC secret).
 *   - It does not implement persistence (that is Prisma).
 *   - It does not implement upload orchestration (that reuses the existing
 *     authenticated capture pipeline).
 *
 * Failure-mode rule, mirroring Phase 3:
 *   - Every helper degrades to a typed result rather than throwing.
 *   - Status transitions are validated against an explicit machine, never
 *     ad-hoc.
 */

import { z } from "zod";

// -----------------------------------------------------------------------------
// Intake link status
//
// Distinct from the *session* status. A link's status describes the link
// itself (can it still be redeemed?), independent of any individual
// contributor session born from it.
// -----------------------------------------------------------------------------

export const WORKFLOW_INTAKE_LINK_STATUSES = [
  "ACTIVE",
  "REVOKED",
  "EXPIRED",
] as const;
export const WorkflowIntakeLinkStatusSchema = z.enum(WORKFLOW_INTAKE_LINK_STATUSES);
export type WorkflowIntakeLinkStatus = z.infer<typeof WorkflowIntakeLinkStatusSchema>;

// -----------------------------------------------------------------------------
// Intake session lifecycle
//
// Tracks the per-contributor lifecycle of a redemption. A single REUSABLE
// link can produce many sessions. ONE_TIME links produce exactly one
// SUBMITTED session before the link itself transitions to REVOKED/EXPIRED.
// -----------------------------------------------------------------------------

export const WORKFLOW_INTAKE_SESSION_STATUSES = [
  "CREATED",
  "OPENED",
  "UPLOAD_STARTED",
  "UPLOAD_COMPLETED",
  "SUBMITTED",
  "EXPIRED",
  "REVOKED",
  "ABANDONED",
] as const;
export const WorkflowIntakeSessionStatusSchema = z.enum(
  WORKFLOW_INTAKE_SESSION_STATUSES,
);
export type WorkflowIntakeSessionStatus = z.infer<
  typeof WorkflowIntakeSessionStatusSchema
>;

// Terminal states: no further transitions allowed.
const TERMINAL_SESSION_STATUSES: ReadonlyArray<WorkflowIntakeSessionStatus> = [
  "SUBMITTED",
  "EXPIRED",
  "REVOKED",
  "ABANDONED",
];

export function isTerminalWorkflowIntakeSessionStatus(
  status: WorkflowIntakeSessionStatus,
): boolean {
  return TERMINAL_SESSION_STATUSES.includes(status);
}

/**
 * Allowed transitions per status. Keys are the FROM status, values are the
 * set of TO statuses that are legal. Treat any unknown FROM as "no
 * transitions allowed" so a corrupted row can't silently advance.
 *
 * Intentional asymmetries:
 *   - SUBMITTED is a happy-path terminal state; once submitted the
 *     contributor cannot go back.
 *   - EXPIRED and REVOKED are reachable from any non-terminal state — the
 *     system always has the right to time-out or revoke.
 *   - ABANDONED is reachable from OPENED / UPLOAD_STARTED / UPLOAD_COMPLETED
 *     but NOT from CREATED (which means the contributor never opened the
 *     link — there's nothing to abandon yet).
 */
const ALLOWED_TRANSITIONS: Readonly<
  Record<WorkflowIntakeSessionStatus, ReadonlyArray<WorkflowIntakeSessionStatus>>
> = {
  CREATED: ["OPENED", "EXPIRED", "REVOKED"],
  OPENED: [
    "UPLOAD_STARTED",
    "ABANDONED",
    "EXPIRED",
    "REVOKED",
    "SUBMITTED", // path: an external contributor may submit a zero-file session if the workflow allows it
  ],
  UPLOAD_STARTED: [
    "UPLOAD_COMPLETED",
    // Forensic P0 bugfix — the contributor flow goes:
    //   open link → "Add files" (bumps OPENED → UPLOAD_STARTED) →
    //   PUT to S3 → "Submit Evidence"
    // Nothing in the public flow ever transitions to UPLOAD_COMPLETED
    // (that's an enterprise/multi-stage marker). Without SUBMITTED
    // in this list, every fresh upload-then-submit returned 409
    // `transition_not_allowed`. Production request
    // 0500d474-61e4-4453-a51f-ae0ae33f66ca hit exactly this path.
    "SUBMITTED",
    "ABANDONED",
    "EXPIRED",
    "REVOKED",
  ],
  UPLOAD_COMPLETED: [
    "SUBMITTED",
    "ABANDONED",
    "EXPIRED",
    "REVOKED",
  ],
  SUBMITTED: [],
  EXPIRED: [],
  REVOKED: [],
  ABANDONED: [],
};

export type WorkflowIntakeSessionTransitionResult = {
  ok: boolean;
  reason:
    | "ok"
    | "terminal_from_status"
    | "transition_not_allowed"
    | "unknown_from_status"
    | "unknown_to_status";
};

export function canTransitionWorkflowIntakeSession(
  from: WorkflowIntakeSessionStatus,
  to: WorkflowIntakeSessionStatus,
): WorkflowIntakeSessionTransitionResult {
  const allowed = ALLOWED_TRANSITIONS[from];
  if (!allowed) return { ok: false, reason: "unknown_from_status" };
  if (TERMINAL_SESSION_STATUSES.includes(from)) {
    return { ok: false, reason: "terminal_from_status" };
  }
  if (!WORKFLOW_INTAKE_SESSION_STATUSES.includes(to)) {
    return { ok: false, reason: "unknown_to_status" };
  }
  if (!allowed.includes(to)) {
    return { ok: false, reason: "transition_not_allowed" };
  }
  return { ok: true, reason: "ok" };
}

// -----------------------------------------------------------------------------
// Token format
//
// Opaque, URL-safe, version-prefixed. The server stores only an HMAC of the
// token (never the raw value). This module declares the format constants;
// the API package implements issuance/verification.
// -----------------------------------------------------------------------------

export const WORKFLOW_INTAKE_TOKEN_PREFIX = "pwi";
export const WORKFLOW_INTAKE_TOKEN_VERSION = 1;
export const WORKFLOW_INTAKE_TOKEN_RANDOM_BYTES = 32;

const TOKEN_PATTERN = /^pwi_v(\d+)_([A-Za-z0-9_-]+)$/;

export type WorkflowIntakeTokenShape = {
  raw: string;
  version: number;
  body: string;
};

export function parseWorkflowIntakeTokenShape(
  token: string,
): WorkflowIntakeTokenShape | null {
  if (typeof token !== "string") return null;
  const match = TOKEN_PATTERN.exec(token);
  if (!match) return null;
  const version = Number.parseInt(match[1], 10);
  if (!Number.isFinite(version) || version < 1) return null;
  if (match[2].length < 16) return null;
  return { raw: token, version, body: match[2] };
}

export function formatWorkflowIntakeTokenWireValue(body: string): string {
  return `${WORKFLOW_INTAKE_TOKEN_PREFIX}_v${WORKFLOW_INTAKE_TOKEN_VERSION}_${body}`;
}

// -----------------------------------------------------------------------------
// Consent snapshot
//
// Frozen at the moment a contributor accepts the disclosure. Goes into the
// CustodyEvent and onto WorkflowIntakeSession.consentSnapshotJson so the
// audit trail can prove what the contributor saw and accepted.
// -----------------------------------------------------------------------------

export const WorkflowIntakeConsentSnapshotSchema = z.object({
  acceptedAtUtc: z.string().datetime(),
  policyVersion: z.string().min(1).max(40),
  disclosureTextHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/i, { message: "expected 64-char hex SHA-256" }),
  termsAcknowledged: z.boolean(),
  identityDisclosed: z.boolean(),
  ipHash: z.string().regex(/^[a-f0-9]{64}$/i).nullable(),
  userAgent: z.string().max(512).nullable(),
});
export type WorkflowIntakeConsentSnapshot = z.infer<
  typeof WorkflowIntakeConsentSnapshotSchema
>;
