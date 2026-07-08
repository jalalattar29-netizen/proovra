/**
 * Phase 3 (Enterprise Identity) — Org session-timeout POLICY enforcement.
 *
 * REPAIR verification. The OrganizationSecurityPolicy row has stored
 * `reviewerSessionTimeoutSeconds` / `contributorSessionTimeoutSeconds`
 * since Phase 17, but they were READ-ONLY (enforcement deferred). These
 * tests lock the newly-connected enforcement:
 *
 *   PART 1 — pure decision helpers (shared, browser-safe):
 *     - role → applicable timeout mapping (reviewer vs contributor tier)
 *     - a session older than the role timeout → expired (absolute)
 *     - an idle session past the role timeout → expired (idle)
 *     - within timeout → allowed
 *     - null timeout → never expired (JWT exp still caps)
 *
 *   PART 2 — enforcement service (services/api), with a mock Prisma:
 *     - reviewer-tier member over the reviewer timeout → expire
 *     - within timeout → allow
 *     - FAIL SAFE: policy lookup throws → allow (degraded), NOT locked out
 *     - personal-space (teamId null) → allow (no-op)
 *     - viewer maps to the contributor timeout
 *     - a policy expiry writes the `session_expired_by_policy` audit event
 *
 *   PART 3 — middleware wiring (source contract):
 *     - requireAuth calls enforceSessionTimeoutPolicy
 *     - it returns a 401 with a session_expired reason on expire
 *     - revocation is still checked and still fails closed
 *     - the external reviewer portal session model is NOT touched by
 *       this enforcement (isolation).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  evaluateSessionTimeout,
  resolveSessionTimeoutSecondsForRole,
} from "@proovra/shared";

import { enforceSessionTimeoutPolicy } from "../src/services/identity-security/session-timeout-policy.service.js";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

const HOUR = 3600;

// =============================================================================
// PART 1 — pure decision helpers
// =============================================================================

describe("Phase 3 — resolveSessionTimeoutSecondsForRole (role → tier)", () => {
  const policy = {
    reviewerSessionTimeoutSeconds: 8 * HOUR,
    contributorSessionTimeoutSeconds: 1 * HOUR,
  };

  it("OWNER / ADMIN / MEMBER map to the reviewer (staff) tier", () => {
    expect(resolveSessionTimeoutSecondsForRole("OWNER", policy)).toBe(8 * HOUR);
    expect(resolveSessionTimeoutSecondsForRole("ADMIN", policy)).toBe(8 * HOUR);
    expect(resolveSessionTimeoutSecondsForRole("MEMBER", policy)).toBe(8 * HOUR);
  });

  it("VIEWER maps to the contributor (limited) tier", () => {
    expect(resolveSessionTimeoutSecondsForRole("VIEWER", policy)).toBe(1 * HOUR);
  });

  it("null timeout for the applicable tier ⇒ no constraint (null)", () => {
    expect(
      resolveSessionTimeoutSecondsForRole("MEMBER", {
        reviewerSessionTimeoutSeconds: null,
        contributorSessionTimeoutSeconds: 1 * HOUR,
      }),
    ).toBeNull();
  });

  it("unknown / null role fails toward the TIGHTER tier, never the longer", () => {
    // Both present → the smaller of the two.
    expect(resolveSessionTimeoutSecondsForRole(null, policy)).toBe(1 * HOUR);
    // Only reviewer present → that one (no longer-granting default).
    expect(
      resolveSessionTimeoutSecondsForRole(null, {
        reviewerSessionTimeoutSeconds: 8 * HOUR,
        contributorSessionTimeoutSeconds: null,
      }),
    ).toBe(8 * HOUR);
  });

  it("non-positive / non-finite timeouts normalise to null (disabled)", () => {
    expect(
      resolveSessionTimeoutSecondsForRole("MEMBER", {
        reviewerSessionTimeoutSeconds: 0,
        contributorSessionTimeoutSeconds: -5,
      }),
    ).toBeNull();
  });
});

describe("Phase 3 — evaluateSessionTimeout (age + idle decision)", () => {
  const policy = {
    reviewerSessionTimeoutSeconds: 8 * HOUR,
    contributorSessionTimeoutSeconds: 1 * HOUR,
  };
  const now = 1_000_000_000_000; // fixed ms epoch

  it("an IDLE session past the role timeout → expired (idle)", () => {
    const issuedAtMs = now - 2 * HOUR * 1000; // young session
    const d = evaluateSessionTimeout({
      role: "VIEWER", // contributor cap 1h
      policy,
      issuedAtMs,
      lastSeenAtMs: now - (1 * HOUR + 300) * 1000, // idle 65m > 60m
      nowMs: now,
    });
    expect(d.expired).toBe(true);
    expect(d.reason).toBe("idle");
    expect(d.appliedTimeoutSeconds).toBe(1 * HOUR);
  });

  it("no last-seen anchor → idle measured from issuance, reason `absolute`", () => {
    const issuedAtMs = now - 9 * HOUR * 1000; // 9h old, reviewer cap 8h
    const d = evaluateSessionTimeout({
      role: "MEMBER",
      policy,
      issuedAtMs,
      lastSeenAtMs: null, // no heartbeat recorded yet
      nowMs: now,
    });
    expect(d.expired).toBe(true);
    expect(d.reason).toBe("absolute");
    expect(d.appliedTimeoutSeconds).toBe(8 * HOUR);
  });

  it("recently active but OLD session → NOT expired (idle is the check)", () => {
    // 9h old but seen 1 minute ago → within the 8h idle window.
    const issuedAtMs = now - 9 * HOUR * 1000;
    const d = evaluateSessionTimeout({
      role: "MEMBER",
      policy,
      issuedAtMs,
      lastSeenAtMs: now - 60 * 1000,
      nowMs: now,
    });
    expect(d.expired).toBe(false);
    expect(d.reason).toBeNull();
  });

  it("WITHIN the timeout (idle under) → allowed", () => {
    const issuedAtMs = now - 30 * 60 * 1000; // 30m old
    const d = evaluateSessionTimeout({
      role: "MEMBER",
      policy,
      issuedAtMs,
      lastSeenAtMs: now - 5 * 60 * 1000, // idle 5m
      nowMs: now,
    });
    expect(d.expired).toBe(false);
    expect(d.reason).toBeNull();
  });

  it("null resolved timeout ⇒ never expired (JWT exp still caps)", () => {
    const issuedAtMs = now - 40 * HOUR * 1000; // ancient
    const d = evaluateSessionTimeout({
      role: "MEMBER",
      policy: {
        reviewerSessionTimeoutSeconds: null,
        contributorSessionTimeoutSeconds: null,
      },
      issuedAtMs,
      lastSeenAtMs: now - 40 * HOUR * 1000,
      nowMs: now,
    });
    expect(d.expired).toBe(false);
    expect(d.appliedTimeoutSeconds).toBeNull();
  });
});

// =============================================================================
// PART 2 — enforcement service (mock Prisma)
// =============================================================================

type MockClient = {
  organizationSecurityPolicy: { findUnique: ReturnType<typeof vi.fn> };
  teamMember: { findUnique: ReturnType<typeof vi.fn> };
  // audit/security-event writers — best-effort in the service, stubbed here.
  securityEvent: { create: ReturnType<typeof vi.fn> };
  platformAuditLog?: { create: ReturnType<typeof vi.fn> };
};

function makeClient(over: Partial<MockClient> = {}): MockClient {
  return {
    organizationSecurityPolicy: { findUnique: vi.fn() },
    teamMember: { findUnique: vi.fn() },
    securityEvent: { create: vi.fn().mockResolvedValue({ id: "evt_1" }) },
    ...over,
  };
}

const TEAM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const NOW = 1_700_000_000_000;

describe("Phase 3 — enforceSessionTimeoutPolicy (service, mock prisma)", () => {
  let client: MockClient;
  beforeEach(() => {
    client = makeClient();
  });

  it("reviewer-tier member idle PAST the reviewer timeout → expire", async () => {
    client.organizationSecurityPolicy.findUnique.mockResolvedValue({
      reviewerSessionTimeoutSeconds: 4 * HOUR,
      contributorSessionTimeoutSeconds: 1 * HOUR,
    });
    client.teamMember.findUnique.mockResolvedValue({ role: "MEMBER" });
    const res = await enforceSessionTimeoutPolicy(
      {
        userId: USER,
        teamId: TEAM,
        iat: Math.floor((NOW - 6 * HOUR * 1000) / 1000),
        lastSeenAtMs: NOW - 5 * HOUR * 1000, // idle 5h > 4h
        nowMs: NOW,
      },
      client as never,
    );
    expect(res.action).toBe("expire");
    if (res.action === "expire") {
      expect(res.reason).toBe("idle");
      expect(res.appliedTimeoutSeconds).toBe(4 * HOUR);
      expect(res.role).toBe("MEMBER");
    }
  });

  it("WITHIN timeout → allow (not degraded)", async () => {
    client.organizationSecurityPolicy.findUnique.mockResolvedValue({
      reviewerSessionTimeoutSeconds: 8 * HOUR,
      contributorSessionTimeoutSeconds: 1 * HOUR,
    });
    client.teamMember.findUnique.mockResolvedValue({ role: "ADMIN" });
    const res = await enforceSessionTimeoutPolicy(
      {
        userId: USER,
        teamId: TEAM,
        iat: Math.floor((NOW - 30 * 60 * 1000) / 1000),
        lastSeenAtMs: NOW - 60 * 1000,
        nowMs: NOW,
      },
      client as never,
    );
    expect(res.action).toBe("allow");
    if (res.action === "allow") expect(res.degraded).toBe(false);
  });

  it("FAIL SAFE — policy lookup throws → allow (degraded), NOT locked out", async () => {
    client.organizationSecurityPolicy.findUnique.mockRejectedValue(
      new Error("prisma down"),
    );
    client.teamMember.findUnique.mockResolvedValue({ role: "MEMBER" });
    const res = await enforceSessionTimeoutPolicy(
      {
        userId: USER,
        teamId: TEAM,
        iat: Math.floor((NOW - 999 * HOUR * 1000) / 1000), // absurdly old
        lastSeenAtMs: NOW - 999 * HOUR * 1000,
        nowMs: NOW,
      },
      client as never,
    );
    expect(res.action).toBe("allow");
    if (res.action === "allow") expect(res.degraded).toBe(true);
  });

  it("personal-space session (teamId null) → allow, no lookups", async () => {
    const res = await enforceSessionTimeoutPolicy(
      {
        userId: USER,
        teamId: null,
        iat: Math.floor((NOW - 999 * HOUR * 1000) / 1000),
        lastSeenAtMs: NOW - 999 * HOUR * 1000,
        nowMs: NOW,
      },
      client as never,
    );
    expect(res.action).toBe("allow");
    expect(client.organizationSecurityPolicy.findUnique).not.toHaveBeenCalled();
    expect(client.teamMember.findUnique).not.toHaveBeenCalled();
  });

  it("VIEWER is governed by the CONTRIBUTOR timeout (tier isolation)", async () => {
    client.organizationSecurityPolicy.findUnique.mockResolvedValue({
      reviewerSessionTimeoutSeconds: 8 * HOUR, // long
      contributorSessionTimeoutSeconds: 1 * HOUR, // short
    });
    client.teamMember.findUnique.mockResolvedValue({ role: "VIEWER" });
    const res = await enforceSessionTimeoutPolicy(
      {
        userId: USER,
        teamId: TEAM,
        iat: Math.floor((NOW - 3 * HOUR * 1000) / 1000),
        lastSeenAtMs: NOW - 2 * HOUR * 1000, // idle 2h > contributor 1h
        nowMs: NOW,
      },
      client as never,
    );
    expect(res.action).toBe("expire");
    if (res.action === "expire") expect(res.appliedTimeoutSeconds).toBe(1 * HOUR);
  });

  it("a policy expiry writes the session_expired_by_policy security event", async () => {
    client.organizationSecurityPolicy.findUnique.mockResolvedValue({
      reviewerSessionTimeoutSeconds: 1 * HOUR,
      contributorSessionTimeoutSeconds: 1 * HOUR,
    });
    client.teamMember.findUnique.mockResolvedValue({ role: "MEMBER" });
    await enforceSessionTimeoutPolicy(
      {
        userId: USER,
        teamId: TEAM,
        iat: Math.floor((NOW - 5 * HOUR * 1000) / 1000),
        lastSeenAtMs: NOW - 3 * HOUR * 1000, // idle 3h > 1h
        nowMs: NOW,
      },
      client as never,
    );
    // safeEmitSecurityEvent is fire-and-forget; let the microtask flush.
    await new Promise((r) => setTimeout(r, 0));
    expect(client.securityEvent.create).toHaveBeenCalled();
    const arg = client.securityEvent.create.mock.calls[0]?.[0];
    expect(arg?.data?.eventType).toBe("session_expired_by_policy");
    expect(arg?.data?.teamId).toBe(TEAM);
  });
});

// =============================================================================
// PART 3 — middleware wiring + isolation (source contract)
// =============================================================================

describe("Phase 3 — requireAuth wiring (source contract)", () => {
  const MIDDLEWARE = readSource("../src/middleware/auth.ts");

  it("imports + calls enforceSessionTimeoutPolicy", () => {
    expect(MIDDLEWARE).toMatch(/session-timeout-policy\.service/);
    expect(MIDDLEWARE).toMatch(/enforceSessionTimeoutPolicy\(/);
  });

  it("returns a 401 with a session_expired reason on expire", () => {
    expect(MIDDLEWARE).toMatch(/timeout\.action === "expire"/);
    expect(MIDDLEWARE).toMatch(/session_expired/);
    // 401 status via TOKEN_EXPIRED (maps to 401 in errors.ts).
    expect(MIDDLEWARE).toMatch(/TOKEN_EXPIRED/);
  });

  it("still checks revocation and still fails CLOSED on revocation errors", () => {
    // The revocation block must remain: reject when revoked, and reject
    // when the deny-list read itself fails (fail closed).
    expect(MIDDLEWARE).toMatch(/isSessionRevoked/);
    expect(MIDDLEWARE).toMatch(/auth\.revocation_check_failed/);
  });

  it("timeout enforcement is scoped to sessions carrying a sid", () => {
    // Enforcement lives inside the `if (sid) {` block so teamless /
    // sidless tokens are a no-op — the external portal never reaches it.
    const sidBlock = MIDDLEWARE.slice(MIDDLEWARE.indexOf("if (sid) {"));
    expect(sidBlock).toMatch(/enforceSessionTimeoutPolicy/);
  });
});

describe("Phase 3 — external reviewer portal isolation", () => {
  const PORTAL_SESSION = readSource(
    "../src/services/external-review/portal-session.service.ts",
  );
  const TIMEOUT_SERVICE = readSource(
    "../src/services/identity-security/session-timeout-policy.service.ts",
  );

  it("the portal session service does NOT import the internal timeout policy", () => {
    expect(PORTAL_SESSION).not.toMatch(/session-timeout-policy/);
    expect(PORTAL_SESSION).not.toMatch(/enforceSessionTimeoutPolicy/);
  });

  it("the portal keeps its OWN independent caps (not the org policy)", () => {
    // Portal enforces its own inactivity + max-session caps — unaffected.
    expect(PORTAL_SESSION).toMatch(/EXTERNAL_PORTAL_INACTIVITY_TIMEOUT_MS/);
    expect(PORTAL_SESSION).toMatch(/EXTERNAL_PORTAL_MAX_SESSION_MS/);
  });

  it("the internal timeout service documents portal isolation as a hard rule", () => {
    expect(TIMEOUT_SERVICE).toMatch(/portal/i);
    expect(TIMEOUT_SERVICE).toMatch(/AUTHENTICATED INTERNAL SESSIONS ONLY/);
  });
});
