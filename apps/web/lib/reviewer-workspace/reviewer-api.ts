"use client";

import type { SlaDimensionWire } from "./sla-presentation";

/**
 * PROOVRA Phase 2A — Reviewer Workspace API client.
 *
 * Bounded fetcher helpers wrapping the canonical workspace + coding +
 * disagreement + QC endpoints. Everything returns bounded shapes
 * matching the server-side projection types.
 */

import type {
  CodingFieldType,
  CodingSchemaCategory,
  ReviewerDenialReason,
  ReviewerVerdict,
  ReviewerOpsQueueType,
  ReviewerOpsSavedViewFilter,
  ReviewerWorkspaceProjection,
} from "@proovra/shared";

import { reviewerDenialFromError } from "./reviewer-denial";
import { apiFetch } from "../api";

function withTeamId(url: string, teamId?: string | null): string {
  if (!teamId) return url;
  return url.includes("?")
    ? `${url}&teamId=${encodeURIComponent(teamId)}`
    : `${url}?teamId=${encodeURIComponent(teamId)}`;
}

export async function fetchReviewerWorkspace(
  teamId?: string | null,
): Promise<ReviewerWorkspaceProjection | null> {
  const res = await apiFetch(withTeamId("/v1/reviewer/workspace", teamId), {
    method: "GET",
  });
  return (res?.workspace ?? null) as ReviewerWorkspaceProjection | null;
}

export type CodingFieldRow = {
  id: string;
  slug: string;
  label: string;
  fieldType: CodingFieldType;
  required: boolean;
  orderIndex: number;
  helpText: string | null;
  options: Record<string, unknown> | null;
};

export type CodingSchemaRow = {
  id: string;
  slug: string;
  label: string;
  category: CodingSchemaCategory;
  version: number;
  status: "DRAFT" | "PUBLISHED" | "ARCHIVED";
  description: string | null;
  fields: CodingFieldRow[];
};

export async function fetchSchema(
  schemaId: string,
  teamId?: string | null,
): Promise<CodingSchemaRow | null> {
  const res = await apiFetch(withTeamId(`/v1/coding/schemas/${schemaId}`, teamId), {
    method: "GET",
  });
  return (res?.schema ?? null) as CodingSchemaRow | null;
}

export type CodingValueRow = {
  id: string;
  fieldId: string;
  value: Record<string, unknown>;
  rationale: string | null;
  authorUserId: string;
  updatedAt: string;
};

export type CodingCoverage = {
  totalRequired: number;
  fulfilled: number;
  unfulfilledFieldIds: string[];
};

/**
 * Review remediation F-15 — whether a coding write by this caller would be
 * accepted now (advisory; the write door decides), and why not.
 */
export type CodingWritable = {
  allowed: boolean;
  reason: "workflow_closed" | "no_permission" | "no_schema" | null;
};

export async function fetchCodingState(
  workflowId: string,
  teamId?: string | null,
): Promise<{
  values: CodingValueRow[];
  coverage: CodingCoverage;
  /** F-26 — values of a schema the review is no longer bound to (history, never current). */
  otherSchemaValues: CodingValueRow[];
  /** F-15 — absent on an older API. */
  writable: CodingWritable | null;
}> {
  const res = await apiFetch(withTeamId(`/v1/reviewer/work/${workflowId}/coding`, teamId), {
    method: "GET",
  });
  return {
    values: (res?.values ?? []) as CodingValueRow[],
    coverage: res?.coverage as CodingCoverage,
    otherSchemaValues: (Array.isArray(res?.otherSchemaValues) ? res.otherSchemaValues : []) as CodingValueRow[],
    writable: res?.writable && typeof res.writable === "object" ? (res.writable as CodingWritable) : null,
  };
}

export type CodingWriteResult =
  | { ok: true; codingValueId: string }
  | { ok: false; denial: ReviewerDenialReason };

export async function writeCodingValue(input: {
  workflowId: string;
  fieldId: string;
  value: Record<string, unknown>;
  rationale?: string;
  teamId?: string | null;
}): Promise<CodingWriteResult> {
  try {
    const res = await apiFetch(
      withTeamId(`/v1/reviewer/work/${input.workflowId}/code`, input.teamId),
      {
        method: "POST",
        body: JSON.stringify({
          fieldId: input.fieldId,
          value: input.value,
          rationale: input.rationale,
        }),
      },
    );
    return { ok: true, codingValueId: res.codingValueId };
  } catch (err) {
    // PRO-R2Z-06 — the fields apiFetch actually sets.
    const denial = reviewerDenialFromError(err) as ReviewerDenialReason;
    return { ok: false, denial };
  }
}

