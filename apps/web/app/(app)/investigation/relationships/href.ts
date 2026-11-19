/**
 * PRO-K1C-06 — THE ONE LINK INTO THE RELATIONSHIP INSPECTOR.
 *
 * The inspector's contract (relationships/page.tsx): `caseId` is required and
 * `nodeId` / `edgeId` are graph ids of that case's subgraph. A link that cannot
 * name the case cannot be served, so this returns `null` and the caller offers
 * no dead "Inspect" link (an evidence-keyed pivot goes to the record instead).
 */
export function relationshipInspectorHref(input: {
  caseId: string | null | undefined;
  nodeId?: string | null;
  edgeId?: string | null;
}): string | null {
  if (!input.caseId) return null;
  const params = new URLSearchParams({ caseId: input.caseId });
  if (input.nodeId) params.set("nodeId", input.nodeId);
  if (input.edgeId) params.set("edgeId", input.edgeId);
  return `/investigation/relationships?${params.toString()}`;
}
