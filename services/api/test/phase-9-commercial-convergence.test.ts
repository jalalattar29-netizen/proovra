/**
 * PHASE 9 CONVERGENCE AUDIT (2026-07-22) — anti-layering / anti-duplication.
 *
 * Records the CURRENT reality that `resolveCommercialContext` is layered ABOVE
 * `workspace-billing.service`, which remains an independently-callable public
 * commercial decision authority. These two facts are machine-pinned so the
 * bypass surface can only RATCHET DOWN as convergence proceeds:
 *
 *   1. The set of production files that reach the effective-scope decision
 *      APIs DIRECTLY (bypassing resolveCommercialContext) is frozen to a
 *      baseline. A NEW bypass file fails this test. Removing one (by migrating
 *      it onto resolveCommercialContext) requires shrinking the baseline —
 *      that is the intended direction.
 *   2. resolveCommercialContext must COMPOSE workspace-billing (adapter), not
 *      fork its own scope logic.
 *
 * NOTE: this scans source text for import/call of the decision symbols. It is
 * an alerting ratchet, not a proof of semantic convergence; the ledger records
 * the full call graph + verdict.
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full));
    else if (e.name.endsWith(".ts") && statSync(full).isFile()) out.push(full);
  }
  return out;
}
const FILES = walk(SRC).map((f) => ({ rel: relative(SRC, f).replace(/\\/g, "/"), body: readFileSync(f, "utf8") }));

// The effective-scope DECISION APIs exposed by workspace-billing.service. A
// production file calling any of these derives effective plan/capabilities
// WITHOUT going through resolveCommercialContext (a bypass of the intended
// single public resolver).
// NOTE: getWorkspaceCapabilities DELETED (2026-07-22 convergence) — a dead
// duplicate effective-capability authority (0 callers).
const SCOPE_DECISION_API =
  /\b(resolveWorkspaceScopeForUser|getPersonalWorkspaceScope|getTeamWorkspaceScope|resolveEvidenceWorkspaceScope)\b/;

// The canonical layer itself is allowed to call these (composition / adapter).
const CANONICAL_LAYER = new Set([
  "services/workspace-billing.service.ts",
  "services/billing/commercial-context.service.ts",
]);

// LOCKED baseline (2026-07-22). This is a KNOWN-DEBT list, NOT an approval —
// every entry is a production commercial-decision path that must migrate onto
// resolveCommercialContext (or become a proven internal adapter). The set may
// only SHRINK. Adding a file here to make a new bypass pass is forbidden.
//
// §9.4 UPDATE (2026-07-22): the scope API these files call is now an INPUT
// ADAPTER — its effective-plan decision is DELEGATED to the canonical pure
// policy (`resolveOwnedWorkspaceEffectivePlan`/`isWorkspaceSubscriptionActive`
// in shared-billing; single implementation, inheritance branch deleted). The
// remaining debt for these entries is ENVELOPE ADOPTION (lifecycle/seat
// context via resolveCommercialContext), no longer independent effective-plan
// derivation.
// §9.7 MIGRATED (ratchet reductions, 2026-07-22): billing-overview.service +
// billing.routes now consume the resolveCommercialContext envelope with
// EXPLICIT subjects (PERSONAL_ACCOUNT / WORKSPACE) — removed from baseline.
// NOTE: billing-guards remains listed for its getTeamWorkspaceScope call
// inside resolveCollaborationTeamWorkspacePlan (workspace-subject plan for
// member/invite limits) — envelope adoption pending.
// §9.7 CHOKEPOINT CONVERGENCE (2026-07-22): billing-enforcement's scope
// entry became `resolveEnforcementScopeForRequester` — an ENVELOPE consumer
// (explicit subjects, envelope-resolved `commercialLimits` attached). The
// evidence family (evidence.routes, evidence-requests.routes,
// evidence-complete.service, evidence.service) consumes that converged
// chokepoint, so five entries left the baseline in one step. The legacy
// grandfather-cap ternary was FOLDED into resolveCommercialContext.limits.
// §9.7 COMPLETE (2026-07-22): the ratchet reached ZERO. The chokepoint
// convergence (billing-enforcement → `resolveEnforcementScopeForRequester`,
// an envelope consumer with envelope-resolved `commercialLimits`) collapsed
// the evidence family; ai/teams/billing-guards/workspace-lifecycle migrated
// with explicit subjects (PERSONAL_ACCOUNT for creation-allowance + personal
// AI; WORKSPACE-by-persisted-id for existing-workspace operations). The
// grandfather-cap ternary was FOLDED into resolveCommercialContext.limits.
describe("Phase 9 convergence — scope-decision bypasses = 0 (locked)", () => {
  it("NO production file outside the canonical layer touches the scope-decision API", () => {
    const bypasses = FILES.filter(
      (f) => !CANONICAL_LAYER.has(f.rel) && SCOPE_DECISION_API.test(f.body),
    )
      .map((f) => f.rel)
      .sort();
    expect(
      bypasses,
      "commercial-decision bypass introduced — route it through resolveCommercialContext with an explicit subject",
    ).toEqual([]);
    // Non-vacuous guard: the canonical layer itself genuinely contains the
    // adapter symbols (the scanner is alive).
    const canonical = FILES.filter((f) => CANONICAL_LAYER.has(f.rel));
    expect(canonical.some((f) => SCOPE_DECISION_API.test(f.body))).toBe(true);
  });

  it("resolveCommercialContext COMPOSES workspace-billing (adapter, not a fork)", () => {
    const cc = FILES.find((f) => f.rel === "services/billing/commercial-context.service.ts")!.body;
    expect(cc).toMatch(/from\s+"\.\.\/workspace-billing\.service\.js"/);
    expect(cc).toContain("resolveWorkspaceScopeForUser");
  });
});
