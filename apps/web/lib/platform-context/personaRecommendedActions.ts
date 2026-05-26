"use client";

/**
 * Phase E7 — Persona-aware recommended-action bridge.
 *
 * Thin presentation-layer adapter that pulls persona-specific
 * "recommended next step" copy + recommended capture-template
 * priorities from the canonical shared content module at
 * `@proovra/shared-evidence-presentation/persona-content`.
 *
 * The shared module is the SOURCE OF TRUTH; this file just adapts the
 * pure functions into React hooks that consume `usePersonaProfile()`.
 *
 * Hard rules (mirrored from `usePersonaProfile.ts`):
 *
 *   - This module NEVER replaces a capability check. Pages keep gating
 *     on `ctx.can(CAPABILITY_KEY)` regardless of persona.
 *   - It only adds presentation-layer text + ordering. It does not
 *     register routes, mutate state, or call APIs.
 *   - It uses the existing `WorkspacePersonaProfile` enum codes — it
 *     does not invent new persona values.
 */

import {
  getPersonaContent,
  getPersonaRecommendedNextStep,
  getPersonaRecommendedTemplates,
  getPersonaEmptyStateHint,
  type PersonaCode,
  type PersonaContent,
} from "@proovra/shared-evidence-presentation";

import { usePrimaryPersona } from "./usePersonaProfile";

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/**
 * Return the canonical persona content record for the active persona.
 *
 * Pages consume this to render persona-aware labels + recommended
 * actions without making the persona content live in the page itself.
 */
export function usePersonaContent(): PersonaContent {
  const persona = usePrimaryPersona();
  return getPersonaContent(persona as PersonaCode);
}

/**
 * Return the persona-specific "do this first" onboarding line. Use on
 * dashboard empty states, onboarding banners, and persona settings
 * page.
 */
export function usePersonaRecommendedNextStep(): string {
  const persona = usePrimaryPersona();
  return getPersonaRecommendedNextStep(persona as PersonaCode);
}

/**
 * Return the persona's recommended capture-template slugs in priority
 * order. The workflow-template registry remains authoritative for what
 * is actually selectable — these are SUGGESTIONS only.
 */
export function usePersonaRecommendedTemplates(): ReadonlyArray<string> {
  const persona = usePrimaryPersona();
  return getPersonaRecommendedTemplates(persona as PersonaCode);
}

/**
 * Return the persona-specific empty-state hint for a surface
 * (e.g. "evidence" / "cases" / "reports"). Falls back to the
 * INDIVIDUAL hint if the persona/surface combination is unknown.
 */
export function usePersonaEmptyStateHint(surface: string): string {
  const persona = usePrimaryPersona();
  return getPersonaEmptyStateHint(persona as PersonaCode, surface);
}
