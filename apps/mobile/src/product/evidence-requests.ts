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
}

export interface EvidenceRequestDeliverable {
  id: string;
  title: string;
  description: string | null;
  required: boolean;
  status: string;
  fulfilledCount: number;
}

export interface EvidenceRequestDetail extends EvidenceRequestListItem {
  instructions: string | null;
  priority: string | null;
  recipientLabel: string | null;
  deliverables: EvidenceRequestDeliverable[];
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
    });
  }
  return {
    ...base,
    instructions: s(r["instructions"]),
    priority: s(r["priority"]),
    recipientLabel: s(r["recipientLabel"]),
    deliverables,
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

export function availableRequestTransitions(status: string): RequestTransition[] {
  const s = (status ?? "").toUpperCase();
  if (TERMINAL.has(s)) return [];

  const out: RequestTransition[] = [];
  // Only an unsent request can be sent. Re-sending a delivered one is a
  // different act with its own delivery route.
  if (s === "DRAFT" || s === "OPEN") out.push("send");
  // Asking for more is only meaningful once something has come back.
  if (["RESPONSE_RECEIVED", "UNDER_REVIEW", "PARTIALLY_FULFILLED", "IN_PROGRESS"].includes(s)) {
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

export interface RequestDelivery {
  id: string;
  channel: string | null;
  status: string;
  recipientLabel: string | null;
  sentAtIso: string | null;
  failureReason: string | null;
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
      return {
        id,
        channel: rs(d.channel),
        status: rs(d.status) ?? "UNKNOWN",
        // Already masked by the projection; nothing here un-masks it.
        recipientLabel: rs(d.recipientLabel) ?? rs(d.recipientPreview),
        sentAtIso: rs(d.sentAtUtc) ?? rs(d.sentAt),
        // A failure that says nothing is worse than one that names itself.
        failureReason: rs(d.failureReason) ?? rs(d.error),
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

export interface RequestEvent {
  id: string;
  type: string;
  occurredAtIso: string | null;
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
        actorLabel: rs(e.actorLabel) ?? rs(ro(e.actor).displayName),
        note: rs(e.reviewerNote) ?? rs(e.note),
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
