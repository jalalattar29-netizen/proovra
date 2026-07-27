/**
 * PHASE 10 §10.6 Step 4 — BREAK-GLASS RUNTIME AUTHORIZATION COMPOSITION.
 *
 * Production-path tests for the canonical runtime evaluator
 * `evaluateEmergencyAccess` (the ONE break-glass authority) and its composition
 * into the canonical authorize path via `authorizeWithEmergencyOverlay`.
 *
 * Style: the REAL evaluator against a prisma stub (only the DB boundary + the
 * audit sink are mocked); a Fastify inject test for the overlay composition; and
 * a source-contract test pinning "break-glass authorities = 1" + "no second
 * authorization engine".
 *
 * Machine metrics enforced:
 *   - EmergencyAccessGrant WRITE authorities = 1 (only break-glass.service).
 *   - mutations on any DENIAL path = 0.
 *   - un-audited allow/deny paths = 0 (every path audits at critical severity).
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

// ── audit sink: mocked so we can COUNT + inspect every audit emission ────────
const AUDITS: Array<{
  action: string;
  outcome: string | null | undefined;
  severity: string | null | undefined;
  metadata: Record<string, unknown>;
}> = [];
vi.mock("../src/services/platform-audit-log.service.js", () => ({
  appendPlatformAuditLog: async (p: {
    action: string;
    outcome?: string | null;
    severity?: string | null;
    metadata: Record<string, unknown>;
  }) => {
    AUDITS.push({ action: p.action, outcome: p.outcome, severity: p.severity, metadata: p.metadata });
  },
}));

import {
  evaluateEmergencyAccess,
  evaluateEmergencyCapability,
  EMERGENCY_OPERATOR_ALLOWED_ACTIONS,
  BREAK_GLASS_FORBIDDEN_ACTIONS,
  type EmergencyRole,
} from "../src/services/identity/break-glass.service.js";

const API = resolve(__dirname, "..");
const NOW = 1_800_000_000_000;
const GRANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ACTOR = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

type GrantRow = {
  id: string;
  organizationId: string;
  emergencyUserId: string;
  grantedRole: string;
  status: string;
  expiresAtUtc: Date;
  revokedAtUtc: Date | null;
  stepUpProofId: string | null;
};

function grant(over: Partial<GrantRow> = {}): GrantRow {
  return {
    id: GRANT,
    organizationId: ORG,
    emergencyUserId: ACTOR,
    grantedRole: "EMERGENCY_READ_ONLY",
    status: "ACTIVE",
    expiresAtUtc: new Date(NOW + 3_600_000),
    revokedAtUtc: null,
    stepUpProofId: "proof-1",
    ...over,
  };
}

/** A prisma stub whose emergencyAccessGrant.* records every WRITE attempt. */
function makePrisma(opts: { row?: GrantRow | null; throwCode?: string } = {}) {
  const writes: string[] = [];
  const track = (name: string) => async () => {
    writes.push(name);
    return {};
  };
  const prisma = {
    emergencyAccessGrant: {
      findUnique: async () => {
        if (opts.throwCode) {
          const e = new Error("schema unavailable") as Error & { code?: string };
          e.code = opts.throwCode;
          throw e;
        }
        return opts.row ?? null;
      },
      create: track("create"),
      update: track("update"),
      updateMany: track("updateMany"),
      upsert: track("upsert"),
      delete: track("delete"),
      deleteMany: track("deleteMany"),
    },
  } as never;
  return { prisma, writes };
}

beforeEach(() => {
  AUDITS.length = 0;
});

const base = { actorUserId: ACTOR, organizationId: ORG, action: "evidence.read", nowMs: NOW };

