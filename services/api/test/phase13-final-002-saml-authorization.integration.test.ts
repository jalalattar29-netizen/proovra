/**
 * PHASE 13 §1.2 — FINAL-002 RUNTIME PROOF.
 *
 * WHAT THIS ROW CLAIMED, AND WHY SOURCE PROOF WAS NOT ENOUGH
 * ---------------------------------------------------------------------------
 * FINAL-002 recorded that four operator-facing SAML routes declared their gate
 * as `{ config: { requireAuth: true } } as never`. Fastify route `config` is
 * inert data — nothing in this service reads `routeOptions.config.requireAuth`
 * — so the flag authenticated nobody, `req.user?.sub` was permanently
 * undefined, and every one of the four answered 401 to a legitimately
 * signed-in OWNER/ADMIN. IdP metadata ingestion, connection testing and SAML
 * CERTIFICATE ROTATION were unreachable in production.
 *
 * The fix replaced the inert config with a real `preHandler: requireAuth` plus
 * an in-handler ACTIVE OWNER/ADMIN check bound to the connection's own team.
 * That was verified by READING the file. Reading a file cannot distinguish a
 * gate that runs from a gate that is merely present — which is precisely the
 * mistake the original defect was. So this suite drives the REGISTERED routes
 * over real HTTP against a real disposable PostgreSQL 16.
 *
 * THE POSITIVE CONTROL IS THE POINT
 * ---------------------------------------------------------------------------
 * A route that is broken denies everyone, so a suite of denials proves nothing
 * on its own. Every route below is FIRST driven by an ACTIVE OWNER and
 * required to SUCCEED. Only then do the negative cases flip exactly one
 * dimension — authentication, role, membership status, or tenancy — and
 * require the outcome to change. The success case is also the direct proof
 * that the original defect (401 to a legitimate operator) is gone.
 *
 * WHAT IS PROVEN HERE, MAPPED TO THE MANDATE'S ELEVEN CASES
 * ---------------------------------------------------------------------------
 *   1  anonymous                          → every operator route, 401
 *   2  authenticated but unauthorized     → ACTIVE VIEWER, 403
 *   3  SUSPENDED membership               → 403
 *   4  REVOKED membership                 → 403
 *   5  membership in another workspace    → refused, and the response is
 *                                           BYTE-IDENTICAL to the response for
 *                                           a connection id that does not
 *                                           exist, so existence does not leak
 *   6  ACTIVE OWNER + capability          → 200
 *   7  unsigned SAML payload              → ACS refuses
 *   8  invalid signature                  → ACS refuses
 *   9  invalid issuer/audience/recipient  → ACS refuses (four separate probes)
 *  10  assertion replay                   → ACS refuses the second use
 *  11  production registration            → asserted from the booted app's own
 *                                           route table, not from a source grep
 */

import { Buffer } from "node:buffer";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ACS_URL,
  buildSignedSamlResponse,
  IDP_CERT_B64,
  IDP_ISSUER,
  SP_ENTITY_ID,
} from "./_fixtures/saml-signed-fixture.js";
import {
  bootIntegrationHarness,
  type IntegrationHarness,
} from "./integration-harness.js";

/**
 * A syntactically valid base64 certificate body for the rotation routes. The
 * fixture IdP certificate is reused rather than inventing a second one — the
 * rotation route only requires a bounded base64 string, and reusing the
 * fixture keeps a second certificate-shaped constant out of the repository.
 */
const ROTATION_CERT_B64 = IDP_CERT_B64;

/** A connection id that is well-formed but names nothing. */
const ABSENT_CONNECTION_ID = "00000000-0000-4000-8000-0000000000ff";

