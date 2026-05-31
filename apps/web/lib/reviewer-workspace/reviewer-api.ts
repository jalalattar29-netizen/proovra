"use client";

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
  ReviewerWorkspaceProjection,
} from "@proovra/shared";

import { apiFetch } from "../api";

export async function fetchReviewerWorkspace(): Promise<
  ReviewerWorkspaceProjection | null
> {
  const res = await apiFetch("/v1/reviewer/workspace", { method: "GET" });
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

export async function fetchSchema(schemaId: string): Promise<CodingSchemaRow | null> {
  const res = await apiFetch(`/v1/coding/schemas/${schemaId}`, { method: "GET" });
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

export async function fetchCodingState(workflowId: string): Promise<{
  values: CodingValueRow[];
  coverage: CodingCoverage;
}> {
  const res = await apiFetch(`/v1/reviewer/work/${workflowId}/coding`, {
    method: "GET",
  });
  return {
    values: (res?.values ?? []) as CodingValueRow[],
    coverage: res?.coverage as CodingCoverage,
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
}): Promise<CodingWriteResult> {
  try {
    const res = await apiFetch(`/v1/reviewer/work/${input.workflowId}/code`, {
      method: "POST",
      body: JSON.stringify({
        fieldId: input.fieldId,
        value: input.value,
        rationale: input.rationale,
      }),
    });
    return { ok: true, codingValueId: res.codingValueId };
  } catch (err) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const denial = ((err as any)?.body?.denial ?? "RATE_LIMITED") as ReviewerDenialReason;
    return { ok: false, denial };
  }
}

export async function fileDisagreement(input: {
  workflowId: string;
  originalDecisionId: string;
  rationale: string;
}): Promise<{ ok: true; disagreementId: string } | { ok: false; denial: ReviewerDenialReason }> {
  try {
    const res = await apiFetch(`/v1/reviewer/work/${input.workflowId}/disagree`, {
      method: "POST",
      body: JSON.stringify({
        originalDecisionId: input.originalDecisionId,
        rationale: input.rationale,
      }),
    });
    return { ok: true, disagreementId: res.disagreementId };
  } catch (err) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const denial = ((err as any)?.body?.denial ?? "RATE_LIMITED") as ReviewerDenialReason;
    return { ok: false, denial };
  }
}

export async function transitionDisagreement(input: {
  disagreementId: string;
  to: string;
  verdict?: ReviewerVerdict;
  rationale?: string;
}): Promise<{ ok: true } | { ok: false; denial: ReviewerDenialReason }> {
  try {
    await apiFetch(`/v1/reviewer/disagreements/${input.disagreementId}/transition`, {
      method: "POST",
      body: JSON.stringify({
        to: input.to,
        verdict: input.verdict,
        rationale: input.rationale,
      }),
    });
    return { ok: true };
  } catch (err) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const denial = ((err as any)?.body?.denial ?? "RATE_LIMITED") as ReviewerDenialReason;
    return { ok: false, denial };
  }
}

export async function fetchQcSamples(): Promise<unknown[]> {
  const res = await apiFetch("/v1/reviewer/qc/samples?limit=100", { method: "GET" });
  return (res?.samples ?? []) as unknown[];
}

export async function renderQcVerdict(input: {
  sampleId: string;
  verdict: "PASS" | "FAIL" | "PARTIAL";
  failureReason?: string;
  rationale?: string;
}): Promise<{ ok: true } | { ok: false; denial: ReviewerDenialReason }> {
  try {
    await apiFetch(`/v1/reviewer/qc/samples/${input.sampleId}/verdict`, {
      method: "POST",
      body: JSON.stringify(input),
    });
    return { ok: true };
  } catch (err) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const denial = ((err as any)?.body?.denial ?? "RATE_LIMITED") as ReviewerDenialReason;
    return { ok: false, denial };
  }
}

export async function fetchReviewerMetrics(): Promise<{
  throughput7d: number;
  approvalRate7dPct: number;
  escalationRate7dPct: number;
  disagreementRate7dPct: number;
  qcFailureRate7dPct: number;
  avgReviewDurationMs7d: number;
}> {
  const res = await apiFetch("/v1/reviewer/metrics", { method: "GET" });
  return res.metrics;
}

export async function seedDefaultSchemas(): Promise<{ created: number; existing: number }> {
  return apiFetch("/v1/coding/schemas/seed-defaults", { method: "POST", body: "{}" });
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
};

export async function fetchEvidencePreview(
  evidenceId: string,
): Promise<EvidencePreviewMeta> {
  // The existing evidence detail route returns the canonical fields
  // including a presigned preview URL when authorised. Bounded to a
  // single read for the workspace.
  try {
    const res = await apiFetch(`/v1/evidence/${evidenceId}`, { method: "GET" });
    return {
      id: res?.evidence?.id ?? evidenceId,
      mimeType: res?.evidence?.mimeType ?? null,
      previewUrl:
        res?.previewUrl ??
        res?.evidence?.previewUrl ??
        res?.evidence?.signedPreviewUrl ??
        null,
    };
  } catch {
    return { id: evidenceId, mimeType: null, previewUrl: null };
  }
}

export type BulkOutcome = {
  workflowId: string;
  ok: boolean;
  denial?: string;
};

export async function bulkAssign(input: {
  assigneeUserId: string;
  workflowIds: string[];
}): Promise<{
  total: number;
  succeeded: number;
  outcomes: BulkOutcome[];
} | { denial: string }> {
  try {
    return await apiFetch("/v1/reviewer/bulk/assign", {
      method: "POST",
      body: JSON.stringify(input),
    });
  } catch (err) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { denial: ((err as any)?.body?.denial ?? "RATE_LIMITED") as string };
  }
}

export async function bulkDecide(input: {
  verdict: "APPROVE" | "REJECT" | "ESCALATE" | "NEEDS_INFO";
  rationale?: string;
  workflowIds: string[];
}): Promise<{
  total: number;
  succeeded: number;
  outcomes: BulkOutcome[];
} | { denial: string }> {
  try {
    return await apiFetch("/v1/reviewer/bulk/decide", {
      method: "POST",
      body: JSON.stringify(input),
    });
  } catch (err) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { denial: ((err as any)?.body?.denial ?? "RATE_LIMITED") as string };
  }
}

export async function bulkCode(input: {
  fieldSlug: string;
  value: Record<string, unknown>;
  workflowIds: string[];
}): Promise<{
  total: number;
  succeeded: number;
  outcomes: BulkOutcome[];
} | { denial: string }> {
  try {
    return await apiFetch("/v1/reviewer/bulk/code", {
      method: "POST",
      body: JSON.stringify(input),
    });
  } catch (err) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { denial: ((err as any)?.body?.denial ?? "RATE_LIMITED") as string };
  }
}
