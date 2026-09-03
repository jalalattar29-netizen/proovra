/**
 * THE SCIM FAILURE KINDS, IN A MODULE NOBODY MOCKS.
 *
 * =============================================================================
 * WHY THIS IS NOT IN THE SERVICE
 * =============================================================================
 * It was. The route imported it from `scim-reconciliation.service` so the query
 * and its validation could not drift apart — one list, checked in both places.
 *
 * That is the right goal and the wrong home. `phase-12b-identity-recovery-org-
 * matrix` replaces the whole service module with `vi.mock`, as an authorization
 * test should: it cares which service function is called and with what, not
 * what the function does. The mock has no reason to re-export a constant, so
 * `SCIM_FAILURE_EVENT_TYPES` arrived `undefined`, `z.enum(undefined)` threw at
 * request time, and four cases that assert 200 and 404 got 500 instead.
 *
 * A shared CONTRACT and a mockable BEHAVIOUR should not live in the same
 * module. This holds the contract; the service and the route both import it,
 * they still cannot drift, and mocking the service leaves it intact.
 */

/** The failure kinds the SCIM service emits into the SecurityEvent catalog. */
export const SCIM_FAILURE_EVENT_TYPES = [
  "scim_invalid_token",
  "scim_user_create_failed",
  "scim_user_deactivate_failed",
  "scim_group_membership_reconcile_failed",
] as const;

export type ScimFailureEventType = (typeof SCIM_FAILURE_EVENT_TYPES)[number];
