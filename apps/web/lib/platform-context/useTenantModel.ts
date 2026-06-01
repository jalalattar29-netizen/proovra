"use client";

/**
 * ENTERPRISE TENANT MODEL — canonical product-model hooks.
 *
 * These hooks expose the Account / Personal Space / Organization /
 * ActiveSpace sections of the canonical platform-context envelope. They are
 * NON-AUTHORITATIVE derivations of the envelope — no fetches, no role
 * derivation, no platform-admin checks. The server is the only authority.
 *
 * Hard rules:
 *
 *   1. Personal Space is NOT an organization. `useOrganizations()` never
 *      returns the personal-space row; the backend filters `isPersonal=true`.
 *
 *   2. ActiveSpace is the resolved space (PERSONAL or ORGANIZATION). It is
 *      the right hook for pages that need to know "what mode am I in".
 *
 *   3. `useCan(key)` reads the canonical CapabilityMap. Pages MUST NOT
 *      re-derive role from `activeSpace.roleLabel` to gate features.
 */

import { usePlatformContext } from "./PlatformContextProvider";
import type {
  CapabilityKey,
  PlatformContextAccount,
  PlatformContextActiveSpace,
  PlatformContextDuplicatePersonalCandidate,
  PlatformContextOrganization,
  PlatformContextPersonalSpace,
} from "./types";

/**
 * Returns the Account section, or `null` while the envelope is loading.
 */
export function useAccount(): PlatformContextAccount | null {
  const { envelope } = usePlatformContext();
  return envelope?.account ?? null;
}

/**
 * Returns the canonical Personal Space, or `null` while the envelope is
 * loading. Every authenticated user has exactly one Personal Space; this
 * hook never returns multiple.
 */
export function usePersonalSpace(): PlatformContextPersonalSpace | null {
  const { envelope } = usePlatformContext();
  return envelope?.personalSpace ?? null;
}

/**
 * Returns the list of real organizations (excluding the Personal Space).
 * Empty array while loading or for personal-only users.
 */
export function useOrganizations(): ReadonlyArray<PlatformContextOrganization> {
  const { envelope } = usePlatformContext();
  return envelope?.organizations ?? [];
}

/**
 * Returns the currently-active space (PERSONAL or ORGANIZATION). Returns
 * `null` while loading. For new pages this is the recommended hook for
 * "what mode am I in" — replaces `useTeamWorkspaceGate` / `useTeamId` for
 * personal-friendly pages.
 */
export function useActiveSpace(): PlatformContextActiveSpace | null {
  const { envelope } = usePlatformContext();
  return envelope?.activeSpace ?? null;
}

/**
 * Convenience guard for pages that need "active-space id, whatever the
 * type". Returns `null` while the envelope is loading or genuinely
 * unhealthy.
 *
 * @deprecated PHASE 3 — Prefer `useActiveWorkspaceId` from
 *   `./useTeamWorkspaceGate` for new code. This hook reads from
 *   `envelope.activeSpace`, which can disagree with `envelope.workspace`
 *   under degraded-envelope scenarios. The canonical hook resolves
 *   workspace.id with a personalSpace.id fallback (matching the
 *   PageRouteGate fallback). This alias is retained for the small
 *   number of call sites that explicitly need the activeSpace.id
 *   semantics (e.g. workspace switcher highlight).
 *   See docs/architecture/architecture-invariants.md (INV-3).
 */
export function useActiveSpaceId(): string | null {
  const space = useActiveSpace();
  if (!space) return null;
  if (space.type === "PERSONAL") return space.id ?? null;
  return space.id || null;
}

/**
 * Capability guard. Pages MUST use this instead of re-deriving role
 * locally. Returns `false` while the envelope is loading — pages should
 * gate optimistic UI on a separate "loading" state, not the cap value.
 */
export function useCan(capability: CapabilityKey): boolean {
  const { envelope } = usePlatformContext();
  if (!envelope) return false;
  return envelope.capabilities[capability] === true;
}

/**
 * Diagnostic — returns legacy duplicate-personal-like rows surfaced by the
 * backend heuristic. Empty array on healthy envelopes. Consumed by /teams.
 */
export function useDuplicatePersonalCandidates(): ReadonlyArray<PlatformContextDuplicatePersonalCandidate> {
  const { envelope } = usePlatformContext();
  return envelope?.duplicatePersonalCandidates ?? [];
}
