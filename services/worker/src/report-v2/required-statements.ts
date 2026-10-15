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
