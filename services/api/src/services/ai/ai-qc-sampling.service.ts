/**
 * Phase D5 — QC sampling over persisted Copilot runs.
 *
 * Deterministic, injectable sampling strategies over AiCopilotRun rows +
 * observation interactions. AI "confidence" is never treated as truth
 * confidence — sampling keys on operational signals only (edit rate,
 * citation-drop rate, blocks, failures, disagreement).
 */

export type QcRunRow = {
  id: string;
  workspaceId: string;
  feature: string;
  status: string;
  generatedAt: Date;
  droppedCitations: number;
  observationCount: number;
  editedCount: number;
  rejectedCount: number;
};

export type QcSampleStrategy =
  | "RANDOM"
  | "RISK_BASED"
  | "HIGH_EDIT_RATE"
  | "LOW_CITATION"
  | "DISAGREEMENT"
  | "POLICY_BLOCK"
  | "INJECTION_DETECTED"
  | "PROVIDER_FAILURE";

/** Deterministic pseudo-random selection seeded by run id (reproducible). */
function seededScore(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return (h % 1000) / 1000;
}

function editRate(r: QcRunRow): number {
  return r.observationCount === 0 ? 0 : r.editedCount / r.observationCount;
}
function rejectRate(r: QcRunRow): number {
  return r.observationCount === 0 ? 0 : r.rejectedCount / r.observationCount;
}

export function selectQcSample(
  rows: QcRunRow[],
  strategy: QcSampleStrategy,
  limit = 10,
): QcRunRow[] {
  let filtered: QcRunRow[];
  switch (strategy) {
    case "RANDOM":
      filtered = [...rows].sort((a, b) => seededScore(a.id) - seededScore(b.id));
      break;
    case "RISK_BASED":
      filtered = [...rows].sort(
        (a, b) =>
          (editRate(b) + rejectRate(b) + b.droppedCitations) -
          (editRate(a) + rejectRate(a) + a.droppedCitations),
      );
      break;
    case "HIGH_EDIT_RATE":
      filtered = rows.filter((r) => editRate(r) >= 0.3).sort((a, b) => editRate(b) - editRate(a));
      break;
    case "LOW_CITATION":
      filtered = rows.filter((r) => r.droppedCitations > 0).sort((a, b) => b.droppedCitations - a.droppedCitations);
      break;
    case "DISAGREEMENT":
      filtered = rows.filter((r) => rejectRate(r) > 0).sort((a, b) => rejectRate(b) - rejectRate(a));
      break;
    case "POLICY_BLOCK":
      filtered = rows.filter((r) => r.status === "blocked_prohibited_claim");
      break;
    case "INJECTION_DETECTED":
      filtered = rows.filter((r) => r.status === "injection_detected");
      break;
    case "PROVIDER_FAILURE":
      filtered = rows.filter((r) => r.status === "schema_error" || r.status === "provider_unavailable");
      break;
  }
  return filtered.slice(0, limit);
}

export type QcVerdict = "CONFIRMED" | "REJECTED" | "EDITED" | "POLICY_ISSUE" | "CITATION_ISSUE";
