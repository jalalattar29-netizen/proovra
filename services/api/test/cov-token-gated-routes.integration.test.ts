/**
 * THE TOKEN-GATED GET ROUTES THE TENANT SWEEP NEVER EXERCISED.
 *
 *   API key    GET /v1/integrations/api/evidence, /evidence/:id, /evidence-requests/:id
 *   SCIM       GET /v2/scim/Users, /Users/:id, /Groups, /Groups/:id
 *   Capability GET /v1/external-intake/:token,
 *                  /v1/external-review/access/:token/context,
 *                  /v1/external-review/access/:token/verification-package
 *
 * (The four portal-session GETs are in cov-external-reviewer.integration.test.ts.)
 *
 * Tokens are minted through their real routes with a real step-up. Each route gets a
 * real token of the right kind on its own tenant, then the same token against the
 * other tenant's real resource, then a revoked or expired token, a token of the wrong
 * kind or scope, and a plain session. FIXTURE (labelled): expiry is reached by moving
 * the stored timestamp, since no test can wait for one.
 */
import { createHash, randomUUID } from "node:crypto";

import { PutObjectCommand } from "@aws-sdk/client-s3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import { coverageKit, type CoverageKit, type Injected } from "./support/coverage-actors.js";
import { customerKit, type Customer } from "./support/coverage-customer.js";
import { createStepUpCeremony } from "./support/step-up-ceremony.js";

type Prisma = import("@prisma/client").PrismaClient;

const SCIM_GROUP = "urn:ietf:params:scim:schemas:core:2.0:Group";

