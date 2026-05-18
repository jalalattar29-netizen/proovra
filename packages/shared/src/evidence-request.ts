/**
 * Phase 7 — Evidence Request canonical types + state machine.
 *
 * Provider-agnostic. There is NO insurance/legal/journalism/investigation-
 * specific type in this module. Verticals are represented through the
 * workflow template a request binds to, plus the deliverables on the
 * request itself.
 *
 * Reuse statement:
 *   - Status / priority / lifecycle live here so every consumer (API,
 *     web, future worker hooks) reads from one source of truth.
 *   - Transitions are validated by a single guard function. Routes call
 *     it. UI never calls service functions that bypass it.
 *
 * Legally-safe language is enforced via the `STATUS_LABEL` map below.
 * Producers MUST render statuses using these labels in any
 * external-facing surface. On-the-wire enum values can be the raw
 * machine identifiers.
 */

import { z } from "zod";

// -----------------------------------------------------------------------------
// EvidenceRequest status
// -----------------------------------------------------------------------------

export const EVIDENCE_REQUEST_STATUSES = [
  "DRAFT",
  "OPEN",
  "SENT",
  "VIEWED",
  "IN_PROGRESS",
  "RESPONSE_RECEIVED",
  "UNDER_REVIEW",
  "PARTIALLY_FULFILLED",
  "FULFILLED",
  "NEEDS_MORE_INFO",
  "CANCELLED",
  "CLOSED",
] as const;
export const EvidenceRequestStatusSchema = z.enum(EVIDENCE_REQUEST_STATUSES);
export type EvidenceRequestStatus = z.infer<typeof EvidenceRequestStatusSchema>;

const TERMINAL_REQUEST_STATUSES: ReadonlyArray<EvidenceRequestStatus> = [
  "CANCELLED",
  "CLOSED",
];

export function isTerminalEvidenceRequestStatus(
  status: EvidenceRequestStatus,
): boolean {
  return TERMINAL_REQUEST_STATUSES.includes(status);
}

/**
 * Status transition table. Keys are the FROM status; values are the set of
 * legal TO statuses.
 *
 * Forward path: DRAFT → OPEN → SENT → VIEWED → IN_PROGRESS → RESPONSE_RECEIVED
 *               → UNDER_REVIEW → (PARTIALLY_FULFILLED | FULFILLED |
 *                                 NEEDS_MORE_INFO | CLOSED)
 *
 * NEEDS_MORE_INFO can re-open into RESPONSE_RECEIVED when a follow-up
 * submission arrives. PARTIALLY_FULFILLED can advance to FULFILLED.
 *
 * CANCELLED and CLOSED are terminal — no transitions out.
 *
 * CANCELLED is reachable from any non-terminal status (admin can always
 * cancel an open request).
 *
 * "Re-open" is a deliberate path: a closed request cannot be re-opened.
 * That keeps the audit trail honest — to ask for more, create a new
 * request.
 */
const ALLOWED_REQUEST_TRANSITIONS: Readonly<
  Record<EvidenceRequestStatus, ReadonlyArray<EvidenceRequestStatus>>
> = {
  DRAFT: ["OPEN", "CANCELLED"],
  OPEN: ["SENT", "IN_PROGRESS", "CANCELLED", "CLOSED"],
  SENT: ["VIEWED", "IN_PROGRESS", "RESPONSE_RECEIVED", "CANCELLED", "CLOSED"],
  VIEWED: ["IN_PROGRESS", "RESPONSE_RECEIVED", "CANCELLED", "CLOSED"],
  IN_PROGRESS: ["RESPONSE_RECEIVED", "CANCELLED", "CLOSED"],
  RESPONSE_RECEIVED: [
    "UNDER_REVIEW",
    "PARTIALLY_FULFILLED",
    "FULFILLED",
    "NEEDS_MORE_INFO",
    "CANCELLED",
    "CLOSED",
  ],
  UNDER_REVIEW: [
    "PARTIALLY_FULFILLED",
    "FULFILLED",
    "NEEDS_MORE_INFO",
    "CANCELLED",
    "CLOSED",
  ],
  PARTIALLY_FULFILLED: [
    "FULFILLED",
    "NEEDS_MORE_INFO",
    "CLOSED",
    "CANCELLED",
  ],
  FULFILLED: ["NEEDS_MORE_INFO", "CLOSED", "CANCELLED"],
  NEEDS_MORE_INFO: [
    "RESPONSE_RECEIVED",
    "IN_PROGRESS",
    "CANCELLED",
    "CLOSED",
  ],
  CANCELLED: [],
  CLOSED: [],
};

