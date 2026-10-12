/**
 * Statements the rendered report must carry in full. The sections print them
 * from here and the geometric release gate (pdf/report-geometry.ts) requires
 * them in the PDF's own text — so a statement that is clipped, pushed off a
 * page or dropped refuses the report instead of shipping without it.
 */

/** The opening of an updated report's supersession notice. */
export function supersessionStatement(previousVersion: number): string {
  return `This version supersedes report v${previousVersion}`;
}

/** The evidence boundary every report states once, in its provenance panel. */
export const PROVENANCE_BOUNDARY_STATEMENT =
  "Integrity and custody records do not prove factual truth, authorship or legal admissibility.";
