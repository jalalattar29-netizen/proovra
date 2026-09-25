/**
 * LINKED EVIDENCE REQUESTS (T-12 / RC-13) — the native port of
 * `apps/web/app/(app)/evidence/[id]/components/EvidenceRequestPanel.tsx`:
 * the requests linked to one evidence record, and "New request" from it.
 *
 * Shown to `intakeIncluded` plans (the web's `usePlanFeatureGate`), scoped to
 * the record's review workspace (`reviewWorkflow.teamId`). A 503 /
 * FEATURE_DISABLED hides the panel, as on the web. POST /v1/evidence-requests
 * is the one creation writer; the server re-checks membership, the intake
 * plan gate and every bound below.
 *
 * Per-request actions (send, close, cancel, needs-more-info, response review,
 * activity) live on the native request screen, which already implements them
 * all against the same routes — a row here opens it.
 */

export const REQUEST_TYPE_OPTIONS = [
  { value: "ADDITIONAL_EVIDENCE", label: "Additional evidence" },
  { value: "CLARIFICATION", label: "Clarification" },
  { value: "REPLACEMENT_FILE", label: "Replacement file" },
  { value: "WITNESS_STATEMENT", label: "Witness statement" },
  { value: "DOCUMENT", label: "Document" },
  { value: "OTHER", label: "Other" },
] as const;

export const REQUEST_PRIORITY_OPTIONS = [
  { value: "LOW", label: "Low" },
  { value: "NORMAL", label: "Normal" },
  { value: "HIGH", label: "High" },
  { value: "URGENT", label: "Urgent" },
] as const;

export const RECIPIENT_MODE_OPTIONS = [
  { value: "INTERNAL_USER", label: "Internal team member" },
  { value: "EXTERNAL_CONTRIBUTOR", label: "External contributor" },
  { value: "ANONYMOUS_SOURCE", label: "Anonymous source" },
  { value: "PSEUDONYMOUS_SOURCE", label: "Pseudonymous source" },
] as const;

const RECIPIENT_MODE_LABEL: Record<string, string> = {
  INTERNAL_USER: "Internal user",
  EXTERNAL_CONTRIBUTOR: "External contributor",
  ANONYMOUS_SOURCE: "Anonymous source",
  PSEUDONYMOUS_SOURCE: "Pseudonymous source",
};

export const LINKED_REQUESTS_COPY = {
  eyebrow: "Evidence requests",
  title: "Linked requests",
  empty: "No linked requests yet. Use “New request” to ask a contributor or reviewer for additional evidence or context.",
  loadFailed: "Unable to load evidence requests.",
  createFailed: "Could not create request.",
  dialogTitle: "New evidence request",
  workspacePrefix: "Evidence request will be created in",
} as const;

/** The server's bounds (EvidenceRequestInputSchema) — checked here so the form can say which field is wrong. */
export const REQUEST_TITLE_MAX = 180;
export const REQUEST_INSTRUCTIONS_MAX = 4000;
export const DELIVERABLE_DESCRIPTION_MAX = 2000;
export const DELIVERABLES_MAX = 32;
/** The web form's own bound on "Due in (hours)". */
export const DUE_HOURS_MAX = 24 * 365;

export function buildLinkedRequestsPath(teamId: string, evidenceId: string): string {
  return `/v1/evidence-requests?teamId=${encodeURIComponent(teamId)}&evidenceId=${encodeURIComponent(evidenceId)}`;
}
export const EVIDENCE_REQUESTS_CREATE_PATH = "/v1/evidence-requests";

function o(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}
function s(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** The request's workspace, as the web reads it: `review-workspace.reviewWorkflow.teamId`. */
export function projectRequestTeamId(reviewWorkspace: unknown): string | null {
  return s(o(o(reviewWorkspace)["reviewWorkflow"])["teamId"]);
}

export interface LinkedRequest {
  id: string;
  title: string;
  status: string;
  requestType: string;
  recipientMode: string;
  recipientLabel: string | null;
  dueAtUtc: string | null;
  deliverableCount: number;
  responseCount: number;
}

export function parseLinkedRequests(payload: unknown): LinkedRequest[] {
  const list = o(payload)["requests"];
  const out: LinkedRequest[] = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const r = o(raw);
    const id = s(r["id"]);
    if (!id) continue;
    out.push({
      id,
      title: s(r["title"]) ?? "Evidence request",
      status: s(r["status"]) ?? "",
      requestType: s(r["requestType"]) ?? "",
      recipientMode: s(r["recipientMode"]) ?? "",
      recipientLabel: s(r["recipientLabel"]),
      dueAtUtc: s(r["dueAtUtc"]),
      deliverableCount: Array.isArray(r["deliverables"]) ? (r["deliverables"] as unknown[]).length : 0,
      responseCount: Array.isArray(r["responses"]) ? (r["responses"] as unknown[]).length : 0,
    });
  }
  return out;
}

