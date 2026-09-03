/**
 * THE LISTS A PAGE MAY COUNT BY LENGTH.
 *
 * =============================================================================
 * WHY A DECLARATION AND NOT A PATTERN
 * =============================================================================
 * Most admin lists are capped, and a page that prints `rows.length` over a
 * capped read states a population it does not have. The fix is normally to
 * carry the server's `total`, `hasMore` or `limit` to the surface.
 *
 * Some lists genuinely are complete — a fixed catalogue of capabilities, a
 * role matrix, a workspace's own members — and for those the length IS the
 * population. But "the server returns everything" is a claim about a handler
 * in `services/api`, and neither script that reads this file can see that
 * service. Inference is not available either: `a.ipAllowlist` and
 * `group.results` are the same expression shape, and a pattern-based
 * exemption cleared both, including a page of search results that had been
 * cut off at ten.
 *
 * So each entry is written down, names the handler, and says why. The proof
 * lives in `services/api/test/admin-count-truth-complete-lists.test.ts`, which
 * asserts every endpoint here still runs its query with no row cap — add a
 * `take` to one and the API suite fails before the page can start lying.
 *
 * =============================================================================
 * WHO READS THIS
 * =============================================================================
 *   admin-count-truth-audit.mjs      classifies the count as COMPLETE_LIST
 *   admin-composition-contract.mjs   accepts the list as not needing paging
 *   admin-count-truth-complete-lists.test.ts (API)  proves the handler
 *
 * One list, three consumers. It was previously inline in the audit script,
 * where the contract could not see it and reported the same pages again.
 */

/**
 * @typedef {object} CompleteList
 * @property {string} route     the admin route rendering the count
 * @property {string} noun      the counted noun, as the page words it
 * @property {string} endpoint  the handler that returns the rows
 * @property {string} reason    why nothing truncates it
 */

/** @type {CompleteList[]} */
export const COMPLETE_LISTS = [
  {
    route: "/admin/platform/automation",
    noun: "rule",
    endpoint: "GET /v1/automation/rules",
    reason:
      "Rules are per-workspace configuration, bounded by what an operator " +
      "created; the handler runs findMany with no take, so the length IS the " +
      "population.",
  },
  {
    route: "/admin/adoption",
    noun: "capability",
    endpoint: "GET /v1/admin/adoption",
    reason:
      "One row per KNOWN capability, enumerated from a fixed catalogue rather " +
      "than queried from a growing table. The list cannot exceed the number of " +
      "capabilities the product has.",
  },
  {
    route: "/admin/identity",
    noun: "member",
    endpoint: "GET /v1/identity/members",
    reason:
      "listTeamMembersWithAccess runs findMany with no take, so the browser " +
      "holds every member of the workspace. That is also why this page may " +
      "filter client-side: the filter narrows all of them, not a page of them.",
  },
  {
    route: "/admin/identity/permission-matrix",
    noun: "role",
    endpoint: "GET /v1/admin/identity/role-matrix",
    reason:
      "The matrix is the product's fixed set of roles crossed with its fixed " +
      "set of capabilities. Both are compiled-in constants, not rows.",
  },
];

/** True when `route` renders a list declared complete for `noun`. */
export function isDeclaredComplete(route, noun = "") {
  return COMPLETE_LISTS.some(
    (d) =>
      d.route === route &&
      (noun === "" || String(noun).toLowerCase().includes(d.noun)),
  );
}
