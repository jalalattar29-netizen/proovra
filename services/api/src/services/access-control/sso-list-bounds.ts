/**
 * THE SSO CONNECTION LIST CAP, OUTSIDE THE MOCKABLE SERVICE.
 *
 * `listSsoConnections` reads at most this many rows, and the route ships the
 * number alongside the list so `/admin/identity/providers` can say "100 shown,
 * capped at 100" rather than presenting a bounded read as every connection a
 * workspace has.
 *
 * It lives in its own module for the same reason `scim-failure-kinds.ts` does.
 * A test that does `vi.mock("./sso.service.js", factory)` replaces the WHOLE
 * module, so a constant declared there disappears — and the route importing it
 * fails at module load with a 500 that looks nothing like the cause. That cost
 * a round trip on the SCIM enum already; a constant a route needs must not sit
 * in a module tests stand in for.
 */
export const SSO_CONNECTION_LIST_CAP = 100;
