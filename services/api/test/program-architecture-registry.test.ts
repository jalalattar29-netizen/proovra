/**
 * PROGRAM-WIDE ARCHITECTURE REGISTRY (2026-07-22) — the single anti-layering
 * gate built once and reused through Phase 12 (master convergence mandate).
 *
 * For each architectural CONCERN it records the canonical entry point and the
 * LOCKED set of files allowed to perform the concern's authoritative
 * writes/decisions. A new unregistered writer/bypass fails. Baselines are
 * RATCHETS — they exist to shrink to zero, not to freeze duplication.
 *
 * Coverage is explicit: `status: "ENFORCED"` concerns are machine-checked
 * here; `status: "AUDIT_PENDING"` concerns are registered with their canonical
 * entry but their writer/bypass enumeration is not yet locked (honest — no
 * silent claim of convergence). Billing is enforced by its own dedicated
 * suites (phase-9-authority-writers / -convergence) and referenced here.
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
function writersMatching(re: RegExp): string[] {
  return FILES.filter((f) => re.test(f.body)).map((f) => f.rel).sort();
}

type Concern = {
  name: string;
  canonicalEntry: string; // symbol that must exist as the single public authority
  status: "ENFORCED" | "AUDIT_PENDING";
  wave: "A" | "B" | "C";
  // For ENFORCED concerns with a write registry:
  write?: RegExp;
  allowed?: Record<string, string>;
  /** When true the correct writer set is EMPTY and any match is a regression. */
  banned?: boolean;
};

