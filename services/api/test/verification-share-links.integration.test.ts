/**
 * ET-PKG-07 — public verification is reached through an opaque, revocable
 * share link, never through the record's id. Live PostgreSQL 16, real HTTP.
 *
 * On a40ca76f GET /public/verify/<evidence id> served every finalized record:
 * published by default, no expiry, no rotation, and the only way to withdraw
 * one recipient was to unpublish for everyone. The id is the primary key and
 * appears in reports, packages, storage keys and internal URLs.
 */
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const DAY = 24 * 3600_000;

describe("public verification share links (live PostgreSQL 16, real HTTP)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let clearRates: () => Promise<unknown>;
  const keyId = `pkg07-${randomUUID().slice(0, 8)}`;
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  let ipCounter = 10;
  const nextIp = () => `198.51.100.${(ipCounter = ipCounter >= 250 ? 10 : ipCounter + 1)}`;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    ({ clearAllRateLimitBuckets: clearRates } = await import("../src/services/rate-limit.js"));
    await prisma.signingKey.create({
      data: { keyId, version: 1, publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString().trim() },
    });
  }, 180_000);

  beforeEach(async () => {
    await clearRates();
  });

  afterAll(async () => {
    await h?.cleanup();
  });

  type Team = IntegrationHarness["fixtures"]["teamA"];

  /** A signed, verifiable record in a workspace. Unpublished unless `over` says otherwise. */
  async function signedRecord(T: Team, over: Record<string, unknown> = {}): Promise<string> {
    const team = await prisma.team.findUniqueOrThrow({ where: { id: T.teamId }, select: { organizationId: true } });
    const row = await prisma.evidence.create({
      data: {
        title: "PKG-07 private title",
        type: "PHOTO",
        status: "SIGNED",
        teamId: T.teamId,
        organizationId: team.organizationId,
        ownerUserId: T.ownerUserId,
        signedAtUtc: new Date(),
      } as never,
      select: { id: true },
    });
    const fileSha256 = sha(randomUUID());
    const canonical = JSON.stringify({ v: 1, evidenceId: row.id, sha256: fileSha256 });
    const fingerprintHash = sha(canonical);
    await prisma.evidence.update({
      where: { id: row.id },
      data: {
        fileSha256,
        fingerprintCanonicalJson: canonical,
        fingerprintHash,
        signatureBase64: sign(null, Buffer.from(fingerprintHash, "hex"), privateKey).toString("base64"),
        signingKeyId: keyId,
        signingKeyVersion: 1,
        ...over,
      } as never,
    });
    return row.id;
  }
  const published = (T: Team, over: Record<string, unknown> = {}) =>
    signedRecord(T, { publicVerifyState: "PUBLISHED", ...over });

  const api = (method: "GET" | "POST", url: string, token: string, payload?: unknown) =>
    h.app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}`, ...(payload ? { "content-type": "application/json" } : {}) },
      ...(payload ? { payload: payload as never } : {}),
    });
  const verify = (segment: string, ip: string = nextIp()) =>
    h.app.inject({ method: "GET", url: `/public/verify/${segment}`, remoteAddress: ip });
  const createLink = async (T: Team, evidenceId: string, body: Record<string, unknown> = {}) => {
    const res = await api("POST", `/v1/evidence/${evidenceId}/verify-links`, T.ownerToken, {
      audience: "Opposing counsel",
      expiresInDays: 30,
      ...body,
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json() as { token: string; verifyPath: string; link: { id: string; state: string }; published: boolean };
  };
  const NOT_FOUND = JSON.stringify({ message: "Evidence not found" });

  it("a record is unpublished by default, and its id opens nothing", async () => {
    const A = h.fixtures.teamA;
    // Through the real create route (a Personal Space, which any plan may record in).
    const viaApi = await api("POST", "/v1/evidence", h.fixtures.personal.token, { type: "PHOTO", mimeType: "image/jpeg" });
    expect(viaApi.statusCode, viaApi.body).toBe(201);
    const created = await prisma.evidence.findUniqueOrThrow({ where: { id: viaApi.json().id as string } });
    expect(created.publicVerifyState).toBe("NOT_PUBLISHED");
    expect(created.legacyVerifyUuidUntilUtc).toBeNull();

    const id = await signedRecord(A);
    expect((await prisma.evidence.findUniqueOrThrow({ where: { id } })).publicVerifyState).toBe("NOT_PUBLISHED");
    const res = await verify(id);
    expect(res.statusCode).toBe(404);
    expect(res.body).toBe(NOT_FOUND);
    expect(await prisma.verificationShareToken.count({ where: { evidenceId: id } })).toBe(0);
  });

  it("a PUBLISHED record is still not reachable by its id — only a share token opens it", async () => {
    const A = h.fixtures.teamA;
    const id = await published(A);
    const byId = await verify(id);
    expect(byId.statusCode).toBe(404);
    expect(byId.body).toBe(NOT_FOUND);

    const { token, verifyPath, link } = await createLink(A, id);
    expect(token).toMatch(/^pvs_[A-Za-z0-9_-]{43}$/);
    expect(verifyPath).toBe(`/verify/${token}`);
    expect(link.state).toBe("ACTIVE");
    const ok = await verify(token);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().evidenceId).toBe(id);
    expect(ok.json().link).toMatchObject({ kind: "SHARE_TOKEN" });
  });

  it("only the token's hash is stored: the link cannot be recovered from the database", async () => {
    const A = h.fixtures.teamA;
    const id = await published(A);
    const { token, link } = await createLink(A, id);
    const row = await prisma.verificationShareToken.findUniqueOrThrow({ where: { id: link.id } });
    expect(row.tokenHash).toBe(sha(token));
    expect(JSON.stringify(row)).not.toContain(token);
    expect(JSON.stringify(row)).not.toContain(token.slice(4));
    // Listing never returns a token or a hash.
    const listed = await api("GET", `/v1/evidence/${id}/verify-links`, A.ownerToken);
    expect(listed.statusCode).toBe(200);
    expect(listed.body).not.toContain(token);
    expect(listed.body).not.toContain(row.tokenHash);
    expect(listed.json().links[0]).toMatchObject({ id: link.id, state: "ACTIVE", audience: "Opposing counsel" });
  });

  it("a random token, a malformed one and an unknown id are byte-identical 404s", async () => {
    const neverIssued = `pvs_${randomBytes(32).toString("base64url")}`;
    const answers = await Promise.all([
      verify(neverIssued),
      verify("pvs_too-short"),
      verify("not-a-token"),
      verify(randomUUID()),
    ]);
    for (const a of answers) {
      expect(a.statusCode).toBe(404);
      expect(a.body).toBe(NOT_FOUND);
    }
  });

  it("an expired link answers 410 and releases nothing; the record's other links still work", async () => {
    const A = h.fixtures.teamA;
    const id = await published(A);
    const expired = await createLink(A, id, { audience: "Expired recipient" });
    const live = await createLink(A, id, { audience: "Live recipient" });
    await prisma.verificationShareToken.update({
      where: { id: expired.link.id },
      data: { expiresAtUtc: new Date(Date.now() - 60_000) },
    });

    const gone = await verify(expired.token);
    expect(gone.statusCode).toBe(410);
    expect(gone.json()).toEqual({
      code: "VERIFICATION_LINK_EXPIRED",
      message: "This verification link has expired. Ask the record's owner for a new link.",
    });
    expect(gone.body).not.toContain(id);
    expect((await verify(live.token)).statusCode).toBe(200);

    const listed = (await api("GET", `/v1/evidence/${id}/verify-links`, A.ownerToken)).json();
    const states = Object.fromEntries(listed.links.map((l: { audience: string; state: string }) => [l.audience, l.state]));
    expect(states).toEqual({ "Expired recipient": "EXPIRED", "Live recipient": "ACTIVE" });
  });

  it("revoking one link withdraws that recipient only", async () => {
    const A = h.fixtures.teamA;
    const id = await published(A);
    const a = await createLink(A, id, { audience: "Recipient A" });
    const b = await createLink(A, id, { audience: "Recipient B" });

    const revoked = await api("POST", `/v1/evidence/${id}/verify-links/${a.link.id}/revoke`, A.ownerToken);
    expect(revoked.statusCode, revoked.body).toBe(200);
    expect(revoked.json()).toMatchObject({ changed: true, link: { state: "REVOKED", revocationReason: "OWNER_REVOKED", revokedByUserId: A.ownerUserId } });

    const gone = await verify(a.token);
    expect(gone.statusCode).toBe(410);
    expect(gone.json().code).toBe("VERIFICATION_LINK_REVOKED");
    expect((await verify(b.token)).statusCode).toBe(200);
    // The record itself was never unpublished.
    expect((await prisma.evidence.findUniqueOrThrow({ where: { id } })).publicVerifyState).toBe("PUBLISHED");
    // Revoking again changes nothing.
    const again = await api("POST", `/v1/evidence/${id}/verify-links/${a.link.id}/revoke`, A.ownerToken);
    expect(again.json()).toMatchObject({ changed: false, link: { state: "REVOKED" } });
  });

  it("rotating a link stops the old token at once and returns its replacement once", async () => {
    const A = h.fixtures.teamA;
    const id = await published(A);
    const first = await createLink(A, id, { audience: "Insurer", expiresInDays: 14, projection: "BASIC" });

    const rotated = await api("POST", `/v1/evidence/${id}/verify-links/${first.link.id}/rotate`, A.ownerToken);
    expect(rotated.statusCode, rotated.body).toBe(201);
    const next = rotated.json() as { token: string; replacedLinkId: string; link: Record<string, unknown> };
    expect(next.replacedLinkId).toBe(first.link.id);
    expect(next.token).not.toBe(first.token);
    expect(next.link).toMatchObject({ audience: "Insurer", projection: "BASIC", state: "ACTIVE", rotatedFromId: first.link.id });

    const old = await verify(first.token);
    expect(old.statusCode).toBe(410);
    expect(old.json().code).toBe("VERIFICATION_LINK_REVOKED");
    expect((await verify(next.token)).statusCode).toBe(200);

    const was = await prisma.verificationShareToken.findUniqueOrThrow({ where: { id: first.link.id } });
    expect(was.revocationReason).toBe("ROTATED");
    // A link that no longer works is not rotated.
    const twice = await api("POST", `/v1/evidence/${id}/verify-links/${first.link.id}/rotate`, A.ownerToken);
    expect(twice.statusCode).toBe(409);
    expect(twice.json().code).toBe("VERIFICATION_LINK_NOT_ACTIVE");
  });

  it("a use limit is exact, even under concurrent requests; use count and last-used are recorded", async () => {
    const A = h.fixtures.teamA;
    const id = await published(A);
    const limited = await createLink(A, id, { audience: "One-time recipient", maxUses: 2 });

    const answers = await Promise.all(Array.from({ length: 6 }, () => verify(limited.token)));
    const codes = answers.map((a) => a.statusCode).sort();
    expect(codes.filter((c) => c === 200)).toHaveLength(2);
    expect(codes.filter((c) => c === 410)).toHaveLength(4);
    expect(answers.find((a) => a.statusCode === 410)!.json().code).toBe("VERIFICATION_LINK_EXHAUSTED");

    const row = await prisma.verificationShareToken.findUniqueOrThrow({ where: { id: limited.link.id } });
    expect(row.useCount).toBe(2);
    expect(row.lastUsedAtUtc).toBeInstanceOf(Date);
    const listed = (await api("GET", `/v1/evidence/${id}/verify-links`, A.ownerToken)).json();
    expect(listed.links.find((l: { id: string }) => l.id === limited.link.id)).toMatchObject({ state: "EXHAUSTED", useCount: 2, maxUses: 2 });
  });

  it("the legacy record-id link works only inside its bounded grace, says when it ends, and the owner can end it", async () => {
    const A = h.fixtures.teamA;
    const until = new Date(Date.now() + 90 * DAY);
    const legacy = await published(A, { legacyVerifyUuidUntilUtc: until });

    const during = await verify(legacy);
    expect(during.statusCode, during.body).toBe(200);
    expect(during.json().link).toEqual({ kind: "LEGACY_RECORD_ID", expiresAtUtc: until.toISOString() });

    const listed = (await api("GET", `/v1/evidence/${legacy}/verify-links`, A.ownerToken)).json();
    expect(listed.legacy).toEqual({ active: true, expiresAtUtc: until.toISOString(), graceDays: 180 });

    // The grace has run out: the id is no longer a capability.
    const lapsed = await published(A, { legacyVerifyUuidUntilUtc: new Date(Date.now() - 60_000) });
    const after = await verify(lapsed);
    expect(after.statusCode).toBe(404);
    expect(after.body).toBe(NOT_FOUND);

    // The owner ends the legacy link early; a share link on the same record is unaffected.
    const share = await createLink(A, legacy);
    const ended = await api("POST", `/v1/evidence/${legacy}/verify-links/legacy/revoke`, A.ownerToken);
    expect(ended.statusCode, ended.body).toBe(200);
    expect(ended.json()).toMatchObject({ changed: true, legacy: { active: false } });
    expect((await verify(legacy)).statusCode).toBe(404);
    expect((await verify(share.token)).statusCode).toBe(200);
    // Nothing brings it back, and a record without one never gains one.
    const again = await api("POST", `/v1/evidence/${legacy}/verify-links/legacy/revoke`, A.ownerToken);
    expect(again.json()).toMatchObject({ changed: false });
    const fresh = await published(A);
    const none = await api("POST", `/v1/evidence/${fresh}/verify-links/legacy/revoke`, A.ownerToken);
    expect(none.statusCode).toBe(409);
    expect(none.json().code).toBe("LEGACY_LINK_NOT_ACTIVE");
  });

  it("the workspace inventory lists the records still reachable by id", async () => {
    const A = h.fixtures.teamA;
    await prisma.user.update({ where: { id: A.ownerUserId }, data: { currentWorkspaceId: A.teamId } });
    const soon = new Date(Date.now() + 5 * DAY);
    const id = await published(A, { legacyVerifyUuidUntilUtc: soon });
    const res = await api("GET", "/v1/verify-links/legacy-inventory", A.ownerToken);
    expect(res.statusCode, res.body).toBe(200);
    const inv = res.json();
    expect(inv.graceDays).toBe(180);
    expect(inv.activeCount).toBeGreaterThanOrEqual(1);
    expect(inv.records.map((r: { evidenceId: string }) => r.evidenceId)).toContain(id);
    expect(Date.parse(inv.earliestExpiryUtc)).toBeLessThanOrEqual(soon.getTime());
    // Another workspace's inventory does not contain it.
    const B = h.fixtures.teamB;
    await prisma.user.update({ where: { id: B.ownerUserId }, data: { currentWorkspaceId: B.teamId } });
    const other = (await api("GET", "/v1/verify-links/legacy-inventory", B.ownerToken)).json();
    expect(other.records.map((r: { evidenceId: string }) => r.evidenceId)).not.toContain(id);
  });

  it("links are bound to their own record and workspace: another tenant can neither see nor manage them", async () => {
    const A = h.fixtures.teamA;
    const B = h.fixtures.teamB;
    const id = await published(A);
    const { token, link } = await createLink(A, id);

    for (const [method, url, payload] of [
      ["GET", `/v1/evidence/${id}/verify-links`, undefined],
      ["POST", `/v1/evidence/${id}/verify-links`, { audience: "Intruder", expiresInDays: 1 }],
      ["POST", `/v1/evidence/${id}/verify-links/${link.id}/revoke`, undefined],
      ["POST", `/v1/evidence/${id}/verify-links/${link.id}/rotate`, undefined],
      ["POST", `/v1/evidence/${id}/verify-links/legacy/revoke`, undefined],
    ] as const) {
      const res = await api(method, url, B.ownerToken, payload);
      expect(res.statusCode, `${method} ${url}`).toBe(404);
      expect(res.body).toBe(NOT_FOUND);
    }
    // A's link id under B's own record is not found either.
    const bRecord = await published(B);
    const crossed = await api("POST", `/v1/evidence/${bRecord}/verify-links/${link.id}/revoke`, B.ownerToken);
    expect(crossed.statusCode).toBe(404);
    expect(crossed.json().code).toBe("VERIFICATION_LINK_NOT_FOUND");
    // The link still works, and opens only its own record.
    const ok = await verify(token);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().evidenceId).toBe(id);
  });

  it("a member who can read but not publish is refused; creating the first link on an unpublished record needs step-up", async () => {
    const A = h.fixtures.teamA;
    const id = await published(A);
    const asViewer = await api("GET", `/v1/evidence/${id}/verify-links`, A.viewerToken);
    expect(asViewer.statusCode).toBe(403);
    expect(asViewer.json().code).toBe("VERIFICATION_LINKS_NOT_PERMITTED");
    const viewerCreate = await api("POST", `/v1/evidence/${id}/verify-links`, A.viewerToken, { audience: "x", expiresInDays: 1 });
    expect(viewerCreate.statusCode).toBe(403);

    // Publishing is never implicit: without the step-up proof, nothing is published and no link exists.
    const unpublished = await signedRecord(A);
    const attempt = await api("POST", `/v1/evidence/${unpublished}/verify-links`, A.ownerToken, { audience: "First recipient", expiresInDays: 7 });
    expect(attempt.statusCode).toBe(401);
    expect(attempt.json().error.code).toBe("STEP_UP_REQUIRED");
    expect((await prisma.evidence.findUniqueOrThrow({ where: { id: unpublished } })).publicVerifyState).toBe("NOT_PUBLISHED");
    expect(await prisma.verificationShareToken.count({ where: { evidenceId: unpublished } })).toBe(0);
  });

  it("a link is necessary, not sufficient: suspending or unpublishing the record closes every link", async () => {
    const A = h.fixtures.teamA;
    const id = await published(A);
    const { token } = await createLink(A, id);
    expect((await verify(token)).statusCode).toBe(200);
    for (const state of ["SUSPENDED", "UNPUBLISHED", "NOT_PUBLISHED"] as const) {
      await prisma.evidence.update({ where: { id }, data: { publicVerifyState: state } });
      const res = await verify(token);
      expect(res.statusCode, state).toBe(404);
      expect(res.body).toBe(NOT_FOUND);
    }
    await prisma.evidence.update({ where: { id }, data: { publicVerifyState: "PUBLISHED", lifecycleState: "TRASHED", deletedAt: new Date() } });
    expect((await verify(token)).statusCode).toBe(404);
  });

  it("the public answer is an allow-list: nothing about the link's audience, its creator, the workspace or holds", async () => {
    const A = h.fixtures.teamA;
    const id = await published(A);
    const audience = `Secret-audience-${randomUUID().slice(0, 8)}`;
    const basic = await createLink(A, id, { audience, projection: "BASIC" });
    const res = await verify(basic.token);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    // A BASIC link narrows the projection whatever the record is entitled to.
    expect(body.tier).toBe("BASIC");
    expect(Object.keys(body).sort()).toEqual(["basicVerification", "evidenceId", "link", "tier"]);
    expect(Object.keys(body.link).sort()).toEqual(["expiresAtUtc", "kind"]);
    for (const forbidden of [
      audience,
      A.ownerUserId,
      A.teamId,
      basic.link.id,
      "PKG-07 private title",
      "createdByUserId",
      "tokenHash",
      "audience",
      "legalHold",
      "ownerUserId",
      "teamId",
      "revokedByUserId",
    ]) {
      expect(res.body, `public verify must not carry ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("guessing tokens is rate limited per client before any lookup", async () => {
    const ip = "203.0.113.77";
    let limited = 0;
    for (let i = 0; i < 80; i++) {
      const res = await verify(`pvs_${randomBytes(32).toString("base64url")}`, ip);
      if (res.statusCode === 429) {
        limited++;
        expect(res.headers["retry-after"]).toBeTruthy();
      } else {
        expect(res.statusCode).toBe(404);
      }
    }
    expect(limited).toBeGreaterThan(0);
  });

  it("a record holds at most 25 active owner links; a revoked one frees a place", async () => {
    const A = h.fixtures.teamA;
    const id = await published(A);
    const made: string[] = [];
    for (let i = 0; i < 25; i++) made.push((await createLink(A, id, { audience: `Recipient ${i}` })).link.id);
    const over = await api("POST", `/v1/evidence/${id}/verify-links`, A.ownerToken, { audience: "One too many", expiresInDays: 1 });
    expect(over.statusCode).toBe(409);
    expect(over.json()).toMatchObject({ code: "VERIFICATION_LINK_LIMIT_REACHED", details: { limit: 25 } });
    await api("POST", `/v1/evidence/${id}/verify-links/${made[0]}/revoke`, A.ownerToken);
    await createLink(A, id, { audience: "Fits now" });
  });
  describe("UC-OUT-001 / UC-OUT-005 — printed links on private records, and NULL-team records", () => {
    it("UC-OUT-001: a valid REPORT link on an unpublished record answers the documented 404, and the owner listing marks it unusable", async () => {
      const A = h.fixtures.teamA;
      const id = await signedRecord(A);
      const { mintVerificationShareTokenTx } = await import("@proovra/shared-runtime");
      const minted = await prisma.$transaction((tx) =>
        mintVerificationShareTokenTx(tx, {
          evidenceId: id,
          teamId: A.teamId,
          purpose: "REPORT",
          reportVersion: 1,
          audience: "Report version 1",
        }),
      );
      // Documented response: a private record answers exactly like a missing one
      // (no state is disclosed to an unauthenticated caller). The report that
      // would carry this link prints "Not published" instead (worker test).
      const res = await verify(minted.token);
      expect(res.statusCode).toBe(404);
      expect(res.body).toBe(NOT_FOUND);

      const listing = await api("GET", `/v1/evidence/${id}/verify-links`, A.ownerToken);
      expect(listing.statusCode, listing.body).toBe(200);
      const link = (listing.json().links as Array<{ purpose: string; state: string; usable: boolean; inactiveReason: string | null }>).find(
        (l) => l.purpose === "REPORT",
      )!;
      expect(link.state).toBe("ACTIVE");
      expect(link.usable).toBe(false);
      expect(link.inactiveReason).toBe("RECORD_NOT_PUBLISHED");

      // Publishing makes the same link usable.
      await prisma.evidence.update({ where: { id }, data: { publicVerifyState: "PUBLISHED" } });
      const after = await api("GET", `/v1/evidence/${id}/verify-links`, A.ownerToken);
      const again = (after.json().links as Array<{ purpose: string; usable: boolean }>).find((l) => l.purpose === "REPORT")!;
      expect(again.usable).toBe(true);
      expect((await verify(minted.token)).statusCode).toBe(200);
    });

    it("UC-OUT-005: a NULL-team personal record resolves to its owner's personal workspace for publication and the legacy inventory", async () => {
      const P = h.fixtures.personal;
      const { resolveShareWorkspaceId, legacyVerifyLinkInventory } = await import(
        "../src/services/governance/verification-share.service.js"
      );
      const row = await prisma.evidence.create({
        data: {
          title: "legacy NULL-team",
          type: "PHOTO",
          status: "SIGNED",
          teamId: null,
          ownerUserId: P.userId,
          signedAtUtc: new Date(),
          publicVerifyState: "PUBLISHED",
          legacyVerifyUuidUntilUtc: new Date(Date.now() + 10 * DAY),
        } as never,
        select: { id: true, teamId: true, ownerUserId: true },
      });
      expect(await resolveShareWorkspaceId(row)).toBe(P.teamId);
      const inventory = await legacyVerifyLinkInventory({ teamId: P.teamId });
      expect(inventory.records.map((r) => r.evidenceId)).toContain(row.id);
    });
  });
});
