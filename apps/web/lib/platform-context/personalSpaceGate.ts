/**
 * PHASE 10 CLOSURE — FIX 3 (2026-07-23) — canonical client-side personal-
 * space gate.
 *
 * Reads ONLY the server-projected `personalSpaceAllowed` boolean off the
 * platform-context envelope (see ./types.ts, and
 * services/api/src/services/platform-context/platform-context.service.ts
 * for the authoritative computation). This module is a PURE PROJECTION —
 * it never re-derives identityMode / ssoRequired / managed-status / any
 * other policy signal. The server remains the sole authority; every
 * personal-scope mutation is independently enforced there regardless of
 * what this module decides to render.
 *
 * `personalSpaceAllowed` is optional on the envelope for backward
 * compatibility with a pre-Step-6 API response — an ABSENT value is
 * treated as allowed (`true`, legacy/STANDARD behavior), never as
 * disallowed. Only an EXPLICIT `false` triggers gating.
 *
 * Consumers:
 *   - usePersonalSpaceGate (./usePersonalSpaceGate.ts) — the "use client"
 *     hook that drives AppShellV2's heal-out / canonical-unavailable
 *     rendering for EVERY (app) route (capture, evidence, billing,
 *     settings, deep links — every page is wrapped by AppShellV2, so this
 *     one gate protects all of them from ever operating in a disallowed
 *     Personal context).
 *   - components/billing/CheckoutPanel.tsx — hides the explicit Personal
 *     checkout target/button (a user-selectable target independent of the
 *     active context, so it needs its own read of the same field).
 */

import type {
  PlatformContextActiveSpace,
  PlatformContextContextOptions,
} from "./types";

export type PersonalSpaceGateEnvelopeInput = {
  activeSpace?: PlatformContextActiveSpace | null;
  personalSpaceAllowed?: boolean;
  contextOptions?: PlatformContextContextOptions | null;
};

export type PersonalSpaceGateResult =
  | { action: "none" }
  | { action: "heal"; targetWorkspaceId: string }
  | { action: "unavailable" };

/**
 * True iff Personal Space is currently disallowed for this identity.
 * Absent/undefined `personalSpaceAllowed` defaults to allowed — the server
 * only ever sets it to `false` explicitly for a managed identity.
 */
export function isPersonalSpaceDisallowed(
  envelope: Pick<PersonalSpaceGateEnvelopeInput, "personalSpaceAllowed">,
): boolean {
  return envelope.personalSpaceAllowed === false;
}

/**
 * The first server-authorized non-Personal workspace this identity can
 * heal into — an OWNED workspace if any, else the first workspace of the
 * first ACTIVE organization the server already listed. Returns null when
 * no alternative exists (the canonical "Personal Space unavailable" state
 * is the only honest option — NEVER a fabricated/other tenant).
 */
export function firstAvailableNonPersonalWorkspaceId(
  contextOptions: PlatformContextContextOptions | null | undefined,
): string | null {
  if (!contextOptions) return null;
  const owned = contextOptions.ownedWorkspaces?.[0]?.workspaceId;
  if (owned) return owned;
  for (const group of contextOptions.organizations ?? []) {
    const first = group.workspaces?.[0]?.workspaceId;
    if (first) return first;
  }
  return null;
}

/**
 * Resolve what the shell must do RIGHT NOW given the current envelope.
 *
 *   "none"        — nothing to do: Personal Space is allowed, OR the
 *                    active context is already non-Personal.
 *   "heal"        — the active context IS the disallowed Personal Space
 *                    AND a real, server-authorized workspace this identity
 *                    already owns/belongs to exists; switch to
 *                    `targetWorkspaceId` — NEVER an arbitrary other
 *                    tenant.
 *   "unavailable" — the active context is the disallowed Personal Space
 *                    and there is no alternative workspace to heal into;
 *                    render the canonical unavailable state instead of
 *                    silently rendering Personal content.
 */
export function resolvePersonalSpaceGate(
  envelope: PersonalSpaceGateEnvelopeInput,
): PersonalSpaceGateResult {
  if (!isPersonalSpaceDisallowed(envelope)) return { action: "none" };
  if (envelope.activeSpace?.type !== "PERSONAL") return { action: "none" };

  const targetWorkspaceId = firstAvailableNonPersonalWorkspaceId(
    envelope.contextOptions,
  );
  if (targetWorkspaceId) return { action: "heal", targetWorkspaceId };
  return { action: "unavailable" };
}
