/**
 * ET-PKG-07 — public verification is reached through an opaque, revocable
 * share link (or the record's permanent canonical reference), never through
 * the record's id. Live PostgreSQL 16, real HTTP.
 *
 * On a40ca76f GET /public/verify/<evidence id> served every finalized record:
 * published by default, no expiry, no rotation, and the only way to withdraw
 * one recipient was to unpublish for everyone. The id is the primary key and
 * appears in reports, packages, storage keys and internal URLs.
 *
 * (2026-10-18) THE DISCLOSURE CONTRACT. The publication model is retired.
 * Every identifier of a record answers subject to the record's canonical
 * ACCESS state (AVAILABLE / WITHDRAWN / SUSPENDED) and lifecycle — a reviewer
 * share can never weaken it. What an answer DISCLOSES is the record's policy
 * for a canonical identifier and the link's own profile for a reviewer share
 * (STANDARD = content preview, BASIC = verification only; originals only with
 * an explicit allowOriginalDownload grant, which needs step-up). Creating a
 * link never changes the record's disclosure policy.
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
  let generateVerificationRef: () => string;
  const keyId = `pkg07-${randomUUID().slice(0, 8)}`;
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  let ipCounter = 10;
  const nextIp = () => `198.51.100.${(ipCounter = ipCounter >= 250 ? 10 : ipCounter + 1)}`;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    ({ clearAllRateLimitBuckets: clearRates } = await import("../src/services/rate-limit.js"));
    ({ generateVerificationRef } = await import("@proovra/shared-runtime"));
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

  /**
   * A signed, verifiable record in a workspace, holding its canonical
   * reference (every finalized record is issued one at finalization). Its
   * disclosure policy is the column default — VERIFICATION_ONLY — unless
   * `over` says otherwise.
   */
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
        verificationRef: generateVerificationRef(),
        verificationRefIssuedAtUtc: new Date(),
        ...over,
      } as never,
    });
    return row.id;
  }

  const policyOf = (id: string) =>
    prisma.evidence.findUniqueOrThrow({
      where: { id },
      select: {
        verificationDisclosureMode: true,
        showRecordedLocation: true,
        verificationDisclosureVersion: true,
        verificationAccessState: true,
        verificationRef: true,
      },
    });

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
    return res.json() as { token: string; verifyPath: string; link: { id: string; state: string; allowOriginalDownload: boolean } };
  };
  const NOT_FOUND = JSON.stringify({ message: "Evidence not found" });

  it("a new record's page discloses verification only by default, and its id opens nothing", async () => {
    const A = h.fixtures.teamA;
    // Through the real create route (a Personal Space, which any plan may record in).
    const viaApi = await api("POST", "/v1/evidence", h.fixtures.personal.token, { type: "PHOTO", mimeType: "image/jpeg" });
    expect(viaApi.statusCode, viaApi.body).toBe(201);
    const created = await prisma.evidence.findUniqueOrThrow({ where: { id: viaApi.json().id as string } });
    expect(created.verificationDisclosureMode).toBe("VERIFICATION_ONLY");
    expect(created.showRecordedLocation).toBe(false);
    expect(created.verificationDisclosureVersion).toBe(0);
    expect(created.legacyVerifyUuidUntilUtc).toBeNull();

    const id = await signedRecord(A);
    expect(await policyOf(id)).toMatchObject({ verificationDisclosureMode: "VERIFICATION_ONLY", verificationAccessState: "AVAILABLE" });
    const res = await verify(id);
    expect(res.statusCode).toBe(404);
    expect(res.body).toBe(NOT_FOUND);
    expect(await prisma.verificationShareToken.count({ where: { evidenceId: id } })).toBe(0);
  });

  // A record id outside its legacy grace answers the SAME 404 as anything
  // unknown (anti-enumeration).
  const expectRecordIdEnded = (res: { statusCode: number; body: string }) => {
    expect(res.statusCode).toBe(404);
    expect(res.body).toBe(NOT_FOUND);
  };

  it("a record is not reachable by its id — a share token opens it under the link's own profile, and the record's policy is untouched", async () => {
    const A = h.fixtures.teamA;
    const id = await signedRecord(A);
    const byId = await verify(id);
    expectRecordIdEnded(byId);
    // ...and byte-identical to an id that never existed.
    expect(byId.body).toBe((await verify(randomUUID())).body);

    const { token, verifyPath, link } = await createLink(A, id);
    expect(token).toMatch(/^pvs_[A-Za-z0-9_-]{43}$/);
    expect(verifyPath).toBe(`/verify/${token}`);
    expect(link.state).toBe("ACTIVE");
    expect(link.allowOriginalDownload).toBe(false);
    const ok = await verify(token);
    expect(ok.statusCode, ok.body).toBe(200);
    const body = ok.json();
    // The internal record id never leaves — and (2026-10-20, AUD-13) neither
    // does the record's PERMANENT reference: a reviewer share is revocable, the
    // reference is not, so handing it out would outlive the owner's revocation.
    expect(body.evidenceId).toBeUndefined();
    expect(ok.body).not.toContain(id);
    const { verificationRef } = await policyOf(id);
    expect(verificationRef).toMatch(/^pvr_/);
    expect(ok.body).not.toContain(verificationRef!);
    expect(body.canonicalVerification).toMatchObject({ reference: null, status: "AVAILABLE" });
    expect(body.link).toMatchObject({ kind: "SHARE_TOKEN" });
    // A STANDARD reviewer share opens content BY ITSELF — no publication step —
    // and never hands out originals without an explicit grant.
    expect(body.disclosure).toMatchObject({ mode: "CONTENT_PREVIEW", source: "REVIEWER_SHARE", originalDownload: false, recordedLocation: false });
    // Creating the link changed nothing about the record's own page.
    expect(await policyOf(id)).toMatchObject({
      verificationDisclosureMode: "VERIFICATION_ONLY",
      verificationDisclosureVersion: 0,
      verificationAccessState: "AVAILABLE",
    });
    expect(await prisma.custodyEvent.count({ where: { evidenceId: id, eventType: "VERIFICATION_DISCLOSURE_CHANGED" } })).toBe(0);
  });

  it("only the token's hash is stored: the link cannot be recovered from the database", async () => {
    const A = h.fixtures.teamA;
    const id = await signedRecord(A);
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
    expect(listed.json()).toMatchObject({ verificationAccessState: "AVAILABLE", shareable: true });
    expect(listed.json()).not.toHaveProperty("published");
    expect(listed.json().links[0]).toMatchObject({
      id: link.id,
      state: "ACTIVE",
      audience: "Opposing counsel",
      usable: true,
      inactiveReason: null,
      allowOriginalDownload: false,
    });
  });

  it("a random token, a malformed one, an unknown reference and an unknown id are byte-identical 404s", async () => {
    const neverIssued = `pvs_${randomBytes(32).toString("base64url")}`;
    const answers = await Promise.all([
      verify(neverIssued),
      verify("pvs_too-short"),
      verify("not-a-token"),
      verify(`pvr_${randomBytes(20).toString("base64url")}`),
    ]);
    for (const a of answers) {
      expect(a.statusCode).toBe(404);
      expect(a.body).toBe(NOT_FOUND);
    }
    expectRecordIdEnded(await verify(randomUUID()));
  });

  it("an expired link answers 410 and releases nothing; the record's other links still work", async () => {
    const A = h.fixtures.teamA;
    const id = await signedRecord(A);
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
    const id = await signedRecord(A);
    const a = await createLink(A, id, { audience: "Recipient A" });
    const b = await createLink(A, id, { audience: "Recipient B" });

    const revoked = await api("POST", `/v1/evidence/${id}/verify-links/${a.link.id}/revoke`, A.ownerToken);
    expect(revoked.statusCode, revoked.body).toBe(200);
    expect(revoked.json()).toMatchObject({ changed: true, link: { state: "REVOKED", revocationReason: "OWNER_REVOKED", revokedByUserId: A.ownerUserId } });

    const gone = await verify(a.token);
    expect(gone.statusCode).toBe(410);
    expect(gone.json().code).toBe("VERIFICATION_LINK_REVOKED");
    expect((await verify(b.token)).statusCode).toBe(200);
    // The record's own page was never touched: access and policy unchanged.
    expect(await policyOf(id)).toMatchObject({ verificationAccessState: "AVAILABLE", verificationDisclosureMode: "VERIFICATION_ONLY" });
    // Revoking again changes nothing.
    const again = await api("POST", `/v1/evidence/${id}/verify-links/${a.link.id}/revoke`, A.ownerToken);
    expect(again.json()).toMatchObject({ changed: false, link: { state: "REVOKED" } });
  });

  it("rotating a link stops the old token at once and returns its replacement once", async () => {
    const A = h.fixtures.teamA;
    const id = await signedRecord(A);
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
    const id = await signedRecord(A);
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

  it("the legacy record-id link works only inside its bounded grace and only for a record holding its reference, says when it ends, and the owner can end it", async () => {
    const A = h.fixtures.teamA;
    const until = new Date(Date.now() + 90 * DAY);
    const legacy = await signedRecord(A, { legacyVerifyUuidUntilUtc: until });

    const during = await verify(legacy);
    expect(during.statusCode, during.body).toBe(200);
    expect(during.json().link).toEqual({ kind: "LEGACY_RECORD_ID", expiresAtUtc: until.toISOString() });
    // It opens the CANONICAL page: the record's own policy, never originals.
    expect(during.json().disclosure).toMatchObject({ mode: "VERIFICATION_ONLY", source: "RECORD_POLICY", originalDownload: false });

    const listed = (await api("GET", `/v1/evidence/${legacy}/verify-links`, A.ownerToken)).json();
    expect(listed.legacy).toEqual({ active: true, expiresAtUtc: until.toISOString(), graceDays: 180 });

    // The grace has run out: the id is no longer a capability.
    const lapsed = await signedRecord(A, { legacyVerifyUuidUntilUtc: new Date(Date.now() - 60_000) });
    expectRecordIdEnded(await verify(lapsed));
    // Inside a grace but without a canonical reference: not a capability either.
    const unreferenced = await signedRecord(A, { legacyVerifyUuidUntilUtc: until, verificationRef: null, verificationRefIssuedAtUtc: null });
    expectRecordIdEnded(await verify(unreferenced));

    // The owner ends the legacy link early; a share link on the same record is unaffected.
    const share = await createLink(A, legacy);
    const ended = await api("POST", `/v1/evidence/${legacy}/verify-links/legacy/revoke`, A.ownerToken);
    expect(ended.statusCode, ended.body).toBe(200);
    expect(ended.json()).toMatchObject({ changed: true, legacy: { active: false } });
    expectRecordIdEnded(await verify(legacy));
    expect((await verify(share.token)).statusCode).toBe(200);
    // Nothing brings it back, and a record without one never gains one.
    const again = await api("POST", `/v1/evidence/${legacy}/verify-links/legacy/revoke`, A.ownerToken);
    expect(again.json()).toMatchObject({ changed: false });
    const fresh = await signedRecord(A);
    const none = await api("POST", `/v1/evidence/${fresh}/verify-links/legacy/revoke`, A.ownerToken);
    expect(none.statusCode).toBe(409);
    expect(none.json().code).toBe("LEGACY_LINK_NOT_ACTIVE");
  });

  it("the workspace inventory lists the records still reachable by id", async () => {
    const A = h.fixtures.teamA;
    await prisma.user.update({ where: { id: A.ownerUserId }, data: { currentWorkspaceId: A.teamId } });
    const soon = new Date(Date.now() + 5 * DAY);
    const id = await signedRecord(A, { legacyVerifyUuidUntilUtc: soon });
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
    const id = await signedRecord(A);
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
    const bRecord = await signedRecord(B);
    const crossed = await api("POST", `/v1/evidence/${bRecord}/verify-links/${link.id}/revoke`, B.ownerToken);
    expect(crossed.statusCode).toBe(404);
    expect(crossed.json().code).toBe("VERIFICATION_LINK_NOT_FOUND");
    // The link still works, and opens only its own record.
    const ok = await verify(token);
    expect(ok.statusCode).toBe(200);
    // Its own record (by its signed digest), and never the permanent reference (AUD-13).
    const { verificationRef } = await policyOf(id);
    const own = await prisma.evidence.findUniqueOrThrow({ where: { id }, select: { fileSha256: true } });
    expect(ok.body).toContain(own.fileSha256!);
    expect(ok.body).not.toContain(verificationRef!);
    expect(ok.json().canonicalVerification.reference).toBeNull();
  });

  it("a member who can read but not share is refused; creating a link never changes the disclosure policy; granting originals needs step-up", async () => {
    const A = h.fixtures.teamA;
    const id = await signedRecord(A);
    const asViewer = await api("GET", `/v1/evidence/${id}/verify-links`, A.viewerToken);
    expect(asViewer.statusCode).toBe(403);
    expect(asViewer.json().code).toBe("VERIFICATION_LINKS_NOT_PERMITTED");
    const viewerCreate = await api("POST", `/v1/evidence/${id}/verify-links`, A.viewerToken, { audience: "x", expiresInDays: 1 });
    expect(viewerCreate.statusCode).toBe(403);

    // A plain reviewer link needs no step-up and leaves the record's policy alone.
    const plain = await api("POST", `/v1/evidence/${id}/verify-links`, A.ownerToken, { audience: "First recipient", expiresInDays: 7 });
    expect(plain.statusCode, plain.body).toBe(201);
    expect(plain.json()).not.toHaveProperty("published");
    expect(await policyOf(id)).toMatchObject({ verificationDisclosureMode: "VERIFICATION_ONLY", verificationDisclosureVersion: 0 });

    // Handing out the ORIGINAL files is the sensitive grant: without a fresh
    // step-up nothing is created.
    const before = await prisma.verificationShareToken.count({ where: { evidenceId: id } });
    const originals = await api("POST", `/v1/evidence/${id}/verify-links`, A.ownerToken, {
      audience: "Expert witness",
      expiresInDays: 7,
      allowOriginalDownload: true,
    });
    expect(originals.statusCode, originals.body).toBe(401);
    expect(originals.json().error.code).toBe("STEP_UP_REQUIRED");
    expect(await prisma.verificationShareToken.count({ where: { evidenceId: id } })).toBe(before);

    // A BASIC link never downloads, so it never asks for the grant's step-up
    // and the grant is not recorded.
    const basic = await createLink(A, id, { audience: "Insurer", projection: "BASIC", allowOriginalDownload: true });
    expect(basic.link.allowOriginalDownload).toBe(false);
    expect(await policyOf(id)).toMatchObject({ verificationDisclosureMode: "VERIFICATION_ONLY", verificationDisclosureVersion: 0 });
  });

  it("withdrawing or suspending the canonical page closes every link (410 / 503), a trashed record's links answer RETAINED, and a share never weakens access", async () => {
    const A = h.fixtures.teamA;
    const id = await signedRecord(A);
    const { token, link } = await createLink(A, id);
    expect((await verify(token)).statusCode).toBe(200);

    const listingOf = async () =>
      ((await api("GET", `/v1/evidence/${id}/verify-links`, A.ownerToken)).json().links as Array<{ id: string; usable: boolean; inactiveReason: string | null; state: string }>).find(
        (l) => l.id === link.id,
      )!;

    for (const [access, status, code] of [
      ["WITHDRAWN", 410, "VERIFICATION_RECORD_WITHDRAWN"],
      ["SUSPENDED", 503, "VERIFICATION_RECORD_TEMPORARILY_UNAVAILABLE"],
    ] as const) {
      await prisma.evidence.update({ where: { id }, data: { verificationAccessState: access } });
      const res = await verify(token);
      expect(res.statusCode, access).toBe(status);
      expect(res.json().code).toBe(code);
      // No record data, no internal id.
      expect(res.body).not.toContain("PKG-07 private title");
      expect(res.body).not.toContain(id);
      expect(res.json()).not.toHaveProperty("verificationMatrix");
      // The link itself is still ACTIVE, and the owner sees why it does not answer.
      expect(await listingOf()).toMatchObject({ state: "ACTIVE", usable: false, inactiveReason: "PAGE_NOT_AVAILABLE" });
      // A denied request spends no use.
      expect((await prisma.verificationShareToken.findUniqueOrThrow({ where: { id: link.id } })).useCount).toBe(1);
    }

    // Reinstated: the same link answers again.
    await prisma.evidence.update({ where: { id }, data: { verificationAccessState: "AVAILABLE" } });
    expect((await verify(token)).statusCode).toBe(200);
    expect(await listingOf()).toMatchObject({ usable: true, inactiveReason: null });

    // Trashed: the canonical state is RETAINED for every identifier — a
    // truthful answer with no record content.
    await prisma.evidence.update({ where: { id }, data: { lifecycleState: "TRASHED", deletedAt: new Date() } });
    const retained = await verify(token);
    expect(retained.statusCode).toBe(200);
    expect(retained.json().code).toBe("VERIFICATION_RECORD_RETAINED");
    expect(retained.body).not.toContain("PKG-07 private title");
    expect(retained.json()).not.toHaveProperty("verificationMatrix");
  });

  it("a link's own profile decides what it discloses — a BASIC link narrows a content-preview page, and location is never added by a link", async () => {
    const A = h.fixtures.teamA;
    const id = await signedRecord(A, { verificationDisclosureMode: "CONTENT_PREVIEW", showRecordedLocation: false });
    const basic = await createLink(A, id, { audience: "Insurer", projection: "BASIC" });
    const narrowed = await verify(basic.token);
    expect(narrowed.statusCode, narrowed.body).toBe(200);
    expect(narrowed.json().disclosure).toMatchObject({ mode: "VERIFICATION_ONLY", source: "REVIEWER_SHARE", recordedLocation: false });
    expect(narrowed.body).not.toContain("PKG-07 private title");

    const standard = await createLink(A, id, { audience: "Counsel" });
    const shown = await verify(standard.token);
    expect(shown.statusCode, shown.body).toBe(200);
    // Location follows the record's explicit decision (off here) — a link never adds it.
    expect(shown.json().disclosure).toMatchObject({ mode: "CONTENT_PREVIEW", recordedLocation: false });
    expect(shown.json().captureContext ?? null).toBeNull();
    expect(shown.json().locationState ?? null).toBeNull();
  });

  it("the public answer is an allow-list: nothing about the link's audience, its creator, the workspace or holds", async () => {
    const A = h.fixtures.teamA;
    const id = await signedRecord(A);
    const audience = `Secret-audience-${randomUUID().slice(0, 8)}`;
    const basic = await createLink(A, id, { audience, projection: "BASIC" });
    const res = await verify(basic.token);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    // A BASIC link narrows the projection whatever the record is entitled to.
    expect(body.tier).toBe("BASIC");
    expect(Object.keys(body).sort()).toEqual([
      "basicVerification",
      "canonicalVerification",
      "disclosure",
      "link",
      "recordFacts",
      "tier",
      "verificationMatrix",
    ]);
    // The matrix at this tier never describes who submitted the record.
    for (const key of ["account_identity", "organization_verification"]) {
      const row = body.verificationMatrix.rows.find((r: { key: string }) => r.key === key);
      expect(row.status, key).toBe("NOT_APPLICABLE");
      expect(row.statement, key).toBe("Not disclosed on this verification page.");
    }
    expect(Object.keys(body.link).sort()).toEqual(["expiresAtUtc", "kind"]);
    for (const forbidden of [
      audience,
      id,
      A.ownerUserId,
      A.teamId,
      basic.link.id,
      "PKG-07 private title",
      "evidenceId",
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
    const id = await signedRecord(A);
    const made: string[] = [];
    for (let i = 0; i < 25; i++) made.push((await createLink(A, id, { audience: `Recipient ${i}` })).link.id);
    const over = await api("POST", `/v1/evidence/${id}/verify-links`, A.ownerToken, { audience: "One too many", expiresInDays: 1 });
    expect(over.statusCode).toBe(409);
    expect(over.json()).toMatchObject({ code: "VERIFICATION_LINK_LIMIT_REACHED", details: { limit: 25 } });
    await api("POST", `/v1/evidence/${id}/verify-links/${made[0]}/revoke`, A.ownerToken);
    await createLink(A, id, { audience: "Fits now" });
  });
  describe("UC-OUT-001 / UC-OUT-005 — printed links, and NULL-team records", () => {
    it("CANONICAL VERIFICATION: a REPORT link printed by an earlier report opens the canonical page under the record's policy, and the listing marks it usable", async () => {
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
      // A link a report printed is the record's canonical page — the record's
      // own disclosure policy (verification only here), never the internal id.
      const res = await verify(minted.token);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().link).toEqual({ kind: "CANONICAL", expiresAtUtc: null });
      expect(res.json().disclosure).toMatchObject({ mode: "VERIFICATION_ONLY", source: "RECORD_POLICY", originalDownload: false });
      expect(res.body).not.toContain(id);

      const listing = await api("GET", `/v1/evidence/${id}/verify-links`, A.ownerToken);
      expect(listing.statusCode, listing.body).toBe(200);
      const link = (listing.json().links as Array<{ purpose: string; state: string; usable: boolean; inactiveReason: string | null }>).find(
        (l) => l.purpose === "REPORT",
      )!;
      expect(link.state).toBe("ACTIVE");
      expect(link.usable).toBe(true);
      expect(link.inactiveReason).toBeNull();

      // The owner's policy is what the same printed link discloses next.
      await prisma.evidence.update({ where: { id }, data: { verificationDisclosureMode: "CONTENT_PREVIEW" } });
      const after = await verify(minted.token);
      expect(after.statusCode).toBe(200);
      expect(after.json().disclosure).toMatchObject({ mode: "CONTENT_PREVIEW", source: "RECORD_POLICY", originalDownload: false });
    });

    it("UC-OUT-005: a NULL-team personal record resolves to its owner's personal workspace for sharing and the legacy inventory", async () => {
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
          verificationRef: generateVerificationRef(),
          verificationRefIssuedAtUtc: new Date(),
          legacyVerifyUuidUntilUtc: new Date(Date.now() + 10 * DAY),
        } as never,
        select: { id: true, teamId: true, ownerUserId: true },
      });
      expect(await resolveShareWorkspaceId(row)).toBe(P.teamId);
      const inventory = await legacyVerifyLinkInventory({ teamId: P.teamId });
      expect(inventory.records.map((r) => r.evidenceId)).toContain(row.id);
    });
  });

  it("UC-OUT-005: the owner of a NULL-team legacy record can share it by creating a link, and the link answers; an originals grant reaches the step-up in the personal workspace", async () => {
    const P = h.fixtures.personal;
    const row = await prisma.evidence.create({
      data: { title: "legacy NULL-team share", type: "PHOTO", status: "SIGNED", teamId: null, ownerUserId: P.userId, signedAtUtc: new Date() } as never,
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
        verificationRef: generateVerificationRef(),
        verificationRefIssuedAtUtc: new Date(),
      } as never,
    });
    // The route resolves the personal workspace (it used to refuse 409
    // record_has_no_workspace) and the originals grant reaches its step-up.
    const grant = await api("POST", `/v1/evidence/${row.id}/verify-links`, P.token, {
      audience: "Court clerk",
      expiresInDays: 30,
      allowOriginalDownload: true,
    });
    expect(grant.statusCode, grant.body).toBe(401);
    expect(grant.json().error.code).toBe("STEP_UP_REQUIRED");
    // A plain link needs no publication and no step-up, and it answers.
    const res = await api("POST", `/v1/evidence/${row.id}/verify-links`, P.token, { audience: "Court clerk", expiresInDays: 30 });
    expect(res.statusCode, res.body).toBe(201);
    expect((await verify(res.json().token as string)).statusCode).toBe(200);
    expect(await policyOf(row.id)).toMatchObject({ verificationDisclosureMode: "VERIFICATION_ONLY", verificationDisclosureVersion: 0 });
  });
});
