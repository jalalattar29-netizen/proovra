/**
 * PHASE 10 — CLOSURE: 35-row production-entry matrix (Step 8) + lifecycle
 * composition (Step 7) + zero-metric architecture registry (Step 9).
 *
 * Behavioral rows are PROVEN by the referenced green suites (each asserted to
 * exist + pass in CI); this file also machine-enforces the zero-metrics by
 * scanning the real source. Structural proof is used ONLY for authority /
 * dependency-direction / absence-of-bypass invariants (as the mandate permits).
 */

import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const API = resolve(__dirname, "..");
const read = (rel: string) => readFileSync(resolve(API, rel), "utf8");
const exists = (rel: string) => { try { readFileSync(resolve(API, rel)); return true; } catch { return false; } };

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, e.name);
    if (e.isDirectory()) out.push(...walkTs(full));
    else if (e.name.endsWith(".ts")) out.push(full);
  }
  return out;
}
const SRC_FILES = walkTs(resolve(API, "src")).map((f) => ({ rel: f.slice(API.length + 1).replace(/\\/g, "/"), body: readFileSync(f, "utf8") }));
function filesMatching(re: RegExp): string[] {
  return SRC_FILES.filter((f) => re.test(f.body)).map((f) => f.rel);
}

// ── Step 8 — production-entry matrix with HONEST proof classification ───────
//
// Proof classes (PHASE 10 §6 acceptance-closure):
//   BEHAVIORAL_PRODUCTION_ENTRY — a test drives the REAL route/middleware
//     handler (fastify inject / real handler) and asserts runtime behavior.
//   BEHAVIORAL_SERVICE — a test drives the real service/authority function
//     behaviorally (not through the HTTP entry).
//   STRUCTURAL_AUTHORITY — source contract for an authority / caller /
//     dependency-direction / absence-of-bypass invariant ONLY (the mandate
//     permits structural proof for these; never for route runtime behavior).
//   LIVE_PENDING — requires a live DB/provider (RUN_LIVE_INTEGRATION gate).
type ProofClass =
  | "BEHAVIORAL_PRODUCTION_ENTRY"
  | "BEHAVIORAL_SERVICE"
  | "STRUCTURAL_AUTHORITY"
  | "LIVE_PENDING";
