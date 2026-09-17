/**
 * D38 — evidence declarations carry the statement their requester wrote.
 *
 * OWNER DECISION (2026-09-17): the person requesting a custodian or
 * qualified-person declaration writes its statement. It is stored on the
 * request, and a signature attaches to exactly that text. Before this a request
 * stored no statement, so no declaration could ever be signed in the product,
 * and the attest route would have signed whatever text the client sent.
 *
 * Everything runs through the real routes against a disposable PostgreSQL 16.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe("D38 evidence declaration statements (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];

  const STATEMENT = "I am the custodian of this record and it was kept in the ordinary course of business.";

  const post = (url: string, token: string, payload: unknown) =>
    harness.app.inject({
      method: "POST",
      url,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: payload as never,
    });
  const json = (res: { body: string }) => JSON.parse(res.body) as Json;
  const base = () => `/v1/evidence/${harness.fixtures.teamA.evidenceId}/certifications`;
  const rows = () =>
    prisma.evidenceCertification.findMany({
      where: { evidenceId: harness.fixtures.teamA.evidenceId, declarationType: "CUSTODIAN" },
      orderBy: { version: "asc" },
    });
  const signer = (statementMarkdown: string) => ({
    declarationType: "CUSTODIAN",
    attestorName: "Dana Reyes",
    attestorTitle: "Records Custodian",
    attestorEmail: "dana@test.proovra.local",
    attestorOrganization: null,
    statementMarkdown,
    signatureText: "Dana Reyes",
  });

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
  }, 180_000);

  afterAll(async () => {
    await harness?.cleanup();
  });

  it("a request without a statement is refused and records nothing", async () => {
    const { teamA } = harness.fixtures;
    const bare = await post(`${base()}/request`, teamA.ownerToken, { declarationType: "CUSTODIAN" });
    expect(bare.statusCode, bare.body).toBe(400);
    const short = await post(`${base()}/request`, teamA.ownerToken, {
      declarationType: "CUSTODIAN",
      statementMarkdown: "   too short   ",
    });
    expect(short.statusCode, short.body).toBe(400);
    expect(await rows()).toHaveLength(0);
  });

  it("the requester's statement is stored, a different statement cannot be signed, and the recorded one is", async () => {
    const { teamA } = harness.fixtures;
    const requested = await post(`${base()}/request`, teamA.ownerToken, {
      declarationType: "CUSTODIAN",
      statementMarkdown: `  ${STATEMENT}  `,
    });
    expect(requested.statusCode, requested.body).toBe(200);
    expect(json(requested).certification).toMatchObject({ status: "REQUESTED", statementMarkdown: STATEMENT });
    const [stored] = await rows();
    expect(stored).toMatchObject({ status: "REQUESTED", statementMarkdown: STATEMENT, requestedByUserId: teamA.ownerUserId });

    // A signer's client that shows (or sends) other wording is refused.
    const changed = await post(`${base()}/attest`, teamA.ownerToken, signer("I attest to something else entirely."));
    expect(changed.statusCode, changed.body).toBe(409);
    expect(json(changed).error).toMatchObject({ code: "CERTIFICATION_STATEMENT_CHANGED" });
    expect((await rows())[0]).toMatchObject({ status: "REQUESTED", statementMarkdown: STATEMENT, signatureText: null });

    const signed = await post(`${base()}/attest`, teamA.ownerToken, signer(STATEMENT));
    expect(signed.statusCode, signed.body).toBe(200);
    const [after] = await rows();
    expect(after).toMatchObject({
      status: "ATTESTED",
      statementMarkdown: STATEMENT,
      attestedByUserId: teamA.ownerUserId,
      signatureText: "Dana Reyes",
    });
    expect(after!.certificationHash).toMatch(/^[0-9a-f]{64}$/);

    // A signed declaration is final for its version (D35), with a code.
    const again = await post(`${base()}/attest`, teamA.ownerToken, signer(STATEMENT));
    expect(again.statusCode).toBe(409);
    expect(json(again).error).toMatchObject({ code: "CERTIFICATION_ALREADY_ATTESTED" });
  });

  it("a request recorded before statements were required cannot be signed", async () => {
    const { teamA } = harness.fixtures;
    await prisma.evidenceCertification.create({
      data: {
        evidenceId: teamA.evidenceId,
        declarationType: "QUALIFIED_PERSON",
        status: "REQUESTED",
        version: 1,
        requestedByUserId: teamA.ownerUserId,
        requestedAtUtc: new Date(),
      },
    });
    const res = await post(`${base()}/attest`, teamA.ownerToken, {
      ...signer(STATEMENT),
      declarationType: "QUALIFIED_PERSON",
    });
    expect(res.statusCode, res.body).toBe(409);
    expect(json(res).error).toMatchObject({ code: "CERTIFICATION_STATEMENT_MISSING" });
    const row = await prisma.evidenceCertification.findFirstOrThrow({
      where: { evidenceId: teamA.evidenceId, declarationType: "QUALIFIED_PERSON" },
    });
    expect(row).toMatchObject({ status: "REQUESTED", statementMarkdown: null, signatureText: null });
  });
});
