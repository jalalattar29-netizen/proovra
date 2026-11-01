/**
 * PHASE 10 CLOSURE — FIX 3 (2026-07-23); Native Convergence — now a thin selector
 * over the ONE platform-context reader (src/product/platform-context.ts) so a
 * screen makes at most one /v1/platform/context fetch (Law of One).
 *
 * Exposes ONLY the `personalSpaceAllowed` projection (see ./personal-space.ts for
 * the pure gate + copy). This is a UX hint, not a security boundary — the server
 * independently enforces the same field on every personal-scope mutation, so a
 * transient fetch failure does not guess at policy here. A capture that needs a
 * workspace asks `resolveWorkspace`, which refuses to file into an unknown one.
 */

import { usePlatformContext } from "./product/platform-context";

export type PersonalSpaceAllowedState = {
  loading: boolean;
  allowed: boolean;
};

export function usePersonalSpaceAllowed(): PersonalSpaceAllowedState {
  const { loading, context } = usePlatformContext();
  // Only an explicit server `personalSpaceAllowed === false` blocks this hint.
  return { loading, allowed: context ? context.personalSpaceAllowed : true };
}
