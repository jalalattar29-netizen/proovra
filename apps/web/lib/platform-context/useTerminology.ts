"use client";

/**
 * Canonical product terminology.
 *
 * (2026-07-20) The persona/workflow terminology-override dimension was
 * removed with the workspace-persona feature family. Every surface now
 * uses the single canonical vocabulary; the backend object names
 * (`Case`, `Evidence`, `Report`, …) are unchanged.
 */

export type TerminologyKey =
  | "case"
  | "caseLower"
  | "casePlural"
  | "evidence"
  | "evidenceLower"
  | "report"
  | "reportLower"
  | "timeline"
  | "publicVerify"
  | "review"
  | "assignment"
  | "dashboard"
  | "queue"
  | "incident";

type TerminologyMap = Record<TerminologyKey, string>;

const CANONICAL_TERMS: TerminologyMap = {
  case: "Case",
  caseLower: "case",
  casePlural: "Cases",
  evidence: "Evidence",
  evidenceLower: "evidence",
  report: "Report",
  reportLower: "report",
  timeline: "Timeline",
  publicVerify: "Public Verify",
  review: "Review",
  assignment: "Assignment",
  dashboard: "Dashboard",
  queue: "Queue",
  incident: "Incident",
};

export function useTerminology(): TerminologyMap {
  return CANONICAL_TERMS;
}

/** Pure-function variant for tests + non-React callers. */
export function resolveTerminology(): TerminologyMap {
  return CANONICAL_TERMS;
}
