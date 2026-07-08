/**
 * PHASE 3 (Blocker 2) — Admin SAML SP signing + verified-domain policy CRUD.
 *
 * Behavioural + source-contract coverage for the admin-identity policy update
 * path added on top of the existing Identity Provider surface.
 *
 * We drive `updateSsoConnectionPolicy` against a FAKE prisma client and stub
 * the audit / security-event / metrics side-effect modules with `vi.mock` so
 * we can assert on exactly what is (and is NOT) persisted, logged, or audited.
 *
 * Hard security assertions:
 *   - The private key is ACCEPTED for storage but the returned projection
 *     NEVER contains any key field — only status + SHA-256 fingerprint.
 *   - Neither the security-event details nor the audit metadata ever carry
 *     the key/cert VALUES — field NAMES only.
 *   - Enabling restrictToVerifiedDomains with ZERO verified domains is
 *     rejected (SSO_NO_VERIFIED_DOMAINS); with a verified domain it succeeds.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { generateKeyPairSync } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Stub the side-effect modules BEFORE importing the service under test.
// ---------------------------------------------------------------------------
const auditCalls: Array<Record<string, unknown>> = [];
const securityEventCalls: Array<Record<string, unknown>> = [];

vi.mock("../src/services/platform-audit-log.service.js", () => ({
  appendPlatformAuditLog: vi.fn(async (args: Record<string, unknown>) => {
    auditCalls.push(args);
  }),
}));
vi.mock("../src/services/security/security-event.service.js", () => ({
  safeEmitSecurityEvent: vi.fn((args: Record<string, unknown>) => {
    securityEventCalls.push(args);
  }),
}));
vi.mock("../src/services/ops/metrics.service.js", () => ({
  bump: vi.fn(),
}));

import {
  updateSsoConnectionPolicy,
  SsoServiceError,
} from "../src/services/access-control/sso.service.js";

// ---------------------------------------------------------------------------
// Fake prisma client — only the methods the update path touches.
// ---------------------------------------------------------------------------
type FakeRow = Record<string, unknown>;

function makeRow(overrides: FakeRow = {}): FakeRow {
  const now = new Date("2026-01-01T00:00:00.000Z");
  return {
    id: "11111111-1111-1111-1111-111111111111",
    teamId: "22222222-2222-2222-2222-222222222222",
    provider: "GENERIC_SAML",
    displayName: "Acme SAML",
    status: "ACTIVE",
    issuerUrl: null,
    clientId: null,
    clientSecretHash: null,
    clientSecretPreview: null,
    allowedEmailDomains: [],
    jitDefaultRole: null,
    notes: null,
    createdByUserId: "33333333-3333-3333-3333-333333333333",
    createdAt: now,
    updatedAt: now,
    lastUsedAtUtc: null,
    rotatedAtUtc: null,
    revokedAtUtc: null,
    revokedByUserId: null,
    samlSignRequests: false,
    samlSpPrivateKey: null,
    samlSpCertificate: null,
    restrictToVerifiedDomains: false,
    ...overrides,
  };
}

function makeFakeClient(opts: {
  row: FakeRow | null;
  organizationId?: string | null;
  verifiedDomainCount?: number;
}) {
  let current = opts.row;
  const updateData: FakeRow[] = [];
  const client = {
    ssoConnection: {
      findFirst: vi.fn(async () => current),
      update: vi.fn(async ({ data }: { data: FakeRow }) => {
        updateData.push(data);
        current = { ...(current as FakeRow), ...data };
        return current;
      }),
    },
    team: {
      findUnique: vi.fn(async () => ({
        organizationId: opts.organizationId ?? "org-1",
      })),
    },
    organizationDomain: {
      count: vi.fn(async () => opts.verifiedDomainCount ?? 0),
    },
    __updateData: updateData,
  };
  return client;
}

function pem(): string {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}

const ACTOR = "44444444-4444-4444-4444-444444444444";

beforeEach(() => {
  auditCalls.length = 0;
  securityEventCalls.length = 0;
});

// =============================================================================
// Group A — projection NEVER exposes key material
// =============================================================================
describe("Phase 3 CRUD — projection never returns the private key", () => {
  it("returns status + fingerprint but no key field after storing a key", async () => {
    const key = pem();
    const client = makeFakeClient({ row: makeRow(), verifiedDomainCount: 0 });
    const projection = await updateSsoConnectionPolicy(
      {
        teamId: "22222222-2222-2222-2222-222222222222",
        id: "11111111-1111-1111-1111-111111111111",
        actorUserId: ACTOR,
        samlSignRequests: true,
        samlSpPrivateKey: key,
      },
      client as never,
    );

    // No key field of ANY name may appear in the projection.
    const json = JSON.stringify(projection);
    expect(json).not.toContain("PRIVATE KEY");
    expect(json).not.toContain(key.slice(0, 40));
    expect(Object.keys(projection)).not.toContain("samlSpPrivateKey");

    // But status + fingerprint ARE surfaced.
    expect(projection.samlSignRequests).toBe(true);
    expect(projection.samlSpKeyConfigured).toBe(true);
    expect(projection.samlSpKeyFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(projection.samlSpSigningKeySource).toBe("stored");
  });

  it("stamps rotatedAtUtc when a new key is installed", async () => {
    const client = makeFakeClient({ row: makeRow() });
    await updateSsoConnectionPolicy(
      {
        teamId: "22222222-2222-2222-2222-222222222222",
        id: "11111111-1111-1111-1111-111111111111",
        actorUserId: ACTOR,
        samlSpPrivateKey: pem(),
      },
      client as never,
    );
    expect(client.__updateData[0]).toHaveProperty("rotatedAtUtc");
  });

  it("rejects a non-PEM private key with SSO_INVALID_SP_KEY", async () => {
    const client = makeFakeClient({ row: makeRow() });
    await expect(
      updateSsoConnectionPolicy(
        {
          teamId: "22222222-2222-2222-2222-222222222222",
          id: "11111111-1111-1111-1111-111111111111",
          actorUserId: ACTOR,
          samlSpPrivateKey: "not-a-key",
        },
        client as never,
      ),
    ).rejects.toMatchObject({ code: "SSO_INVALID_SP_KEY" });
  });
});

// =============================================================================
// Group B — verified-domain guard
// =============================================================================
describe("Phase 3 CRUD — restrictToVerifiedDomains guard", () => {
  it("rejects enabling restriction when the org has ZERO verified domains", async () => {
    const client = makeFakeClient({ row: makeRow(), verifiedDomainCount: 0 });
    await expect(
      updateSsoConnectionPolicy(
        {
          teamId: "22222222-2222-2222-2222-222222222222",
          id: "11111111-1111-1111-1111-111111111111",
          actorUserId: ACTOR,
          restrictToVerifiedDomains: true,
        },
        client as never,
      ),
    ).rejects.toBeInstanceOf(SsoServiceError);
    // No update was persisted.
    expect(client.ssoConnection.update).not.toHaveBeenCalled();
  });

  it("allows enabling restriction when a verified domain exists", async () => {
    const client = makeFakeClient({ row: makeRow(), verifiedDomainCount: 1 });
    const projection = await updateSsoConnectionPolicy(
      {
        teamId: "22222222-2222-2222-2222-222222222222",
        id: "11111111-1111-1111-1111-111111111111",
        actorUserId: ACTOR,
        restrictToVerifiedDomains: true,
      },
      client as never,
    );
    expect(projection.restrictToVerifiedDomains).toBe(true);
  });

  it("allows DISABLING restriction regardless of verified-domain count", async () => {
    const client = makeFakeClient({
      row: makeRow({ restrictToVerifiedDomains: true }),
      verifiedDomainCount: 0,
    });
    const projection = await updateSsoConnectionPolicy(
      {
        teamId: "22222222-2222-2222-2222-222222222222",
        id: "11111111-1111-1111-1111-111111111111",
        actorUserId: ACTOR,
        restrictToVerifiedDomains: false,
      },
      client as never,
    );
    expect(projection.restrictToVerifiedDomains).toBe(false);
  });
});

// =============================================================================
// Group C — audit + security-event never carry key material
// =============================================================================
describe("Phase 3 CRUD — audit/security-event carry field NAMES only", () => {
  it("logs a policy_update audit event with changed field names and no key/cert values", async () => {
    const key = pem();
    const cert = "MIID-fake-base64-cert-value";
    const client = makeFakeClient({ row: makeRow(), verifiedDomainCount: 1 });
    await updateSsoConnectionPolicy(
      {
        teamId: "22222222-2222-2222-2222-222222222222",
        id: "11111111-1111-1111-1111-111111111111",
        actorUserId: ACTOR,
        samlSignRequests: true,
        samlSpPrivateKey: key,
        samlSpCertificate: cert,
      },
      client as never,
    );

    expect(auditCalls).toHaveLength(1);
    const audit = auditCalls[0]!;
    expect(audit.action).toBe("sso.connection.policy_update");
    // Assert on the audit PAYLOAD (action + metadata) — NOT the injected `db`
    // handle, which is the test's fake client and is never serialized by the
    // real audit writer.
    const auditPayload = JSON.stringify({
      action: audit.action,
      resourceType: audit.resourceType,
      resourceId: audit.resourceId,
      metadata: audit.metadata,
    });
    expect(auditPayload).not.toContain("PRIVATE KEY");
    expect(auditPayload).not.toContain(key.slice(0, 40));
    expect(auditPayload).not.toContain(cert);
    // Field NAMES are present.
    expect(auditPayload).toContain("samlSignRequests");
    expect(auditPayload).toContain("samlSpPrivateKey:rotated");

    // Same guarantee for the security event.
    expect(securityEventCalls).toHaveLength(1);
    const evtJson = JSON.stringify(securityEventCalls[0]);
    expect(evtJson).not.toContain("PRIVATE KEY");
    expect(evtJson).not.toContain(cert);
  });

  it("does not audit when nothing changed", async () => {
    const client = makeFakeClient({ row: makeRow() });
    await updateSsoConnectionPolicy(
      {
        teamId: "22222222-2222-2222-2222-222222222222",
        id: "11111111-1111-1111-1111-111111111111",
        actorUserId: ACTOR,
      },
      client as never,
    );
    expect(auditCalls).toHaveLength(0);
    expect(client.ssoConnection.update).not.toHaveBeenCalled();
  });

  it("rejects updates against a REVOKED connection", async () => {
    const client = makeFakeClient({ row: makeRow({ status: "REVOKED" }) });
    await expect(
      updateSsoConnectionPolicy(
        {
          teamId: "22222222-2222-2222-2222-222222222222",
          id: "11111111-1111-1111-1111-111111111111",
          actorUserId: ACTOR,
          samlSignRequests: true,
        },
        client as never,
      ),
    ).rejects.toMatchObject({ code: "SSO_INVALID_STATE" });
  });
});

// =============================================================================
// Group D — route wiring + step-up + auth (source contract)
// =============================================================================
function readApi(rel: string): string {
  return readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");
}
const ADMIN_ROUTES = readApi("src/routes/admin-identity.routes.ts");
const SSO_SERVICE = readApi("src/services/access-control/sso.service.ts");
const PROVIDERS_PAGE = readFileSync(
  fileURLToPath(
    new URL(
      "../../../apps/web/app/(app)/admin/identity/providers/page.tsx",
      import.meta.url,
    ),
  ),
  "utf8",
);

describe("Phase 3 CRUD — route + UI wiring", () => {
  it("exposes the policy endpoint on the existing provider surface", () => {
    expect(ADMIN_ROUTES).toMatch(
      /\/v1\/admin\/identity\/providers\/:id\/policy/,
    );
    expect(ADMIN_ROUTES).toMatch(/updateSsoConnectionPolicy/);
  });

  it("requires the identity manage permission for the policy endpoint", () => {
    expect(ADMIN_ROUTES).toMatch(/identity\.external_mapping\.manage/);
  });

  it("reuses the EXISTING identity-provider step-up purpose (no new purpose)", () => {
    // The policy route reuses EXTERNAL_IDENTITY_LINK — the same purpose the
    // provider create path uses. It must NOT invent a new purpose.
    const policyBlock = ADMIN_ROUTES.slice(
      ADMIN_ROUTES.indexOf("/policy"),
      ADMIN_ROUTES.indexOf("/policy") + 2000,
    );
    expect(policyBlock).toMatch(/EXTERNAL_IDENTITY_LINK/);
    expect(policyBlock).toMatch(/requireStepUpForSensitiveAction/);
  });

  it("the GET providers list surfaces the verified-domain count for UI gating", () => {
    expect(ADMIN_ROUTES).toMatch(/verifiedDomainCount/);
    expect(ADMIN_ROUTES).toMatch(/verifiedAt:\s*\{\s*not:\s*null\s*\}/);
  });

  it("the service projection never selects/returns samlSpPrivateKey to the caller", () => {
    // The projection maps ONLY status + fingerprint fields; the key string is
    // dropped. There must be no `samlSpPrivateKey: row.samlSpPrivateKey` echo.
    expect(SSO_SERVICE).not.toMatch(/samlSpPrivateKey:\s*row\.samlSpPrivateKey/);
    expect(SSO_SERVICE).toMatch(/samlSpKeyFingerprint/);
    expect(SSO_SERVICE).toMatch(/fingerprintSpKey/);
  });

  it("the providers page wires step-up + posts to the policy endpoint (write-only key)", () => {
    expect(PROVIDERS_PAGE).toMatch(/useStepUpAction/);
    expect(PROVIDERS_PAGE).toMatch(/StepUpModal/);
    expect(PROVIDERS_PAGE).toMatch(/providers\/\$\{encodeURIComponent\(id\)\}\/policy/);
    // The page never renders a key back — no state field named for the stored key.
    expect(PROVIDERS_PAGE).not.toMatch(/samlSpKeyFingerprint.*value=/);
  });

  it("the providers page gates the restrict toggle when no verified domain exists", () => {
    expect(PROVIDERS_PAGE).toMatch(/verifiedDomainCount/);
    expect(PROVIDERS_PAGE).toMatch(/noVerifiedDomains/);
  });
});