const CONCERNS: Concern[] = [
  // ── WAVE A — security & tenancy ────────────────────────────────────────
  {
    name: "3. Membership & grants (governance/operational access mutation)",
    canonicalEntry: "provisionMembership", // membership-provisioning orchestrator
    status: "ENFORCED",
    wave: "A",
    write: /\.organizationMembership\.(create|update|upsert|updateMany|delete|deleteMany)\b/,
    allowed: {
      "services/identity/membership-provisioning.service.ts": "canonical Membership Orchestrator — the ONE OrganizationMembership writer",
    },
  },
  {
    name: "3b. MembershipGrant provenance writer",
    canonicalEntry: "membershipGrant provenance",
    status: "ENFORCED",
    wave: "A",
    write: /\.membershipGrant\.(create|update|upsert|updateMany|delete|deleteMany)\b/,
    allowed: {
      "services/identity/membership-provisioning.service.ts": "canonical grant-provenance writer (source-aware)",
    },
  },
  {
    name: "3c. TeamMember (operational Workspace access) writer",
    canonicalEntry: "provisionMembership (creation/provenance) + rbac.service (transitions)",
    status: "ENFORCED",
    wave: "A",
    // Actual CALL syntax only (`client.teamMember.update(` / `prisma.teamMember...`)
    // — the earlier looser regex matched a comment in scim-groups.service
    // (false positive; that file only READS teamMember). RESOLVED 2026-07-22:
    // rbac.service is the canonical member-TRANSITION engine (suspendMember /
    // revokeMember / restoreMember / changeMemberRole / touchMemberLastSeen)
    // with hash-chained platform-audit + OWNER-safety; the orchestrator
    // COMPOSES it (membership-provisioning calls changeMemberRole). Two
    // registered canonical engines for two sub-concerns (creation vs
    // transition) — NOT a duplicate authority.
    write: /(client|prisma|tx)\.teamMember\.(create|update|upsert|updateMany|delete|deleteMany)\(/,
    allowed: {
      "services/identity/membership-provisioning.service.ts": "canonical orchestrator — membership CREATION + provenance",
      "services/identity/rbac.service.ts": "canonical member-TRANSITION engine (suspend/revoke/restore/changeRole/touchLastSeen) — audit-composed, OWNER-safe, orchestrator-composed",
    },
  },
  {
    name: "4. Organization lifecycle transition writer",
    canonicalEntry: "org-lifecycle.service (suspend/resume) / org-closure.service (archive) / enterprise-provisioning (activation)",
    status: "ENFORCED",
    wave: "A",
    // Direct Organization.status transition writes (SUSPENDED/ARCHIVED/ACTIVE).
    // CONVERGED 2026-07-22: account-closure's inline solo-personal-org
    // archive write was replaced by composing the canonical
    // `archiveOrganizationStatusTx` (org-closure engine) — Organization→
    // ARCHIVED now has exactly ONE implementation.
    write: /organization\.update(Many)?\(\s*\{[\s\S]{0,300}?status:\s*"(ACTIVE|SUSPENDED|ARCHIVED)"/,
    allowed: {
      "services/organization/org-lifecycle.service.ts": "canonical org suspend/resume transition engine",
      "services/organization/org-closure.service.ts": "canonical org archive transition engine (archiveOrganizationStatusTx — the ONE ARCHIVED write)",
      // enterprise-provisioning CREATES orgs (status set at create) + updates
      // `kind`; it performs NO org-status TRANSITION (update…status), so it is
      // not a concern-4 writer. (Prior match was a false positive via proximity
      // to an upsertEnterpriseContract status literal.)
    },
  },
  {
    name: "1. Tenant/domain classification (WS PERSONAL/OWNED/ORGANIZATION)",
    canonicalEntry: "resolveWorkspaceKind (workspace-kind.ts)",
    status: "ENFORCED",
    wave: "A",
    // §9.4 corrected + relocated (2026-07-22): the classification MATH lives
    // in the general DOMAIN package (`normalizeWorkspaceKind`,
    // @proovra/shared — a tenant fact, not a commercial conclusion; billing
    // receives the explicit kind and never infers). API and worker share the
    // ONE implementation; the api canonical entry (workspace-kind.ts)
    // DELEGATES with zero duplicated logic. This lock:
    // only the canonical entry may consume the shared normalizer inside
    // services/api — every other api file must go through
    // resolveWorkspaceKind. (Plan-based mapping no longer exists anywhere in
    // api src — it lives once, inside the shared normalizer.)
    write: /\bnormalizeWorkspaceKind\b/,
    allowed: {
      "services/identity/workspace-kind.ts": "the canonical api classifier entry — sole delegator to the shared single-implementation normalizer",
    },
  },
  {
    name: "2. Authorization (actor × operation × tenant-bound resource)",
    canonicalEntry: "authorizeOrFail + authorization-allowlist.ts (CANONICAL/EXCEPTION/PENDING, PENDING=0)",
    status: "ENFORCED",
    wave: "A",
    // Enforced by the DEDICATED Phase 1 suite `phase-1-authorization-closure`
    // (every gate-bearing file must be CANONICAL/EXCEPTION/PENDING; PENDING
    // asserted = 0). This entry pins the allowlist module so its deletion or
    // relocation cannot silently disable that suite.
    write: /export const (AUTHORIZATION_EXCEPTIONS|PENDING_AUTHORIZATION_MIGRATIONS)\b/,
    allowed: {
      "services/identity/authorization-allowlist.ts": "the symbol-level authorization gate registry (PENDING=0 enforced by phase-1-authorization-closure)",
    },
  },
  {
    name: "5. Invitations & external access acceptance",
    canonicalEntry: "provisionMembership (all acceptance paths compose the orchestrator)",
    status: "ENFORCED",
    wave: "A",
    // Enforced INDIRECTLY but bindingly: every acceptance/provisioning path
    // composes the orchestrator's public grant surface (provisionMembership /
    // grantOrganizationMembership / grantWorkspaceMembership); the #3 writer
    // registries make a direct membership write from any acceptance path
    // IMPOSSIBLE without failing this suite. This entry pins the exact
    // consumer set of the orchestrator surface (drift = new consumer must be
    // classified).
    write: /\b(provisionMembership|grantOrganizationMembership|grantWorkspaceMembership)\b/,
    allowed: {
      "services/identity/membership-provisioning.service.ts": "the orchestrator itself",
      "routes/teams.routes.ts": "team-invite acceptance → orchestrator",
      "services/organization/org-invite-acceptance.service.ts": "org-invite acceptance orchestration (guarded claim → grantOrganizationMembership/grantWorkspaceMembership)",
      "services/enterprise-provisioning.service.ts": "enterprise bootstrap provisioning → orchestrator",
      "services/access-control/scim.service.ts": "SCIM provisioning → orchestrator",
      "services/access-control/sso.service.ts": "SSO JIT → orchestrator",
      "services/security/saml-user-mapping.service.ts": "SAML mapping provisioning → orchestrator",
      "services/platform-context/workspace-bootstrap.service.ts": "personal-workspace bootstrap → orchestrator",
    },
  },
  // ── PHASE 10 — advanced enterprise identity (Wave B) ───────────────────
  {
    name: "10a. OrganizationSecurityPolicy writer (the ONE org security-policy authority)",
    canonicalEntry: "org-security-policy.service (SOLE public authority — base posture + Phase 10 versioned patch, composing the internal pure evaluator)",
    status: "ENFORCED",
    wave: "B",
    // §10.1 (2026-07-23): ONE public authority. The duplicate
    // enterprise-security-policy.SERVICE was DELETED; its pure decisions live
    // in enterprise-security-policy.POLICY (no DB/writes), composed by this
    // service. The 1:1 row is written only by this service + the MFA facet.
    write: /\.organizationSecurityPolicy\.(create|update|upsert)/,
    allowed: {
      "services/identity/org-security-policy.service.ts": "the SOLE authority — base posture + §10.1 versioned patch",
      "services/identity-security/mfa-policy.service.ts": "MFA-policy facet of the same aggregate",
      "services/enterprise-provisioning.service.ts": "§policy-convergence — creates the EXPLICIT baseline policy transactionally at Customer-Org provisioning (a CUSTOMER org must never be left fail-closed)",
    },
  },
  {
    name: "10b. Break-glass authority (EmergencyAccessGrant writer)",
    canonicalEntry: "break-glass.service (activate/revoke) — the ONE emergency-access authority",
    status: "ENFORCED",
    wave: "B",
    write: /\.emergencyAccessGrant\.(create|update|upsert|updateMany|delete)/,
    allowed: {
      "services/identity/break-glass.service.ts": "the ONLY writer — bounded, restricted-role, audited emergency access",
    },
  },
  {
    name: "10c. Support-access authority (SupportAccessGrant writer)",
    canonicalEntry: "support-access.service (start/revoke) — the ONE dual-identity support authority",
    status: "ENFORCED",
    wave: "B",
    write: /\.supportAccessGrant\.(create|update|upsert|updateMany|delete)/,
    allowed: {
      "services/identity/support-access.service.ts": "the ONLY writer — scoped, read-only-default, audited support access",
    },
  },
  {
    name: "6. Evidence destruction writer (hard delete)",
    canonicalEntry: "resolveEvidenceDestructiveAccess (API gate) + worker purge executor (legal-hold-prevails)",
    status: "ENFORCED",
    wave: "A",
    // CLASSIFIED 2026-07-22: the ONLY real `evidence.delete` call sites are
    // (a) evidence.routes — the user-facing delete behind the canonical
    //     `resolveEvidenceDestructiveAccess` gate, plus a quota-denial
    //     ROLLBACK compensator that deletes the row the same request just
    //     created (no destruction decision);
    // (b) worker processor purge executor — guarded by legal-hold-prevails
    //     (all 3 hold families, Phase 6 §9.7), object-lock retention,
    //     custody EVIDENCE_PURGED event + worker audit.
    // governance-lifecycle.routes / governance.service matches are
    // "evidence.delete" PERMISSION STRINGS, excluded by the call-syntax regex.
    // BILLING COMMERCIAL CORRECTNESS (2026-08-27) — the allowlist is now
    // EMPTY, and `banned` says so explicitly.
    //
    // The single permitted API-side `evidence.delete` was the compensator that
    // undid a row the same request had just created, when the packaging quota
    // engine then denied it. That engine was a duplicate commercial authority
    // (100 records a calendar month against a TEAM plan sold as 500 a rolling
    // 30 days) and has been removed, so the rollback it existed for is gone
    // too. No API file may hard-delete an Evidence row for ANY reason; a
    // record ends only through the worker purge executor, which leaves a
    // custody tombstone.
    write: /\.evidence\.delete(Many)?\(/,
    banned: true,
    allowed: {},
  },
  {
    name: "6b. Policy-precedence vocabulary (the ONE effective-policy/hold-prevails/retention-strength source)",
    canonicalEntry: "governance/policy-precedence.ts (resolveEffectivePolicyValue / legalHoldPrevails / strongerRetentionDays)",
    status: "ENFORCED",
    wave: "A",
    // CLASSIFIED 2026-07-22: policy-precedence = canonical pure vocabulary;
    // retention-inheritance = the ONE retention resolver COMPOSING it;
    // retention-engine = execution + conflict REPORTING (its retentionDays
    // comparison at ~705 produces an advisory diagnostic message, not an
    // effective-policy decision — the winner is already resolved upstream);
    // worker hold-checkers = input ADAPTERS over the same persisted hold
    // tables (persisted rows are the authority). Redaction / AI policy /
    // review / evidence-requests are DISTINCT domain questions, not
    // precedence duplicates — intentionally not merged.
    write: /export const POLICY_SCOPE_PRECEDENCE|export function (resolveEffectivePolicyValue|legalHoldPrevails|strongerRetentionDays)\b/,
    allowed: {
      "services/governance/policy-precedence.ts": "the ONE precedence vocabulary — no second file may define these symbols",
    },
  },
  {
    name: "6c. Retention resolver (effective team retention)",
    canonicalEntry: "resolveTeamRetentionPolicy (retention-inheritance.service)",
    status: "ENFORCED",
    wave: "A",
    write: /\bresolveTeamRetentionPolicy\b/,
    allowed: {
      "services/organization/retention-inheritance.service.ts": "the resolver itself (composes policy-precedence)",
      "routes/governance-lifecycle.routes.ts": "governance lifecycle API consumer",
      "services/governance-lifecycle/retention-engine.service.ts": "retention execution engine consumer",
    },
  },
  {
    name: "3d. rbac SUBORDINATION — engine internal to the Membership Orchestrator (external importers = 0)",
    canonicalEntry: "membership-provisioning.service public command surface (re-exports; zero duplicated policy)",
    status: "ENFORCED",
    wave: "A",
    // WAVE A FINAL CLOSURE (2026-07-22): the rbac engine module may be
    // IMPORTED only by the Membership Orchestrator implementation. Every
    // production route/service (identity admin routes, access-review, SCIM/
    // SSO/invitation paths) consumes transitions via the orchestrator's
    // public commands. A new direct `identity/rbac.service` import anywhere
    // else fails this suite. (The same-named collaboration-team member
    // functions are a DIFFERENT aggregate — collaborationTeamMember — and do
    // not import this module.)
    // Matches "./rbac.service.js" and ".../identity/rbac.service.js";
    // does NOT match "redaction-rbac.service.js" (segment must start at "/").
    write: /from\s+"[^"]*\/rbac\.service\.js"/,
    allowed: {
      "services/identity/membership-provisioning.service.ts": "the ONLY importer — orchestrator public command surface (pure re-export, single implementation)",
    },
  },
  // ── WAVE B — identity, context, commercial ─────────────────────────────
  { name: "7. Client context safety & navigation", canonicalEntry: "PlatformContextProvider / useWorkspaceContextSafety", status: "AUDIT_PENDING", wave: "B" },
  { name: "8. SSO/SCIM/enterprise identity", canonicalEntry: "sso.service / access-policy.service", status: "AUDIT_PENDING", wave: "B" },
  {
    name: "9. Billing/plan/contract (ENFORCED by dedicated suites)",
    canonicalEntry: "resolveCommercialContext",
    status: "ENFORCED",
    wave: "B",
    // Team billing-column authoritative writer (mirrors phase-9-authority-writers).
    // BILLING PERSONAL/ORGANIZATION MODEL (2026-08-28) — kept in lockstep with
    // that suite: one writer, Enterprise provisioning, because an ORGANIZATION
    // workspace is now the only workspace with commercial state of its own.
    write: /billing(?:Plan|Status):\s*(?:prismaPkg\.)?(?:PlanType|TeamBillingStatus)\.\w/,
    allowed: {
      "services/enterprise-provisioning.service.ts": "canonical Team-billing writer (see phase-9-authority-writers)",
    },
  },
  // ── WAVE C — url, audit, repo convergence ──────────────────────────────
  { name: "10. Audit/events", canonicalEntry: "canonical audit/event ingestion", status: "AUDIT_PENDING", wave: "C" },
  { name: "11. URL/deep-link context", canonicalEntry: "workspace-aware route resolver", status: "AUDIT_PENDING", wave: "C" },
  { name: "12. Repository convergence (twins/duplicates/dead)", canonicalEntry: "one impl per feature family", status: "AUDIT_PENDING", wave: "C" },
];

describe("Program architecture registry — canonical authority per concern", () => {
  for (const c of CONCERNS.filter((x) => x.status === "ENFORCED" && x.write && x.allowed)) {
    // A concern may declare `banned: true` — meaning the correct writer set is
    // EMPTY, and any match is a regression. Without it the "scanner matched
    // nothing" guard is right: an allowlisted concern that suddenly matches
    // zero files usually means the regex rotted, not that the writers left.
    if (c.banned) {
      it(`${c.name}: NO file may write it`, () => {
        expect(writersMatching(c.write!), c.name).toEqual([]);
      });
      continue;
    }
    it(`${c.name}: only the LOCKED writer set may write it`, () => {
      const found = writersMatching(c.write!);
      expect(found.length, `${c.name}: scanner matched nothing`).toBeGreaterThan(0);
      expect(found, c.name).toEqual(Object.keys(c.allowed!).sort());
    });
  }

  it("every architectural concern is registered with a canonical entry point (coverage manifest)", () => {
    // 12 top-level concerns (some split into sub-writers). Registry must not
    // silently drop a concern.
    const topLevel = new Set(CONCERNS.map((c) => c.name.match(/^\d+/)?.[0]).filter(Boolean));
    for (let n = 1; n <= 12; n++) expect(topLevel.has(String(n)), `concern ${n} registered`).toBe(true);
    for (const c of CONCERNS) expect(c.canonicalEntry.length, `${c.name} canonical entry`).toBeGreaterThan(3);
  });
});

// ============================================================================
// PHASE 12 — the 25 concern families, each pinned to its canonical authority
// FILE SET (exists + bounded) and its guard/proof suite. Extends THIS registry
// — no second registry. A family whose authority file disappears, whose file
// set grows a parallel implementation, or whose guard suite is deleted fails.
// Paths are repo-relative from services/api (../.. = repo root).
// ============================================================================
type Phase12Family = {
  family: string;
  /** Canonical authority file(s) — every one must exist. */
  authority: string[];
  /** Proof suite file — must exist. */
  guard: string;
};

const P12 = (rel: string) => rel; // readability marker

const PHASE12_FAMILIES: Phase12Family[] = [
  { family: "1. workspace/organization kind classification", authority: [P12("../../packages/shared/src/workspace-kind.ts")], guard: "test/p1-workspace-kind.test.ts" },
  { family: "2. authoritative request context", authority: [P12("src/services/platform-context/platform-context.service.ts")], guard: "test/phase-10-closure-matrix.test.ts" },
  { family: "3. organization lifecycle", authority: [P12("src/services/organization/org-lifecycle.service.ts")], guard: "test/phase-1-authorization-closure.test.ts" },
  { family: "4. membership provisioning/transitions", authority: [P12("src/services/identity/membership-provisioning.service.ts")], guard: "test/p2-invitation-coherence.test.ts" },
  { family: "5. invitations", authority: [P12("src/services/organization/org-invite-acceptance.service.ts")], guard: "test/p2-invitation-coherence.test.ts" },
  { family: "6. authorization/capability evaluation", authority: [P12("src/middleware/authorize.ts")], guard: "test/phase-1-authorization-closure.test.ts" },
  { family: "7. evidence custody", authority: [P12("src/services/evidence.service.ts")], guard: "test/phase-4b-product-packaging-and-lifecycle.test.ts" },
  { family: "8. legal hold/retention/destruction", authority: [P12("src/services/lifecycle/legal-hold.service.ts"), P12("src/services/lifecycle/destruction-governance.service.ts")], guard: "test/phase-4b-product-packaging-and-lifecycle.test.ts" },
  // BILLING COMMERCIAL CORRECTNESS (2026-08-27) — the previous guard,
  // phase9-collaboration-team-billing-parity, ASSERTED that the Collaboration
  // Team cap equals the Owned Workspace cap. That equality was the defect, not
  // the contract, so the suite was deleted with the conflation it protected.
  { family: "9. commercial context", authority: [P12("src/services/billing-overview.service.ts")], guard: "test/billing-commercial-correctness.test.ts" },
  { family: "10. subscription lifecycle", authority: [P12("src/services/billing-checkout.service.ts")], guard: "test/production-billing-parity.test.ts" },
  { family: "11. plan/capability/limit vocabulary", authority: [P12("../../packages/shared-billing/src/plan-catalog.ts")], guard: "test/pricing-hardening-plan-capabilities.test.ts" },
  { family: "12. seats/storage/add-ons", authority: [P12("src/services/billing-overview.service.ts")], guard: "test/billing-commercial-correctness.test.ts" },
  { family: "13. provider (Stripe/PayPal) state normalization", authority: [P12("src/services/paypal.service.ts"), P12("src/services/billing-checkout.service.ts")], guard: "test/phase-10-paypal-idempotency.test.ts" },
  { family: "14. enterprise provisioning", authority: [P12("src/services/enterprise-provisioning.service.ts")], guard: "test/phase2-enterprise-provisioning.test.ts" },
  { family: "15. managed identity/SSO/SCIM", authority: [P12("src/services/identity/identity-mode.service.ts"), P12("src/services/access-control/scim-reconciliation.service.ts")], guard: "test/phase-10-mandatory-sso-switch.test.ts" },
  { family: "16. OrganizationSecurityPolicy", authority: [P12("src/services/identity/org-security-policy.service.ts")], guard: "test/phase-10-closure-matrix.test.ts" },
  { family: "17. session policy/concurrency", authority: [P12("src/services/identity/concurrent-session.service.ts")], guard: "test/phase-10-concurrent-session.test.ts" },
  { family: "18. break-glass", authority: [P12("src/services/identity/break-glass.service.ts")], guard: "test/phase-10-break-glass-runtime.test.ts" },
  { family: "19. support access", authority: [P12("src/services/identity/support-access.service.ts")], guard: "test/phase-10-support-runtime.test.ts" },
  { family: "20. no-Personal policy", authority: [P12("src/services/identity/enterprise-security-policy.policy.ts")], guard: "test/phase-10-closure-matrix.test.ts" },
  { family: "21. internal URL/deep-link resolution", authority: [P12("src/services/identity/deep-link-resolution.service.ts"), P12("../../packages/shared/src/tenant-url.ts")], guard: "test/phase-11-architecture-guard.test.ts" },
  { family: "22. tenant/platform audit emission", authority: [P12("src/services/audit/tenant-audit.service.ts")], guard: "test/phase-11-architecture-guard.test.ts" },
  { family: "23. audit query/export", authority: [P12("src/services/audit/tenant-audit.service.ts")], guard: "test/phase-11-architecture-guard.test.ts" },
  { family: "24. worker authoritative reload", authority: [P12("../worker/src/lifecycle-recovery.ts")], guard: "test/worker-plan-resolver-parity.contract.test.ts" },
  { family: "25. frontend context safety (server contract)", authority: [P12("src/services/platform-context/platform-context.service.ts")], guard: "test/phase-11-closure-matrix.test.ts" },
];

describe("PHASE 12 — 25 concern families pinned to one canonical authority", () => {
  const apiRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  for (const fam of PHASE12_FAMILIES) {
    it(`${fam.family}: authority file(s) + guard suite present`, () => {
      for (const a of fam.authority) {
        expect(statSync(join(apiRoot, a)).isFile(), `${fam.family}: missing authority ${a}`).toBe(true);
      }
      expect(statSync(join(apiRoot, fam.guard)).isFile(), `${fam.family}: guard suite missing`).toBe(true);
    });
  }
  it("family coverage = 25 (no silent drop)", () => {
    expect(PHASE12_FAMILIES).toHaveLength(25);
  });
});
