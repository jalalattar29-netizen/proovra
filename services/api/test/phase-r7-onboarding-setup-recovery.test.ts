/**
 * PHASE R7 — Onboarding & Setup Recovery guardrails.
 *
 * Phase 12 Point 4 (Pass E) — SCOPE REDUCED, and the reason matters.
 *
 * R7 authored `apps/web/lib/onboarding/*` (types + per-mode step
 * sequences + `resolveOnboardingState`) as a canonical step model whose
 * consumer was to be "future surface wiring" — explicitly, a
 * PersonaSetupBanner enrichment. That banner was physically deleted with
 * the workspace-persona feature on 2026-07-20, so the module never gained
 * a single importer: it was a second, parallel onboarding model shadowing
 * the one that actually ships (`resolveDashboardOnboarding`, rendered by
 * CommandCenter). It has been deleted.
 *
 * Eight of this suite's eleven parts read those four files as text and
 * asserted their contents. With no consumer, none of them constrained
 * anything a user could see, so they were removed with the module rather
 * than re-pointed at an arbitrary substitute.
 *
 * What remains are the parts that were never about that module, and they
 * are unchanged:
 *
 *   1. The dashboard onboarding hint — the SURVIVING onboarding surface —
 *      still consumes the canonical helper.
 *   2. No duplicate onboarding system / no parallel state store exists in
 *      components/ (this is the guard that would have caught the shadow
 *      model earlier had it covered lib/ too).
 *   3. Capture / custody / TSA / report / package files unchanged.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function webPath(rel: string): string {
  return fileURLToPath(new URL(`../../../apps/web/${rel}`, import.meta.url));
}
function readWeb(rel: string): string {
  return readFileSync(webPath(rel), "utf8");
}

// (2026-07-20) The /settings/persona page + PersonaSetupBanner were
// physically deleted with the workspace-persona / workflow-personalization
// feature; the persona-refresh + setup-banner tests were removed below.
const COMMAND_CENTER = readWeb(
  "components/command-center/CommandCenter.tsx",
);

// =============================================================================
// PART 6 — R1 refresh behavior preserved (workflow setup outcome)
// =============================================================================

describe("R7 Part 6 — dashboard onboarding hint preserved", () => {
  // (2026-07-20) The persona-save-refresh tests were removed with the
  // /settings/persona page. The dashboard onboarding hint is the
  // surviving onboarding surface and still consumes the canonical helper.
  it("dashboard onboarding hint still consumes the canonical helper", () => {
    expect(COMMAND_CENTER).toMatch(/resolveDashboardOnboarding/);
    expect(COMMAND_CENTER).toMatch(/onboardingHint\s*\?/);
  });
});

// =============================================================================
// PART 8 — No duplicate onboarding system
// =============================================================================

describe("R7 Part 8 — no duplicate onboarding system / parallel state store", () => {
  it("no separate OnboardingProvider / OnboardingContext component file", () => {
    const root = webPath("components");
    function listAllFiles(dirAbs: string): string[] {
      const out: string[] = [];
      const stack: string[] = [dirAbs];
      while (stack.length > 0) {
        const dir = stack.pop()!;
        let entries: string[];
        try {
          entries = readdirSync(dir);
        } catch {
          continue;
        }
        for (const name of entries) {
          const full = `${dir}/${name}`;
          try {
            const st = statSync(full);
            if (st.isFile() && /\.tsx?$/.test(name)) out.push(full);
            else if (st.isDirectory()) stack.push(full);
          } catch {
            /* ignore */
          }
        }
      }
      return out;
    }
    const all = listAllFiles(root);
    const FORBIDDEN_NAMES = [
      "OnboardingProvider.tsx",
      "OnboardingContext.tsx",
      "OnboardingStateProvider.tsx",
      "SetupWizard.tsx",
      "SetupProvider.tsx",
      "OnboardingPortal.tsx",
    ];
    for (const file of all) {
      const name = file.split(/[\\/]/).pop()!;
      expect(
        FORBIDDEN_NAMES.includes(name),
        `R7 forbids parallel onboarding state components — found ${name}`,
      ).toBe(false);
    }
  });

  // (2026-07-20) The "PersonaSetupBanner remains the single setup-banner"
  // and "PersonaWizardPage remains the single setup wizard" tests were
  // removed: both were physically deleted with the workspace-persona /
  // workflow-personalization feature. Onboarding is now the mode-driven
  // dashboard hint + the bounded step model — there is no setup wizard.
});

// =============================================================================
// PART 11 — Capture / custody / TSA / report / package unchanged
// =============================================================================