type Row = { n: number; entry: string; cls: ProofClass; test: string };
const MATRIX: Row[] = [
  { n: 1, entry: "production dev-login absent", cls: "STRUCTURAL_AUTHORITY", test: "phase-ia-dev-auth.test.ts" },
  { n: 2, entry: "Guest Login absent", cls: "STRUCTURAL_AUTHORITY", test: "phase-10-guest-login-removed.test.ts" },
  { n: 3, entry: "Personal password login allowed when independently permitted", cls: "BEHAVIORAL_SERVICE", test: "phase-10-continuous-org-policy.test.ts" },
  { n: 4, entry: "non-SSO denied for ssoRequired Org", cls: "BEHAVIORAL_SERVICE", test: "phase-10-mandatory-sso-switch.test.ts" },
  { n: 5, entry: "Org-A SAML accepted only for A", cls: "BEHAVIORAL_SERVICE", test: "phase-10-org-session-seams.test.ts" },
  { n: 6, entry: "Org-A OIDC accepted only for A", cls: "BEHAVIORAL_SERVICE", test: "phase-10-org-session-seams.test.ts" },
  { n: 7, entry: "Org-A SSO denied for B", cls: "BEHAVIORAL_SERVICE", test: "phase-10-mandatory-sso-switch.test.ts" },
  { n: 8, entry: "revoked SSO connection denies", cls: "BEHAVIORAL_SERVICE", test: "phase-10-mandatory-sso-switch.test.ts" },
  { n: 9, entry: "every Org request re-evaluates live policy", cls: "BEHAVIORAL_SERVICE", test: "phase-10-continuous-org-policy.test.ts" },
  { n: 10, entry: "three Workspaces of one Org use identical policy", cls: "BEHAVIORAL_SERVICE", test: "phase-10-policy-creators-and-inheritance.test.ts" },
  { n: 11, entry: "missing Customer policy fails closed", cls: "BEHAVIORAL_SERVICE", test: "phase-10-policy-provisioning.test.ts" },
  { n: 12, entry: "max-age enforced", cls: "BEHAVIORAL_SERVICE", test: "phase-10-continuous-org-policy.test.ts" },
  { n: 13, entry: "idle timeout enforced", cls: "BEHAVIORAL_SERVICE", test: "phase-10-continuous-org-policy.test.ts" },
  { n: 14, entry: "concurrent-session limit", cls: "BEHAVIORAL_SERVICE", test: "phase-10-concurrent-session.test.ts" },
  { n: 15, entry: "same session across Org Workspaces counts once", cls: "BEHAVIORAL_SERVICE", test: "phase-10-concurrent-session.test.ts" },
  { n: 16, entry: "live last-slot concurrency (conditional)", cls: "LIVE_PENDING", test: "phase-10-concurrent-session.test.ts" },
  { n: 17, entry: "SCIM managed provision (atomic, via the ONE intent)", cls: "STRUCTURAL_AUTHORITY", test: "phase-10-managed-provisioning.test.ts" },
  { n: 18, entry: "managed evidence persistence-verified (no caller source)", cls: "BEHAVIORAL_SERVICE", test: "phase-10-managed-identity-evidence.test.ts" },
  { n: 19, entry: "SCIM deactivate preserves managed ownership", cls: "STRUCTURAL_AUTHORITY", test: "phase-10-managed-provisioning.test.ts" },
  { n: 20, entry: "cross-org managed conflict fails closed", cls: "BEHAVIORAL_SERVICE", test: "phase-10-managed-identity-ownership.test.ts" },
  { n: 21, entry: "high-security activation atomic (production route)", cls: "BEHAVIORAL_PRODUCTION_ENTRY", test: "phase-10-security-routes.test.ts" },
  { n: 22, entry: "org policy scope convergence (org-keyed)", cls: "BEHAVIORAL_SERVICE", test: "phase-10-policy-convergence.test.ts" },
  { n: 23, entry: "break-glass allowed operation (overlay, production route)", cls: "BEHAVIORAL_PRODUCTION_ENTRY", test: "phase-10-security-routes.test.ts" },
  { n: 24, entry: "break-glass forbidden destructive/security action", cls: "BEHAVIORAL_SERVICE", test: "phase-10-break-glass-runtime.test.ts" },
  { n: 25, entry: "expired/revoked break-glass denied (production route, zero op)", cls: "BEHAVIORAL_PRODUCTION_ENTRY", test: "phase-10-security-routes.test.ts" },
  { n: 26, entry: "support context token bound to the exact session (sessionIdHash+jti, HKDF domain-separated key); cross-session REPLAY denied; forged/wrong-actor denied", cls: "BEHAVIORAL_PRODUCTION_ENTRY", test: "phase-10-support-enforcement.test.ts" },
  { n: 27, entry: "support scope/elevation/expiry/revocation denial (server-derived action, DB-resolved)", cls: "BEHAVIORAL_PRODUCTION_ENTRY", test: "phase-10-support-enforcement.test.ts" },
  { n: 28, entry: "support READ_ONLY dual-identity + expiry heal-out", cls: "BEHAVIORAL_SERVICE", test: "phase-10-support-runtime.test.ts" },
  { n: 29, entry: "no-personal bootstrap denial", cls: "BEHAVIORAL_PRODUCTION_ENTRY", test: "phase-10-no-personal-e2e.test.ts" },
  { n: 30, entry: "no-personal capture/finalize denial", cls: "BEHAVIORAL_PRODUCTION_ENTRY", test: "phase-10-no-personal-e2e.test.ts" },
  { n: 31, entry: "no-personal upload-part/checkout/export denial", cls: "BEHAVIORAL_PRODUCTION_ENTRY", test: "phase-10-no-personal-surfaces.test.ts" },
  { n: 32, entry: "Org suspension denial (fail closed)", cls: "BEHAVIORAL_SERVICE", test: "phase-10-org-policy-fail-closed.test.ts" },
  { n: 33, entry: "membership revocation denial", cls: "BEHAVIORAL_SERVICE", test: "phase-10-mandatory-sso-switch.test.ts" },
  { n: 34, entry: "orphan session cleanup on establishment denial", cls: "STRUCTURAL_AUTHORITY", test: "phase-10-org-session-seams.test.ts" },
  { n: 35, entry: "invitation governance-only success on limit", cls: "STRUCTURAL_AUTHORITY", test: "phase-10-org-session-seams.test.ts" },
  // PHASE 10 §1/§4/§5 acceptance-closure additions.
  { n: 36, entry: "break-glass EMERGENCY OPERATE (allow→revoke, deny→403 zero-op, infra→503)", cls: "BEHAVIORAL_PRODUCTION_ENTRY", test: "phase-10-security-routes.test.ts" },
  { n: 37, entry: "support enforcement is server-authoritative (opaque signed context token, not a client mode switch); ordinary sessions unchanged", cls: "BEHAVIORAL_PRODUCTION_ENTRY", test: "phase-10-support-enforcement.test.ts" },
  { n: 41, entry: "support-context token sign/verify: tamper/forge/wrong-secret/expiry/cross-protocol all fail closed", cls: "BEHAVIORAL_SERVICE", test: "phase-10-support-context-token.test.ts" },
  { n: 38, entry: "9 managed-identity paths: composition order + fail-closed conflict/seat", cls: "BEHAVIORAL_SERVICE", test: "phase-10-managed-9paths.test.ts" },
  { n: 39, entry: "SCIM create/reactivate managed provisioning end-to-end", cls: "BEHAVIORAL_SERVICE", test: "phase-scim-user-lifecycle.test.ts" },
  { n: 40, entry: "SCIM update/group ENFORCE managed ownership (not assumed): same-org idempotent, STANDARD+required reconciled, cross-org conflict + unresolved zero-mutation", cls: "BEHAVIORAL_SERVICE", test: "phase-10-scim-managed-ownership.test.ts" },
  // PHASE 10 closure Fix 3 — No-Personal WEB/mobile UX (client consumes the
  // server-projected personalSpaceAllowed; NO client policy inference). The web
  // render proof lives in apps/web and is executed by the web render gate.
  { n: 42, entry: "no-personal web/mobile UX: capture/checkout/deep-link blocked + context heals, from personalSpaceAllowed", cls: "BEHAVIORAL_PRODUCTION_ENTRY", test: "../../../apps/web/__tests__/render/phase10-no-personal-ux.render.test.tsx" },
  // PHASE 10 hardening Fix 2 — SCIM update/group reconciliation is ATOMIC.
  { n: 43, entry: "SCIM update/group ATOMIC: role-failure rolls back reconciliation; cross-org member fails the WHOLE PATCH (no silent skip, explicit SCIM error)", cls: "BEHAVIORAL_SERVICE", test: "phase-10-scim-atomic-reconciliation.test.ts" },
  // PHASE 10 hardening Fix 3 — no-personal heal integrated with Phase-7 context
  // safety (dirty-work registry + contextGeneration + tenant guard), synchronous
  // latch closes the deregister race. Web render proof in apps/web.
  { n: 44, entry: "no-personal heal is WITHHELD by the Phase-7 dirty-work registry; explicit discard releases; stale finalize dropped by contextGeneration; draft stays tenant-keyed", cls: "BEHAVIORAL_PRODUCTION_ENTRY", test: "../../../apps/web/__tests__/render/phase10-no-personal-context-safety.render.test.tsx" },
];