describe("token-gated GET routes (live PostgreSQL, MinIO)", () => {
  let h: IntegrationHarness;
  let prisma: Prisma;
  let kit: CoverageKit;
  let stepUp: ReturnType<typeof createStepUpCeremony>;
  let a: Customer;
  let b: Customer;

  const session = () => ({ token: a.owner.token });
  const bearer = (token: string) => ({ token });

  async function apiKey(c: Customer, scopes: string[]) {
    const header = await stepUp.approvedHeader({
      token: c.owner.token,
      userId: c.owner.userId,
      teamId: c.workspaceId,
      purpose: "INTEGRATION_API_KEY_CREATE",
      resourceKind: "team",
      resourceId: c.workspaceId,
    });
    const res = await kit.call(
      "POST",
      "/v1/integrations/api-keys",
      { token: c.owner.token },
      { teamId: c.workspaceId, name: `key ${kit.tag()}`, scopes },
      header,
    );
    expect(res.statusCode, res.body).toBe(201);
    return { id: res.json().apiKey.id as string, raw: res.json().rawKey as string };
  }

  async function scimToken(c: Customer, scopes: string[]) {
    const header = await stepUp.approvedHeader({
      token: c.owner.token,
      userId: c.owner.userId,
      teamId: c.workspaceId,
      purpose: "EXTERNAL_IDENTITY_LINK",
      resourceKind: "scim_token",
    });
    const res = await kit.call(
      "POST",
      "/v1/admin/identity/scim/tokens",
      { token: c.owner.token },
      { teamId: c.workspaceId, name: `scim ${kit.tag()}`, scopes },
      header,
    );
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json();
    return { id: body.projection.id as string, raw: body.tokenOnce as string };
  }

  async function record(c: Customer, title: string, over: Record<string, unknown> = {}) {
    return (
      await prisma.evidence.create({
        data: {
          title,
          type: "PHOTO",
          status: "SIGNED",
          teamId: c.workspaceId,
          organizationId: c.orgId,
          ownerUserId: c.owner.userId,
          ...over,
        } as never,
        select: { id: true },
      })
    ).id;
  }

  async function restrictedCase(c: Customer) {
    return (
      await prisma.case.create({
        data: { name: `Restricted ${kit.tag()}`, teamId: c.workspaceId, ownerUserId: c.owner.userId, restrictedAtUtc: new Date() } as never,
        select: { id: true },
      })
    ).id;
  }

  const expectInvalidKey = (res: Injected) => {
    expect(res.statusCode, res.body).toBe(401);
    expect(res.json()).toMatchObject({ error: { code: "UNAUTHORIZED" } });
  };

  beforeAll(async () => {
    process.env.INTEGRATIONS_ENABLED = "true";
    process.env.API_KEY_SECRET = "integration-only-api-key-secret-0123456789abcdef";
    process.env.WORKFLOW_INTAKE_LINKS_ENABLED = "true";
    process.env.WORKFLOW_INTAKE_TOKEN_SECRET =
      process.env.WORKFLOW_INTAKE_TOKEN_SECRET ?? "integration-only-intake-secret-0123456789abcdef";
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    prisma = (await import("../src/db.js")).prisma as unknown as Prisma;
    kit = await coverageKit(h);
    stepUp = createStepUpCeremony({ prisma, inject: h.app.inject.bind(h.app) as never });
    const customers = await customerKit(h, prisma);
    a = await customers.customer();
    b = await customers.customer();
  }, 900_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  // ===========================================================================
  // API key
  // ===========================================================================
  describe("API key routes", () => {
    const READ = ["integration.evidence.read", "integration.evidence_request.read", "integration.evidence_request.create"];
    let keyA: { id: string; raw: string };
    let keyB: { id: string; raw: string };
    let evidenceA: string;
    let evidenceB: string;
    let hiddenEvidence: string;
    let requestA: string;
    let requestB: string;
    let hiddenCase: string;

    const newRequest = async (raw: string, over: Record<string, unknown> = {}) => {
      const res = await kit.call("POST", "/v1/integrations/api/evidence-requests", bearer(raw), {
        requestType: "DOCUMENT",
        title: `Request ${kit.tag()}`,
        recipientMode: "INTERNAL_USER",
        createIntakeLink: false,
        ...over,
      });
      expect(res.statusCode, res.body).toBe(201);
      return res.json().evidenceRequest.id as string;
    };

    beforeAll(async () => {
      keyA = await apiKey(a, READ);
      keyB = await apiKey(b, READ);
      evidenceA = await record(a, `A-${kit.tag()}`);
      evidenceB = await record(b, `SENTINEL-B-${kit.tag()}`);
      hiddenCase = await restrictedCase(a);
      hiddenEvidence = await record(a, `SENTINEL-HIDDEN-${kit.tag()}`);
      await prisma.caseEvidenceLink.create({
        data: { caseId: hiddenCase, evidenceId: hiddenEvidence, teamId: a.workspaceId } as never,
      });
      requestA = await newRequest(keyA.raw);
      requestB = await newRequest(keyB.raw);
    });

    it("POSITIVE: a key reads its own workspace, and the read is logged against the key", async () => {
      const list = await kit.call("GET", "/v1/integrations/api/evidence", bearer(keyA.raw));
      expect(list.statusCode, list.body).toBe(200);
      const ids = list.json().evidence.map((e: { id: string }) => e.id);
      expect(ids).toContain(evidenceA);
      expect(ids).not.toContain(evidenceB);
      expect(ids).not.toContain(hiddenEvidence);
      const one = await kit.call("GET", `/v1/integrations/api/evidence/${evidenceA}`, bearer(keyA.raw));
      expect(one.statusCode, one.body).toBe(200);
      expect(one.json().evidence.id).toBe(evidenceA);
      const req = await kit.call("GET", `/v1/integrations/api/evidence-requests/${requestA}`, bearer(keyA.raw));
      expect(req.statusCode, req.body).toBe(200);
      expect(req.json().evidenceRequest.id).toBe(requestA);
      await h.handlersSettled();
      expect(await prisma.apiCredentialUsageLog.count({ where: { apiCredentialId: keyA.id } })).toBeGreaterThanOrEqual(3);
    });

    it("the same key against the other tenant's real rows answers as if they did not exist", async () => {
      for (const url of [
        `/v1/integrations/api/evidence/${evidenceB}`,
        `/v1/integrations/api/evidence-requests/${requestB}`,
      ]) {
        const res = await kit.call("GET", url, bearer(keyA.raw));
        expect(res.statusCode, res.body).toBe(404);
        expect(res.json()).toEqual({ error: { code: "not_found" } });
      }
      // The list takes no workspace from the caller.
      const named = await kit.call("GET", `/v1/integrations/api/evidence?teamId=${b.workspaceId}`, bearer(keyA.raw));
      expect(named.statusCode).toBeLessThan(500);
      expect(named.body).not.toContain(evidenceB);
    });

    it("a key is no person: a record or a request on a restricted case stays closed to it", async () => {
      const ev = await kit.call("GET", `/v1/integrations/api/evidence/${hiddenEvidence}`, bearer(keyA.raw));
      expect(ev.statusCode, ev.body).toBe(404);
      // A request made before its case was restricted: the row is moved onto the
      // case directly, since the create path checks reach at creation only.
      const onCase = await newRequest(keyA.raw);
      await prisma.evidenceRequest.update({ where: { id: onCase }, data: { caseId: hiddenCase } });
      const res = await kit.call("GET", `/v1/integrations/api/evidence-requests/${onCase}`, bearer(keyA.raw));
      expect(res.statusCode, res.body).toBe(404);
      expect(res.json()).toEqual({ error: { code: "not_found" } });
      const onRecord = await newRequest(keyA.raw);
      await prisma.evidenceRequest.update({ where: { id: onRecord }, data: { evidenceId: hiddenEvidence } });
      const second = await kit.call("GET", `/v1/integrations/api/evidence-requests/${onRecord}`, bearer(keyA.raw));
      expect(second.statusCode, second.body).toBe(404);
    });

    it("a key without the scope is refused per route, on its own tenant's row", async () => {
      const narrow = await apiKey(a, ["integration.evidence_request.read"]);
      const refused = await kit.call("GET", `/v1/integrations/api/evidence/${evidenceA}`, bearer(narrow.raw));
      expect(refused.statusCode, refused.body).toBe(403);
      expect(refused.body).not.toContain(evidenceA);
      const list = await kit.call("GET", "/v1/integrations/api/evidence", bearer(narrow.raw));
      expect(list.statusCode, list.body).toBe(403);
      const control = await kit.call("GET", `/v1/integrations/api/evidence-requests/${requestA}`, bearer(narrow.raw));
      expect(control.statusCode, control.body).toBe(200);
    });

    it("a revoked key and an expired key stop working, with the same answer as a made-up one", async () => {
      const revoked = await apiKey(a, READ);
      const header = await stepUp.approvedHeader({
        token: a.owner.token,
        userId: a.owner.userId,
        teamId: a.workspaceId,
        purpose: "INTEGRATION_API_KEY_REVOKE",
        resourceKind: "api_credential",
        resourceId: revoked.id,
      });
      const before = await kit.call("GET", "/v1/integrations/api/evidence", bearer(revoked.raw));
      expect(before.statusCode, before.body).toBe(200);
      const done = await kit.call(
        "POST",
        `/v1/integrations/api-keys/${revoked.id}/revoke`,
        session(),
        { teamId: a.workspaceId, reason: "coverage" },
        header,
      );
      expect(done.statusCode, done.body).toBe(200);
      expectInvalidKey(await kit.call("GET", "/v1/integrations/api/evidence", bearer(revoked.raw)));

      const expired = await apiKey(a, READ);
      await prisma.apiCredential.update({ where: { id: expired.id }, data: { expiresAtUtc: new Date(Date.now() - 1000) } });
      expectInvalidKey(await kit.call("GET", `/v1/integrations/api/evidence/${evidenceA}`, bearer(expired.raw)));

      const made = await kit.call("GET", "/v1/integrations/api/evidence", bearer(`pwk_v1_${"x".repeat(40)}`));
      expectInvalidKey(made);
    });

    it("a session, a SCIM token and no credential at all are not an API key", async () => {
      const scim = await scimToken(a, ["users.read"]);
      for (const url of [
        "/v1/integrations/api/evidence",
        `/v1/integrations/api/evidence/${evidenceA}`,
        `/v1/integrations/api/evidence-requests/${requestA}`,
      ]) {
        expectInvalidKey(await kit.call("GET", url, session()));
        expectInvalidKey(await kit.call("GET", url, bearer(scim.raw)));
        const anon = await kit.call("GET", url, null);
        expect(anon.statusCode, anon.body).toBe(401);
      }
    });
  });

  // ===========================================================================
  // SCIM
  // ===========================================================================
  describe("SCIM routes", () => {
    const ALL = ["users.read", "users.write", "groups.read", "groups.write"];
    let tokenA: { id: string; raw: string };
    let tokenB: { id: string; raw: string };
    let groupA: string;
    let groupB: string;
    let userA: { id: string; userName: string };
    let userB: { id: string; userName: string };

    const newGroup = async (raw: string) => {
      const res = await kit.call("POST", "/v2/scim/Groups", bearer(raw), {
        schemas: [SCIM_GROUP],
        displayName: `Group ${kit.tag()}`,
        mappedRole: "MEMBER",
      });
      expect(res.statusCode, res.body).toBe(201);
      return res.json().id as string;
    };

    // IDENT-013 — a directory creates accounts only in a domain its
    // Organization verified, so each customer gets one.
    const newUser = async (raw: string, c: Customer) => {
      const domain = `${kit.tag()}-${c.orgId.slice(0, 8)}.verified.example`.toLowerCase();
      await prisma.organizationDomain.create({
        data: {
          organizationId: c.orgId,
          domain,
          verifiedAt: new Date(),
          verificationToken: `cov-${kit.tag()}`,
          createdByUserId: c.owner.userId,
        } as never,
      });
      const userName = `scim-${kit.tag()}@${domain}`;
      const res = await kit.call("POST", "/v2/scim/Users", bearer(raw), {
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
        userName,
        emails: [{ value: userName, primary: true }],
      });
      expect(res.statusCode, res.body).toBe(201);
      return { id: res.json().id as string, userName };
    };

    beforeAll(async () => {
      tokenA = await scimToken(a, ALL);
      tokenB = await scimToken(b, ALL);
      groupA = await newGroup(tokenA.raw);
      groupB = await newGroup(tokenB.raw);
      userA = await newUser(tokenA.raw, a);
      userB = await newUser(tokenB.raw, b);
    });

    it("POSITIVE: a token reads its own users and groups", async () => {
      const users = await kit.call("GET", "/v2/scim/Users", bearer(tokenA.raw));
      expect(users.statusCode, users.body).toBe(200);
      const names = users.json().Resources.map((u: { userName: string }) => u.userName);
      expect(names).toContain(userA.userName);
      const one = await kit.call("GET", `/v2/scim/Users/${userA.id}`, bearer(tokenA.raw));
      expect(one.statusCode, one.body).toBe(200);
      expect(one.json().id).toBe(userA.id);
      const groups = await kit.call("GET", "/v2/scim/Groups", bearer(tokenA.raw));
      expect(groups.statusCode, groups.body).toBe(200);
      expect(groups.json().Resources.map((g: { id: string }) => g.id)).toContain(groupA);
      const group = await kit.call("GET", `/v2/scim/Groups/${groupA}`, bearer(tokenA.raw));
      expect(group.statusCode, group.body).toBe(200);
    });

    it("the same token cannot reach the other tenant's user or group, and its lists hold none", async () => {
      for (const url of [`/v2/scim/Users/${userB.id}`, `/v2/scim/Groups/${groupB}`]) {
        const res = await kit.call("GET", url, bearer(tokenA.raw));
        expect(res.statusCode, res.body).toBe(404);
        expect(res.body).not.toContain(userB.userName);
      }
      const users = await kit.call("GET", `/v2/scim/Users?filter=${encodeURIComponent(`userName eq "${userB.userName}"`)}`, bearer(tokenA.raw));
      expect(users.statusCode, users.body).toBe(200);
      expect(users.body).not.toContain(userB.userName);
      const groups = await kit.call("GET", "/v2/scim/Groups", bearer(tokenA.raw));
      expect(groups.json().Resources.map((g: { id: string }) => g.id)).not.toContain(groupB);
    });

    it("a token without the scope is refused; groups.read does not read users", async () => {
      const groupsOnly = await scimToken(a, ["groups.read"]);
      for (const url of ["/v2/scim/Users", `/v2/scim/Users/${userA.id}`]) {
        const res = await kit.call("GET", url, bearer(groupsOnly.raw));
        expect(res.statusCode, res.body).toBe(403);
        expect(res.body).not.toContain(userA.userName);
      }
      const control = await kit.call("GET", "/v2/scim/Groups", bearer(groupsOnly.raw));
      expect(control.statusCode, control.body).toBe(200);
      const deactivateOnly = await scimToken(a, ["users.deactivate"]);
      const groups = await kit.call("GET", `/v2/scim/Groups/${groupA}`, bearer(deactivateOnly.raw));
      expect(groups.statusCode, groups.body).toBe(403);
    });

    it("a revoked token and an expired token are refused on every read", async () => {
      const revoked = await scimToken(a, ALL);
      const header = await stepUp.approvedHeader({
        token: a.owner.token,
        userId: a.owner.userId,
        teamId: a.workspaceId,
        purpose: "EXTERNAL_IDENTITY_UNLINK",
        resourceKind: "SCIM_TOKEN",
        resourceId: revoked.id,
      });
      const done = await kit.call(
        "POST",
        `/v1/admin/identity/scim/tokens/${revoked.id}/revoke`,
        session(),
        { teamId: a.workspaceId, reason: "coverage" },
        header,
      );
      expect(done.statusCode, done.body).toBe(200);

      const expired = await scimToken(a, ALL);
      await prisma.scimProvisioningToken.update({
        where: { id: expired.id },
        data: { expiresAtUtc: new Date(Date.now() - 1000) },
      });
      for (const raw of [revoked.raw, expired.raw]) {
        for (const url of ["/v2/scim/Users", `/v2/scim/Users/${userA.id}`, "/v2/scim/Groups", `/v2/scim/Groups/${groupA}`]) {
          const res = await kit.call("GET", url, bearer(raw));
          expect(res.statusCode, `${url} ${res.body}`).toBe(401);
          expect(res.body).not.toContain(userA.userName);
        }
      }
    });

    it("a session and an API key are not a SCIM token", async () => {
      const key = await apiKey(a, ["integration.evidence.read"]);
      for (const url of ["/v2/scim/Users", `/v2/scim/Users/${userA.id}`, "/v2/scim/Groups", `/v2/scim/Groups/${groupA}`]) {
        for (const who of [session(), bearer(key.raw), null]) {
          const res = await kit.call("GET", url, who);
          expect(res.statusCode, `${url} ${res.body}`).toBe(401);
        }
      }
    });
  });

  // ===========================================================================
  // Capability tokens
  // ===========================================================================
  describe("capability token routes", () => {
    let issueInvitation: typeof import("../src/services/external-review/portal-invitation.service.js")["issueInvitation"];
    let issueExternalReviewGrant: typeof import("../src/services/external-review/external-review-grant.service.js")["issueExternalReviewGrant"];

    /** A signed record with a published EXTERNAL_DISCLOSURE package at a real object. */
    async function recordWithPackage(c: Customer) {
      const { s3 } = await import("../src/storage.js");
      const bucket = process.env.S3_BUCKET as string;
      const id = await record(c, `pkg ${kit.tag()}`, { type: "DOCUMENT", status: "REPORTED", signedAtUtc: new Date() });
      const key = `verification/${id}/external.zip`;
      const body = Buffer.from(`package ${randomUUID()}`);
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body }));
      await prisma.report.create({
        data: { evidenceId: id, version: 1, storageBucket: "b", storageKey: `reports/${id}/v1.pdf`, generatedAtUtc: new Date(), sizeBytes: 1_000n },
      });
      await prisma.verificationPackage.create({
        data: {
          evidenceId: id,
          version: 1,
          storageBucket: bucket,
          storageKey: key,
          generatedAtUtc: new Date(),
          sizeBytes: BigInt(body.length),
          reportVersion: 1,
          disclosureProfile: "EXTERNAL_DISCLOSURE",
          packageSha256: createHash("sha256").update(body).digest("hex"),
        } as never,
      });
      return id;
    }

    async function grant(c: Customer, evidenceId: string, over: Record<string, unknown> = {}) {
      const issued = await issueExternalReviewGrant({
        teamId: c.workspaceId,
        invitedByUserId: c.owner.userId,
        scopeKind: "EVIDENCE",
        evidenceId,
        reviewerEmail: `rev-${kit.tag()}@test.proovra.local`,
        expiresAtUtc: new Date(Date.now() + 3 * 86_400_000).toISOString(),
        allowPackageDownload: true,
        ...over,
      } as never);
      if (!issued.ok) throw new Error(`grant refused: ${issued.reason}`);
      return issued as { rawToken: string; grant: { id: string } };
    }
    const accept = (token: string) => kit.call("POST", `/v1/external-review/access/${token}`, null);
    const context = (token: string, who: { token: string } | null = null) =>
      kit.call("GET", `/v1/external-review/access/${token}/context`, who);
    const pkg = (token: string) => kit.call("GET", `/v1/external-review/access/${token}/verification-package`, null);
    const NOT_ACTIVE = { error: { code: "grant_not_active" } };

    beforeAll(async () => {
      ({ issueInvitation } = await import("../src/services/external-review/portal-invitation.service.js"));
      ({ issueExternalReviewGrant } = await import("../src/services/external-review/external-review-grant.service.js"));
    });

    it("POSITIVE: a reviewer's token shows its own scope and releases its own package, in custody", async () => {
      const id = await recordWithPackage(a);
      const g = await grant(a, id);
      expect((await accept(g.rawToken)).statusCode).toBe(200);
      const ctx = await context(g.rawToken);
      expect(ctx.statusCode, ctx.body).toBe(200);
      expect(ctx.json().context).toMatchObject({ scopeKind: "EVIDENCE" });
      const res = await pkg(g.rawToken);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({ disclosureProfile: "EXTERNAL_DISCLOSURE" });
      expect(await prisma.custodyEvent.count({ where: { evidenceId: id } })).toBeGreaterThanOrEqual(1);
    });

    it("the token has no way to name another tenant's record: its answer is its own grant, whoever asks", async () => {
      const own = await recordWithPackage(a);
      const foreign = await recordWithPackage(b);
      const g = await grant(a, own);
      await accept(g.rawToken);
      // A session of the other tenant adds nothing, and query parameters are ignored.
      const asked = await kit.call("GET", `/v1/external-review/access/${g.rawToken}/verification-package?evidenceId=${foreign}`, {
        token: b.owner.token,
      });
      expect(asked.statusCode, asked.body).toBe(200);
      expect(asked.body).not.toContain(foreign);
      const row = await prisma.verificationPackage.findFirstOrThrow({ where: { evidenceId: own } });
      expect(asked.json().packageId).toBe(row.id);
      expect(await prisma.custodyEvent.count({ where: { evidenceId: foreign, eventType: "VERIFICATION_PACKAGE_DOWNLOADED" as never } })).toBe(0);
    });

    it("a grant whose scope is not a record gets no package", async () => {
      const caseRow = await prisma.case.create({
        data: { name: `Open ${kit.tag()}`, teamId: a.workspaceId, ownerUserId: a.owner.userId } as never,
        select: { id: true },
      });
      const g = await grant(a, "", { scopeKind: "CASE", caseId: caseRow.id, evidenceId: undefined });
      await accept(g.rawToken);
      const res = await pkg(g.rawToken);
      expect(res.statusCode, res.body).toBeGreaterThanOrEqual(400);
      expect(res.statusCode).toBeLessThan(500);
      expect(res.json().url).toBeUndefined();
    });

    it("revoked, expired, unknown and wrong-kind tokens get one answer, on both routes", async () => {
      const id = await recordWithPackage(a);
      const revoked = await grant(a, id);
      await accept(revoked.rawToken);
      const r = await kit.call("POST", `/v1/external-review/grants/${revoked.grant.id}/revoke`, session(), { teamId: a.workspaceId });
      expect(r.statusCode, r.body).toBe(200);

      const expired = await grant(a, id);
      await accept(expired.rawToken);
      await prisma.externalReviewGrant.update({ where: { id: expired.grant.id }, data: { createdAtUtc: new Date(Date.now() - 86_400_000), expiresAtUtc: new Date(Date.now() - 1000) } });

      const apiLike = (await apiKey(a, ["integration.evidence.read"])).raw;
      const tokens = [revoked.rawToken, expired.rawToken, "ab".repeat(32), apiLike];
      for (const token of tokens) {
        for (const res of [await context(token), await pkg(token)]) {
          // A token of the wrong shape stops at the parameter check, which reveals nothing.
          expect([400, 401], res.body).toContain(res.statusCode);
          if (res.statusCode === 401) expect(res.json()).toEqual(NOT_ACTIVE);
          expect(res.body).not.toContain(id);
        }
      }
    });

    it("a session cannot stand in for the token, and an MFA invitation is not opened by its token alone", async () => {
      const id = await record(a, `mfa ${kit.tag()}`);
      const res = await context("ab".repeat(32), session());
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual(NOT_ACTIVE);
      const issued = await issueInvitation({
        teamId: a.workspaceId,
        invitedByUserId: a.owner.userId,
        reviewerEmail: `mfa-${kit.tag()}@test.proovra.local`,
        role: "EXTERNAL_REVIEWER",
        mfaRequired: true,
        scope: { kind: "EVIDENCE", evidenceId: id },
        expiresAtUtc: new Date(Date.now() + 86_400_000).toISOString(),
      });
      if (!issued.ok) throw new Error(issued.denial);
      // Not yet accepted, so not active.
      expect((await context(issued.rawToken)).statusCode).toBe(401);
    });

    describe("external intake", () => {
      let keyA: string;
      let keyB: string;
      const link = async (raw: string, over: Record<string, unknown> = {}) => {
        const res = await kit.call("POST", "/v1/integrations/api/intake-links", bearer(raw), {
          workflowTemplateSlug: "general-evidence-record",
          intakeMode: "EXTERNAL_REUSABLE",
          maxUses: 5,
          expiresAtUtc: new Date(Date.now() + 86_400_000).toISOString(),
          ...over,
        });
        expect(res.statusCode, res.body).toBe(201);
        return { id: res.json().intakeLink.id as string, token: res.json().rawToken as string };
      };
      const open = (token: string, headers?: Record<string, string>) =>
        kit.call("GET", `/v1/external-intake/${token}`, null, undefined, headers);

      beforeAll(async () => {
        keyA = (await apiKey(a, ["integration.intake_link.create"])).raw;
        keyB = (await apiKey(b, ["integration.intake_link.create"])).raw;
      });

      it("POSITIVE: a link opens a session of its own, with no workspace internals in the answer", async () => {
        const l = await link(keyA);
        const res = await open(l.token);
        expect(res.statusCode, res.body).toBe(200);
        expect(res.json().session.id).toBeTruthy();
        expect(res.body).not.toContain(a.workspaceId);
        expect(res.body).not.toContain(a.owner.email);
        const row = await prisma.workflowIntakeSession.findFirstOrThrow({ where: { id: res.json().session.id } });
        expect(row.intakeLinkId).toBe(l.id);
      });

      it("a session of another tenant's link cannot be resumed through this link", async () => {
        const mine = await link(keyA);
        const theirs = await link(keyB);
        const opened = await open(theirs.token);
        expect(opened.statusCode, opened.body).toBe(200);
        const foreignSession = opened.json().session.id as string;
        const res = await open(mine.token, { "x-proovra-intake-session": foreignSession });
        expect(res.statusCode, res.body).toBe(200);
        expect(res.json().resumed).toBe(false);
        expect(res.json().session.id).not.toBe(foreignSession);
        const sameLink = await open(theirs.token, { "x-proovra-intake-session": foreignSession });
        expect(sameLink.json().resumed).toBe(true);
        expect(sameLink.json().session.id).toBe(foreignSession);
      });

      it("revoked, expired, unknown and wrong-kind tokens open nothing and start no session", async () => {
        const revoked = await link(keyA);
        const done = await kit.call("POST", `/v1/workflow/intake-links/${revoked.id}/revoke`, session(), { reason: "coverage" });
        expect(done.statusCode, done.body).toBe(200);
        const expired = await link(keyA);
        await prisma.workflowIntakeLink.update({ where: { id: expired.id }, data: { expiresAtUtc: new Date(Date.now() - 1000) } });

        const before = await prisma.workflowIntakeSession.count();
        const answers: Injected[] = [];
        for (const token of [revoked.token, expired.token, "z".repeat(48), `pwk_v1_${"x".repeat(40)}`]) {
          const res = await open(token);
          expect(res.statusCode, `${token.slice(0, 6)} ${res.body}`).toBeGreaterThanOrEqual(400);
          expect(res.statusCode).toBeLessThan(500);
          expect(res.body).not.toContain(a.workspaceId);
          answers.push(res);
        }
        expect(await prisma.workflowIntakeSession.count()).toBe(before);
        // A session in place of a token changes nothing.
        const withSession = await kit.call("GET", `/v1/external-intake/${"z".repeat(48)}`, session());
        expect(withSession.statusCode).toBe(answers[2]!.statusCode);
      });
    });
  });
});
