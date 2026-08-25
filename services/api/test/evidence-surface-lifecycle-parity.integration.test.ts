/**
 * THE LIBRARY AND THE DETAILS PAGE MUST READ THE SAME LIFECYCLE VERDICT
 * (live PostgreSQL 16).
 *
 * THE DEFECT THIS PINS
 * ---------------------------------------------------------------------------
 * `/evidence` could move an eligible record to trash. `/evidence/:id` showed
 * the same record as ACTIVE with every lifecycle timestamp "Not recorded", and
 * a permanently disabled "Move to trash" reading
 * "Record state is loading. Try again in a moment." Waiting never helped,
 * because nothing was loading.
 *
 * Both surfaces call the SAME helper, `getEvidenceDeletionEligibility`, whose
 * last branch returns exactly that message when the response carries neither
 * the canonical `lifecycle` projection nor the legacy `deleteEligibility`. It
 * refuses rather than guessing, which is right. The problem was upstream: the
 * Details page does not read `GET /v1/evidence/:id` at all. It reads
 * `GET /v1/evidence/:id/review-workspace`, and THAT response was never given
 * the projection — so the browser was permanently told "I cannot see the
 * verdict", and correctly declined to invent one.
 *
 * WHAT THIS SUITE ASSERTS
 * ---------------------------------------------------------------------------
 * All three read surfaces are driven for the SAME record and required to
 * report the SAME canonical verdict:
 *
 *   GET /v1/evidence                       the Library list row
 *   GET /v1/evidence/:id                   the canonical detail response
 *   GET /v1/evidence/:id/review-workspace  what the Details page ACTUALLY reads
 *
 * Personal scope is first because that is where it was reported, and because
 * personal evidence is the case where a workspace-scoped shortcut would hide
 * the bug. Organization is covered too, so the fix is not personal-only.
 *
 * It asserts the FIELDS, not a hand-written expectation of what the verdict
 * should be: the point is that three responses agree, and a suite that
 * restated the rule would pass while they disagreed with each other.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

type Projection = Record<string, unknown> | undefined;

describe("Evidence lifecycle parity across read surfaces (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let organizationId: string;
  /** The personal space is a Team too, so it has an Organization container. */
  let personalOrganizationId: string;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    const team = await prisma.team.findUniqueOrThrow({
      where: { id: harness.fixtures.teamA.teamId },
      select: { organizationId: true },
    });
    organizationId = team.organizationId as string;
    const personalTeam = await prisma.team.findUniqueOrThrow({
      where: { id: harness.fixtures.personal.teamId },
      select: { organizationId: true },
    });
    personalOrganizationId = personalTeam.organizationId as string;
  }, 600_000);

  afterAll(async () => {
    await harness?.cleanup();
  });

  let seq = 0;
  const tag = () => `${Math.floor(performance.now() * 1000)}-${(seq += 1)}`;

  async function seedRecord(over: {
    teamId: string | null;
    organizationId: string | null;
    ownerUserId: string;
  }): Promise<string> {
    const row = await prisma.evidence.create({
      data: {
        title: `Fictional parity record ${tag()}`,
        type: "PHOTO",
        status: "CREATED",
        teamId: over.teamId,
        organizationId: over.organizationId,
        ownerUserId: over.ownerUserId,
      } as never,
      select: { id: true },
    });
    return row.id;
  }

  async function get(url: string, token: string) {
    const res = await harness.app.inject({
      method: "GET",
      url,
      headers: { authorization: `Bearer ${token}` },
    });
    return { status: res.statusCode, body: res.json() as Record<string, unknown> };
  }

  /** The three surfaces' lifecycle projections for one record. */
  async function projectionsFor(evidenceId: string, token: string, listUrl: string) {
    const list = await get(listUrl, token);
    expect(list.status, "the Library list must load").toBe(200);
    const items = (list.body.items ?? list.body.evidence ?? []) as Array<
      Record<string, unknown>
    >;
    const row = items.find((i) => i.id === evidenceId);

    const detail = await get(`/v1/evidence/${evidenceId}`, token);
    expect(detail.status, "the canonical detail response must load").toBe(200);

    const workspace = await get(`/v1/evidence/${evidenceId}/review-workspace`, token);
    expect(workspace.status, "the review workspace must load").toBe(200);

    return {
      library: row?.lifecycle as Projection,
      detail: (detail.body.evidence as Record<string, unknown> | undefined)
        ?.lifecycle as Projection,
      reviewWorkspace: (
        workspace.body.evidence as Record<string, unknown> | undefined
      )?.lifecycle as Projection,
      libraryRowPresent: Boolean(row),
    };
  }

  /** Every surface answers, and answers the same. */
  function expectAgreement(p: {
    library: Projection;
    detail: Projection;
    reviewWorkspace: Projection;
  }) {
    expect(p.detail, "GET /v1/evidence/:id must carry the projection").toBeTruthy();
    expect(
      p.reviewWorkspace,
      "the review-workspace response — the one Evidence Details actually reads — " +
        "must carry the projection, or the page can only report 'state is loading'",
    ).toBeTruthy();
    expect(p.library, "the Library row must carry the projection").toBeTruthy();

    for (const field of [
      "productState",
      "canTrash",
      "trashBlockReason",
      "canArchive",
      "archiveBlockReason",
      "canUnarchive",
      "canRestoreFromTrash",
    ] as const) {
      expect(
        p.reviewWorkspace![field],
        `review-workspace disagrees with the canonical detail response on ${field}`,
      ).toEqual(p.detail![field]);
      expect(
        p.library![field],
        `the Library row disagrees with the canonical detail response on ${field}`,
      ).toEqual(p.detail![field]);
    }
  }

  describe("PERSONAL scope — where it was reported", () => {
    const personal = () => harness.fixtures.personal;

    it("an ACTIVE eligible record: all three surfaces say it can be trashed", async () => {
      const id = await seedRecord({
        teamId: personal().teamId,
        organizationId: personalOrganizationId,
        ownerUserId: personal().userId,
      });

      const p = await projectionsFor(id, personal().token, "/v1/evidence?scope=active");
      expectAgreement(p);

      // …and the verdict is the eligible one, so this is not three surfaces
      // agreeing on a refusal.
      expect(p.detail!.productState).toBe("ACTIVE");
      expect(p.detail!.canTrash).toBe(true);
      expect(p.detail!.trashBlockReason).toBeNull();
    });

    it("teamId NULL (legacy personal shape) is not a blind spot", async () => {
      const id = await seedRecord({
        teamId: null,
        organizationId: null,
        ownerUserId: personal().userId,
      });

      const detail = await get(`/v1/evidence/${id}`, personal().token);
      const workspace = await get(
        `/v1/evidence/${id}/review-workspace`,
        personal().token,
      );
      expect(detail.status, JSON.stringify(detail.body)).toBe(200);
      expect(workspace.status, JSON.stringify(workspace.body)).toBe(200);
      const dp = (detail.body.evidence as Record<string, unknown>).lifecycle as Projection;
      const wp = (workspace.body.evidence as Record<string, unknown>)
        .lifecycle as Projection;

      expect(wp, "review-workspace must project a null-team record too").toBeTruthy();
      expect(wp!.canTrash).toEqual(dp!.canTrash);
      expect(wp!.canTrash).toBe(true);
    });

    it("under a LEGAL HOLD every surface refuses, with the same reason", async () => {
      const id = await seedRecord({
        teamId: personal().teamId,
        organizationId: personalOrganizationId,
        ownerUserId: personal().userId,
      });
      await prisma.evidenceLegalHold.create({
        data: {
          teamId: personal().teamId,
          scope: "EVIDENCE",
          evidenceId: id,
          title: `Fictional matter ${tag()}`,
          reason: "Fictional preservation obligation",
          status: "ACTIVE",
          placedByUserId: personal().userId,
        } as never,
      });

      const detail = await get(`/v1/evidence/${id}`, personal().token);
      const workspace = await get(
        `/v1/evidence/${id}/review-workspace`,
        personal().token,
      );
      const dp = (detail.body.evidence as Record<string, unknown>).lifecycle as Projection;
      const wp = (workspace.body.evidence as Record<string, unknown>)
        .lifecycle as Projection;

      expect(dp!.canTrash).toBe(false);
      expect(dp!.trashBlockReason).toBe("LEGAL_HOLD_ACTIVE");
      // The Details page must show the HOLD, never "state is loading" — a
      // record whose protection the surface cannot name is the failure this
      // whole suite exists to prevent.
      expect(wp!.canTrash).toBe(false);
      expect(wp!.trashBlockReason).toBe("LEGAL_HOLD_ACTIVE");
      expect(wp!.legalHold).toBe(true);
      expect(wp!.canArchive).toBe(false);
      expect(wp!.archiveBlockReason).toBe("LEGAL_HOLD_ACTIVE");
    });

    it("after the Details mutation, the surface it reloads shows TRASHED", async () => {
      // The Details page trashes through DELETE /v1/evidence/:id — the same
      // canonical route the Library uses — and then reloads the review
      // workspace. If the reloaded response did not carry the projection, the
      // page would go back to "state is loading" the moment it succeeded.
      const id = await seedRecord({
        teamId: personal().teamId,
        organizationId: personalOrganizationId,
        ownerUserId: personal().userId,
      });

      const before = await get(`/v1/evidence/${id}/review-workspace`, personal().token);
      expect(
        ((before.body.evidence as Record<string, unknown>).lifecycle as Projection)!
          .canTrash,
      ).toBe(true);

      const trashed = await harness.app.inject({
        method: "DELETE",
        url: `/v1/evidence/${id}`,
        headers: { authorization: `Bearer ${personal().token}` },
      });
      expect(trashed.statusCode).toBe(200);

      const after = await get(`/v1/evidence/${id}/review-workspace`, personal().token);
      const p = (after.body.evidence as Record<string, unknown>).lifecycle as Projection;
      expect(p!.productState).toBe("TRASHED");
      expect(p!.canTrash).toBe(false);
      expect(p!.trashBlockReason).toBe("ALREADY_IN_STATE");
      expect(p!.canRestoreFromTrash).toBe(true);
      // RECOVERABLE UNTIL — the panel renders this, and it was "Not recorded"
      // for a trashed record while the projection was missing.
      expect(p!.trashGraceUntilUtc).toBeTruthy();

      // It leaves the active scope and appears under trash.
      const active = await get("/v1/evidence?scope=active", personal().token);
      const trash = await get("/v1/evidence?scope=trash", personal().token);
      const ids = (b: Record<string, unknown>) =>
        ((b.items ?? []) as Array<Record<string, unknown>>).map((i) => i.id);
      expect(ids(active.body)).not.toContain(id);
      expect(ids(trash.body)).toContain(id);
    });

    it("an ARCHIVED record reports the archive verdict identically", async () => {
      const id = await seedRecord({
        teamId: personal().teamId,
        organizationId: personalOrganizationId,
        ownerUserId: personal().userId,
      });
      const archived = await harness.app.inject({
        method: "POST",
        url: `/v1/evidence/${id}/archive`,
        headers: { authorization: `Bearer ${personal().token}` },
      });
      expect(archived.statusCode).toBe(200);

      const detail = await get(`/v1/evidence/${id}`, personal().token);
      const workspace = await get(
        `/v1/evidence/${id}/review-workspace`,
        personal().token,
      );
      const dp = (detail.body.evidence as Record<string, unknown>).lifecycle as Projection;
      const wp = (workspace.body.evidence as Record<string, unknown>)
        .lifecycle as Projection;

      expect(wp!.productState).toBe("ARCHIVED");
      expect(wp!.canArchive).toEqual(dp!.canArchive);
      expect(wp!.canUnarchive).toEqual(dp!.canUnarchive);
      expect(wp!.canUnarchive).toBe(true);
      // An archived record is still trashable — the distinction the panel
      // could not draw while it had no projection at all.
      expect(wp!.canTrash).toEqual(dp!.canTrash);
      expect(wp!.canTrash).toBe(true);
    });
  });

  describe("ORGANIZATION scope — the fix is not personal-only", () => {
    it("all three surfaces agree for an org-scoped ACTIVE record", async () => {
      const org = harness.fixtures.teamA;
      const id = await seedRecord({
        teamId: org.teamId,
        organizationId,
        ownerUserId: org.ownerUserId,
      });

      const p = await projectionsFor(
        id,
        org.ownerToken,
        `/v1/evidence?scope=active&teamId=${org.teamId}`,
      );
      expectAgreement(p);
      expect(p.detail!.canTrash).toBe(true);
    });

    it("the union hold evaluator reaches the review workspace too", async () => {
      // A CASE-scoped hold names no evidence row. The list projection cannot
      // see it (it reads the Object Lock column); the DETAIL path resolves the
      // union. The review workspace must use the detail path, not the cheap
      // one, or Details would offer an action the server refuses.
      const org = harness.fixtures.teamA;
      const id = await seedRecord({
        teamId: org.teamId,
        organizationId,
        ownerUserId: org.ownerUserId,
      });
      await prisma.caseEvidenceLink.create({
        data: { caseId: org.caseId, evidenceId: id } as never,
      });
      await prisma.evidenceLegalHold.create({
        data: {
          teamId: org.teamId,
          scope: "CASE",
          caseId: org.caseId,
          title: `Fictional matter ${tag()}`,
          reason: "Fictional preservation obligation",
          status: "ACTIVE",
          placedByUserId: org.ownerUserId,
        } as never,
      });

      const workspace = await get(`/v1/evidence/${id}/review-workspace`, org.ownerToken);
      const wp = (workspace.body.evidence as Record<string, unknown>)
        .lifecycle as Projection;
      expect(wp!.canTrash).toBe(false);
      expect(wp!.trashBlockReason).toBe("LEGAL_HOLD_ACTIVE");
    });
  });
});
