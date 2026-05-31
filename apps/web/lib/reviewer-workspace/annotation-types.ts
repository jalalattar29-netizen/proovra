/**
 * PROOVRA Phase 2A Closure — annotation type shared between viewers
 * and the inline panel.
 *
 * Mirrors the bounded shape returned by
 * `/v1/reviewer/evidence/:evidenceId/annotations`.
 */

export type ReviewerAnnotationSummary = {
  id: string;
  evidenceId: string;
  evidencePartId: string | null;
  authorUserId: string;
  parentAnnotationId: string | null;
  annotationType: string;
  body: string | null;
  pageNumber: number | null;
  mediaTimestampMs: number | null;
  x: number | null;
  y: number | null;
  width: number | null;
  height: number | null;
  coordinateSpace: string;
  createdAt: string;
  updatedAt: string;
  resolvedAtUtc: string | null;
  resolvedByUserId: string | null;
};
