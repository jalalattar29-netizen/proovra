/**
 * PHASE 11 — authenticated post-login destination safety.
 *
 * Every authenticated redirect destination (SAML RelayState / OIDC state
 * `redirectAfter` / post-login "next") flows through the ONE canonical
 * destination-safety authority — never a raw URL:
 *
 *   - PERSIST-time gate: persistCallbackAttempt / persistSamlCallbackAttempt
 *     reject an unsafe `redirectAfter` via the shared `isSafeRedirectAfter`
 *     BEFORE the state row is written (open redirect can never be stored).
 *   - USE-time gate: the route composes `safeIntendedDestination` when it
 *     turns the persisted destination into an actual redirect (defense in
 *     depth — a tampered value neutralises to "/").
 *   - Cross-session RelayState replay is denied by the EXISTING durable
 *     replay mechanism (consumeCallbackAttempt → REPLAYED); this asserts it,
 *     it does not rebuild it.
 *
 * This is a behavioral test: the REAL hardening-service functions execute
 * against an in-memory prisma double (no DB); only leaf side-effect modules
 * (metrics / security-event / secret / incident / audit / db) are stubbed so
 * the run is hermetic.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { safeIntendedDestination } from "@proovra/shared";

// --- leaf stubs (keep the run hermetic; the SUT logic is untouched) ---------
vi.mock("../src/db.js", () => ({ prisma: {} }));
vi.mock("../src/config/index.js", () => ({
  // Constant secret → hashStateToken is deterministic, so the same raw state
  // hashes identically across calls (required for replay detection).
  resolveSecret: () => "phase11-auth-destination-safety-test-secret",
}));
vi.mock("../src/services/ops/metrics.service.js", () => ({
  bump: () => {},
  setGauge: () => {},
}));
const emittedSecurityEvents: Array<{ eventType: string }> = [];
vi.mock("../src/services/security/security-event.service.js", () => ({
  safeEmitSecurityEvent: (e: { eventType: string }) => {
    emittedSecurityEvents.push(e);
  },
}));
vi.mock("../src/services/observability/incident.service.js", () => ({
  recordIncident: async () => {},
}));
vi.mock("../src/services/audit/tenant-audit.service.js", () => ({
  emitTenantAudit: async () => {},
}));

import {
  persistCallbackAttempt,
  persistSamlCallbackAttempt,
  consumeCallbackAttempt,
} from "../src/services/access-control/sso-hardening.service.js";

// --- in-memory prisma double for ssoCallbackAttempt -------------------------
function makeClient() {
  const rowsById = new Map<string, Record<string, unknown>>();
  const idByStateHash = new Map<string, string>();
  let seq = 0;
  return {
    ssoCallbackAttempt: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const id = `attempt-${++seq}`;
        const row = { id, ...data };
        rowsById.set(id, row);
        idByStateHash.set(String(data.stateHash), id);
        return { ...row };
      },
      findUnique: async ({ where }: { where: { stateHash?: string; id?: string } }) => {
        if (where.stateHash) {
          const id = idByStateHash.get(where.stateHash);
          return id ? { ...rowsById.get(id) } : null;
        }
        if (where.id) return rowsById.get(where.id) ? { ...rowsById.get(where.id) } : null;
        return null;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = rowsById.get(where.id);
        if (!row) throw new Error("row_not_found");
        Object.assign(row, data);
        return { ...row };
      },
      // PHASE 12B — the single-use claim is a state-PRECONDITIONED updateMany,
      // so exactly one concurrent writer can match. The double reproduces that
      // precondition (it does NOT blanket-assign), which is what makes the
      // replay assertions below meaningful rather than tautological.
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: string; status?: string };
        data: Record<string, unknown>;
      }) => {
        const row = rowsById.get(where.id);
        if (!row) return { count: 0 };
        if (where.status !== undefined && row.status !== where.status) {
          return { count: 0 };
        }
        Object.assign(row, data);
        return { count: 1 };
      },
      count: async () =>
        [...rowsById.values()].filter((r) => r.status === "PENDING").length,
    },
  } as never;
}

const BASE = {
  teamId: "team-1",
  ssoConnectionId: "conn-1",
  ipPreview: null,
  uaPreview: null,
};

beforeEach(() => {
  emittedSecurityEvents.length = 0;
});
afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// (b) A valid INTERNAL destination survives persist + on-use validation.
// ---------------------------------------------------------------------------
describe("Phase 11 — valid internal destination survives", () => {
  it("OIDC state: a relative in-app path persists and round-trips unchanged", async () => {
    const client = makeClient();
    const persist = await persistCallbackAttempt(
      { ...BASE, stateRaw: "state-ok", nonceRaw: "nonce-ok", redirectAfter: "/evidence/ev-1" },
      client,
    );
    expect(persist.ok).toBe(true);

    const consume = await consumeCallbackAttempt({ stateRaw: "state-ok" }, client);
    expect(consume.ok).toBe(true);
    if (!consume.ok) throw new Error("unreachable");
    expect(consume.attempt.redirectAfter).toBe("/evidence/ev-1");

    // USE-time authority the route composes — a safe internal path is preserved.
    expect(safeIntendedDestination(consume.attempt.redirectAfter)).toBe("/evidence/ev-1");
  });

  it("SAML RelayState: a relative in-app path persists", async () => {
    const client = makeClient();
    const persist = await persistSamlCallbackAttempt(
      {
        ...BASE,
        relayStateRaw: "relay-ok",
        samlAuthnRequestId: "authn-1",
        redirectAfter: "/cases/case-9",
      },
      client,
    );
    expect(persist.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (a) An external / open-redirect destination is rejected AND neutralized.
// ---------------------------------------------------------------------------
describe("Phase 11 — external open-redirect is rejected + neutralized", () => {
  it("OIDC state: an absolute external URL is rejected at persist (never stored)", async () => {
    const client = makeClient();
    const persist = await persistCallbackAttempt(
      {
        ...BASE,
        stateRaw: "state-evil",
        nonceRaw: "nonce-evil",
        redirectAfter: "https://evil.example/steal",
      },
      client,
    );
    expect(persist.ok).toBe(false);
    if (persist.ok) throw new Error("unreachable");
    expect(persist.reason).toBe("INVALID_REDIRECT");
    // Nothing was persisted, so a later consume cannot resurrect it.
    expect(await consumeCallbackAttempt({ stateRaw: "state-evil" }, client)).toMatchObject({
      ok: false,
      reason: "NOT_FOUND",
    });
  });

  it("SAML RelayState: an absolute external URL is rejected at persist", async () => {
    const client = makeClient();
    const persist = await persistSamlCallbackAttempt(
      {
        ...BASE,
        relayStateRaw: "relay-evil",
        samlAuthnRequestId: "authn-2",
        redirectAfter: "https://evil.example/steal",
      },
      client,
    );
    expect(persist).toMatchObject({ ok: false, reason: "INVALID_REDIRECT" });
  });

  it("USE-time authority neutralizes an external URL to '/'", () => {
    // Defense in depth: even if an external value reached the redirect helper,
    // the canonical authority the route composes collapses it to a safe root.
    expect(safeIntendedDestination("https://evil.example/steal")).toBe("/");
    expect(safeIntendedDestination("javascript:alert(1)")).toBe("/");
  });
});

// ---------------------------------------------------------------------------
// (c) A protocol-relative "//evil.com" destination is rejected.
// ---------------------------------------------------------------------------
describe("Phase 11 — protocol-relative destination is rejected", () => {
  it("OIDC state: '//evil.com' is rejected at persist", async () => {
    const client = makeClient();
    const persist = await persistCallbackAttempt(
      { ...BASE, stateRaw: "state-pr", nonceRaw: "nonce-pr", redirectAfter: "//evil.com" },
      client,
    );
    expect(persist).toMatchObject({ ok: false, reason: "INVALID_REDIRECT" });
  });

  it("SAML RelayState: '//evil.com/path' is rejected at persist", async () => {
    const client = makeClient();
    const persist = await persistSamlCallbackAttempt(
      {
        ...BASE,
        relayStateRaw: "relay-pr",
        samlAuthnRequestId: "authn-3",
        redirectAfter: "//evil.com/path",
      },
      client,
    );
    expect(persist).toMatchObject({ ok: false, reason: "INVALID_REDIRECT" });
  });

  it("USE-time authority neutralizes '//evil.com' to '/'", () => {
    expect(safeIntendedDestination("//evil.com")).toBe("/");
  });
});

// ---------------------------------------------------------------------------
// (d) Cross-session RelayState replay is denied by the EXISTING mechanism.
// ---------------------------------------------------------------------------
describe("Phase 11 — cross-session RelayState replay is denied", () => {
  it("a second consume of the same RelayState → REPLAYED (not a fresh session)", async () => {
    const client = makeClient();
    const persist = await persistSamlCallbackAttempt(
      {
        ...BASE,
        relayStateRaw: "relay-replay",
        samlAuthnRequestId: "authn-4",
        redirectAfter: "/home",
      },
      client,
    );
    expect(persist.ok).toBe(true);

    // First consume (the legitimate ACS callback) succeeds exactly once.
    const first = await consumeCallbackAttempt({ stateRaw: "relay-replay" }, client);
    expect(first.ok).toBe(true);

    // Replaying the SAME RelayState (attacker / stale tab) is denied and the
    // durable row is flagged REPLAYED — no second session can be minted.
    const second = await consumeCallbackAttempt({ stateRaw: "relay-replay" }, client);
    expect(second).toMatchObject({ ok: false, reason: "REPLAYED" });
    expect(
      emittedSecurityEvents.some((e) => e.eventType === "sso_callback_replay_detected"),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Adoption guard — the auth routes COMPOSE the canonical authority (they do
// not hand a raw URL to reply.redirect). Pins the convergence so a regression
// that reintroduces a raw redirect destination fails here.
// ---------------------------------------------------------------------------
describe("Phase 11 — auth routes compose the canonical destination authority", () => {
  const read = (rel: string) =>
    readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

  for (const rel of [
    "../src/routes/sso-auth.routes.ts",
    "../src/routes/saml-auth.routes.ts",
  ]) {
    it(`${rel} routes every post-login destination through safeIntendedDestination`, () => {
      const src = read(rel);
      expect(src).toMatch(/safeIntendedDestination/);
      // The post-login redirect is built from the persisted attempt, run
      // through the canonical helper — never reply.redirect(rawRedirectAfter).
      expect(src).toMatch(/resolvePostLoginDestination\(attempt\.redirectAfter\)/);
      expect(src).not.toMatch(/redirect\(\s*attempt\.redirectAfter\s*\)/);
    });
  }
});
