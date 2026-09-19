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