/** "ADDITIONAL_EVIDENCE · External contributor · John Smith" — the web's card subtitle. */
export function linkedRequestSubtitle(r: LinkedRequest): string {
  return `${r.requestType} · ${RECIPIENT_MODE_LABEL[r.recipientMode] ?? r.recipientMode}${r.recipientLabel ? ` · ${r.recipientLabel}` : ""}`;
}

/** A 503 or FEATURE_DISABLED hides the whole panel; anything else is an error to say. */
export function isRequestsFeatureDisabled(err: unknown): boolean {
  const e = (err ?? {}) as { statusCode?: number; code?: string };
  return e.statusCode === 503 || e.code === "FEATURE_DISABLED";
}

export interface DeliverableDraft {
  title: string;
  description: string;
  required: boolean;
}

export function defaultDeliverables(): DeliverableDraft[] {
  return [{ title: "Primary evidence", description: "", required: true }];
}

export interface RequestDraft {
  title: string;
  instructions: string;
  requestType: string;
  priority: string;
  recipientMode: string;
  recipientLabel: string;
  recipientEmail: string;
  dueInHours: string;
  deliverables: DeliverableDraft[];
}

export function emptyRequestDraft(): RequestDraft {
  return {
    title: "",
    instructions: "",
    requestType: "ADDITIONAL_EVIDENCE",
    priority: "NORMAL",
    recipientMode: "EXTERNAL_CONTRIBUTOR",
    recipientLabel: "",
    recipientEmail: "",
    dueInHours: "72",
    deliverables: defaultDeliverables(),
  };
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Why the draft cannot be sent, or null.
 *
 * The web form checks only the title, so a blank deliverable (which "Add
 * deliverable" creates) or a malformed email reaches the server and comes
 * back as one flat 400. The rules are the SERVER's; checking them here only
 * lets the form name the field.
 */
export function requestDraftError(d: RequestDraft): string | null {
  if (!d.title.trim()) return "Enter a title for the request.";
  if (d.title.trim().length > REQUEST_TITLE_MAX) return `The title can be at most ${REQUEST_TITLE_MAX} characters.`;
  if (d.instructions.length > REQUEST_INSTRUCTIONS_MAX) return `Instructions can be at most ${REQUEST_INSTRUCTIONS_MAX} characters.`;
  if (d.recipientMode === "EXTERNAL_CONTRIBUTOR" && d.recipientEmail.trim() && !EMAIL.test(d.recipientEmail.trim())) {
    return "Enter a valid recipient email, or leave it empty.";
  }
  if (d.dueInHours.trim()) {
    const n = Number(d.dueInHours);
    if (!Number.isInteger(n) || n < 1 || n > DUE_HOURS_MAX) return `Due in must be a whole number of hours from 1 to ${DUE_HOURS_MAX}.`;
  }
  if (d.deliverables.length > DELIVERABLES_MAX) return `A request can list at most ${DELIVERABLES_MAX} deliverables.`;
  const blank = d.deliverables.findIndex((x) => !x.title.trim());
  if (blank >= 0) return `Deliverable ${blank + 1} needs a title.`;
  return null;
}

/** The POST body — the web's exact shape, including the fixed deliverable defaults. */
export function buildRequestCreateBody(teamId: string, evidenceId: string, d: RequestDraft, nowMs: number) {
  const hours = d.dueInHours.trim() ? Number(d.dueInHours) : null;
  return {
    teamId,
    evidenceId,
    requestType: d.requestType,
    title: d.title.trim() || "Additional evidence needed",
    instructions: d.instructions,
    priority: d.priority,
    dueAtUtc: hours === null ? null : new Date(nowMs + hours * 3600 * 1000).toISOString(),
    recipientMode: d.recipientMode,
    recipientLabel: d.recipientLabel.trim() || null,
    recipientEmail: d.recipientMode === "EXTERNAL_CONTRIBUTOR" ? d.recipientEmail.trim() || null : null,
    createIntakeLink: true,
    deliverables: d.deliverables.map((x, idx) => ({
      title: x.title.trim(),
      description: x.description,
      required: x.required,
      acceptedKinds: ["PHOTO", "VIDEO", "AUDIO", "DOCUMENT"],
      minCount: 1,
      locationRequirement: "optional",
      captureAfterRequest: false,
      sortOrder: idx,
    })),
  };
}