export type EvidenceRequestTransitionResult = {
  ok: boolean;
  reason:
    | "ok"
    | "terminal_from_status"
    | "transition_not_allowed"
    | "unknown_from_status"
    | "unknown_to_status";
};

export function canTransitionEvidenceRequest(
  from: EvidenceRequestStatus,
  to: EvidenceRequestStatus,
): EvidenceRequestTransitionResult {
  const allowed = ALLOWED_REQUEST_TRANSITIONS[from];
  if (!allowed) return { ok: false, reason: "unknown_from_status" };
  if (TERMINAL_REQUEST_STATUSES.includes(from)) {
    return { ok: false, reason: "terminal_from_status" };
  }
  if (!EVIDENCE_REQUEST_STATUSES.includes(to)) {
    return { ok: false, reason: "unknown_to_status" };
  }
  if (!allowed.includes(to)) {
    return { ok: false, reason: "transition_not_allowed" };
  }
  return { ok: true, reason: "ok" };
}

// -----------------------------------------------------------------------------
// Priorities (mirror existing EvidenceReviewWorkflowPriority shape so the
// review queue can render consistently)
// -----------------------------------------------------------------------------

export const EVIDENCE_REQUEST_PRIORITIES = [
  "LOW",
  "NORMAL",
  "HIGH",
  "URGENT",
] as const;
export const EvidenceRequestPrioritySchema = z.enum(EVIDENCE_REQUEST_PRIORITIES);
export type EvidenceRequestPriority = z.infer<typeof EvidenceRequestPrioritySchema>;

// -----------------------------------------------------------------------------
// Request types
// -----------------------------------------------------------------------------

export const EVIDENCE_REQUEST_TYPES = [
  "ADDITIONAL_EVIDENCE",
  "CLARIFICATION",
  "REPLACEMENT_FILE",
  "WITNESS_STATEMENT",
  "DOCUMENT",
  "OTHER",
] as const;
export const EvidenceRequestTypeSchema = z.enum(EVIDENCE_REQUEST_TYPES);
export type EvidenceRequestType = z.infer<typeof EvidenceRequestTypeSchema>;

// -----------------------------------------------------------------------------
// Recipient mode
// -----------------------------------------------------------------------------

export const EVIDENCE_REQUEST_RECIPIENT_MODES = [
  "INTERNAL_USER",
  "EXTERNAL_CONTRIBUTOR",
  "ANONYMOUS_SOURCE",
  "PSEUDONYMOUS_SOURCE",
] as const;
export const EvidenceRequestRecipientModeSchema = z.enum(
  EVIDENCE_REQUEST_RECIPIENT_MODES,
);
export type EvidenceRequestRecipientMode = z.infer<
  typeof EvidenceRequestRecipientModeSchema
>;

export function isExternalRecipientMode(
  mode: EvidenceRequestRecipientMode,
): boolean {
  return (
    mode === "EXTERNAL_CONTRIBUTOR" ||
    mode === "ANONYMOUS_SOURCE" ||
    mode === "PSEUDONYMOUS_SOURCE"
  );
}

// -----------------------------------------------------------------------------
// Deliverable status
// -----------------------------------------------------------------------------

export const EVIDENCE_REQUEST_DELIVERABLE_STATUSES = [
  "PENDING",
  "PARTIALLY_FULFILLED",
  "FULFILLED",
  "WAIVED",
  "REJECTED",
] as const;
export const EvidenceRequestDeliverableStatusSchema = z.enum(
  EVIDENCE_REQUEST_DELIVERABLE_STATUSES,
);
export type EvidenceRequestDeliverableStatus = z.infer<
  typeof EvidenceRequestDeliverableStatusSchema
>;

// -----------------------------------------------------------------------------
// Response status
// -----------------------------------------------------------------------------

