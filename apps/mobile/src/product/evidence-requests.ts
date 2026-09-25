/**
 * CANONICAL NATIVE EVIDENCE REQUESTS (Master Program §8, Workstream E) — pure.
 *
 * GET /v1/evidence-requests?teamId=… → { requests[] } and GET /v1/evidence-
 * requests/:id → { request } (member-accessible; the contributor/token flow is a
 * separate public surface and stays on web). These parse the authenticated
 * projection and map status → tone; the RN screens are thin shells.
 */
import type { ProovraStatusTone } from "@proovra/ui";
import { humanizeEnum } from "./domain-display";

export const EVIDENCE_REQUEST_STATUSES = [
  "DRAFT", "OPEN", "SENT", "VIEWED", "IN_PROGRESS", "RESPONSE_RECEIVED",
  "UNDER_REVIEW", "PARTIALLY_FULFILLED", "FULFILLED", "NEEDS_MORE_INFO",
  "CANCELLED", "CLOSED",
] as const;

const STATUS_TONE: Record<string, ProovraStatusTone> = {
  DRAFT: "neutral",
  OPEN: "info",
  SENT: "info",
  VIEWED: "info",
  IN_PROGRESS: "info",
  RESPONSE_RECEIVED: "pending",
  UNDER_REVIEW: "pending",
  PARTIALLY_FULFILLED: "pending",
  NEEDS_MORE_INFO: "pending",
  FULFILLED: "verified",
  CLOSED: "verified",
  CANCELLED: "neutral",
};

export function requestStatusDisplay(status: string | null | undefined): { label: string; tone: ProovraStatusTone } {
  const key = status ?? "";
  return { label: key ? humanizeEnum(key) : "Unknown", tone: STATUS_TONE[key] ?? "neutral" };
}

export interface EvidenceRequestListItem {
  id: string;
  title: string;
  status: string;
  dueAtUtc: string | null;
  caseId: string | null;
  evidenceId: string | null;
  /** The projection's deliverable states, for the completion summary. */
  deliverableStates: ReadonlyArray<{ required: boolean; status: string }>;
}

/**
 * The web's request row summary (MatterWorkspace.tsx:1311-1321):
 * "N/M required · P% complete · needs more info · review-ready".
 */