export async function fileDisagreement(input: {
  workflowId: string;
  originalDecisionId: string;
  rationale: string;
  teamId?: string | null;
}): Promise<{ ok: true; disagreementId: string } | { ok: false; denial: ReviewerDenialReason }> {
  try {
    const res = await apiFetch(
      withTeamId(`/v1/reviewer/work/${input.workflowId}/disagree`, input.teamId),
      {
        method: "POST",
        body: JSON.stringify({
          originalDecisionId: input.originalDecisionId,
          rationale: input.rationale,
        }),
      },
    );
    return { ok: true, disagreementId: res.disagreementId };
  } catch (err) {
    // PRO-R2Z-06 — the fields apiFetch actually sets.
    const denial = reviewerDenialFromError(err) as ReviewerDenialReason;
    return { ok: false, denial };
  }
}

/**
 * Prior decision row returned by
 *   GET /v1/reviewer-ops/workspace/:workflowId/decisions?teamId=<uuid>
 *
 * The Disagree surface in the Reviewer Workspace uses this list to
 * populate the decision picker — the canonical fileDisagreement service
 * requires an `originalDecisionId` that maps to a real
 * WorkflowReviewDecision row scoped to the workflow + team, so a
 * free-text prompt cannot supply this safely.
 */
export type WorkflowDecisionRow = {
  id: string;
  stage: string;
  decision: string;
  reasonCode: string | null;
  rationale: string | null;
  decidedAt: string;
  reviewer: {
    userId: string;
    email: string | null;
    displayName: string | null;
  };
};

/**
 * GET /v1/reviewer-ops/workspace/:workflowId/decisions?teamId=<uuid>
 *
 * Returns the canonical decision history for the workflow. We surface
 * the list to the Disagree form so the operator selects which
 * decision they are challenging (the disagreements service rejects an
 * arbitrary id with DISAGREEMENT_NOT_FOUND).
 *
 * Returns `null` when the call fails — callers should treat that as
 * "no decisions on file" and disable Disagree, not synthesize a fake
 * id.
 */
export async function listWorkflowDecisions(input: {
  workflowId: string;
  teamId: string;
}): Promise<WorkflowDecisionRow[] | null> {
  try {
    const res = await apiFetch(
      `/v1/reviewer-ops/workspace/${input.workflowId}/decisions?teamId=${encodeURIComponent(input.teamId)}`,
      { method: "GET" },
    );
    const rows = (res?.decisions ?? []) as WorkflowDecisionRow[];
    return rows;
  } catch {
    return null;
  }
}

/**
 * F-11 — what an OVERTURNED / PARTIAL resolution did to the challenged
 * outcome: the finished review was reopened for a new round, the open round
 * restarted, the challenged decision was already from an earlier round, or
 * nothing (upheld, or an API that does not say).
 */
export type DisagreementSuperseded = "reopen" | "advance_round" | "already_superseded" | null;

export async function transitionDisagreement(input: {
  disagreementId: string;
  to: string;
  verdict?: ReviewerVerdict;
  rationale?: string;
  teamId?: string | null;
}): Promise<{ ok: true; superseded: DisagreementSuperseded } | { ok: false; denial: ReviewerDenialReason }> {
  try {
    const res = await apiFetch(
      withTeamId(
        `/v1/reviewer/disagreements/${input.disagreementId}/transition`,
        input.teamId,
      ),
      {
        method: "POST",
        body: JSON.stringify({
          to: input.to,
          verdict: input.verdict,
          rationale: input.rationale,
        }),
      },
    );
    const superseded = (res as { superseded?: unknown } | null)?.superseded;
    return {
      ok: true,
      superseded:
        superseded === "reopen" || superseded === "advance_round" || superseded === "already_superseded"
          ? superseded
          : null,
    };
  } catch (err) {
    // PRO-R2Z-06 — the fields apiFetch actually sets.
    const denial = reviewerDenialFromError(err) as ReviewerDenialReason;
    return { ok: false, denial };
  }
}

export async function fetchQcSamples(teamId?: string | null): Promise<unknown[]> {
  const res = await apiFetch(withTeamId("/v1/reviewer/qc/samples?limit=100", teamId), {
    method: "GET",
  });
  return (res?.samples ?? []) as unknown[];
}

export async function renderQcVerdict(input: {
  sampleId: string;
  verdict: "PASS" | "FAIL" | "PARTIAL";
  failureReason?: string;
  rationale?: string;
  teamId?: string | null;
}): Promise<{ ok: true } | { ok: false; denial: ReviewerDenialReason }> {
  try {
    await apiFetch(
      withTeamId(`/v1/reviewer/qc/samples/${input.sampleId}/verdict`, input.teamId),
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    );
    return { ok: true };
  } catch (err) {
    // PRO-R2Z-06 — the fields apiFetch actually sets.
    const denial = reviewerDenialFromError(err) as ReviewerDenialReason;
    return { ok: false, denial };
  }
}

/** T-056 (stage C) — rates are per review; null means "No data". */
export async function fetchReviewerMetrics(teamId?: string | null): Promise<{
  throughput7d: number;
  approvalRate7dPct: number | null;
  escalationRate7dPct: number | null;
  disagreementRate7dPct: number | null;
  qcFailureRate7dPct: number | null;
  avgReviewDurationMs7d: number | null;
}> {
  const res = await apiFetch(withTeamId("/v1/reviewer/metrics", teamId), {
    method: "GET",
  });
  return res.metrics;
}