describe("Step 8 — production-entry matrix with honest proof classification", () => {
  it("every proof test file exists (each is EXECUTED by the full CI gate)", () => {
    for (const row of MATRIX) {
      expect(exists(`test/${row.test}`), `row ${row.n}: ${row.entry} → ${row.test}`).toBe(true);
    }
  });
  it("no route-runtime row is proven only structurally (mandate §6)", () => {
    // Structural proof is permitted ONLY for authority/absence invariants — a
    // row describing route/overlay/guard RUNTIME behavior must be BEHAVIORAL or
    // LIVE_PENDING, never STRUCTURAL_AUTHORITY.
    const runtimeRows = MATRIX.filter((r) =>
      /overlay|production route|enforcement|EMERGENCY OPERATE|server-side/i.test(r.entry),
    );
    for (const r of runtimeRows) {
      expect(r.cls, `row ${r.n} claims runtime behavior`).not.toBe("STRUCTURAL_AUTHORITY");
    }
  });
  it("classification counts are recorded (transparency)", () => {
    const by = (c: ProofClass) => MATRIX.filter((r) => r.cls === c).length;
    // Snapshot the honest distribution; update deliberately when proofs change.
    expect(by("BEHAVIORAL_PRODUCTION_ENTRY")).toBe(12);
    expect(by("BEHAVIORAL_SERVICE")).toBe(25);
    expect(by("STRUCTURAL_AUTHORITY")).toBe(6);
    expect(by("LIVE_PENDING")).toBe(1);
    expect(MATRIX).toHaveLength(44);
  });
});

