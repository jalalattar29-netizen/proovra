/**
 * P0 REMEDIATION (2026-07-21) — negative tenant-isolation tests.
 *
 * Covers the security-critical behaviors introduced by the domain-
 * architecture remediation:
 *
 *   1. Enterprise account-linking safety (`evaluateExistingAccountLink`):
 *      an IdP/directory-asserted email may be linked to a PRE-EXISTING
 *      User ONLY when the email's domain is DNS-verified by exactly the
 *      connection's own organization. Fail-closed on every other input.
 *   2. SAML JIT linking guard: an unverified-domain assertion for an
 *      EXISTING user's email is rejected (no session, no duplicate user).
 *   3. SCIM create linking guard: same rule for directory pushes (409).
 *   4. SCIM deactivation: revokes all sessions (deny-list ALL_FOR_USER)
 *      and heals a stale `currentWorkspaceId` pointing at the team.
 *   5. Source contracts pinning the fail-closed reviewer resolver, the
 *      capture-trust membership re-check, the switch-route lifecycle +
 *      audit, and the SAML assertion hardening (issuer / multi-assertion
 *      / signature-reference binding / id_token validation).
 *
 * Service tests use a permissive recording fake Prisma (Proxy-based):
 * unspecified model methods resolve to benign defaults so fire-and-forget
 * audit paths never crash the test, while specified handlers drive the
 * scenario and record calls for assertion.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { evaluateExistingAccountLink } from "../src/services/security/enterprise-account-linking.service.js";
import {
  handleSamlAssertion,
} from "../src/services/security/saml-user-mapping.service.js";
import {
  scimCreateUser,
  scimDeactivateUser,
} from "../src/services/access-control/scim.service.js";

const API_ROOT = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(API_ROOT, rel), "utf8");

// ---------------------------------------------------------------------------
// Recording fake Prisma. `handlers` maps "model.method" → impl; everything
// else resolves permissively (create/update return {}, find* return null,
// findMany return [], count returns 0, $transaction runs the callback with
// the same fake).
// ---------------------------------------------------------------------------
type Handler = (args: unknown) => unknown;

function fakePrisma(handlers: Record<string, Handler>) {
  const calls: Array<{ op: string; args: unknown }> = [];
  const client: unknown = new Proxy(
    {},
    {
      get(_t, model: string) {
        if (model === "$transaction") {
          return async (fn: (tx: unknown) => unknown) =>
            typeof fn === "function" ? fn(client) : undefined;
        }
        // Raw helpers ($executeRaw, $queryRaw, …) — benign async no-ops so
        // fire-and-forget audit paths (advisory locks, hash chains) never
        // crash the scenario under test.
        if (model.startsWith("$")) {
          return async () => [];
        }
        return new Proxy(
          {},
          {
            get(_t2, method: string) {
              return async (args: unknown) => {
                const op = `${model}.${String(method)}`;
                calls.push({ op, args });
                const h = handlers[op];
                if (h) return h(args);
                const m = String(method);
                if (m.startsWith("findMany") || m === "groupBy") return [];
                if (m.startsWith("find")) return null;
                if (m === "count") return 0;
                if (m === "updateMany" || m === "deleteMany")
                  return { count: 0 };
                return {};
              };
            },
          },
        );
      },
    },
  );
  return { client: client as never, calls };
}

const TEAM_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_ORG = "33333333-3333-4333-8333-333333333333";
const USER_ID = "44444444-4444-4444-8444-444444444444";

// ---------------------------------------------------------------------------
// 1. evaluateExistingAccountLink — canonical linking policy
// ---------------------------------------------------------------------------

describe("P0 — evaluateExistingAccountLink (fail-closed linking policy)", () => {
  const baseHandlers = (claims: Array<{ organizationId: string }>) => ({
    "team.findUnique": () => ({ organizationId: ORG_ID }),
    "organizationDomain.findMany": () => claims,
  });

  it("allows linking only when exactly our org holds the verified domain", async () => {
    const { client } = fakePrisma(baseHandlers([{ organizationId: ORG_ID }]));
    const res = await evaluateExistingAccountLink(
      { teamId: TEAM_ID, email: "jalal@company.com" },
      client,
    );
    expect(res).toEqual({
      ok: true,
      organizationId: ORG_ID,
      domain: "company.com",
    });
  });

  it("denies when the domain is not verified for the connection's org", async () => {
    const { client } = fakePrisma(baseHandlers([]));
    const res = await evaluateExistingAccountLink(
      { teamId: TEAM_ID, email: "victim@othercompany.com" },
      client,
    );
    expect(res).toEqual({ ok: false, reason: "domain_not_verified_for_org" });
  });

  it("denies when ANOTHER org also verified the same domain (claim conflict)", async () => {
    const { client } = fakePrisma(
      baseHandlers([
        { organizationId: ORG_ID },
        { organizationId: OTHER_ORG },
      ]),
    );
    const res = await evaluateExistingAccountLink(
      { teamId: TEAM_ID, email: "jalal@company.com" },
      client,
    );
    expect(res).toEqual({ ok: false, reason: "domain_claim_conflict" });
  });

  it("denies when only a FOREIGN org verified the domain", async () => {
    const { client } = fakePrisma(
      baseHandlers([{ organizationId: OTHER_ORG }]),
    );
    const res = await evaluateExistingAccountLink(
      { teamId: TEAM_ID, email: "victim@company.com" },
      client,
    );
    expect(res).toEqual({ ok: false, reason: "domain_not_verified_for_org" });
  });

  it("fails closed on invalid email and unknown workspace", async () => {
    const { client } = fakePrisma(baseHandlers([{ organizationId: ORG_ID }]));
    expect(
      await evaluateExistingAccountLink(
        { teamId: TEAM_ID, email: "not-an-email" },
        client,
      ),
    ).toEqual({ ok: false, reason: "email_invalid" });

    const { client: noTeam } = fakePrisma({
      "team.findUnique": () => null,
      "organizationDomain.findMany": () => [{ organizationId: ORG_ID }],
    });
    expect(
      await evaluateExistingAccountLink(
        { teamId: TEAM_ID, email: "a@company.com" },
        noTeam,
      ),
    ).toEqual({ ok: false, reason: "workspace_not_found" });
  });
});

// ---------------------------------------------------------------------------
// 2. SAML JIT — linking to an existing user requires the verified domain
// ---------------------------------------------------------------------------

function samlAssertionFor(email: string) {
  return {
    nameId: email,
    nameIdFormat: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
    nameIdHash: "hash",
    sessionIndex: null,
    inResponseTo: null,
    issuer: "https://idp.example.com",
    attributes: {},
    authnContextClassRef: null,
    notBefore: null,
    notOnOrAfter: null,
    audienceRestriction: [],
  } as never;
}

describe("P0 — SAML JIT existing-account link guard", () => {
  const commonHandlers = {
    "externalIdentityMapping.findUnique": () => null,
    "user.findFirst": () => ({ id: USER_ID }),
    "team.findUnique": () => ({ organizationId: ORG_ID }),
  };

  it("rejects linking an EXISTING user when the domain is not verified (no duplicate created)", async () => {
    const { client, calls } = fakePrisma({
      ...commonHandlers,
      "organizationDomain.findMany": () => [],
    });
    await expect(
      handleSamlAssertion(
        {
          teamId: TEAM_ID,
          connectionId: "conn-1",
          provider: "GENERIC_SAML" as never,
          assertion: samlAssertionFor("Victim@OtherCompany.com"),
          attributeMapping: null,
          allowedEmailDomains: [],
          jitDefaultRole: "MEMBER",
          scimManaged: false,
        } as never,
        client,
      ),
    ).rejects.toMatchObject({ code: "SAML_ACCOUNT_LINK_DENIED" });
    // Fail closed — never fall through to creating a duplicate user or a
    // membership for the attacker workspace.
    expect(calls.some((c) => c.op === "user.create")).toBe(false);
    expect(calls.some((c) => c.op === "teamMember.upsert")).toBe(false);
  });

  it("links the existing user when exactly our org verified the domain", async () => {
    const { client, calls } = fakePrisma({
      ...commonHandlers,
      "organizationDomain.findMany": () => [{ organizationId: ORG_ID }],
    });
    const result = await handleSamlAssertion(
      {
        teamId: TEAM_ID,
        connectionId: "conn-1",
        provider: "GENERIC_SAML" as never,
        assertion: samlAssertionFor("Jalal@Company.com"),
        attributeMapping: null,
        allowedEmailDomains: [],
        jitDefaultRole: "MEMBER",
        scimManaged: false,
      } as never,
      client,
    );
    expect((result as { userId: string }).userId).toBe(USER_ID);
    // Email normalized to lowercase before lookup (duplicate-generator fix).
    const lookup = calls.find((c) => c.op === "user.findFirst");
    expect(
      (lookup?.args as { where: { email: string } }).where.email,
    ).toBe("jalal@company.com");
    expect(calls.some((c) => c.op === "user.create")).toBe(false);
    expect(calls.some((c) => c.op === "teamMember.upsert")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2b. PHASE 8 §11.1 — repeat login re-validates the stored mapping and
//     quarantines any that no longer satisfies the connection policy.
// ---------------------------------------------------------------------------

describe("Phase 8 §11.1 — repeat-login mapping revalidation", () => {
  const OTHER_TEAM = "99999999-9999-4999-8999-999999999999";

  it("quarantines + denies a mapping whose team does not match the connection", async () => {
    const { client, calls } = fakePrisma({
      // Existing mapping is bound to a DIFFERENT team than this login.
      "externalIdentityMapping.findUnique": () => ({
        id: "map-1",
        userId: USER_ID,
        teamId: OTHER_TEAM,
        unlinkedAtUtc: null,
      }),
      "team.findUnique": () => ({ organizationId: ORG_ID }),
    });
    await expect(
      handleSamlAssertion(
        {
          teamId: TEAM_ID,
          connectionId: "conn-1",
          provider: "GENERIC_SAML" as never,
          assertion: samlAssertionFor("jalal@company.com"),
          attributeMapping: null,
          allowedEmailDomains: [],
          jitDefaultRole: "MEMBER",
          scimManaged: false,
        } as never,
        client,
      ),
    ).rejects.toMatchObject({ code: "SAML_ACCOUNT_LINK_DENIED" });
    // The bad mapping is soft-unlinked (quarantined) so it can never
    // authorize again, and no session/membership is granted.
    const quarantine = calls.find(
      (c) => c.op === "externalIdentityMapping.update",
    );
    expect(quarantine).toBeDefined();
    expect(
      (quarantine?.args as { data: { unlinkedAtUtc: unknown } }).data
        .unlinkedAtUtc,
    ).toBeInstanceOf(Date);
    expect(calls.some((c) => c.op === "teamMember.upsert")).toBe(false);
  });

  it("denies an already-quarantined mapping without re-authorizing", async () => {
    const { client } = fakePrisma({
      "externalIdentityMapping.findUnique": () => ({
        id: "map-1",
        userId: USER_ID,
        teamId: TEAM_ID,
        unlinkedAtUtc: new Date("2026-01-01"),
      }),
      "team.findUnique": () => ({ organizationId: ORG_ID }),
    });
    await expect(
      handleSamlAssertion(
        {
          teamId: TEAM_ID,
          connectionId: "conn-1",
          provider: "GENERIC_SAML" as never,
          assertion: samlAssertionFor("jalal@company.com"),
          attributeMapping: null,
          allowedEmailDomains: [],
          jitDefaultRole: "MEMBER",
          scimManaged: false,
        } as never,
        client,
      ),
    ).rejects.toMatchObject({ code: "SAML_ACCOUNT_LINK_DENIED" });
  });

  it("allows a valid same-team mapping (repeat login succeeds)", async () => {
    const { client } = fakePrisma({
      "externalIdentityMapping.findUnique": () => ({
        id: "map-1",
        userId: USER_ID,
        teamId: TEAM_ID,
        unlinkedAtUtc: null,
      }),
      "team.findUnique": () => ({ organizationId: ORG_ID }),
    });
    const result = await handleSamlAssertion(
      {
        teamId: TEAM_ID,
        connectionId: "conn-1",
        provider: "GENERIC_SAML" as never,
        assertion: samlAssertionFor("jalal@company.com"),
        attributeMapping: null,
        allowedEmailDomains: [],
        jitDefaultRole: "MEMBER",
        scimManaged: false,
      } as never,
      client,
    );
    expect((result as { userId: string }).userId).toBe(USER_ID);
  });
});

// ---------------------------------------------------------------------------
// 3. SCIM create — same linking rule for directory pushes
// ---------------------------------------------------------------------------

describe("P0 — SCIM create existing-account link guard", () => {
  const scimUser = {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
    userName: "victim@othercompany.com",
    emails: [{ value: "victim@othercompany.com", primary: true }],
    active: true,
  };

  it("returns 409 unsafe_account_link when the domain is not exclusively verified", async () => {
    const { client, calls } = fakePrisma({
      "externalIdentityMapping.findFirst": () => null,
      "user.findFirst": () => ({
        id: USER_ID,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
      "team.findUnique": () => ({ organizationId: ORG_ID }),
      "organizationDomain.findMany": () => [],
    });
    const res = await scimCreateUser(
      { teamId: TEAM_ID, tokenId: "tok-1", baseUrl: "https://x" } as never,
      scimUser as never,
      client,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(409);
      expect(res.detail).toBe("unsafe_account_link");
    }
    expect(calls.some((c) => c.op === "externalIdentityMapping.create")).toBe(
      false,
    );
    expect(calls.some((c) => c.op === "teamMember.upsert")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. SCIM deactivate — session revocation + active-context healing
// ---------------------------------------------------------------------------

describe("P0 — SCIM deactivation revokes sessions and heals context", () => {
  it("writes an ALL_FOR_USER deny-list row and clears a stale currentWorkspaceId", async () => {
    const { client, calls } = fakePrisma({
      "teamMember.findUnique": () => ({ id: "member-1", status: "ACTIVE" }),
    });
    const res = await scimDeactivateUser(
      { teamId: TEAM_ID, tokenId: "tok-1", baseUrl: "https://x" } as never,
      USER_ID,
      client,
    );
    expect(res.ok).toBe(true);

    const suspend = calls.find((c) => c.op === "teamMember.update");
    expect(
      (suspend?.args as { data: { status: string } }).data.status,
    ).toBe("SUSPENDED");

    const revoke = calls.find((c) => c.op === "revokedSession.create");
    expect(revoke).toBeTruthy();
    const revokeData = (revoke?.args as {
      data: { scope: string; userId: string; reason: string };
    }).data;
    expect(revokeData.userId).toBe(USER_ID);
    expect(revokeData.reason).toBe("SCIM_DEACTIVATED");

    const heal = calls.find((c) => c.op === "user.updateMany");
    expect(
      (heal?.args as {
        where: { id: string; currentWorkspaceId: string };
      }).where,
    ).toEqual({ id: USER_ID, currentWorkspaceId: TEAM_ID });
  });
});

// ---------------------------------------------------------------------------
// 5. Source contracts — fail-closed guards pinned at the code level
// ---------------------------------------------------------------------------

describe("P0 — source contracts for fail-closed tenant guards", () => {
  it("reviewer resolveTeam fails closed on missing ACTIVE membership (incl. platform admins)", () => {
    const src = read("src/routes/reviewer-workspace.routes.ts");
    expect(src).toMatch(/status:\s*"ACTIVE"/);
    expect(src).toMatch(/if \(!membership\) \{[\s\S]{0,200}NOT_PERMITTED/);
    // The old non-member context shape is gone.
    expect(src).not.toMatch(/workspaceRole:\s*\(membership\?\.role \?\? null\)/);
    // The undefined-user platform-admin coercion is gone.
    expect(src).not.toMatch(/user\?\.platformRole !== null/);
  });

  it("capture-trust re-checks ACTIVE membership on the currentWorkspaceId pointer", () => {
    const src = read("src/routes/capture-trust.routes.ts");
    expect(src).toMatch(
      /teamMember\.findUnique[\s\S]{0,200}teamId: team\.id, userId/,
    );
    expect(src).toMatch(/membership\?\.status !== "ACTIVE"/);
  });

  it("switch-workspace enforces org lifecycle and audits every attempt", () => {
    const src = read("src/routes/platform-context.routes.ts");
    expect(src).toMatch(/organization: \{ select: \{ status: true \} \}/);
    expect(src).toMatch(/organization_unavailable/);
    expect(src).toMatch(/workspace_context_switched/);
    expect(src).toMatch(/previousWorkspaceId/);
  });

  it("platform-context envelope excludes workspaces of non-ACTIVE organizations", () => {
    const src = read(
      "src/services/platform-context/platform-context.service.ts",
    );
    expect(src).toMatch(
      /m\.team\.organization[\s\S]{0,80}status !== "ACTIVE"[\s\S]{0,40}continue/,
    );
  });

  it("SAML assertion hardening: multi-assertion reject + reference binding + issuer pin", () => {
    const src = read("src/services/security/saml-assertion.service.ts");
    expect(src).toMatch(/SAML_MULTIPLE_ASSERTIONS/);
    expect(src).toMatch(/SAML_SIGNATURE_NOT_BOUND/);
    expect(src).toMatch(/SAML_ISSUER_MISMATCH/);
    expect(src).toMatch(/expectedIdpEntityId/);
  });

  it("OIDC callback validates the id_token (JWKS, issuer, audience, nonce, sub match)", () => {
    const src = read("src/services/access-control/sso.service.ts");
    expect(src).toMatch(/jwtVerify\(/);
    expect(src).toMatch(/issuer: discovery\.issuer/);
    expect(src).toMatch(/audience: conn\.clientId/);
    expect(src).toMatch(/payload\.nonce !== stateRecord\.nonce/);
    expect(src).toMatch(/userinfo\.sub !== idTokenSub/);
    expect(src).toMatch(/SSO_ACCOUNT_LINK_DENIED/);
  });

  it("admin org-member removal revokes workspace access, heals context, revokes sessions", () => {
    const src = read("src/routes/organizations.routes.ts");
    const removal = src.slice(
      src.indexOf('"/v1/orgs/:id/members/:memberId"'),
      src.indexOf("POST /v1/orgs/:id/leave"),
    );
    // PHASE 3: workspace off-board goes through the canonical mass
    // revocation (REVOKED + provenance closed) — same semantics.
    expect(removal).toMatch(/massRevokeWorkspaceMemberships/);
    expect(removal).toMatch(/currentWorkspaceId: \{ in: orgTeamIds \}/);
    expect(removal).toMatch(/ORG_MEMBER_REMOVED/);
    expect(removal).toMatch(/revokeAllSessionsForUser/);
  });
});