export async function seedDefaultSchemas(
  teamId?: string | null,
): Promise<{
  created: number;
  updated: number;
  existing: number;
  failed: number;
  degraded?: boolean;
  reason?: string;
}> {
  return apiFetch(withTeamId("/v1/coding/schemas/seed-defaults", teamId), {
    method: "POST",
    body: "{}",
  });
}

export type ReviewerOpsWorkspaceSummary = {
  projection: {
    workflowId: string;
    evidenceId: string;
    lifecycleState: string;
    assignedToUserId: string | null;
    assignedAtUtc: string | null;
    priority: string;
    slaRollupState: string;
    slaDimensions: Array<SlaDimensionWire>;
  };
  /** unit: escalations — active escalations on the review (T-049). */
  activeEscalationCount?: number;
  /** The governing (highest-severity) active escalation (T-049). */
  openEscalation: null | {
    id: string;
    reason: string;
    severity: string;
    status: string;
    safeSummary: string;
    createdAt: string;
    assignedToUserId: string | null;
  };
  allowedLifecycleTransitions: ReadonlyArray<string>;
};

export async function fetchReviewerOpsWorkspace(
  workflowId: string,
  teamId: string,
): Promise<ReviewerOpsWorkspaceSummary | null> {
  try {
    return (await apiFetch(
      `/v1/reviewer-ops/workspace/${encodeURIComponent(workflowId)}?teamId=${encodeURIComponent(teamId)}`,
      { method: "GET" },
    )) as ReviewerOpsWorkspaceSummary;
  } catch {
    return null;
  }
}

export type ReviewerSavedViewRow = {
  id?: string;
  name?: string | null;
  queueType?: string | null;
  filter?: ReviewerOpsSavedViewFilter;
};

export function resolveSavedViewQueue(
  view: Pick<ReviewerSavedViewRow, "queueType"> & {
    filter?: { queue?: ReviewerOpsQueueType; onlyMine?: boolean };
  },
): ReviewerOpsQueueType | null {
  const queue = view.filter?.queue;
  if (queue) return queue;
  if (view.filter?.onlyMine) return "MY_REVIEWS";
  return null;
}

// ---------------------------------------------------------------------------
// Phase 2A Closure — annotations + bulk + evidence preview
// ---------------------------------------------------------------------------

import type { ReviewerAnnotationSummary } from "./annotation-types";

export async function fetchAnnotationsForEvidence(
  evidenceId: string,
): Promise<ReviewerAnnotationSummary[]> {
  const res = await apiFetch(
    `/v1/reviewer/evidence/${evidenceId}/annotations`,
    { method: "GET" },
  );
  return (res?.annotations ?? []) as ReviewerAnnotationSummary[];
}

export type EvidencePreviewMeta = {
  id: string;
  mimeType: string | null;
  previewUrl: string | null;
  /**
   * T-076 (stage D) — why there is no URL, when there is none:
   *   not_previewable  the file type has no in-page preview
   *   policy           the workspace download policy withholds original bytes
   *   no_file          the record has no stored file yet
   *   failed           the parts listing could not be read
   */
  unavailable?: "not_previewable" | "policy" | "no_file" | "failed" | null;
  /** The file name the API projects for the previewed part. */
  displayName?: string | null;
};

type PartsListingItem = {
  mimeType?: string | null;
  previewUrl?: string | null;
  previewable?: boolean;
  isPrimary?: boolean;
  displayName?: string | null;
};

/**
 * T-076 (stage D) — THE preview contract: `GET /v1/evidence/:id/parts`.
 *
 * The record read (`GET /v1/evidence/:id`) never carries a preview URL, so the
 * viewer always said "Evidence bytes are not yet available". The parts
 * listing does: each part carries `previewable` and, when the workspace's
 * original-download decision allows it, a presigned `previewUrl` (the listing
 * is custody-logged as `parts_listing`, unchanged). The primary part is
 * previewed; otherwise the first previewable one. No new endpoint.
 */
export async function fetchEvidencePreview(
  evidenceId: string,
): Promise<EvidencePreviewMeta> {
  try {
    const res = (await apiFetch(`/v1/evidence/${encodeURIComponent(evidenceId)}/parts`, { method: "GET" })) as {
      parts?: ReadonlyArray<PartsListingItem>;
    } | null;
    const parts = Array.isArray(res?.parts) ? res!.parts! : [];
    if (parts.length === 0) {
      return { id: evidenceId, mimeType: null, previewUrl: null, unavailable: "no_file" };
    }
    const primary = parts.find((p) => p?.isPrimary) ?? null;
    const target =
      (primary && primary.previewable ? primary : null) ??
      parts.find((p) => p?.previewable) ??
      primary ??
      parts[0]!;
    const mimeType = typeof target.mimeType === "string" ? target.mimeType : null;
    const displayName = typeof target.displayName === "string" ? target.displayName : null;
    if (!target.previewable) {
      return { id: evidenceId, mimeType, previewUrl: null, unavailable: "not_previewable", displayName };
    }
    const url = typeof target.previewUrl === "string" && target.previewUrl.length > 0 ? target.previewUrl : null;
    if (!url) {
      return { id: evidenceId, mimeType, previewUrl: null, unavailable: "policy", displayName };
    }
    return { id: evidenceId, mimeType, previewUrl: url, unavailable: null, displayName };
  } catch {
    return { id: evidenceId, mimeType: null, previewUrl: null, unavailable: "failed" };
  }
}

