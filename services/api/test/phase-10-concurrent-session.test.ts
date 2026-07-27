/**
 * PHASE 10 §2 — CONCURRENT ORGANIZATION-SESSION LIMIT.
 *
 * `establishOrganizationSessionContext` is the ONE authority. It counts DISTINCT
 * active sessionIds per (userId, organizationId), is idempotent per sessionId,
 * serialises under a per-(user,org) advisory lock, and FAILS CLOSED (deny, no
 * eviction) beyond the limit. Runs against the REAL service with an in-memory
 * transactional prisma stub. The true concurrent-last-slot race is authored as a
 * live-DB gate (see the `.gate.` describe) — it needs Postgres advisory locks
 * and is NOT claimed to run here.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  establishOrganizationSessionContext,
  releaseOrganizationSessionContext,
} from "../src/services/identity/concurrent-session.service.js";
import { isLiveIntegrationEnabled } from "./integration-harness.js";

const API = resolve(__dirname, "..");
const future = () => new Date(Date.now() + 3600_000);

type SessionRow = { id: string; organizationContextId: string | null; expiresAtUtc: Date; revokedAtUtc: Date | null } | null;

function mockDb(opts: {
  orgStatus?: string;
  session?: SessionRow;
  activeCount?: number;
  limit?: number | null;
}) {
  const writes: string[] = [];
  const calls: string[] = [];
  const sessionDefault: SessionRow = { id: "sess-1", organizationContextId: null, expiresAtUtc: future(), revokedAtUtc: null };
  const tx = {
    $executeRaw: async () => { calls.push("advisory_lock"); return 1; },
    organization: {
      findUnique: async () => ({ status: opts.orgStatus ?? "ACTIVE" }),
    },
    authenticatedSession: {
      findUnique: async () => { calls.push("session.findUnique"); return opts.session === undefined ? sessionDefault : opts.session; },
      count: async () => { calls.push("count"); return opts.activeCount ?? 0; },
      update: async () => { writes.push("session.update"); return {}; },
      updateMany: async () => { writes.push("session.updateMany"); return { count: 1 }; },
    },
    team: { findUnique: async () => ({ organizationId: "org-A" }) },
    organizationSecurityPolicy: {
      findUnique: async () => ({ teamId: "ws-A", concurrentSessionLimit: opts.limit === undefined ? null : opts.limit }),
    },
  };
  const prisma = { $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx), ...tx } as never;
  return { prisma, writes, calls };
}

const base = { userId: "u1", organizationId: "org-A", sessionIdHash: "hash-1" };

describe("§2 — establish counts per (user, org) + fails closed at the limit", () => {
  it("first Org context under the limit → allowed + established (context write)", async () => {
    const { prisma, writes } = mockDb({ activeCount: 0, limit: 2 });
    const d = await establishOrganizationSessionContext(base, prisma);
    expect(d).toMatchObject({ allowed: true, established: true, activeCount: 1, limit: 2 });
    expect(writes).toContain("session.update");
  });

  it("a second session under the limit → allowed", async () => {
    const { prisma } = mockDb({ activeCount: 1, limit: 2 });
    expect((await establishOrganizationSessionContext(base, prisma)).allowed).toBe(true);
  });

  it("AT the limit → DENIED (concurrent_session_limit_reached), ZERO mutation (no eviction)", async () => {
    const { prisma, writes } = mockDb({ activeCount: 2, limit: 2 });
    const d = await establishOrganizationSessionContext(base, prisma);
    expect(d).toMatchObject({ allowed: false, reason: "concurrent_session_limit_reached" });
    expect(writes).toEqual([]); // existing sessions preserved; nothing written
  });

  it("OVER the limit (policy reduced) → DENIED deterministically", async () => {
    const { prisma } = mockDb({ activeCount: 5, limit: 2 });
    expect((await establishOrganizationSessionContext(base, prisma)).allowed).toBe(false);
  });

  it("no limit configured (null) → allowed regardless of count", async () => {
    const { prisma } = mockDb({ activeCount: 99, limit: null });
    expect((await establishOrganizationSessionContext(base, prisma)).allowed).toBe(true);
  });
});

describe("§2 — idempotency + scope isolation", () => {
  it("a session already holding THIS Org's context counts once (no re-write, allowed at limit)", async () => {
    // organizationContextId already === org-A → idempotent even though count==limit.
    const { prisma, writes } = mockDb({
      session: { id: "sess-1", organizationContextId: "org-A", expiresAtUtc: future(), revokedAtUtc: null },
      activeCount: 2, limit: 2,
    });
    const d = await establishOrganizationSessionContext(base, prisma);
    expect(d).toMatchObject({ allowed: true, established: false });
    expect(writes).toEqual([]); // no new context write — counted once
  });

  it("the count query excludes expired + revoked sessions (source contract)", () => {
    const src = readFileSync(resolve(API, "src/services/identity/concurrent-session.service.ts"), "utf8");
    expect(src).toMatch(/revokedAtUtc:\s*null/);
    expect(src).toMatch(/expiresAtUtc:\s*\{\s*gt:/);
    expect(src).toMatch(/organizationContextId:\s*organizationId/);
  });
});

describe("§2 — fail closed on lifecycle / inventory / infra", () => {
  it("suspended Organization → organization_suspended, zero mutation", async () => {
    const { prisma, writes } = mockDb({ orgStatus: "SUSPENDED", activeCount: 0, limit: 5 });
    const d = await establishOrganizationSessionContext(base, prisma);
    expect(d).toMatchObject({ allowed: false, reason: "organization_suspended" });
    expect(writes).toEqual([]);
  });

  it("missing session (not in inventory) → fail closed", async () => {
    const { prisma } = mockDb({ session: null, limit: 5 });
    expect((await establishOrganizationSessionContext(base, prisma)).allowed).toBe(false);
  });

  it("expired session → fail closed (session_not_in_inventory)", async () => {
    const { prisma } = mockDb({ session: { id: "s", organizationContextId: null, expiresAtUtc: new Date(Date.now() - 1000), revokedAtUtc: null }, limit: 5 });
    expect((await establishOrganizationSessionContext(base, prisma)).allowed).toBe(false);
  });

  it("revoked session → fail closed", async () => {
    const { prisma } = mockDb({ session: { id: "s", organizationContextId: null, expiresAtUtc: future(), revokedAtUtc: new Date() }, limit: 5 });
    expect((await establishOrganizationSessionContext(base, prisma)).allowed).toBe(false);
  });
});

describe("§2 — concurrency: advisory lock precedes the count (serialised)", () => {
  it("acquires the per-(user,org) advisory lock BEFORE counting", async () => {
    const { prisma, calls } = mockDb({ activeCount: 0, limit: 2 });
    await establishOrganizationSessionContext(base, prisma);
    expect(calls[0]).toBe("advisory_lock");
    expect(calls.indexOf("advisory_lock")).toBeLessThan(calls.indexOf("count"));
  });

  it("uses a PostgreSQL advisory lock, not an in-process mutex (source contract)", () => {
    const src = readFileSync(resolve(API, "src/services/identity/concurrent-session.service.ts"), "utf8");
    expect(src).toMatch(/pg_advisory_xact_lock/);
    expect(src).not.toMatch(/new Mutex|async-mutex|process-local lock/i);
  });
});

describe("§2 — release clears org context (leaving the org)", () => {
  it("releaseOrganizationSessionContext clears organizationContextId", async () => {
    const { prisma, writes } = mockDb({});
    await releaseOrganizationSessionContext({ userId: "u1", sessionIdHash: "hash-1" }, prisma);
    expect(writes).toContain("session.updateMany");
  });
});

describe("§2 — switch-workspace route wiring", () => {
  const ROUTE = readFileSync(resolve(API, "src/routes/platform-context.routes.ts"), "utf8");

  it("the switch seam establishes org context for ORG workspaces and denies with 429", () => {
    expect(ROUTE).toMatch(/establishOrganizationSessionContext\(/);
    expect(ROUTE).toMatch(/concurrent_session_limit_reached/);
    // Limit-reached maps to HTTP 429.
    expect(ROUTE).toMatch(/concurrent_session_limit_reached"\s*\?\s*429/);
  });
  it("the switch seam releases org context for Personal/OWNED targets", () => {
    expect(ROUTE).toMatch(/releaseOrganizationSessionContext\(/);
  });
  it("enforcement runs AFTER the login-method + session-policy gates", () => {
    const establishIdx = ROUTE.indexOf("establishOrganizationSessionContext(");
    const sessionGateIdx = ROUTE.indexOf("evaluateSessionAgainstPolicy(");
    expect(sessionGateIdx).toBeGreaterThan(-1);
    expect(sessionGateIdx).toBeLessThan(establishIdx); // max-age/idle checked first
  });
});

describe("§8 — machine metrics", () => {
  const SVC = readFileSync(resolve(API, "src/services/identity/concurrent-session.service.ts"), "utf8");
  const ROUTE = readFileSync(resolve(API, "src/routes/platform-context.routes.ts"), "utf8");

  it("concurrent-session authority = 1 (single canonical service; route delegates)", () => {
    // The route does not re-implement counting/limit logic; it only calls the service.
    expect(ROUTE).toMatch(/establishOrganizationSessionContext\(/);
    expect(ROUTE).not.toMatch(/concurrentSessionLimit/); // no direct limit interpretation in the route
    expect(ROUTE).not.toMatch(/authenticatedSession\.count\(/); // no direct counting in the route
  });

  it("count is ORGANIZATION-scoped, not team-scoped (no per-workspace duplication)", () => {
    expect(SVC).toMatch(/organizationContextId:\s*organizationId/);
    // The count filter keys off organizationContextId (org), never teamId.
    expect(SVC).not.toMatch(/count\(\{[\s\S]*teamId/);
  });

  it("no in-process locking (advisory lock only)", () => {
    const code = SVC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    expect(code).toMatch(/pg_advisory_xact_lock/);
    // No in-process lock library in real code (comments describing the choice
    // are stripped above).
    expect(code).not.toMatch(/Mutex|Semaphore|async-mutex/i);
  });

  it("no unguarded count-then-insert (count runs inside the advisory-locked transaction)", () => {
    // The lock statement precedes the count in the transaction body.
    const lockIdx = SVC.indexOf("pg_advisory_xact_lock");
    const countIdx = SVC.indexOf("countActiveOrgSessions");
    expect(lockIdx).toBeGreaterThan(-1);
    expect(lockIdx).toBeLessThan(countIdx);
  });

  it("no client-controlled session timestamps (nowMs is optional server input, not from a request body)", () => {
    // The service takes no request/body object; timestamps come from the server clock.
    expect(SVC).not.toMatch(/req\.body|request\.body/);
  });

  it("the live concurrency gate is CONDITIONAL (runIf), not permanently skipped", () => {
    const testSrc = readFileSync(resolve(__dirname, "phase-10-concurrent-session.test.ts"), "utf8");
    // The last-slot race is gated by the canonical live switch, so it executes
    // under RUN_LIVE_INTEGRATION=1 — it is a real deployment gate, not skip-forever.
    expect(testSrc).toMatch(/describe\.runIf\(isLiveIntegrationEnabled\(\)\)/);
    expect(testSrc).not.toMatch(/describe\.skip\(/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §7 test 17 — TRUE concurrent-last-slot race (LIVE Postgres deployment gate).
//
// Runs ONLY when the repo's canonical live-integration switch is on:
//   RUN_LIVE_INTEGRATION=1 TEST_DATABASE_URL=postgres://… \
//     npx vitest run test/phase-10-concurrent-session.test.ts
// Skipped otherwise (Docker/DB not available here) — but NOT permanently: the
// `runIf` below actually executes it under live integration. The advisory-lock
// serialisation cannot be exercised against a stub, so this is the authoritative
// concurrency proof and is a MANDATORY deployment gate.
// ─────────────────────────────────────────────────────────────────────────────
describe.runIf(isLiveIntegrationEnabled())("§2 GATE (live Postgres) — last-slot race", () => {
  it("two concurrent establishments for one remaining slot → exactly one succeeds", async () => {
    const { PrismaClient } = await import("@prisma/client");
    const url = process.env.TEST_DATABASE_URL;
    const prisma = new PrismaClient({ datasourceUrl: url } as never);
    try {
      // Minimal fixtures: a CUSTOMER org with concurrentSessionLimit=2, one
      // active session already holding org context (1 slot remains), and TWO
      // fresh inventory sessions competing for it.
      const org = await prisma.organization.create({ data: { name: "conc-test", kind: "CUSTOMER", status: "ACTIVE" } });
      const user = await prisma.user.create({ data: { provider: "EMAIL", providerUserId: `conc-${org.id}`, email: `conc-${org.id}@x.test` } });
      const team = await prisma.team.create({ data: { name: "ws", isPersonal: false, organizationId: org.id, ownerId: user.id } as never });
      await prisma.organizationSecurityPolicy.create({ data: { teamId: team.id, organizationId: org.id, concurrentSessionLimit: 2 } as never });
      const mkSession = async (hash: string, ctx: string | null) =>
        prisma.authenticatedSession.create({
          data: { userId: user.id, teamId: team.id, sessionIdHash: hash, organizationContextId: ctx, issuedAtUtc: new Date(), expiresAtUtc: new Date(Date.now() + 3600_000) } as never,
        });
      await mkSession("live-existing", org.id); // 1 active in-context → 1 slot left
      await mkSession("live-a", null);
      await mkSession("live-b", null);

      const [a, b] = await Promise.all([
        establishOrganizationSessionContext({ userId: user.id, organizationId: org.id, sessionIdHash: "live-a" }, prisma),
        establishOrganizationSessionContext({ userId: user.id, organizationId: org.id, sessionIdHash: "live-b" }, prisma),
      ]);
      const successes = [a, b].filter((r) => r.allowed).length;
      const denials = [a, b].filter((r) => !r.allowed).length;
      expect(successes).toBe(1); // exactly one won the last slot
      expect(denials).toBe(1);
      const finalCount = await prisma.authenticatedSession.count({
        where: { userId: user.id, organizationContextId: org.id, revokedAtUtc: null, expiresAtUtc: { gt: new Date() } },
      });
      expect(finalCount).toBe(2); // never exceeds the limit
    } finally {
      await prisma.$disconnect();
    }
  });
});