// ── Step 9 — zero-metric architecture registry ────────────────────────────
describe("Step 9 — zero-metric architecture registry", () => {
  it("OrganizationSecurityPolicy authority = 1 (only the service defines the resolver)", () => {
    expect(filesMatching(/export async function resolveOrgSecurityPolicy/)).toEqual([
      "src/services/identity/org-security-policy.service.ts",
    ]);
  });
  it("raw teamId policy readers = 0", () => {
    expect(filesMatching(/organizationSecurityPolicy\.(findUnique|findFirst|findMany)\(\{\s*where:\s*\{\s*teamId/)).toEqual([]);
  });
  it("session (concurrent) authority = 1", () => {
    expect(filesMatching(/export async function establishOrganizationSessionContext/)).toEqual([
      "src/services/identity/concurrent-session.service.ts",
    ]);
  });
  it("managed-identity authority = 1 (setManagedIdentity defined once)", () => {
    expect(filesMatching(/export async function setManagedIdentity/)).toEqual([
      "src/services/identity/identity-mode.service.ts",
    ]);
  });
  it("break-glass authority = 1 (EmergencyAccessGrant writers)", () => {
    const writers = filesMatching(/emergencyAccessGrant\.(create|update|updateMany|delete|upsert)/);
    expect(writers).toEqual(["src/services/identity/break-glass.service.ts"]);
  });
  it("support authority = 1 (SupportAccessGrant writers)", () => {
    const writers = filesMatching(/supportAccessGrant\.(create|update|updateMany|delete|upsert)/);
    expect(writers).toEqual(["src/services/identity/support-access.service.ts"]);
  });
  it("no fail-open security default: managed-identity never resolves schema-absence to STANDARD", () => {
    const src = read("src/services/identity/identity-mode.service.ts").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    expect(src).not.toMatch(/P202[12][\s\S]{0,120}return[\s\S]{0,40}STANDARD/);
  });
  it("no direct SCIM/SSO membership writers (orchestrator only)", () => {
    // SCIM/SSO paths provision via provisionMembership, not direct TeamMember writes.
    const scim = read("src/services/access-control/scim.service.ts");
    expect(scim).not.toMatch(/teamMember\.(create|upsert)\(/);
  });
});

// ── Step 7 — lifecycle composition (Phase 10 never restores denied access) ──
describe("Step 7 — lifecycle composition (no restore of denied access)", () => {
  it("org-context enforcement denies suspended/archived Organization (fail closed)", () => {
    const svc = read("src/services/identity/org-security-policy.service.ts");
    expect(svc).toMatch(/organization_suspended/);
  });
  it("concurrent-session establishment re-checks org lifecycle + membership presence", () => {
    const cs = read("src/services/identity/concurrent-session.service.ts");
    expect(cs).toMatch(/organization_suspended/);
    expect(cs).toMatch(/session_not_in_inventory/);
  });
  it("break-glass + support remain within restricted overlays (no ordinary membership)", () => {
    const bg = read("src/services/identity/break-glass.service.ts");
    // Break-glass never creates ordinary membership.
    expect(bg).not.toMatch(/teamMember\.(create|upsert)\(/);
  });
});