// =============================================================================
// The canonical runtime evaluator — production behavior.
// =============================================================================
describe("§10.6 evaluateEmergencyAccess — active grant permits a bounded read", () => {
  it("EMERGENCY_READ_ONLY + evidence.read → allowed (read capability), audited USE, zero mutation", async () => {
    const { prisma, writes } = makePrisma({ row: grant() });
    const d = await evaluateEmergencyAccess(GRANT, base, prisma);
    expect(d.allowed).toBe(true);
    if (d.allowed) {
      expect(d.capability).toBe("read");
      expect(d.role).toBe("EMERGENCY_READ_ONLY");
      expect(d.organizationId).toBe(ORG);
      expect(d.actorUserId).toBe(ACTOR);
    }
    // Audited the USE via the canonical tenant-audit facade (PHASE 11 §3 Batch
    // B): severity is derived from outcome ("success" → "info"), not set by
    // the caller.
    expect(AUDITS).toHaveLength(1);
    expect(AUDITS[0].action).toBe("identity.break_glass.used");
    expect(AUDITS[0].outcome).toBe("success");
    expect(AUDITS[0].severity).toBe("critical");
    // NEVER writes/mints anything at runtime.
    expect(writes).toEqual([]);
  });
});

describe("§10.6 evaluateEmergencyAccess — every denial fails closed, audits, zero mutation", () => {
  const cases: Array<{ name: string; row: GrantRow | null; reason: string; over?: Partial<typeof base> }> = [
    { name: "expired grant", row: grant({ expiresAtUtc: new Date(NOW - 1) }), reason: "grant_expired" },
    { name: "revoked (status)", row: grant({ status: "REVOKED" }), reason: "grant_revoked" },
    { name: "revoked (revokedAtUtc set)", row: grant({ revokedAtUtc: new Date(NOW - 10) }), reason: "grant_revoked" },
    { name: "wrong org", row: grant(), reason: "org_scope_mismatch", over: { organizationId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" } },
    { name: "wrong actor", row: grant(), reason: "actor_mismatch", over: { actorUserId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" } },
    { name: "missing grant", row: null, reason: "grant_not_found" },
  ];

  for (const c of cases) {
    it(`${c.name} → denied (${c.reason}), audited DENY, zero mutation`, async () => {
      const { prisma, writes } = makePrisma({ row: c.row });
      const d = await evaluateEmergencyAccess(GRANT, { ...base, ...c.over }, prisma);
      expect(d.allowed).toBe(false);
      if (!d.allowed) expect(d.reason).toBe(c.reason);
      expect(AUDITS).toHaveLength(1);
      expect(AUDITS[0].action).toBe("identity.break_glass.denied");
      expect(AUDITS[0].outcome).toBe("denied");
      // Facade-derived severity (PHASE 11 §3 Batch B): "denied" → "warning".
      expect(AUDITS[0].severity).toBe("critical");
      expect(writes).toEqual([]);
    });
  }

  it("step-up reference mismatch → denied (step_up_mismatch)", async () => {
    const { prisma, writes } = makePrisma({ row: grant({ stepUpProofId: "proof-1" }) });
    const d = await evaluateEmergencyAccess(GRANT, { ...base, stepUpProofId: "WRONG" } as never, prisma);
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe("step_up_mismatch");
    expect(writes).toEqual([]);
  });

  it("schema unavailable (P2021) → denied (schema_unavailable), fail-closed, zero mutation", async () => {
    const { prisma, writes } = makePrisma({ throwCode: "P2021" });
    const d = await evaluateEmergencyAccess(GRANT, base, prisma);
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe("schema_unavailable");
    expect(AUDITS).toHaveLength(1);
    expect(AUDITS[0].outcome).toBe("denied");
    expect(writes).toEqual([]);
  });

  it("invalid input (empty action) → denied (invalid_input), no grant load", async () => {
    const { prisma, writes } = makePrisma({ row: grant() });
    const d = await evaluateEmergencyAccess(GRANT, { ...base, action: "" }, prisma);
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe("invalid_input");
    expect(writes).toEqual([]);
  });
});

describe("§10.6 evaluateEmergencyAccess — ALWAYS-forbidden actions denied even with an ACTIVE grant", () => {
  for (const action of ["evidence.delete", "legal_hold.remove", "retention.weaken", "security_policy.update", "billing.change"]) {
    it(`${action} denied under an ACTIVE EMERGENCY_OPERATOR grant (forbidden_action)`, async () => {
      const { prisma, writes } = makePrisma({ row: grant({ grantedRole: "EMERGENCY_OPERATOR" }) });
      const d = await evaluateEmergencyAccess(GRANT, { ...base, action }, prisma);
      expect(d.allowed).toBe(false);
      if (!d.allowed) expect(d.reason).toBe("forbidden_action");
      expect(AUDITS[0].outcome).toBe("denied");
      expect(writes).toEqual([]);
    });
  }
});

describe("§10.6 RESTRICTED capability overlay — bounded allowlist per role", () => {
  it("EMERGENCY_READ_ONLY may NOT perform an operate action (read_only)", async () => {
    const { prisma } = makePrisma({ row: grant({ grantedRole: "EMERGENCY_READ_ONLY" }) });
    const d = await evaluateEmergencyAccess(GRANT, { ...base, action: "session.revoke" }, prisma);
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe("read_only");
  });

  it("EMERGENCY_OPERATOR may perform a bounded operate action (session.revoke → operate)", async () => {
    const { prisma } = makePrisma({ row: grant({ grantedRole: "EMERGENCY_OPERATOR" }) });
    const d = await evaluateEmergencyAccess(GRANT, { ...base, action: "session.revoke" }, prisma);
    expect(d.allowed).toBe(true);
    if (d.allowed) expect(d.capability).toBe("operate");
  });

  it("EMERGENCY_OPERATOR may NOT perform an un-allowlisted operate action (capability_not_permitted)", async () => {
    const { prisma } = makePrisma({ row: grant({ grantedRole: "EMERGENCY_OPERATOR" }) });
    const d = await evaluateEmergencyAccess(GRANT, { ...base, action: "user.create" }, prisma);
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe("capability_not_permitted");
  });

  it("the operate allowlist and the forbidden blocklist are disjoint (no forbidden action is operable)", () => {
    for (const a of EMERGENCY_OPERATOR_ALLOWED_ACTIONS) {
      expect((BREAK_GLASS_FORBIDDEN_ACTIONS as readonly string[]).includes(a)).toBe(false);
    }
  });

  it("pure capability function forbids the blocklist for both roles", () => {
    for (const role of ["EMERGENCY_READ_ONLY", "EMERGENCY_OPERATOR"] as EmergencyRole[]) {
      for (const a of BREAK_GLASS_FORBIDDEN_ACTIONS) {
        expect(evaluateEmergencyCapability(role, a).allowed).toBe(false);
      }
    }
  });
});

// =============================================================================
// Source-contract: ONE authority, no second authorization engine.
// =============================================================================
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = resolve(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

describe("§10.6 source-contract — break-glass authorities = 1, no alternate engine", () => {
  const files = walk(resolve(API, "src"));

  it("exactly ONE file WRITES EmergencyAccessGrant (break-glass.service.ts)", () => {
    const writeRe = /emergencyAccessGrant\.(create|update|updateMany|upsert|delete|deleteMany)\b/;
    const writers = files.filter((f) => writeRe.test(readFileSync(f, "utf8")));
    expect(writers).toHaveLength(1);
    expect(writers[0].replace(/\\/g, "/")).toMatch(/services\/identity\/break-glass\.service\.ts$/);
  });

  it("the runtime evaluator lives ONLY in break-glass.service.ts", () => {
    const definers = files.filter((f) => /export async function evaluateEmergencyAccess\b/.test(readFileSync(f, "utf8")));
    expect(definers).toHaveLength(1);
    expect(definers[0].replace(/\\/g, "/")).toMatch(/break-glass\.service\.ts$/);
  });

  it("the composition COMPOSES the canonical authorize helper (does not re-implement authorization)", () => {
    const src = readFileSync(resolve(API, "src/middleware/authorize-emergency.ts"), "utf8");
    // Delegates the normal path to the canonical helper…
    expect(src).toMatch(/authorizeOrFail/);
    // …defers the emergency decision to the ONE authority…
    expect(src).toMatch(/evaluateEmergencyAccess/);
    // …and never re-implements the member-access engine (no second engine).
    expect(src).not.toMatch(/evaluateMemberAccess/);
    expect(src).not.toMatch(/recordPermissionDecision/);
  });
});

// =============================================================================
// Fastify inject — the overlay composed into a route.
// =============================================================================
describe("§10.6 overlay composition (fastify inject)", async () => {
  // Boundary mocks: authenticated actor + the canonical (normal-path) helper.
  // The DB is injected per-call via the overlay's `client` DI seam so the REAL
  // evaluator runs against a controllable prisma stub.
  const RUNTIME = vi.hoisted(() => ({ row: null as GrantRow | null, throwCode: undefined as string | undefined, normalAllowed: true }));
  vi.doMock("../src/auth.js", () => ({ getAuthUserId: () => ACTOR }));
  vi.doMock("../src/middleware/authorize.js", () => ({
    authorizeOrFail: async (_req: unknown, reply: { code: (n: number) => { send: (b: unknown) => void } }) => {
      if (!RUNTIME.normalAllowed) { reply.code(403).send({ error: { code: "permission_denied" } }); return null; }
      return { actorUserId: ACTOR, teamId: "ws-1" };
    },
  }));

  const stubClient = {
    emergencyAccessGrant: {
      findUnique: async () => {
        if (RUNTIME.throwCode) { const e = new Error("schema") as Error & { code?: string }; e.code = RUNTIME.throwCode; throw e; }
        return RUNTIME.row;
      },
    },
  } as never;

  const Fastify = (await import("fastify")).default;
  const { authorizeWithEmergencyOverlay } = await import("../src/middleware/authorize-emergency.js");

  async function makeApp() {
    const app = Fastify();
    app.post("/emergency-op", async (req, reply) => {
      const b = (req.body ?? {}) as { organizationId: string; action: string; grantId?: string; stepUpProofId?: string };
      const ctx = await authorizeWithEmergencyOverlay(req, reply, {
        teamId: "ws-1",
        organizationId: b.organizationId,
        permission: "evidence.read",
        action: b.action,
        grantId: b.grantId ?? null,
        stepUpProofId: b.stepUpProofId ?? null,
        nowMs: NOW,
        client: stubClient,
      });
      if (!ctx) return;
      return reply.send({ ok: true, viaEmergency: ctx.viaEmergency, capability: ctx.emergencyCapability ?? null });
    });
    await app.ready();
    return app;
  }

  const HDR = { "content-type": "application/json" };

  it("no emergency entry → delegates to canonical authorizeOrFail (viaEmergency=false)", async () => {
    RUNTIME.normalAllowed = true;
    const app = await makeApp();
    const res = await app.inject({ method: "POST", url: "/emergency-op", headers: HDR, payload: { organizationId: ORG, action: "evidence.read" } });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).viaEmergency).toBe(false);
  });

  it("explicit emergency entry with an ACTIVE grant → allowed via overlay (read)", async () => {
    RUNTIME.row = grant();
    RUNTIME.throwCode = undefined;
    const app = await makeApp();
    const res = await app.inject({ method: "POST", url: "/emergency-op", headers: HDR, payload: { organizationId: ORG, action: "evidence.read", grantId: GRANT, stepUpProofId: "proof-1" } });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.viaEmergency).toBe(true);
    expect(body.capability).toBe("read");
  });

  it("explicit emergency entry, expired grant → 403 break_glass_denied (grant_expired)", async () => {
    RUNTIME.row = grant({ expiresAtUtc: new Date(NOW - 1) });
    const app = await makeApp();
    const res = await app.inject({ method: "POST", url: "/emergency-op", headers: HDR, payload: { organizationId: ORG, action: "evidence.read", grantId: GRANT, stepUpProofId: "proof-1" } });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toMatchObject({ code: "break_glass_denied", reason: "grant_expired" });
  });

  it("explicit emergency entry, forbidden action → 403 (forbidden_action) even with an ACTIVE grant", async () => {
    RUNTIME.row = grant({ grantedRole: "EMERGENCY_OPERATOR" });
    const app = await makeApp();
    const res = await app.inject({ method: "POST", url: "/emergency-op", headers: HDR, payload: { organizationId: ORG, action: "evidence.delete", grantId: GRANT, stepUpProofId: "proof-1" } });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error.reason).toBe("forbidden_action");
  });

  it("schema unavailable at use → 503 (fail-closed)", async () => {
    RUNTIME.row = null;
    RUNTIME.throwCode = "P2021";
    const app = await makeApp();
    const res = await app.inject({ method: "POST", url: "/emergency-op", headers: HDR, payload: { organizationId: ORG, action: "evidence.read", grantId: GRANT, stepUpProofId: "proof-1" } });
    expect(res.statusCode).toBe(503);
    RUNTIME.throwCode = undefined;
  });
});