// ---------------------------------------------------------------------------
// PHASE 1 — Side-pane read helpers (EVIDENCE / OCR / TRANSCRIPT / REPORT).
//
// These wrap EXISTING canonical endpoints — no new routes. Each helper:
//   * is wrapped in try/catch and returns a tagged failure shape
//     (never throws into render).
//   * surfaces a structured `warn` log so partial-failure is observable.
//   * returns bounded data — no raw storage keys, no full extracted text
//     bodies (the listExtractedTexts endpoint already projects via the
//     summary helper which drops the `text` column on purpose).
// ---------------------------------------------------------------------------

/**
 * Bounded projection of GET /v1/evidence/:id used by the EVIDENCE
 * compare side-pane. Only the fields the side-pane actually renders —
 * no storageBucket / storageKey / file bytes / signedPreviewUrl. The
 * evidence detail page already covers full inspection at /evidence/:id.
 */
export type EvidenceSidePaneDetail = {
  id: string;
  displayTitle: string | null;
  displaySubtitle: string | null;
  displayDescription: string | null;
  mimeType: string | null;
  primaryContentLabel: string | null;
  fileSha256Prefix: string | null;
  status: string | null;
  verificationStatus: string | null;
  caseId: string | null;
  templateSlug: string | null;
  templateVersion: string | null;
};

export type EvidenceSidePaneResult =
  | { ok: true; detail: EvidenceSidePaneDetail }
  | { ok: false; reason: "FORBIDDEN" | "NOT_FOUND" | "ERROR" };

function shortHashPrefix(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  // 12 hex chars is the canonical truncation the rest of the UI uses
  // for evidence-hash displays — operator sees a stable prefix without
  // leaking the full integrity fingerprint into side-pane copy.
  return raw.slice(0, 12);
}

export async function fetchEvidenceSidePaneDetail(
  evidenceId: string,
): Promise<EvidenceSidePaneResult> {
  try {
    const res = await apiFetch(`/v1/evidence/${evidenceId}`, { method: "GET" });
    const ev = (res?.evidence ?? null) as Record<string, unknown> | null;
    if (!ev) return { ok: false, reason: "NOT_FOUND" };
    const templateSlugRaw = ev.workflowDefinitionSlug ?? ev.templateSlug ?? null;
    const templateVersionRaw =
      ev.workflowDefinitionVersion ?? ev.templateVersion ?? null;
    return {
      ok: true,
      detail: {
        id: String(ev.id ?? evidenceId),
        displayTitle:
          typeof ev.displayTitle === "string" ? ev.displayTitle : null,
        displaySubtitle:
          typeof ev.displaySubtitle === "string" ? ev.displaySubtitle : null,
        displayDescription:
          typeof ev.displayDescription === "string"
            ? ev.displayDescription
            : null,
        mimeType: typeof ev.mimeType === "string" ? ev.mimeType : null,
        primaryContentLabel:
          typeof ev.primaryContentLabel === "string"
            ? ev.primaryContentLabel
            : null,
        fileSha256Prefix: shortHashPrefix(ev.fileSha256),
        status: typeof ev.status === "string" ? ev.status : null,
        verificationStatus:
          typeof ev.verificationStatus === "string"
            ? ev.verificationStatus
            : null,
        caseId: typeof ev.caseId === "string" ? ev.caseId : null,
        templateSlug:
          typeof templateSlugRaw === "string" ? templateSlugRaw : null,
        templateVersion:
          typeof templateVersionRaw === "string"
            ? templateVersionRaw
            : templateVersionRaw == null
              ? null
              : String(templateVersionRaw),
      },
    };
  } catch (err) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const status = (err as any)?.statusCode ?? 0;
    // eslint-disable-next-line no-console
    console.warn("[reviewer-workspace] evidence side-pane fetch failed", {
      evidenceId,
      status,
    });
    if (status === 403) return { ok: false, reason: "FORBIDDEN" };
    if (status === 404) return { ok: false, reason: "NOT_FOUND" };
    return { ok: false, reason: "ERROR" };
  }
}

/**
 * Summary row returned by GET /v1/intelligence/evidence/:id?teamId=...
 * The route uses `projectExtractedTextSummary` which deliberately
 * strips the raw `text` column — only metadata reaches the wire.
 */
