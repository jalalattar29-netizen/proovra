/**
 * PHASE 10 §10.1–§10.9 (2026-07-23) — advanced enterprise identity.
 * Behavioral proofs of the canonical decision surface + the break-glass and
 * support-access services (real services, db substituted where used).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const H = vi.hoisted(() => ({ writes: [] as string[], eagRow: null as Record<string, unknown> | null, sagRow: null as Record<string, unknown> | null }));

vi.mock("../src/db.js", () => {
  const mk = (model: string) =>
    new Proxy(
      {},
      {
        get(_t, method: string) {
          return async (args?: { data?: Record<string, unknown> }) => {
            if (/^(create|update|upsert|delete)/.test(String(method)))
              H.writes.push(`${model}.${String(method)}`);
            if (model === "emergencyAccessGrant" && method === "create")
              return { id: "eag-1", startedAtUtc: new Date(), expiresAtUtc: new Date(Date.now() + 3600_000), grantedRole: "EMERGENCY_READ_ONLY", reason: String(args?.data?.reason ?? ""), organizationId: "org-1", emergencyUserId: "emg-1" };
            if (model === "supportAccessGrant" && method === "create")
              return { id: "sag-1", startedAtUtc: new Date(), expiresAtUtc: new Date(Date.now() + 3600_000), accessLevel: String(args?.data?.accessLevel ?? "READ_ONLY"), reason: String(args?.data?.reason ?? ""), supportUserId: "support-1", organizationId: "org-1", teamId: null };
            // §policy-convergence — the policy write resolves the parent Customer org.
            if (model === "team" && method === "findUnique")
              return { organizationId: "org-1", organization: { kind: "CUSTOMER" } };
            // PHASE 12 CORRECTION 1 — org-keyed writes validate the org kind
            // directly and resolve a canonical team only for audit binding.
            if (model === "organization" && method === "findUnique")
              return { kind: "CUSTOMER" };
            if (model === "team" && method === "findFirst")
              return { id: "team-1" };
            if (model === "organizationSecurityPolicy" && method === "findUnique")
              return { organizationId: "org-1", policyVersion: 1 }; // existing v1 → patch bumps to v2
            if (method === "updateMany") return { count: 1 };
            return {};
          };
        },
      },
    );
  const prisma = new Proxy(
    {},
    {
      get(_t, model: string) {
        if (String(model).startsWith("$")) return async (fn?: unknown) => (typeof fn === "function" ? (fn as (tx: unknown) => unknown)(prisma) : 0);
        // Break-glass/support delegates present (simulating APPLIED migration).
        return mk(String(model));
      },
    },
  );
  return { prisma };
});

import {
  defaultSecurityPolicy,
  evaluateAuthMethod,
  evaluatePolicyVersion,
  evaluateSessionLifetime,
  evaluateStepUpDue,
  evaluatePersonalSpaceAllowed,
  evaluateHighSecurityActivation,
  highSecurityPosture,
  type ResolvedSecurityPolicy,
} from "../src/services/identity/enterprise-security-policy.policy.js";
// §10.1 — the DB-bound write is the SOLE org security-policy authority.
import { applySecurityPolicyPatch } from "../src/services/identity/org-security-policy.service.js";
import {
  activateBreakGlass,
  revokeBreakGlass,
  evaluateBreakGlassActive,
  evaluateBreakGlassActionAllowed,
} from "../src/services/identity/break-glass.service.js";
import {
  startSupportAccess,
  evaluateSupportAccess,
  evaluateSupportActionAllowed,
} from "../src/services/identity/support-access.service.js";

const P = (o: Partial<ResolvedSecurityPolicy> = {}): ResolvedSecurityPolicy => ({ ...defaultSecurityPolicy("ws-1", "org-1"), ...o });

beforeEach(() => {
  H.writes.length = 0;
});

// ── §10.1 ONE authority — the pure evaluator is internal ──────────────────
describe("§10.1 — one public security-policy authority (pure evaluator is internal)", () => {
  it("enterprise-security-policy.policy is imported ONLY by the canonical service (+ tests)", async () => {
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { join } = await import("node:path");
    const SRC = fileURLToPath(new URL("../src", import.meta.url));
    const walk = (d: string): string[] => {
      const out: string[] = [];
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const f = join(d, e.name);
        if (e.isDirectory()) out.push(...walk(f));
        else if (e.name.endsWith(".ts") && statSync(f).isFile()) out.push(f);
      }
      return out;
    };
    // Files that IMPORT the pure evaluator module (exclude the module itself).
    const importers = walk(SRC)
      .filter((f) => !f.endsWith("enterprise-security-policy.policy.ts"))
      .filter((f) => /from "[^"]*enterprise-security-policy\.policy\.js"/.test(readFileSync(f, "utf8")))
      .map((f) => f.replace(SRC, "").replace(/\\/g, "/"));
    expect(importers.sort()).toEqual([
      "/services/identity/org-security-policy.service.ts", // the SOLE authority
    ]);
  });
  it("the duplicate enterprise-security-policy.SERVICE no longer exists", async () => {
    const { existsSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    expect(existsSync(fileURLToPath(new URL("../src/services/identity/enterprise-security-policy.service.ts", import.meta.url)))).toBe(false);
  });
});

// ── §10.1 versioning ──────────────────────────────────────────────────────
describe("§10.1 — versioned policy + session re-evaluation", () => {
  it("a session minted under an older policy version is stale (re-evaluation)", () => {
    const policy = P({ policyVersion: 3 });
    expect(evaluatePolicyVersion(policy, 2)).toEqual({ allowed: false, reason: "policy_version_stale" });
    expect(evaluatePolicyVersion(policy, 3).allowed).toBe(true);
    expect(evaluatePolicyVersion(policy, null).allowed).toBe(true); // legacy session tolerated
  });
  it("applySecurityPolicyPatch bumps the version and audits", async () => {
    const next = await applySecurityPolicyPatch({ organizationId: "org-1", actorUserId: "admin-1", patch: { ssoRequired: true } });
    expect(next.policyVersion).toBe(2);
    expect(next.ssoRequired).toBe(true);
    expect(H.writes.some((w) => /adminAuditLog|auditLog/i.test(w))).toBe(true);
  });
});

// ── §10.2 mandatory SSO (correction 4 — managed-INDEPENDENT) ───────────────
describe("§10.2/correction 4 — mandatory SSO applies to EVERY session (not just managed)", () => {
  it("ssoRequired DENIES password/OAuth and ALLOWS SSO — regardless of managed status", () => {
    const policy = P({ ssoRequired: true });
    expect(evaluateAuthMethod(policy, { method: "PASSWORD" })).toEqual({ allowed: false, reason: "mandatory_sso_required" });
    expect(evaluateAuthMethod(policy, { method: "OAUTH" }).allowed).toBe(false);
    expect(evaluateAuthMethod(policy, { method: "SSO" }).allowed).toBe(true);
  });
  it("a STANDARD (non-managed) session is ALSO forced through org SSO when ssoRequired", () => {
    // correction 4 — mandatory SSO is a login-method policy, decoupled from
    // managed-identity ownership. STANDARD users are NOT exempt.
    const policy = P({ ssoRequired: true });
    expect(evaluateAuthMethod(policy, { method: "PASSWORD" }).allowed).toBe(false);
  });
  it("ssoRequired=false preserves allowed non-SSO behavior", () => {
    const policy = P({ ssoRequired: false });
    expect(evaluateAuthMethod(policy, { method: "PASSWORD" }).allowed).toBe(true);
  });
  it("allowedAuthMethods further restricts", () => {
    const policy = P({ allowedAuthMethods: ["SSO"] });
    expect(evaluateAuthMethod(policy, { method: "PASSWORD" }).allowed).toBe(false);
  });
});

// ── §10.7 domain/session policies ─────────────────────────────────────────
describe("§10.7 — session lifetime, idle timeout, step-up interval (backend-authoritative)", () => {
  it("max session age is enforced", () => {
    const policy = P({ maxSessionAgeSeconds: 3600 });
    const now = 10_000_000;
    expect(evaluateSessionLifetime(policy, { issuedAtMs: now - 2 * 3600_000, lastSeenAtMs: now, nowMs: now })).toEqual({ allowed: false, reason: "session_max_age_exceeded" });
    expect(evaluateSessionLifetime(policy, { issuedAtMs: now - 60_000, lastSeenAtMs: now, nowMs: now }).allowed).toBe(true);
  });
  it("idle timeout is enforced", () => {
    const policy = P({ idleTimeoutSeconds: 900 });
    const now = 10_000_000;
    expect(evaluateSessionLifetime(policy, { issuedAtMs: now, lastSeenAtMs: now - 2 * 900_000, nowMs: now }).allowed).toBe(false);
  });
  it("step-up is due when the interval elapsed (or never stepped up)", () => {
    const policy = P({ stepUpIntervalSeconds: 1800 });
    const now = 10_000_000;
    expect(evaluateStepUpDue(policy, { lastStepUpAtMs: null, nowMs: now }).due).toBe(true);
    expect(evaluateStepUpDue(policy, { lastStepUpAtMs: now - 3600_000, nowMs: now }).due).toBe(true);
    expect(evaluateStepUpDue(policy, { lastStepUpAtMs: now - 60_000, nowMs: now }).due).toBe(false);
    expect(evaluateStepUpDue(P(), { lastStepUpAtMs: null, nowMs: now }).due).toBe(false); // unset → not required
  });
});

// ── §10.4 high-security + §10.5 no-personal ───────────────────────────────
describe("§10.4/§10.5 — high-security bundled mode + no-personal", () => {
  it("high-security posture composes SSO + managed + no-personal", () => {
    expect(highSecurityPosture()).toEqual({ securityMode: "HIGH_SECURITY", ssoRequired: true, managedIdentityRequired: true, noPersonalSpace: true });
  });
  it("activation FAILS atomically if ANY prerequisite is missing", () => {
    const base = { hasActiveSsoConnection: true, ssoConnectionTested: true, hasVerifiedDomain: true, hasBreakGlassReadiness: true, unresolvedPersonalCustodyUserIds: [], contractActive: true };
    expect(evaluateHighSecurityActivation(base)).toEqual({ ok: true });
    expect(evaluateHighSecurityActivation({ ...base, ssoConnectionTested: false })).toMatchObject({ ok: false });
    expect(evaluateHighSecurityActivation({ ...base, hasVerifiedDomain: false })).toMatchObject({ ok: false });
    expect(evaluateHighSecurityActivation({ ...base, hasBreakGlassReadiness: false })).toMatchObject({ ok: false });
    // Unresolved existing Personal custody BLOCKS activation (never seizes).
    const r = evaluateHighSecurityActivation({ ...base, unresolvedPersonalCustodyUserIds: ["u1"] });
    expect(r).toMatchObject({ ok: false });
    expect((r as { missing: string[] }).missing).toContain("unresolved_personal_custody");
  });
  it("no-personal-space policy blocks personal bootstrap decision", () => {
    expect(evaluatePersonalSpaceAllowed(P({ noPersonalSpace: true }))).toBe(false);
    expect(evaluatePersonalSpaceAllowed(P())).toBe(true);
  });
});

// ── §10.6 break-glass ─────────────────────────────────────────────────────
describe("§10.6 — break-glass emergency access (bounded, restricted, audited)", () => {
  it("requires a substantive reason AND a step-up proof (fail closed)", async () => {
    await expect(activateBreakGlass({ organizationId: "org-1", emergencyUserId: "emg-1", requestedByUserId: "req-1", reason: "x", stepUpProofId: "sp-1" })).rejects.toMatchObject({ code: "BREAK_GLASS_REASON_REQUIRED" });
    await expect(activateBreakGlass({ organizationId: "org-1", emergencyUserId: "emg-1", requestedByUserId: "req-1", reason: "server outage recovery", stepUpProofId: "" })).rejects.toMatchObject({ code: "BREAK_GLASS_STEP_UP_REQUIRED" });
  });
  it("a valid activation creates a bounded grant + CRITICAL audit", async () => {
    const g = await activateBreakGlass({ organizationId: "org-1", emergencyUserId: "emg-1", requestedByUserId: "req-1", reason: "SSO outage recovery for org", stepUpProofId: "sp-1" });
    expect(g.status).toBe("ACTIVE");
    expect(g.expiresAtUtc.getTime()).toBeGreaterThan(Date.now());
    expect(H.writes).toContain("emergencyAccessGrant.create");
    expect(H.writes.some((w) => /auditLog/i.test(w))).toBe(true);
  });
  it("destructive/security/billing actions are DENIED regardless of role", () => {
    for (const a of ["evidence.delete", "legal_hold.remove", "retention.weaken", "security_policy.update", "billing.change", "membership.owner_change"]) {
      expect(evaluateBreakGlassActionAllowed(a).allowed).toBe(false);
    }
    expect(evaluateBreakGlassActionAllowed("evidence.read").allowed).toBe(true);
  });
  it("expired/revoked grants are inactive", () => {
    const now = Date.now();
    expect(evaluateBreakGlassActive({ status: "ACTIVE", expiresAtUtc: new Date(now - 1), revokedAtUtc: null }, now).active).toBe(false);
    expect(evaluateBreakGlassActive({ status: "REVOKED", expiresAtUtc: new Date(now + 1000), revokedAtUtc: new Date() }, now).active).toBe(false);
    expect(evaluateBreakGlassActive({ status: "ACTIVE", expiresAtUtc: new Date(now + 1000), revokedAtUtc: null }, now).active).toBe(true);
  });
  it("revocation is auditable", async () => {
    await revokeBreakGlass({ grantId: "eag-1", revokedByUserId: "admin-1" });
    expect(H.writes).toContain("emergencyAccessGrant.updateMany");
  });
});

// ── §10.8 support access ──────────────────────────────────────────────────
describe("§10.8 — dual-identity support access (scoped, read-only default, audited)", () => {
  it("requires a reason; ELEVATED requires explicit approval", async () => {
    await expect(startSupportAccess({ supportUserId: "s-1", organizationId: "org-1", reason: "x" })).rejects.toMatchObject({ code: "SUPPORT_REASON_REQUIRED" });
    await expect(startSupportAccess({ supportUserId: "s-1", organizationId: "org-1", reason: "investigate ticket 42", accessLevel: "ELEVATED" })).rejects.toMatchObject({ code: "SUPPORT_APPROVAL_REQUIRED" });
  });
  it("a valid grant records the support ACTOR distinctly + bounded window + audit", async () => {
    const g = await startSupportAccess({ supportUserId: "support-1", organizationId: "org-1", reason: "investigate ticket 42" });
    expect(g.supportUserId).toBe("support-1");
    expect(g.accessLevel).toBe("READ_ONLY");
    expect(H.writes).toContain("supportAccessGrant.create");
    expect(H.writes.some((w) => /auditLog/i.test(w))).toBe(true);
  });
  it("scope is enforced: another org / another workspace is not covered", () => {
    const now = Date.now();
    const grant = { status: "ACTIVE" as const, expiresAtUtc: new Date(now + 1000), revokedAtUtc: null, organizationId: "org-1", teamId: "ws-1" };
    expect(evaluateSupportAccess(grant, { organizationId: "org-1", teamId: "ws-1", nowMs: now }).active).toBe(true);
    expect(evaluateSupportAccess(grant, { organizationId: "org-2", nowMs: now })).toMatchObject({ active: false, reason: "org_scope_mismatch" });
    expect(evaluateSupportAccess(grant, { organizationId: "org-1", teamId: "ws-2", nowMs: now })).toMatchObject({ active: false, reason: "workspace_scope_mismatch" });
    expect(evaluateSupportAccess(grant, { organizationId: "org-1", teamId: "ws-1", nowMs: now + 5000 })).toMatchObject({ active: false, reason: "expired" });
  });
  it("READ_ONLY denies mutations; destructive/security/billing always denied", () => {
    const ro = { accessLevel: "READ_ONLY" as const };
    expect(evaluateSupportActionAllowed(ro, "evidence.read").allowed).toBe(true);
    expect(evaluateSupportActionAllowed(ro, "evidence.update").allowed).toBe(false);
    expect(evaluateSupportActionAllowed({ accessLevel: "ELEVATED" }, "evidence.delete").allowed).toBe(false);
    expect(evaluateSupportActionAllowed({ accessLevel: "ELEVATED" }, "billing.change").allowed).toBe(false);
  });
});