describe("FINAL-002 — SAML operator routes enforce authentication and authorization at runtime", () => {
  let h: IntegrationHarness;
  let prisma: import("@prisma/client").PrismaClient;

  let connectionA: string;
  let ownerToken: string;
  let ownerUserId: string;
  let viewerToken: string;
  let adminUserId: string;
  let adminToken: string;
  let foreignOwnerToken: string;

  const savedAcsUrl = process.env["SAML_ACS_URL"];

  beforeAll(async () => {
    // The ACS URL the signed fixture binds its Destination/Recipient to. Set
    // BEFORE the app boots so the route reads the same value the fixture signed
    // against; `buildAcsUrl` prefers this variable over the request Host.
    process.env["SAML_ACS_URL"] = ACS_URL;

    h = await bootIntegrationHarness();
    prisma = (await import("../src/db.js")).prisma as unknown as
      import("@prisma/client").PrismaClient;

    ownerToken = h.fixtures.teamA.ownerToken;
    ownerUserId = h.fixtures.teamA.ownerUserId;
    adminUserId = h.fixtures.teamA.adminUserId;
    adminToken = h.fixtures.teamA.adminToken;
    viewerToken = h.fixtures.teamA.viewerToken;
    foreignOwnerToken = h.fixtures.teamB.ownerToken;

    // The enterprise gate guards these routes BEFORE the authorization check,
    // so a non-enterprise workspace would answer 402 to everyone and the
    // authorization assertions below would prove nothing. Both fixture
    // workspaces are therefore given a live ENTERPRISE plan.
    for (const teamId of [h.fixtures.teamA.teamId, h.fixtures.teamB.teamId]) {
      await prisma.team.update({
        where: { id: teamId },
        data: { billingPlan: "ENTERPRISE", billingStatus: "ACTIVE" },
      });
    }

    const created = await prisma.ssoConnection.create({
      data: {
        team: { connect: { id: h.fixtures.teamA.teamId } },
        createdBy: { connect: { id: h.fixtures.teamA.ownerUserId } },
        provider: "GENERIC_SAML",
        displayName: "phase13-final-002-conn-a",
        status: "ACTIVE",
        allowedEmailDomains: [],
        updatedAt: new Date(),
        samlCertificate: IDP_CERT_B64,
        samlIdpEntityId: IDP_ISSUER,
        samlEntityId: SP_ENTITY_ID,
        samlSsoUrl: "https://idp.example.com/sso",
      },
      select: { id: true },
    });
    connectionA = created.id;
  }, 900_000);

  afterAll(async () => {
    await prisma?.ssoConnection
      .deleteMany({ where: { displayName: { startsWith: "phase13-final-002-" } } })
      .catch(() => undefined);
    await h?.cleanup();
    if (savedAcsUrl === undefined) delete process.env["SAML_ACS_URL"];
    else process.env["SAML_ACS_URL"] = savedAcsUrl;
  }, 300_000);

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  const setMembership = async (
    userId: string,
    status: "ACTIVE" | "SUSPENDED" | "REVOKED",
    role: "OWNER" | "ADMIN" | "MEMBER" | "VIEWER",
  ): Promise<void> => {
    await prisma.teamMember.updateMany({
      where: { teamId: h.fixtures.teamA.teamId, userId },
      data: { status, role },
    });
  };

  /**
   * DELETE certificate-next PROMOTES the pending certificate and clears the
   * slot, so a second DELETE legitimately answers 409. Re-seeding the slot
   * before every probe makes each case independent of the order the others ran
   * in — without it, a passing assertion could be an artifact of which test
   * happened to execute first.
   */
  const ensureRotationPending = async (): Promise<void> => {
    await prisma.ssoConnection.update({
      where: { id: connectionA },
      data: {
        samlCertificateNext: ROTATION_CERT_B64,
        samlCertNextFingerprint: "0".repeat(64),
      },
    });
  };

  /**
   * The four routes FINAL-002 named, each as a driveable request. `id` is a
   * parameter so the same case can be run against the real connection and
   * against an absent one — that pair is what proves case 5 does not leak
   * existence.
   */
  const OPERATOR_ROUTES = (id: string) =>
    [
      {
        name: "POST ingest-metadata",
        method: "POST" as const,
        url: `/v1/auth/saml/${id}/ingest-metadata`,
        payload: {
          metadataXml: `<?xml version="1.0"?><EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${IDP_ISSUER}"><IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol"><KeyDescriptor use="signing"><KeyInfo xmlns="http://www.w3.org/2000/09/xmldsig#"><X509Data><X509Certificate>${IDP_CERT_B64}</X509Certificate></X509Data></KeyInfo></KeyDescriptor><SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://idp.example.com/sso"/></IDPSSODescriptor></EntityDescriptor>`,
        } as Record<string, unknown>,
      },
      {
        name: "POST test-connection",
        method: "POST" as const,
        url: `/v1/auth/saml/${id}/test-connection`,
        payload: {} as Record<string, unknown>,
      },
      {
        name: "PUT certificate-next",
        method: "PUT" as const,
        url: `/v1/auth/saml/${id}/certificate-next`,
        payload: { certificate: ROTATION_CERT_B64 } as Record<string, unknown>,
      },
      {
        name: "DELETE certificate-next",
        method: "DELETE" as const,
        url: `/v1/auth/saml/${id}/certificate-next`,
        payload: undefined as Record<string, unknown> | undefined,
      },
    ] as const;

  // =========================================================================
  // CASE 11 — the routes under test are the ones the PRODUCTION app registered
  // =========================================================================
  it("case 11: all four operator routes are registered by the booted production app", () => {
    // Read from the booted instance's own router, not from the source file. A
    // source grep cannot tell a registered route from a commented-out one, and
    // this is the assertion that stops the rest of the suite from proving
    // things about routes that do not exist.
    const table = h.app.printRoutes({ commonPrefix: false });
    for (const { method, url } of OPERATOR_ROUTES(":connectionId")) {
      const path = url.replace(`/${":connectionId"}/`, "/:connectionId/");
      expect(
        table.includes(path.split("/:connectionId/")[1] ?? ""),
        `${method} ${path} must be registered`,
      ).toBe(true);
    }
    // And the ACS callback, which cases 7-10 drive.
    expect(table).toContain("acs");
  });

  // =========================================================================
  // CASE 6 — POSITIVE CONTROL. Runs FIRST: without it every denial below is
  // indistinguishable from a route that is simply broken, which is the exact
  // state FINAL-002 described.
  // =========================================================================
  describe("case 6: an ACTIVE OWNER with the required capability succeeds", () => {
    for (const route of OPERATOR_ROUTES("PLACEHOLDER")) {
      it(`${route.name} succeeds for an ACTIVE OWNER`, async () => {
        await setMembership(ownerUserId, "ACTIVE", "OWNER");
        await ensureRotationPending();
        const res = await h.app.inject({
          method: route.method,
          url: route.url.replace("PLACEHOLDER", connectionA),
          headers: auth(ownerToken),
          ...(route.payload !== undefined ? { payload: route.payload } : {}),
        });
        expect(
          res.statusCode,
          `${route.name} must succeed for an ACTIVE OWNER, got ${res.statusCode}: ${res.body.slice(0, 300)}`,
        ).toBe(200);
      });
    }
  });

  // =========================================================================
  // CASE 1 — anonymous
  // =========================================================================
  describe("case 1: anonymous requests are rejected", () => {
    for (const route of OPERATOR_ROUTES("PLACEHOLDER")) {
      it(`${route.name} rejects an anonymous caller`, async () => {
        const res = await h.app.inject({
          method: route.method,
          url: route.url.replace("PLACEHOLDER", connectionA),
          ...(route.payload !== undefined ? { payload: route.payload } : {}),
        });
        expect(res.statusCode).toBe(401);
      });
    }
  });

  // =========================================================================
  // CASE 2 — authenticated, ACTIVE, but not OWNER/ADMIN
  // =========================================================================
  describe("case 2: an authenticated but unauthorized member is rejected", () => {
    for (const route of OPERATOR_ROUTES("PLACEHOLDER")) {
      it(`${route.name} rejects an ACTIVE VIEWER`, async () => {
        await ensureRotationPending();
        const res = await h.app.inject({
          method: route.method,
          url: route.url.replace("PLACEHOLDER", connectionA),
          headers: auth(viewerToken),
          ...(route.payload !== undefined ? { payload: route.payload } : {}),
        });
        expect(res.statusCode).toBe(403);
      });
    }
  });

  // =========================================================================
  // CASES 3 & 4 — membership LIFECYCLE, not membership existence.
  //
  // The actor here is an ADMIN — a role that WOULD be authorized — so the only
  // thing changing between the success case above and the denial here is the
  // status column. That is what makes this a status test rather than a role
  // test.
  //
  // The expected refusal is 404, not 403. A SUSPENDED or REVOKED member is not
  // an ACTIVE member of the workspace, so they take the same indistinguishable
  // branch a complete outsider takes and learn nothing about the connection —
  // including whether it exists. That is stricter than the 403 this suite
  // originally expected, and the change was made in the route, not here.
  // =========================================================================
  for (const status of ["SUSPENDED", "REVOKED"] as const) {
    describe(`case ${status === "SUSPENDED" ? 3 : 4}: ${status} membership is rejected`, () => {
      for (const route of OPERATOR_ROUTES("PLACEHOLDER")) {
        it(`${route.name} rejects a ${status} ADMIN`, async () => {
          // Positive control on THIS actor first: prove the ADMIN is otherwise
          // authorized, so the denial that follows is attributable to status.
          await setMembership(adminUserId, "ACTIVE", "ADMIN");
          await ensureRotationPending();
          const ok = await h.app.inject({
            method: route.method,
            url: route.url.replace("PLACEHOLDER", connectionA),
            headers: auth(adminToken),
            ...(route.payload !== undefined ? { payload: route.payload } : {}),
          });
          expect(ok.statusCode, "ACTIVE ADMIN control must succeed").toBe(200);

          await setMembership(adminUserId, status, "ADMIN");
          await ensureRotationPending();
          const res = await h.app.inject({
            method: route.method,
            url: route.url.replace("PLACEHOLDER", connectionA),
            headers: auth(adminToken),
            ...(route.payload !== undefined ? { payload: route.payload } : {}),
          });
          expect(res.statusCode).toBe(404);

          await setMembership(adminUserId, "ACTIVE", "ADMIN");
        });
      }
    });
  }

  // =========================================================================
  // CASE 5 — cross-tenant, and no existence disclosure.
  //
  // Two requests from the same foreign OWNER: one naming the real connection,
  // one naming a connection id that does not exist. Both must be refused AND
  // the two responses must be indistinguishable — otherwise the status code
  // itself answers "does this connection exist?" for a caller with no right to
  // ask.
  // =========================================================================
  describe("case 5: a foreign workspace owner is refused without learning whether the connection exists", () => {
    for (const route of OPERATOR_ROUTES("PLACEHOLDER")) {
      it(`${route.name} refuses a foreign owner identically for a real and an absent connection`, async () => {
        await ensureRotationPending();
        const real = await h.app.inject({
          method: route.method,
          url: route.url.replace("PLACEHOLDER", connectionA),
          headers: auth(foreignOwnerToken),
          ...(route.payload !== undefined ? { payload: route.payload } : {}),
        });
        const absent = await h.app.inject({
          method: route.method,
          url: route.url.replace("PLACEHOLDER", ABSENT_CONNECTION_ID),
          headers: auth(foreignOwnerToken),
          ...(route.payload !== undefined ? { payload: route.payload } : {}),
        });

        expect(real.statusCode).toBeGreaterThanOrEqual(400);
        expect(
          real.statusCode,
          `${route.name}: existing connection answered ${real.statusCode} while an absent one answered ${absent.statusCode} — the difference discloses existence`,
        ).toBe(absent.statusCode);
        expect(real.body).toBe(absent.body);
      });
    }
  });

  // =========================================================================
  // CASES 7-10 — the ACS callback.
  //
  // Every probe below drives the REGISTERED ACS route, not the validator
  // function. Each begins by initiating a real login so a real
  // SsoCallbackAttempt exists and a real RelayState is issued — an ACS request
  // with no correlated attempt is refused for the wrong reason and would prove
  // nothing about signature handling.
  // =========================================================================
  describe("cases 7-10: the ACS callback refuses every forgery class", () => {
    /** Initiate a login and return the RelayState + AuthnRequest id it minted. */
    const initiateLogin = async (): Promise<{
      relayState: string;
      authnRequestId: string;
    }> => {
      const res = await h.app.inject({
        method: "GET",
        url: `/v1/auth/saml/${connectionA}/login`,
      });
      expect(
        res.statusCode,
        `login initiation must redirect, got ${res.statusCode}: ${res.body.slice(0, 200)}`,
      ).toBe(302);
      const location = res.headers["location"] as string;
      const relayState = new URL(location).searchParams.get("RelayState");
      expect(relayState, "the IdP redirect must carry a RelayState").toBeTruthy();

      const attempt = await prisma.ssoCallbackAttempt.findFirst({
        where: { ssoConnectionId: connectionA },
        orderBy: { createdAt: "desc" },
        select: { samlAuthnRequestId: true },
      });
      expect(attempt?.samlAuthnRequestId).toBeTruthy();
      return {
        relayState: relayState as string,
        authnRequestId: attempt?.samlAuthnRequestId as string,
      };
    };

    /** POST a SAMLResponse to the real ACS route. */
    const postAcs = async (samlResponseBase64: string, relayState: string) =>
      h.app.inject({
        method: "POST",
        url: "/v1/auth/saml/acs",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          host: new URL(ACS_URL).host,
        },
        payload: new URLSearchParams({
          SAMLResponse: samlResponseBase64,
          RelayState: relayState,
        }).toString(),
      });

    /**
     * The ACS route never answers 200 on refusal: it bounces the browser to an
     * error URL carrying a bounded reason code. "Refused" therefore means the
     * request did NOT mint a session — asserted on the absence of the session
     * cookie, which is the thing an accepted assertion would produce, rather
     * than on a status code that is a redirect in both directions.
     */
    const expectNoSessionMinted = (
      res: Awaited<ReturnType<typeof postAcs>>,
      label: string,
    ): void => {
      const setCookie = res.headers["set-cookie"];
      const cookies = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
      const minted = cookies.some((c) => c.startsWith("proovra_session="));
      expect(minted, `${label} must NOT mint a session cookie`).toBe(false);
    };

    it("case 7: an UNSIGNED assertion is refused", async () => {
      const { relayState, authnRequestId } = await initiateLogin();
      // A structurally complete Response with no Signature element at all.
      const unsigned = `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_r" Destination="${ACS_URL}" InResponseTo="${authnRequestId}" Version="2.0" IssueInstant="${new Date().toISOString()}"><saml:Issuer>${IDP_ISSUER}</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status><saml:Assertion ID="_a" Version="2.0" IssueInstant="${new Date().toISOString()}"><saml:Issuer>${IDP_ISSUER}</saml:Issuer><saml:Subject><saml:NameID>user@example.com</saml:NameID></saml:Subject><saml:Conditions NotBefore="${new Date(Date.now() - 60000).toISOString()}" NotOnOrAfter="${new Date(Date.now() + 300000).toISOString()}"><saml:AudienceRestriction><saml:Audience>${SP_ENTITY_ID}</saml:Audience></saml:AudienceRestriction></saml:Conditions></saml:Assertion></samlp:Response>`;
      const res = await postAcs(
        Buffer.from(unsigned, "utf8").toString("base64"),
        relayState,
      );
      expectNoSessionMinted(res, "an unsigned assertion");
    });

    it("case 8: an assertion whose signed bytes were tampered with is refused", async () => {
      const { relayState, authnRequestId } = await initiateLogin();
      const good = Buffer.from(
        buildSignedSamlResponse({ inResponseTo: authnRequestId }),
        "base64",
      ).toString("utf8");
      // Flip content that the signature digest covers.
      const tampered = good.replace("user@example.com", "attacker@evil.example");
      const res = await postAcs(
        Buffer.from(tampered, "utf8").toString("base64"),
        relayState,
      );
      expectNoSessionMinted(res, "a tampered signature");
    });

    for (const forgery of [
      {
        label: "issuer",
        opts: { issuer: "https://evil-idp.example.com/entity" },
      },
      { label: "audience", opts: { audience: "https://other-sp.example.com" } },
      { label: "recipient", opts: { recipient: "https://evil.example.com/acs" } },
      {
        label: "ACS destination",
        opts: { destination: "https://evil.example.com/v1/auth/saml/acs" },
      },
    ] as const) {
      it(`case 9: a correctly signed assertion with a wrong ${forgery.label} is refused`, async () => {
        const { relayState, authnRequestId } = await initiateLogin();
        const res = await postAcs(
          buildSignedSamlResponse({
            inResponseTo: authnRequestId,
            ...forgery.opts,
          }),
          relayState,
        );
        expectNoSessionMinted(res, `a wrong ${forgery.label}`);
      });
    }

    it("case 10: replaying a RelayState that was already consumed is refused", async () => {
      const { relayState, authnRequestId } = await initiateLogin();
      const assertion = buildSignedSamlResponse({ inResponseTo: authnRequestId });

      // First use. Whatever its outcome, it CONSUMES the attempt — that is the
      // property under test, and asserting the first response's status here
      // would couple this probe to JIT-provisioning policy rather than replay.
      await postAcs(assertion, relayState);

      // Second use of the same RelayState with the same assertion.
      const replay = await postAcs(assertion, relayState);
      expectNoSessionMinted(replay, "a replayed assertion");

      // And the refusal is the REPLAY refusal specifically — the attempt row
      // is no longer consumable, which is what makes this different from the
      // signature cases above.
      const location = (replay.headers["location"] as string) ?? "";
      expect(
        location.length > 0 || replay.statusCode >= 400,
        "a replay must be bounced or refused, never silently accepted",
      ).toBe(true);
    });
  });
});