export type ExtractedTextSummaryRow = {
  id: string;
  kind: string;
  status: string;
  provider: string;
  providerVersion: string | null;
  language: string | null;
  confidence: number | null;
  wordCount: number | null;
  extractedAtUtc: string | null;
};

export type ExtractedTextsResult =
  | { ok: true; rows: ExtractedTextSummaryRow[] }
  | { ok: false; reason: "FORBIDDEN" | "NOT_FOUND" | "NO_TEAM" | "ERROR" };

/**
 * GET /v1/intelligence/evidence/:id?teamId=<uuid>
 *
 * Returns the ExtractedText SUMMARIES (no raw text). The Reviewer
 * Workspace OCR and TRANSCRIPT panes filter the rows client-side by
 * `kind` — the canonical extracted-text kinds include `OCR` and
 * `TRANSCRIPT`. A teamId is required; on personal-mode workspaces this
 * helper returns NO_TEAM so the side-pane renders an honest empty
 * state instead of issuing a request that will 400 on missing param.
 */
export async function fetchExtractedTextsForEvidence(
  evidenceId: string,
  teamId: string | null,
): Promise<ExtractedTextsResult> {
  if (!teamId) return { ok: false, reason: "NO_TEAM" };
  try {
    const res = await apiFetch(
      `/v1/intelligence/evidence/${evidenceId}?teamId=${encodeURIComponent(teamId)}`,
      { method: "GET" },
    );
    const raw = Array.isArray(res?.extractedTexts) ? res.extractedTexts : [];
    const rows: ExtractedTextSummaryRow[] = raw.map(
      (r: Record<string, unknown>) => ({
        id: String(r.id ?? ""),
        kind: String(r.kind ?? ""),
        status: String(r.status ?? ""),
        provider: String(r.provider ?? ""),
        providerVersion:
          typeof r.providerVersion === "string" ? r.providerVersion : null,
        language: typeof r.language === "string" ? r.language : null,
        confidence: typeof r.confidence === "number" ? r.confidence : null,
        wordCount: typeof r.wordCount === "number" ? r.wordCount : null,
        extractedAtUtc:
          typeof r.extractedAtUtc === "string" ? r.extractedAtUtc : null,
      }),
    );
    return { ok: true, rows };
  } catch (err) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const status = (err as any)?.statusCode ?? 0;
    // eslint-disable-next-line no-console
    console.warn(
      "[reviewer-workspace] extracted-texts side-pane fetch failed",
      { evidenceId, status },
    );
    if (status === 403) return { ok: false, reason: "FORBIDDEN" };
    if (status === 404) return { ok: false, reason: "NOT_FOUND" };
    return { ok: false, reason: "ERROR" };
  }
}

/**
 * Bounded projection of GET /v1/evidence/:id/artifacts/status used by
 * the REPORT side-pane. The endpoint is side-effect-free (no
 * CustodyEvent / VerificationView writes) and is the canonical poll
 * surface for "is the artifact pair ready?". We surface only the
 * status flags + version + timestamp — never the download URL.
 */
export type EvidenceArtifactSidePaneState = {
  reportAvailable: boolean;
  reportPending: boolean;
  reportVersion: number | null;
  reportGeneratedAtUtc: string | null;
  packageAvailable: boolean;
  packagePending: boolean;
  packageBlocked: boolean;
  packageVersion: number | null;
  packageGeneratedAtUtc: string | null;
};

export type EvidenceArtifactsResult =
  | { ok: true; state: EvidenceArtifactSidePaneState }
  | { ok: false; reason: "FORBIDDEN" | "NOT_FOUND" | "ERROR" };

export async function fetchEvidenceArtifactsStatus(
  evidenceId: string,
): Promise<EvidenceArtifactsResult> {
  try {
    const res = await apiFetch(`/v1/evidence/${evidenceId}/artifacts/status`, {
      method: "GET",
    });
    const report = (res?.report ?? null) as Record<string, unknown> | null;
    const pkg = (res?.verificationPackage ?? null) as
      | Record<string, unknown>
      | null;
    return {
      ok: true,
      state: {
        reportAvailable: report?.available === true,
        reportPending: report?.pending === true,
        reportVersion:
          typeof report?.version === "number" ? report.version : null,
        reportGeneratedAtUtc:
          typeof report?.generatedAtUtc === "string"
            ? report.generatedAtUtc
            : null,
        packageAvailable: pkg?.available === true,
        packagePending: pkg?.pending === true,
        packageBlocked: pkg?.blocked === true,
        packageVersion: typeof pkg?.version === "number" ? pkg.version : null,
        packageGeneratedAtUtc:
          typeof pkg?.generatedAtUtc === "string"
            ? pkg.generatedAtUtc
            : null,
      },
    };
  } catch (err) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const status = (err as any)?.statusCode ?? 0;
    // eslint-disable-next-line no-console
    console.warn(
      "[reviewer-workspace] artifacts-status side-pane fetch failed",
      { evidenceId, status },
    );
    if (status === 403) return { ok: false, reason: "FORBIDDEN" };
    if (status === 404) return { ok: false, reason: "NOT_FOUND" };
    return { ok: false, reason: "ERROR" };
  }
}

