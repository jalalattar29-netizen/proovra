/**
 * B5B-F-302 — the provenance rule that decides whether an Organization may link
 * (and its provisioning may convert) an EXISTING account, and the signed
 * pending-link ticket the owner's consent consumes.
 *
 * A verified domain proves control of an ADDRESS, not authorship of an ACCOUNT:
 * only an account this Organization's own directory or IdP created is the
 * Organization's. Everything else — an EMAIL account whose provider id is its
 * own address, a Google/Apple account, another Organization's directory row, a
 * legacy synthetic id this Organization did not mint — is a pre-existing
 * self-serve account.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/config/runtime-secrets.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getSecret: (name: string) => (name === "AUTH_JWT_SECRET" ? "test-secret-b5b-f-302" : undefined),
}));

import {
  isSelfServeAccountForOrganization,
  resolveAccountOriginForOrganization,
} from "../src/services/security/enterprise-account-linking.service.js";
import {
  ORGANIZATION_LINK_TTL_SECONDS,
  signOrganizationLinkTicket,
  verifyOrganizationLinkTicket,
  type PendingOrganizationLink,
} from "../src/services/identity/organization-link-consent.service.js";

const ORG = "6f1c2a4e-0b7d-4c55-9a3e-2d8f1b0c9e11";
const OTHER_ORG = "0a9b8c7d-6e5f-4a3b-8c1d-0e2f3a4b5c6d";
const CREATED = new Date("2026-01-01T00:00:00Z");

function client(user: { providerUserId: string; email: string | null; provider?: string } | null, mapping?: { linkedAtUtc: Date } | null) {
  return {
    user: { findUnique: async () => (user ? { ...user, createdAt: CREATED } : null) },
    externalIdentityMapping: { findFirst: async () => mapping ?? null },
  } as never;
}

const origin = (c: never) => resolveAccountOriginForOrganization({ userId: "u1", organizationId: ORG }, c);

describe("B5B-F-302 — account provenance for an Organization", () => {
  it("an account THIS Organization's SCIM / OIDC JIT / SAML JIT created is the Organization's", async () => {
    for (const kind of ["scim", "sso", "saml"] as const) {
      expect(await origin(client({ providerUserId: `${kind}-${ORG}:sub-1`, email: "a@corp.example" }))).toEqual({
        kind: "ORGANIZATION_ORIGINATED",
        via: kind,
        legacy: false,
      });
    }
  });

  it("a self-serve EMAIL account (provider id = its own address) is self-serve — whatever the address starts with", async () => {
    expect(await origin(client({ providerUserId: "alice@corp.example", email: "alice@corp.example" }))).toEqual({ kind: "SELF_SERVE" });
    // An address that LOOKS synthetic is still the person's own address.
    expect(
      await origin(client({ providerUserId: `scim-${ORG}:x@corp.example`, email: `scim-${ORG}:x@corp.example` })),
    ).toEqual({ kind: "SELF_SERVE" });
  });

  it("a Google / Apple account is self-serve", async () => {
    expect(await origin(client({ providerUserId: "108234987234", email: "a@corp.example", provider: "GOOGLE" }))).toEqual({ kind: "SELF_SERVE" });
  });

  it("ANOTHER Organization's directory row is not this Organization's", async () => {
    expect(await origin(client({ providerUserId: `scim-${OTHER_ORG}:sub-1`, email: "a@corp.example" }))).toEqual({ kind: "SELF_SERVE" });
  });

  it("a legacy (pre-DOM-13) synthetic id counts only with the mapping that minted it, written with the account", async () => {
    const legacy = { providerUserId: "scim-legacy-sub", email: "a@corp.example" };
    expect(await origin(client(legacy, { linkedAtUtc: new Date(CREATED.getTime() + 1000) }))).toEqual({
      kind: "ORGANIZATION_ORIGINATED",
      via: "scim",
      legacy: true,
    });
    // No mapping for that subject here → not ours.
    expect(await origin(client(legacy, null))).toEqual({ kind: "SELF_SERVE" });
    // A mapping made long after the account existed is a later LINK, not the creation.
    expect(
      await origin(client(legacy, { linkedAtUtc: new Date(CREATED.getTime() + 24 * 60 * 60 * 1000) })),
    ).toEqual({ kind: "SELF_SERVE" });
  });

  it("isSelfServeAccountForOrganization fails closed: unreadable provenance is never the Organization's", async () => {
    expect(await isSelfServeAccountForOrganization({ userId: "u1", organizationId: ORG }, client(null))).toBe(true);
    expect(
      await isSelfServeAccountForOrganization(
        { userId: "u1", organizationId: ORG },
        client({ providerUserId: `sso-${ORG}:s`, email: "a@corp.example" }),
      ),
    ).toBe(false);
  });
});

describe("B5B-F-302 — the pending organization-link ticket", () => {
  const pending: PendingOrganizationLink = {
    connectionId: "c1",
    organizationId: ORG,
    teamId: "t1",
    provider: "GENERIC_OIDC",
    protocol: "OIDC",
    subject: "sub-1",
    email: "alice@corp.example",
    displayName: null,
    userId: "u1",
    role: "MEMBER",
    organizationName: "Corp",
    organizationRestrictsPersonalSpace: false,
  };

  it("round-trips what the IdP proved", () => {
    expect(verifyOrganizationLinkTicket(signOrganizationLinkTicket(pending))).toEqual(pending);
  });

  it("refuses a forged, altered, expired or JWT-shaped ticket", () => {
    const t = signOrganizationLinkTicket(pending);
    const [payload, sig] = t.split(".") as [string, string];
    const altered = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url").toString("utf8")), userId: "attacker" }),
    ).toString("base64url");
    expect(verifyOrganizationLinkTicket(`${altered}.${sig}`)).toBeNull();
    expect(verifyOrganizationLinkTicket(`${payload}.${sig.slice(0, -2)}xx`)).toBeNull();
    expect(verifyOrganizationLinkTicket(`a.${payload}.${sig}`)).toBeNull();
    const now = Math.floor(Date.now() / 1000);
    expect(verifyOrganizationLinkTicket(signOrganizationLinkTicket(pending, now - ORGANIZATION_LINK_TTL_SECONDS - 1), now)).toBeNull();
    expect(verifyOrganizationLinkTicket(undefined)).toBeNull();
  });
});
