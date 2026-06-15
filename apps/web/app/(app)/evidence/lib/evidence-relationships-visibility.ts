/**
 * Phase EVIDENCE-RELATIONSHIPS-GATE — Manage Relationships visibility.
 *
 * Manage Relationships is a useful surface for enterprise / legal /
 * investigation evidence-graph workflows, but noisy for Personal and
 * small-team workspaces — most users will never link records to other
 * records, and seeing a primary "Manage relationships" button creates
 * the impression of an unfinished workflow.
 *
 * `canManageEvidenceRelationships()` returns a small decision shape
 * the section component uses to decide whether to render the
 * Manage button, the per-row Remove buttons, and the whole
 * relationships subsection.
 *
 * Decision rules (frontend-only — does NOT relax any backend guard):
 *
 *   1. The /investigation surface unlocks evidence-graph workflows.
 *      When the user can reach that surface (ENTERPRISE tier or
 *      explicit grant) the full Manage UI shows.
 *
 *   2. Otherwise (Personal / CORE / PROFESSIONAL workspaces without
 *      explicit grant): the Manage button + per-row Remove buttons
 *      are hidden. If existing relationships are already recorded
 *      on the record, the read-only Linked-evidence list still
 *      shows (per spec: "Optionally show a read-only 'Linked
 *      records' summary only if relationships already exist").
 *
 * Backend authorization is unchanged — every relationship
 * mutation endpoint still enforces its own permission/audit gate.
 * Hiding the UI does NOT make the route forbidden.
 */

export type EvidenceRelationshipsVisibility = {
  /**
   * Show the "Manage relationships" primary button AND per-row
   * "Remove relationship" buttons. False on Personal / small-team
   * workspaces unless the workspace has the investigation surface.
   */
  canManage: boolean;
  /**
   * Show the Linked-evidence subsection at all. True when either
   * `canManage` is true OR existing relationships are present (so a
   * read-only summary stays available even when management is hidden).
   */
  showSection: boolean;
};

export function canManageEvidenceRelationships(input: {
  /** True when the user can reach the /investigation surface. */
  canSeeInvestigation: boolean;
  /** Existing relationship items on this record. */
  existingRelationshipCount: number;
}): EvidenceRelationshipsVisibility {
  const canManage = input.canSeeInvestigation === true;
  const showSection = canManage || input.existingRelationshipCount > 0;
  return { canManage, showSection };
}