export type BulkOutcome = {
  workflowId: string;
  ok: boolean;
  denial?: string;
};

/**
 * T-167 (stage B) — the bulk doors answer 401 STEP_UP_REQUIRED (bulk checkbox,
 * session risk) and 401 reauth_required (4 h window). Folding those into a
 * `{ denial }` left the Queues page unable to satisfy them. A caller that hosts
 * the shared step-up dialog passes the challenge header and asks for those two
 * refusals to be thrown, so `runStepUpAction` can handle them.
 */
export type BulkCallOptions = {
  headers?: Record<string, string>;
  rethrowChallenges?: boolean;
};

function isChallengeRefusal(err: unknown): boolean {
  const e = err as { code?: unknown; statusCode?: unknown } | null;
  return e?.statusCode === 401 && (e.code === "STEP_UP_REQUIRED" || e.code === "reauth_required");
}

export async function bulkAssign(input: {
  assigneeUserId: string;
  workflowIds: string[];
  teamId?: string | null;
}): Promise<{
  total: number;
  succeeded: number;
  outcomes: BulkOutcome[];
} | { denial: string }> {
  try {
    // T-036 — assignment is not a step-up action; no challenge header.
    return await apiFetch(
      withTeamId("/v1/reviewer/bulk/assign", input.teamId),
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    );
  } catch (err) {
    // PRO-R2Z-06 — the fields apiFetch actually sets.
    return { denial: reviewerDenialFromError(err) };
  }
}

export async function bulkDecide(input: {
  verdict: "APPROVE" | "REJECT" | "ESCALATE" | "NEEDS_INFO";
  rationale?: string;
  workflowIds: string[];
  teamId?: string | null;
}, opts: BulkCallOptions = {}): Promise<{
  total: number;
  succeeded: number;
  outcomes: BulkOutcome[];
} | { denial: string }> {
  try {
    return await apiFetch(
      withTeamId("/v1/reviewer/bulk/decide", input.teamId),
      {
        method: "POST",
        ...(opts.headers ? { headers: opts.headers } : {}),
        body: JSON.stringify(input),
      },
    );
  } catch (err) {
    if (opts.rethrowChallenges && isChallengeRefusal(err)) throw err;
    // PRO-R2Z-06 — the fields apiFetch actually sets.
    return { denial: reviewerDenialFromError(err) };
  }
}

export async function bulkCode(input: {
  fieldSlug: string;
  value: Record<string, unknown>;
  workflowIds: string[];
  teamId?: string | null;
}): Promise<{
  total: number;
  succeeded: number;
  outcomes: BulkOutcome[];
} | { denial: string }> {
  try {
    return await apiFetch(withTeamId("/v1/reviewer/bulk/code", input.teamId), {
      method: "POST",
      body: JSON.stringify(input),
    });
  } catch (err) {
    // PRO-R2Z-06 — the fields apiFetch actually sets.
    return { denial: reviewerDenialFromError(err) };
  }
}

// ---------------------------------------------------------------------------
// Reviewer-ops lifecycle wiring — PHASE 1.
//
// These four helpers wrap the canonical reviewer-ops endpoints so the
// Reviewer Workspace can actually close workflows (approve / reject /
// request-info / escalate) instead of merely persisting a coding-value
// pseudo-decision. The endpoints are the *existing* canonical routes
// at services/api/src/routes/reviewer-ops.routes.ts — no new routes,
// no new workflow engine. All four require a teamId because the
// reviewer-ops engine enforces capability + step-up per team.
// ---------------------------------------------------------------------------

export type LifecycleCallResult =
  | { ok: true; projection?: unknown; escalation?: unknown }
  | { ok: false; status: number; code: string; message: string };

function classifyLifecycleError(err: unknown): {
  status: number;
  code: string;
  message: string;
} {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyErr = err as any;
  return {
    status: typeof anyErr?.statusCode === "number" ? anyErr.statusCode : 0,
    code:
      typeof anyErr?.code === "string"
        ? anyErr.code
        : typeof anyErr?.body?.error?.code === "string"
          ? anyErr.body.error.code
          : "LIFECYCLE_CALL_FAILED",
    message:
      typeof anyErr?.message === "string"
        ? anyErr.message
        : "Lifecycle call failed.",
  };
}

/**
 * POST /v1/reviewer-ops/reviews/:workflowId/approve
 *
 * Server body schema (z): { teamId: uuid, note?: string(1..1000)|null }.
 * `note` is optional/nullable for approve.
 */