export const EVIDENCE_REQUEST_RESPONSE_STATUSES = [
  "RECEIVED",
  "UNDER_REVIEW",
  "ACCEPTED",
  "NEEDS_MORE_INFO",
  "REJECTED",
] as const;
export const EvidenceRequestResponseStatusSchema = z.enum(
  EVIDENCE_REQUEST_RESPONSE_STATUSES,
);
export type EvidenceRequestResponseStatus = z.infer<
  typeof EvidenceRequestResponseStatusSchema
>;

// -----------------------------------------------------------------------------
// Legally-safe display labels
//
// Producers MUST use these for any human-facing rendering. The on-the-wire
// values are stable machine identifiers; labels are what end users see.
// -----------------------------------------------------------------------------

export const EVIDENCE_REQUEST_STATUS_LABEL: Readonly<
  Record<EvidenceRequestStatus, string>
> = {
  DRAFT: "Draft",
  OPEN: "Open",
  SENT: "Sent",
  VIEWED: "Viewed",
  IN_PROGRESS: "In progress",
  RESPONSE_RECEIVED: "Response received",
  UNDER_REVIEW: "Under internal review",
  PARTIALLY_FULFILLED: "Partially fulfilled",
  FULFILLED: "Fulfilled",
  NEEDS_MORE_INFO: "Needs additional context",
  CANCELLED: "Cancelled",
  CLOSED: "Closed",
};

export const EVIDENCE_REQUEST_DELIVERABLE_STATUS_LABEL: Readonly<
  Record<EvidenceRequestDeliverableStatus, string>
> = {
  PENDING: "Pending",
  PARTIALLY_FULFILLED: "Partially fulfilled",
  FULFILLED: "Fulfilled",
  WAIVED: "Waived",
  REJECTED: "Rejected as insufficient",
};

export const EVIDENCE_REQUEST_RESPONSE_STATUS_LABEL: Readonly<
  Record<EvidenceRequestResponseStatus, string>
> = {
  RECEIVED: "Received",
  UNDER_REVIEW: "Under internal review",
  ACCEPTED: "Accepted for internal review",
  NEEDS_MORE_INFO: "Needs additional context",
  REJECTED: "Rejected as insufficient",
};

// -----------------------------------------------------------------------------
// Deliverable shape (snapshot-safe)
// -----------------------------------------------------------------------------

export const EvidenceRequestDeliverableInputSchema = z.object({
  title: z.string().min(1).max(180),
  description: z.string().max(2000).default(""),
  required: z.boolean().default(true),
  acceptedKinds: z
    .array(z.enum(["PHOTO", "VIDEO", "AUDIO", "DOCUMENT"]))
    .min(1)
    .max(4),
  minCount: z.number().int().min(0).max(100).default(1),
  maxCount: z.number().int().min(1).max(100).optional(),
  locationRequirement: z
    .enum(["required", "recommended", "optional"])
    .default("optional"),
  captureAfterRequest: z.boolean().default(false),
  workflowStepId: z.string().max(120).nullable().optional(),
  sortOrder: z.number().int().min(0).max(999).default(0),
});
export type EvidenceRequestDeliverableInput = z.infer<
  typeof EvidenceRequestDeliverableInputSchema
>;

// -----------------------------------------------------------------------------
// Request input
// -----------------------------------------------------------------------------

export const EvidenceRequestInputSchema = z.object({
  teamId: z.string().uuid(),
  evidenceId: z.string().uuid().nullable().optional(),
  caseId: z.string().uuid().nullable().optional(),
  workflowTemplateSlug: z.string().min(1).max(120).nullable().optional(),
  workflowStepId: z.string().max(120).nullable().optional(),
  requestType: EvidenceRequestTypeSchema,
  title: z.string().min(1).max(180),
  instructions: z.string().max(4000).default(""),
  priority: EvidenceRequestPrioritySchema.default("NORMAL"),
  dueAtUtc: z.string().datetime().nullable().optional(),
  recipientMode: EvidenceRequestRecipientModeSchema,
  recipientLabel: z.string().max(180).nullable().optional(),
  recipientEmail: z.string().email().nullable().optional(),
  recipientPhone: z.string().max(32).nullable().optional(),
  assignedReviewerUserId: z.string().uuid().nullable().optional(),
  createIntakeLink: z.boolean().default(true),
  deliverables: z.array(EvidenceRequestDeliverableInputSchema).max(32).default([]),
});
export type EvidenceRequestInput = z.infer<typeof EvidenceRequestInputSchema>;