export function requestListSummary(item: Pick<EvidenceRequestListItem, "status" | "deliverableStates">): string {
  const c = requestCompletion(item.deliverableStates);
  return [
    `${c.requiredFulfilled}/${c.requiredTotal} required`,
    `${c.completionPercent}% complete`,
    item.status === "NEEDS_MORE_INFO" ? "needs more info" : null,
    c.reviewReady ? "review-ready" : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

export interface EvidenceRequestDeliverable {
  id: string;
  title: string;
  description: string | null;
  required: boolean;
  status: string;
  fulfilledCount: number;
  minCount: number;
  maxCount: number | null;
  acceptedKinds: string[];
  waivedReason: string | null;
}

/** The web deliverable line: "N of MIN received (up to MAX) · Accepts … · Waived: …". */
export function deliverableProgressLine(d: EvidenceRequestDeliverable): string {
  return [
    `${d.fulfilledCount} of ${d.minCount} received${d.maxCount !== null && d.maxCount > 0 ? ` (up to ${d.maxCount})` : ""}`,
    d.acceptedKinds.length > 0 ? `Accepts ${d.acceptedKinds.join(", ")}` : null,
    d.waivedReason ? `Waived: ${d.waivedReason}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * ONE SUBMISSION against this request, as the authenticated projection sends
 * it (`evidence-request.service.ts:1606`).
 *
 * `submittedByExternalLabel` is the contributor's own label and may be
 * absent — an anonymous source has no name to show, and inventing "Unknown
 * contributor" as an identity rather than as an absence is the kind of small
 * lie a custody surface cannot afford.
 */
export interface EvidenceRequestResponse {
  id: string;
  status: string;
  submittedAtUtc: string | null;
  submittedByExternalLabel: string | null;
  /** An internal member who submitted (a workspace user id, never shown raw). */
  submittedByUserId: string | null;
  responseEvidenceId: string | null;
  reviewerNote: string | null;
  reviewedAtUtc: string | null;
}

export interface EvidenceRequestDetail extends EvidenceRequestListItem {
  /** T-12 — the request's workspace, recipient mode and assigned reviewer. */
  teamId: string | null;
  recipientMode: string | null;
  assignedReviewerUserId: string | null;
  instructions: string | null;
  priority: string | null;
  /** `requestType` (e.g. PHOTO_SET) — the web eyebrow "Evidence Request · photo set". */
  requestType: string | null;
  recipientLabel: string | null;
  deliverables: EvidenceRequestDeliverable[];
  responses: EvidenceRequestResponse[];
}

function o(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}
function s(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function toListItem(raw: unknown): EvidenceRequestListItem | null {
  const r = o(raw);
  const id = s(r["id"]);
  if (!id) return null;
  return {
    id,
    title: s(r["title"]) ?? "Evidence request",
    status: s(r["status"]) ?? "",
    dueAtUtc: s(r["dueAtUtc"]),
    caseId: s(r["caseId"]),
    evidenceId: s(r["evidenceId"]),
    deliverableStates: (Array.isArray(r["deliverables"]) ? (r["deliverables"] as unknown[]) : []).map((d) => ({
      required: !!o(d)["required"],
      status: s(o(d)["status"]) ?? "",
    })),
  };
}

export function parseEvidenceRequestList(data: unknown): EvidenceRequestListItem[] {
  const rows = Array.isArray(o(data)["requests"]) ? (o(data)["requests"] as unknown[]) : [];
  return rows.map(toListItem).filter((x): x is EvidenceRequestListItem => x !== null);
}

export function parseEvidenceRequestDetail(data: unknown): EvidenceRequestDetail | null {
  const r = o(o(data)["request"]);
  const base = toListItem(r);
  if (!base) return null;
  const deliverables: EvidenceRequestDeliverable[] = [];
  for (const raw of Array.isArray(r["deliverables"]) ? (r["deliverables"] as unknown[]) : []) {
    const d = o(raw);
    const id = s(d["id"]);
    if (!id) continue;
    deliverables.push({
      id,
      title: s(d["title"]) ?? "Requested item",
      description: s(d["description"]),
      required: !!d["required"],
      status: s(d["status"]) ?? "",
      fulfilledCount: typeof d["fulfilledCount"] === "number" ? (d["fulfilledCount"] as number) : 0,
      // The server row (prisma EvidenceRequestDeliverable; minCount defaults to 1).
      minCount: typeof d["minCount"] === "number" ? (d["minCount"] as number) : 1,
      maxCount: typeof d["maxCount"] === "number" ? (d["maxCount"] as number) : null,
      acceptedKinds: Array.isArray(d["acceptedKinds"]) ? (d["acceptedKinds"] as unknown[]).filter((k): k is string => typeof k === "string") : [],
      waivedReason: s(d["waivedReason"]),
    });
  }
  const responses: EvidenceRequestResponse[] = [];
  for (const raw of Array.isArray(r["responses"]) ? (r["responses"] as unknown[]) : []) {
    const p = o(raw);
    const id = s(p["id"]);
    if (!id) continue;
    responses.push({
      id,
      status: s(p["status"]) ?? "",
      submittedAtUtc: s(p["submittedAtUtc"]),
      submittedByExternalLabel: s(p["submittedByExternalLabel"]),
      submittedByUserId: s(p["submittedByUserId"]),
      responseEvidenceId: s(p["responseEvidenceId"]),
      reviewerNote: s(p["reviewerNote"]),
      reviewedAtUtc: s(p["reviewedAtUtc"]),
    });
  }
  return {
    teamId: s(r["teamId"]),
    recipientMode: s(r["recipientMode"]),
    assignedReviewerUserId: s(r["assignedReviewerUserId"]),
    ...base,
    instructions: s(r["instructions"]),
    priority: s(r["priority"]),
    requestType: s(r["requestType"]),
    recipientLabel: s(r["recipientLabel"]),
    deliverables,
    responses,
  };
}

// ---------------------------------------------------------------------------
// The workflow
// ---------------------------------------------------------------------------

/**
 * THE STATE MACHINE IS THE SERVER'S.
 *
 * This names which transitions to OFFER, from the status the server reported.
 * It does not decide whether one is permitted — every route re-checks, and a
 * client that believed otherwise would be a second state machine drifting
 * quietly out of step with the first.
 *
 * What it prevents is the other failure: offering "Send" on a request that was
 * cancelled last week, which produces a refusal the user cannot act on and
 * makes the surface look broken rather than the action look wrong.
 */
export type RequestTransition =
  | "send"
  | "cancel"
  | "close"
  | "needs-more-info";

const TERMINAL: ReadonlySet<string> = new Set(["CANCELLED", "CLOSED"]);
const NEEDS_MORE_INFO_FROM: ReadonlySet<string> = new Set([
  "RESPONSE_RECEIVED",
  "UNDER_REVIEW",
  "PARTIALLY_FULFILLED",
  "FULFILLED",
]);

/**
 * The transitions the service REFUSES without a reviewer note
 * (`REQUIRE_REVIEWER_NOTE_ON_TRANSITION`, evidence-request.service.ts:475 →
 * 422 `reviewer_note_required`). Labelling their note "optional" produced a
 * refusal every time it was left empty.
 */
export function transitionRequiresNote(t: RequestTransition): boolean {
  return t === "cancel" || t === "close" || t === "needs-more-info";
}

export function availableRequestTransitions(status: string): RequestTransition[] {
  const s = (status ?? "").toUpperCase();
  if (TERMINAL.has(s)) return [];

  const out: RequestTransition[] = [];
  // Only an unsent request can be sent. Re-sending a delivered one is a
  // different act with its own delivery route.
  if (s === "DRAFT" || s === "OPEN") out.push("send");
  // Asking for more is only meaningful once something has come back. These
  // are exactly the statuses `ALLOWED_REQUEST_TRANSITIONS` lets move to
  // NEEDS_MORE_INFO (packages/shared/src/evidence-request.ts:83-104);
  // IN_PROGRESS is NOT one of them, so offering it there earned a refusal.
  if (NEEDS_MORE_INFO_FROM.has(s)) {
    out.push("needs-more-info");
  }
  // Closing is for a request that has run its course; fulfilled or not.
  if (s !== "DRAFT") out.push("close");
  out.push("cancel");
  return out;
}

export function buildRequestTransitionPath(id: string, transition: RequestTransition): string {
  return `/v1/evidence-requests/${encodeURIComponent(id)}/${transition}`;
}

export function buildRequestDeliveriesPath(id: string): string {
  return `/v1/evidence-requests/${encodeURIComponent(id)}/deliveries`;
}

export function buildRequestEventsPath(id: string): string {
  return `/v1/evidence-requests/${encodeURIComponent(id)}/events`;
}

export function buildRequestAssignPath(id: string): string {
  return `/v1/evidence-requests/${encodeURIComponent(id)}/assign`;
}

export function buildRequestAssignBody(assignedReviewerUserId: string | null) {
  return { assignedReviewerUserId };
}

/** EvidenceRequestAssignment.tsx copy, verbatim. */
export const REQUEST_ASSIGN_COPY = {
  section: "Assigned reviewer",
  unassigned: "Unassigned",
  someMember: "A workspace member",
  internalNote:
    "This request is addressed to an internal team member. The assigned reviewer is the person who receives it.",
  terminal: "The reviewer cannot change on a closed or cancelled request.",
  assign: "Assign reviewer",
  change: "Change reviewer",
  remove: "Remove reviewer",
  removeTitle: "Remove the assigned reviewer?",
  removeInternal:
    "The request will have no reviewer. A request addressed to an internal team member cannot be sent until someone is assigned again.",
  removeExternal: "The request will have no reviewer, and nobody will be notified about new responses.",
  assigned: (label: string) => `${label} is now the assigned reviewer. The saved request was reloaded.`,
  unassignedDone: "The request is now unassigned. The saved request was reloaded.",
  sendBlocked:
    "Assign a reviewer first. A request addressed to an internal team member cannot be sent without an assigned reviewer.",
  alreadyAssigned: "This member is already the assigned reviewer.",
  failed: "The assignment could not be saved.",
} as const;

export function requestAssignErrorCopy(code: string | null): string {
  switch (code) {
    case "assignee_not_workspace_member":
      return "That person is no longer a member of this workspace. Choose someone else.";
    case "request_terminal":
      return "This request is closed or cancelled, so it can no longer change.";
    case "internal_recipient_requires_assignee":
      return "This request cannot be sent until a reviewer is assigned.";
    default:
      return REQUEST_ASSIGN_COPY.failed;
  }
}

/** An internal request with no reviewer cannot be sent (EvidenceRequestAssignment). */
export function sendBlockedForAssignee(r: Pick<EvidenceRequestDetail, "recipientMode" | "assignedReviewerUserId">): boolean {
  return r.recipientMode === "INTERNAL_USER" && !r.assignedReviewerUserId;
}

/** Every transition takes the same optional reviewer note, bounded at 4000. */
export function buildTransitionBody(reviewerNote?: string | null) {
  const note = (reviewerNote ?? "").trim();
  return note.length > 0 ? { reviewerNote: note.slice(0, 4000) } : {};
}

export function requestTransitionLabel(t: RequestTransition): string {
  switch (t) {
    case "send":
      return "Send to recipient";
    case "cancel":
      return "Cancel request";
    case "close":
      return "Close request";
    case "needs-more-info":
      return "Ask for more";
  }
}

/**
 * What each transition does, said before it happens.
 *
 * Cancel and close both end a request, and a user who picks the wrong one
 * cannot undo it — so the difference between them is stated rather than left
 * to be inferred from two similar words.
 */
export function requestTransitionConsequence(t: RequestTransition): string {
  switch (t) {
    case "send":
      return "The recipient is sent a secure link. They can start contributing immediately.";
    case "cancel":
      return "The request is withdrawn and the recipient can no longer contribute. Anything already received is kept.";
    case "close":
      return "The request is completed and stops accepting new contributions. Anything already received is kept.";
    case "needs-more-info":
      return "The recipient is told more is needed and can contribute again.";
  }
}

export function requestTransitionIsDestructive(t: RequestTransition): boolean {
  return t === "cancel";
}

// ---------------------------------------------------------------------------
// Deliveries and events
// ---------------------------------------------------------------------------

/**
 * GET /v1/evidence-requests/:id/deliveries rows (evidence-requests.routes.ts):
 * `{ id, eventType, status, errorCode, retryCount, lastAttemptAtUtc, retryable }`.
 * The parser read channel / recipientLabel / sentAtUtc / failureReason — none of
 * them sent — so every row read "Recipient", with no time and no reason.
 */
export interface RequestDelivery {
  id: string;
  /** What was sent: "request sent", "reminder" … (the web lower-cases the event type). */
  eventLabel: string;
  status: string;
  statusLabel: string;
  errorCode: string | null;
  retryCount: number;
  lastAttemptAtIso: string | null;
  retryable: boolean;
}

/** ContextualDeliveryStatus STATUS_LABEL, verbatim. */
const DELIVERY_STATUS_LABEL: Record<string, string> = {
  PENDING: "Pending",
  SENT: "Sent",
  DELIVERED: "Delivered",
  RETRY_SCHEDULED: "Retrying",
  FAILED: "Failed",
  SKIPPED: "Not sent",
  CANCELLED: "Cancelled",
};

export function buildRequestDeliveryRetryPath(requestId: string, deliveryId: string): string {
  return `/v1/evidence-requests/${encodeURIComponent(requestId)}/deliveries/${encodeURIComponent(deliveryId)}/retry`;
}

export function deliveryAttemptLine(d: RequestDelivery, formatDate: (iso: string) => string): string {
  const retries = d.retryCount > 0 ? ` · ${d.retryCount} retr${d.retryCount === 1 ? "y" : "ies"}` : "";
  return `${d.eventLabel}${d.lastAttemptAtIso ? ` · last attempt ${formatDate(d.lastAttemptAtIso)}` : ""}${retries}`;
}

function ro(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}
function rs(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

export function parseRequestDeliveries(payload: unknown): RequestDelivery[] {
  const raw = ro(payload).deliveries ?? ro(payload).items ?? payload;
  const list = Array.isArray(raw) ? raw : [];
  return list
    .map((entry) => {
      const d = ro(entry);
      const id = rs(d.id);
      if (!id) return null;
      const status = rs(d.status) ?? "UNKNOWN";
      return {
        id,
        eventLabel: (rs(d.eventType) ?? "delivery").toLowerCase().replace(/_/g, " "),
        status,
        statusLabel: DELIVERY_STATUS_LABEL[status] ?? status,
        // A failure that says nothing is worse than one that names itself.
        errorCode: rs(d.errorCode),
        retryCount: typeof d.retryCount === "number" ? (d.retryCount as number) : 0,
        lastAttemptAtIso: rs(d.lastAttemptAtUtc),
        retryable: d.retryable === true,
      };
    })
    .filter((d): d is RequestDelivery => d !== null);
}

export function deliveryTone(status: string): ProovraStatusTone {
  switch (status.toUpperCase()) {
    case "DELIVERED":
    case "SENT":
      return "verified";
    case "FAILED":
    case "BOUNCED":
      return "risk";
    case "QUEUED":
    case "SENDING":
      return "pending";
    default:
      return "neutral";
  }
}

/**
 * GET /v1/evidence-requests/:id/events rows: `{ id, eventType, actorUserId,
 * payload, createdAt }` (listEvidenceRequestEvents). There is no actor label and
 * no note field; the only free text a writer records is `payload.reason`.
 */
export interface RequestEvent {
  id: string;
  type: string;
  occurredAtIso: string | null;
  actorUserId: string | null;
  actorLabel: string | null;
  note: string | null;
}

export function parseRequestEvents(payload: unknown): RequestEvent[] {
  const raw = ro(payload).events ?? ro(payload).items ?? payload;
  const list = Array.isArray(raw) ? raw : [];
  return list
    .map((entry) => {
      const e = ro(entry);
      const id = rs(e.id);
      if (!id) return null;
      return {
        id,
        type: rs(e.eventType) ?? rs(e.type) ?? "EVENT",
        occurredAtIso: rs(e.occurredAtUtc) ?? rs(e.createdAt),
        actorUserId: rs(e.actorUserId),
        actorLabel: rs(e.actorLabel) ?? rs(ro(e.actor).displayName),
        note: rs(ro(e.payload).reason) ?? rs(ro(e.payload).note) ?? rs(e.reviewerNote) ?? rs(e.note),
      };
    })
    .filter((e): e is RequestEvent => e !== null)
    // Newest first: the question on a request timeline is what just happened.
    .sort((a, b) => {
      const at = a.occurredAtIso ? Date.parse(a.occurredAtIso) : 0;
      const bt = b.occurredAtIso ? Date.parse(b.occurredAtIso) : 0;
      return bt - at;
    });
}

// ---------------------------------------------------------------------------
// PER-RESPONSE REVIEW — the reviewer's decision on ONE submission
// ---------------------------------------------------------------------------
//
// A request's own transitions (`send`, `close`, `cancel`, `needs-more-info`)
// act on the whole thread. They are not the same act as judging one
// submission, and a request can hold several submissions in different states:
// one accepted, one rejected as insufficient, one still to look at. Native
// could read none of them, so a reviewer holding a phone could see that a
// request had moved but not what had actually been sent in, and had no way to
// answer it.
//
// The decision vocabulary is the ROUTE'S OWN enum
// (`evidence-requests.routes.ts:581`), not a native paraphrase of it.

export const RESPONSE_REVIEW_DECISIONS = [
  "UNDER_REVIEW",
  "ACCEPTED",
  "NEEDS_MORE_INFO",
  "REJECTED",
] as const;

export type ResponseReviewDecision = (typeof RESPONSE_REVIEW_DECISIONS)[number];

/** `reviewerNote: z.string().max(4000)` on the review route. */
export const RESPONSE_REVIEWER_NOTE_MAX = 4000;

const RESPONSE_STATUS_TONE: Record<string, ProovraStatusTone> = {
  RECEIVED: "pending",
  UNDER_REVIEW: "pending",
  NEEDS_MORE_INFO: "pending",
  ACCEPTED: "verified",
  REJECTED: "risk",
};

/**
 * What a submission's state is CALLED.
 *
 * "Accepted for internal review" rather than "Accepted", because accepting a
 * submission admits it to review — it is not a finding about the evidence, and
 * the shorter word would let a reviewer read one as the other.
 */
const RESPONSE_STATUS_LABEL: Record<string, string> = {
  RECEIVED: "Received",
  UNDER_REVIEW: "Under internal review",
  ACCEPTED: "Accepted for internal review",
  NEEDS_MORE_INFO: "Needs additional context",
  REJECTED: "Rejected as insufficient",
};

export function responseStatusDisplay(status: string | null | undefined): {
  label: string;
  tone: ProovraStatusTone;
} {
  const key = status ?? "";
  if (!key) return { label: "Unknown", tone: "neutral" };
  return {
    label: RESPONSE_STATUS_LABEL[key] ?? humanizeEnum(key),
    tone: RESPONSE_STATUS_TONE[key] ?? "neutral",
  };
}

export function responseDecisionLabel(decision: ResponseReviewDecision): string {
  switch (decision) {
    case "UNDER_REVIEW":
      return "Mark under review";
    case "ACCEPTED":
      return "Accept for review";
    case "NEEDS_MORE_INFO":
      return "Ask for more context";
    case "REJECTED":
      return "Reject as insufficient";
  }
}

/**
 * What each decision does, said before it happens.
 *
 * Rejection is the one that reads as a judgement on the CONTRIBUTOR rather
 * than on the submission, and on an external contributor it can be the last
 * thing they hear, so it says what it actually means and what it does not.
 */
export function responseDecisionConsequence(decision: ResponseReviewDecision): string {
  switch (decision) {
    case "UNDER_REVIEW":
      return "The submission is marked as being looked at. Nothing is sent to the contributor.";
    case "ACCEPTED":
      return "The submission is admitted to internal review. This records that it was accepted, not that its contents are verified.";
    case "NEEDS_MORE_INFO":
      return "The submission is marked as needing more context. The contributor can add to it.";
    case "REJECTED":
      return "The submission is recorded as insufficient for this request. What was sent is kept and stays on the record.";
  }
}

export function responseDecisionIsDestructive(decision: ResponseReviewDecision): boolean {
  return decision === "REJECTED";
}

/**
 * Which decisions to OFFER for a submission in this state.
 *
 * The one it is already in is left out — re-recording the same decision
 * writes a fresh `reviewedAtUtc` and a timeline event saying a reviewer
 * decided something they had already decided.
 */
export function availableResponseDecisions(status: string): ResponseReviewDecision[] {
  return RESPONSE_REVIEW_DECISIONS.filter((d) => d !== status);
}

export function buildResponseReviewPath(requestId: string, responseId: string): string {
  return `/v1/evidence-requests/${encodeURIComponent(requestId)}/responses/${encodeURIComponent(responseId)}/review`;
}

/**
 * The review body.
 *
 * An empty note is sent as `null`, not as "": the field is
 * `.nullable().optional()`, and "" would overwrite a note a previous reviewer
 * left with a note that says nothing. `notifyContributor` is deliberately NOT
 * sent — it makes the server issue an SMS to an external contributor, and
 * that is a message going out under the reviewer's name, which needs its own
 * deliberate control rather than a default.
 */
export type ResponseReviewBody = {
  status: ResponseReviewDecision;
  reviewerNote: string | null;
  notifyContributor?: boolean;
  notifyChannel?: "SMS";
};

export function buildResponseReviewBody(input: {
  status: ResponseReviewDecision;
  reviewerNote?: string | null;
  /**
   * Only when the reviewer ANSWERED the web's "Notify the contributor?"
   * question (page.tsx:222-233) — that question is the deliberate control.
   * Absent, nothing about notification is sent and the server defaults false.
   */
  notifyContributor?: boolean;
}): ResponseReviewBody {
  const note = (input.reviewerNote ?? "").trim();
  const body: ResponseReviewBody = {
    status: input.status,
    reviewerNote: note.length > 0 ? note.slice(0, RESPONSE_REVIEWER_NOTE_MAX) : null,
  };
  if (typeof input.notifyContributor === "boolean") {
    body.notifyContributor = input.notifyContributor;
    // The route's only channel (evidence-requests.routes.ts:603).
    body.notifyChannel = "SMS";
  }
  return body;
}

export function validateResponseReviewerNote(note: string): string | null {
  if (note.trim().length > RESPONSE_REVIEWER_NOTE_MAX) {
    return `A reviewer note cannot be longer than ${RESPONSE_REVIEWER_NOTE_MAX} characters.`;
  }
  return null;
}

/**
 * How one submission is named in a list, without inventing an identity.
 *
 * The web prints `submittedByUserId` raw (page.tsx:644) — a UUID where a
 * person belongs. Native names the member when the workspace roster knows
 * them, says "Workspace member" when it does not, and otherwise uses the web's
 * own absence wording, "External contributor".
 */
export function responseContributorLabel(
  response: Pick<EvidenceRequestResponse, "submittedByExternalLabel"> & { submittedByUserId?: string | null },
  memberName?: (userId: string) => string | null,
): string {
  if (response.submittedByUserId) {
    return memberName?.(response.submittedByUserId) ?? response.submittedByExternalLabel ?? "Workspace member";
  }
  return response.submittedByExternalLabel ?? "External contributor";
}

// ---------------------------------------------------------------------------
// The inspector (web evidence-requests/[id]/page.tsx)
// ---------------------------------------------------------------------------

/** page.tsx:386 — "Evidence Request · photo set". */
export function requestEyebrow(requestType: string | null): string {
  return requestType ? `Evidence Request · ${requestType.toLowerCase().replace(/_/g, " ")}` : "Evidence Request";
}

export interface RequestCompletion {
  requiredFulfilled: number;
  requiredTotal: number;
  optionalFulfilled: number;
  optionalTotal: number;
  completionPercent: number;
  reviewReady: boolean;
}

/**
 * page.tsx:351-363 — the same predicate as the backend `completion` summary:
 * a deliverable counts when FULFILLED or WAIVED; the request is review-ready
 * when every REQUIRED one does (or none is required).
 */
export function requestCompletion(
  deliverables: ReadonlyArray<{ required: boolean; status: string }>,
): RequestCompletion {
  const done = (st: string) => st === "FULFILLED" || st === "WAIVED";
  const required = deliverables.filter((d) => d.required);
  const optional = deliverables.filter((d) => !d.required);
  const requiredFulfilled = required.filter((d) => done(d.status)).length;
  const all = deliverables.filter((d) => done(d.status)).length;
  return {
    requiredFulfilled,
    requiredTotal: required.length,
    optionalFulfilled: optional.filter((d) => done(d.status)).length,
    optionalTotal: optional.length,
    completionPercent: deliverables.length === 0 ? 0 : Math.round((all / deliverables.length) * 100),
    reviewReady: required.length === 0 || requiredFulfilled === required.length,
  };
}

/** The deliverable's own state, as the web chip shows it (identifierLabel). */
export function deliverableStatusDisplay(status: string): { label: string; tone: ProovraStatusTone } {
  switch (status) {
    case "FULFILLED":
      return { label: "Fulfilled", tone: "verified" };
    case "WAIVED":
      return { label: "Waived", tone: "neutral" };
    case "REJECTED":
      return { label: "Rejected", tone: "risk" };
    default:
      return { label: status ? humanizeEnum(status) : "Pending", tone: status === "PARTIALLY_FULFILLED" ? "pending" : "info" };
  }
}

/** page.tsx:591-593 — a deliverable can be waived until it is resolved. */
export function deliverableWaivable(deliverableStatus: string, requestStatus: string): boolean {
  return (
    deliverableStatus !== "WAIVED" &&
    deliverableStatus !== "FULFILLED" &&
    !TERMINAL.has((requestStatus ?? "").toUpperCase())
  );
}

export function buildWaiveDeliverablePath(requestId: string, deliverableId: string): string {
  return `/v1/evidence-requests/${encodeURIComponent(requestId)}/deliverables/${encodeURIComponent(deliverableId)}/waive`;
}

/** `reason: z.string().max(400)` (evidence-requests.routes.ts:545). */
export const WAIVE_REASON_MAX = 400;

export function validateWaiveReason(reason: string): string | null {
  const r = reason.trim();
  if (r.length === 0) return "Give a reason for waiving this deliverable.";
  if (r.length > WAIVE_REASON_MAX) return `A waiver reason cannot be longer than ${WAIVE_REASON_MAX} characters.`;
  return null;
}

/** page.tsx:673 — Accept / Request more / Reject are offered on an unjudged response. */
export function responseAwaitsDecision(status: string): boolean {
  return status === "RECEIVED" || status === "UNDER_REVIEW";
}

export function buildRequestMorePath(requestId: string, responseId: string): string {
  return `/v1/evidence-requests/${encodeURIComponent(requestId)}/responses/${encodeURIComponent(responseId)}/request-more`;
}

export function buildRequestMoreBody(input: { reviewerNote?: string | null; notifyContributor: boolean }) {
  const note = (input.reviewerNote ?? "").trim();
  return {
    ...(note.length > 0 ? { reviewerNote: note.slice(0, RESPONSE_REVIEWER_NOTE_MAX) } : {}),
    notifyContributor: input.notifyContributor,
    notifyChannel: "SMS" as const,
  };
}

/**
 * `{ response, newIntakeLinkId, rawToken, communicationMessageId }`
 * (evidence-requests.routes.ts:678-683). The raw token is shown ONCE.
 */
export function parseRequestMoreResult(payload: unknown): { rawToken: string; sentViaMessage: boolean } | null {
  const p = o(payload);
  const rawToken = s(p["rawToken"]);
  if (!rawToken) return null;
  return { rawToken, sentViaMessage: s(p["communicationMessageId"]) !== null };
}

/**
 * `POST /:id/send` → `{ request, rawToken, intakeUrl, warning }`
 * (evidence-requests.routes.ts:409-416): an external request's one-shot link
 * was being thrown away by the native send.
 */
export function parseSendResult(payload: unknown): { intakeUrl: string | null; warning: string | null } {
  const p = o(payload);
  return { intakeUrl: s(p["intakeUrl"]), warning: s(p["warning"]) };
}

/** The inspector's copy, verbatim from page.tsx / EvidenceRequestAssignment.tsx. */
export const REQUEST_DETAIL_COPY = {
  loading: "Loading evidence request…",
  unavailable: "Evidence request unavailable",
  returnToMatter: "Return to matter",
  backToMatter: "← Back to matter",
  reviewReady: "Review-ready",
  requiredRemaining: "Required items remaining",
  needsMoreInfo: "Needs more info",
  rerequestTitle: "Request more information",
  rerequestBody:
    "Flag this request as needing more information from the contributor. The contributor's intake page will show a re-request banner pointing at the unfulfilled deliverables. Workspace-internal note below is attached to the audit event.",
  rerequestPlaceholder: "Reviewer note (workspace-internal, required)",
  rerequestAction: "Mark as needs more info",
  recording: "Recording…",
  completion: "Completion",
  deliverables: "Deliverables",
  noDeliverables: "This request has no deliverable checklist. It accepts free-form uploads only.",
  responses: "Responses received",
  noResponses: "No responses received yet. Responses appear here once the contributor submits via the intake link.",
  waive: "Waive",
  waivePrompt: "Reason for waiving this deliverable (visible only to workspace members):",
  rejectNotifyTitle: "Notify the contributor?",
  rejectNotifyBody:
    "Send an SMS letting the contributor know their submission was not accepted. The reviewer note stays internal — the SMS only carries a short, neutral message.",
  rejectNotifyYes: "Notify by SMS",
  rejectNotifyNo: "Don't notify",
  requestMorePrompt: "What additional information do you need? (internal note, not sent to contributor)",
  requestMoreNotifyTitle: "Send the new link to the contributor?",
  requestMoreNotifyBody:
    "We'll text the contributor a fresh intake link so they can respond with the additional information you need.",
  requestMoreNotifyYes: "Send by SMS",
  requestMoreNotifyNo: "I'll share the link manually",
  followUpTitle: "Follow-up link created",
  followUpSent: "An SMS with this link has been queued for the contributor. You can also share it directly:",
  followUpManual: "Copy the link below and share it directly with the contributor. This link will not be shown again.",
  sentTitle: "Request sent",
  sendToReviewer: "Send to assigned reviewer",
  sendToReviewerTitle: "Send this request to the assigned reviewer?",
  sendToReviewerBody: (name: string) => `${name} is notified by email and the request moves out of draft.`,
  sendToReviewerConfirm: "Send request",
  sentToReviewer: "Request sent to the assigned reviewer. The saved request was reloaded.",
  saveReviewer: "Save reviewer",
} as const;