export async function approveReview(input: {
  workflowId: string;
  teamId: string;
  note?: string | null;
}): Promise<LifecycleCallResult> {
  try {
    const body: Record<string, unknown> = { teamId: input.teamId };
    if (input.note !== undefined) body.note = input.note;
    const res = await apiFetch(
      `/v1/reviewer-ops/reviews/${input.workflowId}/approve`,
      { method: "POST", body: JSON.stringify(body) },
    );
    return { ok: true, projection: res?.projection };
  } catch (err) {
    return { ok: false, ...classifyLifecycleError(err) };
  }
}

/**
 * POST /v1/reviewer-ops/reviews/:workflowId/reject
 *
 * Server body schema (z): { teamId: uuid, note: string(1..1000) }.
 * `note` carries the rejection reason and is REQUIRED.
 */
export async function rejectReview(input: {
  workflowId: string;
  teamId: string;
  reason: string;
}): Promise<LifecycleCallResult> {
  try {
    const res = await apiFetch(
      `/v1/reviewer-ops/reviews/${input.workflowId}/reject`,
      {
        method: "POST",
        body: JSON.stringify({ teamId: input.teamId, note: input.reason }),
      },
    );
    return { ok: true, projection: res?.projection };
  } catch (err) {
    return { ok: false, ...classifyLifecycleError(err) };
  }
}

/**
 * POST /v1/reviewer-ops/reviews/:workflowId/request-info
 *
 * Server body schema (z): { teamId: uuid, note: string(1..1000) }.
 * `note` carries the "what info is needed" message and is REQUIRED.
 */
export async function requestInfoReview(input: {
  workflowId: string;
  teamId: string;
  message: string;
}): Promise<LifecycleCallResult> {
  try {
    const res = await apiFetch(
      `/v1/reviewer-ops/reviews/${input.workflowId}/request-info`,
      {
        method: "POST",
        body: JSON.stringify({ teamId: input.teamId, note: input.message }),
      },
    );
    return { ok: true, projection: res?.projection };
  } catch (err) {
    return { ok: false, ...classifyLifecycleError(err) };
  }
}

/**
 * POST /v1/reviewer-ops/escalations
 *
 * Server body schema (z): {
 *   teamId: uuid, workflowId: uuid,
 *   reason: enum(REVIEW_ESCALATION_REASONS),
 *   severity?: enum("INFO"|"WARNING"|"HIGH"|"CRITICAL"),
 *   safeSummary: string(1..400),
 *   assignedToUserId?: uuid|null
 * }
 */
export async function createEscalation(input: {
  workflowId: string;
  teamId: string;
  reason: string;
  safeSummary: string;
  severity?: "INFO" | "WARNING" | "HIGH" | "CRITICAL";
  assignedToUserId?: string | null;
  /** 2026-11-27 — explicitly require an independent second decision (integrity reasons always do). */
  requireIndependentReview?: boolean;
  independenceNote?: string | null;
}): Promise<LifecycleCallResult> {
  try {
    const body: Record<string, unknown> = {
      teamId: input.teamId,
      workflowId: input.workflowId,
      reason: input.reason,
      safeSummary: input.safeSummary,
    };
    if (input.severity) body.severity = input.severity;
    if (input.assignedToUserId !== undefined) {
      body.assignedToUserId = input.assignedToUserId;
    }
    if (input.requireIndependentReview !== undefined) body.requireIndependentReview = input.requireIndependentReview;
    if (input.independenceNote) body.independenceNote = input.independenceNote;
    const res = await apiFetch("/v1/reviewer-ops/escalations", {
      method: "POST",
      body: JSON.stringify(body),
    });
    return { ok: true, escalation: res?.escalation };
  } catch (err) {
    return { ok: false, ...classifyLifecycleError(err) };
  }
}

// ---------------------------------------------------------------------------
// Phase 5 — Redaction affordance from Reviewer Workspace.
//
// "Request redaction" is bounded to two interactions with the existing
// canonical surface:
//
//   * GET  /v1/redaction/projects               — list, then client-side
//                                                 filter by evidenceId
//                                                 (no per-evidence read
//                                                 route exists).
//   * POST /v1/redaction/projects               — idempotent open; the
//                                                 service-layer guard
//                                                 returns the existing
//                                                 projectId with
//                                                 opened=false if a row
//                                                 already exists for
//                                                 (teamId, evidenceId).
//
// The route gate is `redaction.region.author` + FEATURE_REDACTION; the
// canonical REVIEWER role receives the bounded redaction subset that
// includes `redaction.region.author` (packages/shared/src/permissions.ts).
// Server gating remains the source of truth — denial is surfaced honestly.
// ---------------------------------------------------------------------------

export type RedactionArtifactKindUI = "IMAGE" | "PDF" | "VIDEO" | "AUDIO";

/**
 * Map a mimeType to the canonical REDACTION_ARTIFACT_KINDS enum. Returns
 * `null` when the kind cannot be inferred — the caller must surface an
 * honest empty state instead of guessing.
 */
