/**
 * EVID-011 — a PRIVILEGED legal note is not read by every reader of the record
 * (live PostgreSQL).
 *
 * `GET /v1/evidence/:id/legal-notes` returned PRIVILEGED notes, with the
 * author's email, to anyone holding evidence.read, VIEWER included. It now
 * returns them to their author and to those who may manage the record's
 * collaborative content (the record owner, OWNER / ADMIN). Other note types are
 * unchanged.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("legal note audiences (EVID-011)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  const A = () => h.fixtures.teamA;
  const PRIV = `privileged-${randomUUID().slice(0, 8)}`;
  const GEN = `general-${randomUUID().slice(0, 8)}`;
  const MINE = `member-privileged-${randomUUID().slice(0, 8)}`;
  let evidenceId: string;

  const notes = (token: string) =>
    h.app.inject({ method: "GET", url: `/v1/evidence/${evidenceId}/legal-notes`, headers: { authorization: `Bearer ${token}` } });

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    const team = await prisma.team.findUniqueOrThrow({ where: { id: A().teamId }, select: { organizationId: true } });
    evidenceId = (
      await prisma.evidence.create({
        data: { title: "notes", type: "DOCUMENT", status: "SIGNED", teamId: A().teamId, organizationId: team.organizationId, ownerUserId: A().ownerUserId } as never,
        select: { id: true },
      })
    ).id;
    await prisma.evidenceLegalNote.createMany({
      data: [
        { evidenceId, authorUserId: A().ownerUserId, noteType: "PRIVILEGED", body: PRIV },
        { evidenceId, authorUserId: A().ownerUserId, noteType: "GENERAL", body: GEN },
        { evidenceId, authorUserId: A().memberUserId, noteType: "PRIVILEGED", body: MINE },
      ] as never,
    });
  }, 180_000);

  afterAll(async () => {
    await h?.cleanup();
  });

  it("VIEWER reads the general note and no privileged one", async () => {
    const res = await notes(A().viewerToken);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.body).toContain(GEN);
    expect(res.body).not.toContain(PRIV);
    expect(res.body).not.toContain(MINE);
  });

  it("a MEMBER reads their own privileged note, not the owner's", async () => {
    const res = await notes(A().memberToken);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.body).toContain(GEN);
    expect(res.body).toContain(MINE);
    expect(res.body).not.toContain(PRIV);
  });

  it("positive controls: the owner and an ADMIN read every note", async () => {
    for (const token of [A().ownerToken, A().adminToken]) {
      const res = await notes(token);
      expect(res.statusCode, res.body).toBe(200);
      for (const body of [PRIV, GEN, MINE]) expect(res.body).toContain(body);
    }
  });
});
