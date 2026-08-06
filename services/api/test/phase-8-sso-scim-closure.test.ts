/**
 * PHASE 8 §11 (2026-07-22) — SSO/SCIM closure behavioral matrix.
 *
 * §11.2 mandatory issuer + mandatory audience (fail-closed) — the two
 * decisions extracted as pure functions so the fail-closed behavior is
 * tested without a signature-valid SAML fixture.
 *
 * The other §11 requirements (repeat-login mapping revalidation §11.1,
 * SCIM-through-orchestrator §11.4, group mapping §11.5, deprovisioning
 * §11.6) are behaviorally covered in p0-tenant-isolation-remediation.test
 * + phase-3-membership-orchestrator.test + phase-scim-user-lifecycle.test;
 * this file adds the §11.2 SAML gates and pins the route wiring.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { vi } from "vitest";

import {
  evaluateSamlAudience,
  samlConnectionRequiresIssuerRemediation,
} from "../src/services/security/saml-assertion.service.js";

describe("Phase 8 §11.2 — mandatory audience (fail closed)", () => {
  const SP = "https://sp.proovra.com/saml/metadata/conn-1";

  it("rejects an assertion with NO AudienceRestriction when audience is required", () => {
    expect(
      evaluateSamlAudience({
        audienceRestriction: [],
        spEntityId: SP,
        requireAudience: true,
      }),
    ).toMatchObject({ ok: false });
  });

  it("accepts a missing AudienceRestriction only when the caller opts out (legacy)", () => {
    expect(
      evaluateSamlAudience({
        audienceRestriction: [],
        spEntityId: SP,
        requireAudience: false,
      }),
    ).toEqual({ ok: true });
  });

  it("rejects when the SP entityID is absent from a declared AudienceRestriction", () => {
    expect(
      evaluateSamlAudience({
        audienceRestriction: ["https://other-sp.example.com"],
        spEntityId: SP,
        requireAudience: true,
      }),
    ).toMatchObject({ ok: false });
  });

  it("accepts when the SP entityID is present in the AudienceRestriction", () => {
    expect(
      evaluateSamlAudience({
        audienceRestriction: [SP, "https://other-sp.example.com"],
        spEntityId: SP,
        requireAudience: true,
      }),
    ).toEqual({ ok: true });
  });
});

describe("Phase 8 §11.2 — mandatory issuer (fail closed + remediation)", () => {
  it("an unpinned connection (no IdP entityID) requires remediation", () => {
    expect(
      samlConnectionRequiresIssuerRemediation({ samlIdpEntityId: null }),
    ).toBe(true);
    expect(
      samlConnectionRequiresIssuerRemediation({ samlIdpEntityId: undefined }),
    ).toBe(true);
  });

  it("a pinned connection does not require remediation", () => {
    expect(
      samlConnectionRequiresIssuerRemediation({
        samlIdpEntityId: "https://idp.example.com/entity",
      }),
    ).toBe(false);
  });
});

const SCIM_H = vi.hoisted(() => ({ sessionsRevoked: [] as unknown[] }));
vi.mock("../src/services/identity-security/session-revocation.service.js", () => ({
  revokeAllSessionsForUser: async (input: unknown) => {
    SCIM_H.sessionsRevoked.push(input);
  },
}));
vi.mock("../src/services/platform-audit-log.service.js", () => ({
  appendPlatformAuditLog: async () => ({}),
}));
vi.mock("../src/services/security/security-event.service.js", () => ({
  safeEmitSecurityEvent: () => {},
}));

describe("Phase 8 §11.6/§11.16 — SCIM deprovisioning end-to-end (behavioral)", () => {
  it("deactivate: suspends membership (frees seat), unlinks mapping, revokes sessions, heals context", async () => {
    const calls: Array<{ op: string; args: unknown[] }> = [];
    const sessionsRevoked = SCIM_H.sessionsRevoked;
    const { scimDeactivateUser } = await import(
      "../src/services/access-control/scim.service.js"
    );

    // PHASE 3 (2026-07-21) — deactivation became ONE atomic composition:
    // suspend + unlink + heal now run inside a single `$transaction` so a
    // failure between them cannot leave a SUSPENDED member still linked. The
    // double therefore has to answer `$transaction` as a real function; it
    // runs the callback against the SAME recording client, which keeps every
    // assertion below (which inspects the recorded calls) meaningful.
    const client: unknown = new Proxy(
      {},
      {
        get(_t, model: string) {
          if (model === "$transaction") {
            return async (arg: unknown) =>
              typeof arg === "function"
                ? await (arg as (tx: unknown) => Promise<unknown>)(client)
                : await Promise.all(arg as Promise<unknown>[]);
          }
          return new Proxy(
            {},
            {
              get(_t2, method: string) {
                return async (...args: unknown[]) => {
                  calls.push({ op: `${model}.${method}`, args: args as unknown[] });
                  if (model === "teamMember" && method === "findUnique")
                    return { id: "m1", role: "MEMBER", status: "ACTIVE" };
                  if (method === "updateMany") return { count: 1 };
                  if (method === "update") return { id: "m1" };
                  if (method === "findFirst" || method === "findUnique")
                    return null;
                  if (method === "findMany") return [];
                  return {};
                };
              },
            },
          );
        },
      },
    );

    const res = await scimDeactivateUser(
      { teamId: "team-1", tokenId: "tok-1", baseUrl: "https://x" } as never,
      "user-1",
      client as never,
    );
    expect(res.ok).toBe(true);

    // Membership suspended via the orchestrator (→ SUSPENDED, not ACTIVE:
    // §12.7 seat is freed because seats count ACTIVE members only).
    const memberUpdate = calls.find(
      (c) => c.op === "teamMember.update" && (c.args[0] as { data?: { status?: string } })?.data?.status === "SUSPENDED",
    );
    expect(memberUpdate).toBeDefined();
    // External IdP mapping soft-unlinked (deprovisioned identity).
    expect(
      calls.some(
        (c) =>
          c.op === "externalIdentityMapping.updateMany" &&
          (c.args[0] as { data: { unlinkedAtUtc: unknown } }).data.unlinkedAtUtc instanceof Date,
      ),
    ).toBe(true);
    // Active-context pointer healed for the deactivated team.
    expect(
      calls.some(
        (c) =>
          c.op === "user.updateMany" &&
          (c.args[0] as { where: { currentWorkspaceId?: string } }).where.currentWorkspaceId === "team-1",
      ),
    ).toBe(true);
    // Sessions revoked with the SCIM_DEACTIVATED reason.
    expect(sessionsRevoked).toContainEqual(
      expect.objectContaining({ userId: "user-1", reason: "SCIM_DEACTIVATED" }),
    );
    // Evidence/audit preserved — deprovisioning NEVER deletes.
    expect(calls.some((c) => /\.(delete|deleteMany)$/.test(c.op))).toBe(false);
    expect(calls.some((c) => c.op.startsWith("evidence."))).toBe(false);
  });
});

describe("Phase 8 §11.2 — SAML route wiring (fail-closed at the caller)", () => {
  const ROUTE = readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "src",
      "routes",
      "saml-auth.routes.ts",
    ),
    "utf8",
  );

  it("unpinned issuer now THROWS (denies) + enters remediation, never proceeds", () => {
    expect(ROUTE).toContain("samlConnectionRequiresIssuerRemediation(conn)");
    expect(ROUTE).toMatch(/throw new SamlAssertionError\(\s*"SAML_ISSUER_UNPINNED"/);
    expect(ROUTE).toMatch(/data:\s*\{\s*status:\s*"PENDING"\s*\}/); // remediation
    // The old fail-open note is gone.
    expect(ROUTE).not.toContain("Login proceeded WITHOUT issuer validation");
  });

  it("validateSamlResponse is called with requireAudience: true", () => {
    expect(ROUTE).toContain("requireAudience: true");
  });
});