export function inferRedactionArtifactKind(
  mimeType: string | null,
): RedactionArtifactKindUI | null {
  if (!mimeType) return null;
  if (mimeType === "application/pdf") return "PDF";
  if (mimeType.startsWith("image/")) return "IMAGE";
  if (mimeType.startsWith("video/")) return "VIDEO";
  if (mimeType.startsWith("audio/")) return "AUDIO";
  return null;
}

export type RedactionAffordanceLookup =
  | { ok: true; projectId: string | null }
  | { ok: false; reason: "FORBIDDEN" | "ERROR" };

/**
 * Client-side lookup: list redaction projects then filter by evidenceId.
 * Returns the first matching projectId if one exists. No per-evidence
 * read route is available, so the listing approach is the only way to
 * answer "does a project already exist for this evidence?" without
 * touching POST.
 */
export async function lookupRedactionProjectForEvidence(
  evidenceId: string,
): Promise<RedactionAffordanceLookup> {
  try {
    const res = await apiFetch("/v1/redaction/projects", { method: "GET" });
    const rows = (res?.projects ?? []) as Array<Record<string, unknown>>;
    for (const row of rows) {
      if (row && row.evidenceId === evidenceId) {
        const id = typeof row.id === "string" ? row.id : null;
        return { ok: true, projectId: id };
      }
    }
    return { ok: true, projectId: null };
  } catch (err) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const status = (err as any)?.statusCode ?? 0;
    // eslint-disable-next-line no-console
    console.warn(
      "[reviewer-workspace] redaction project lookup failed",
      { evidenceId, status },
    );
    if (status === 403) return { ok: false, reason: "FORBIDDEN" };
    return { ok: false, reason: "ERROR" };
  }
}

export type RedactionAffordanceOpen =
  | { ok: true; projectId: string; opened: boolean }
  | {
      ok: false;
      reason:
        | "FORBIDDEN"
        | "ENTITLEMENT_REQUIRED"
        | "UNSUPPORTED_MIME"
        | "ERROR";
    };

/**
 * POST /v1/redaction/projects — idempotent open. Returns the existing
 * projectId with opened=false if a row already exists, or the new
 * projectId with opened=true. Denial surfaces are normalised so the
 * affordance can render an honest message and the operator can route
 * to the existing redaction console for follow-up.
 */
export async function openRedactionProjectForEvidence(input: {
  evidenceId: string;
  mimeType: string | null;
  title: string | null;
}): Promise<RedactionAffordanceOpen> {
  const kind = inferRedactionArtifactKind(input.mimeType);
  if (!kind) {
    return { ok: false, reason: "UNSUPPORTED_MIME" };
  }
  try {
    const body: Record<string, unknown> = {
      evidenceId: input.evidenceId,
      artifactKind: kind,
    };
    if (input.title) {
      // Bounded: backend caps title at 200 chars; mirror the cap.
      body.title = input.title.slice(0, 200);
    }
    const res = await apiFetch("/v1/redaction/projects", {
      method: "POST",
      body: JSON.stringify(body),
    });
    const projectId =
      typeof res?.projectId === "string" ? (res.projectId as string) : null;
    const opened = res?.opened === true;
    if (!projectId) return { ok: false, reason: "ERROR" };
    return { ok: true, projectId, opened };
  } catch (err) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const e = err as any;
    const status = e?.statusCode ?? 0;
    const denial =
      typeof e?.details?.denial === "string"
        ? (e.details.denial as string)
        : typeof e?.denial === "string"
          ? (e.denial as string)
          : null;
    // eslint-disable-next-line no-console
    console.warn(
      "[reviewer-workspace] redaction project open failed",
      { evidenceId: input.evidenceId, status, denial },
    );
    if (denial === "ENTITLEMENT_REQUIRED") {
      return { ok: false, reason: "ENTITLEMENT_REQUIRED" };
    }
    if (status === 403) return { ok: false, reason: "FORBIDDEN" };
    return { ok: false, reason: "ERROR" };
  }
}

// ---------------------------------------------------------------------------
// Review remediation 2026-11-27 — escalation rows and decision projections.
// ---------------------------------------------------------------------------

/** One move on an escalation the viewer may (or may not) make, with why not. */
export type EscalationViewerAction = {
  action: "acknowledge" | "reassign" | "resolve" | "suppress";
  allowed: boolean;
  reason?: string;
};

/** Why an escalation requires an independent second decision (null = administrative). */
export type EscalationIndependenceCause =
  | "independent_review_requested"
  | "integrity_escalation"
  | "legacy_escalation"
  | null;

/** The additive fields GET /v1/reviewer-ops/escalations rows now carry. */
export type EscalationRowRemediation = {
  viewerActions?: EscalationViewerAction[];
  independenceCause?: EscalationIndependenceCause;
  independenceNote?: string | null;
};

/** F-06 — who requested the independent second decision, and when. */
export type DecisionsSecondReviewEscalation = {
  reason: string;
  severity: string;
  requestedByUserId?: string | null;
  requestedByName?: string | null;
  requestedAtUtc?: string | null;
  note?: string | null;
};
