/**
 * EVERY IDENTIFIER PROOVRA SHOWS A PERSON MUST FIND THE RECORD IT NAMES.
 *
 * WHAT THIS SUITE IS FOR
 * ---------------------------------------------------------------------------
 * A previous closure reported that Customer ID, contributor name, email and
 * phone were searchable end to end. Production then could not find records by
 * Customer ID, by phone, or by the reference Operations prints in its own
 * incident titles — "RFC3161 timestamp missing for record 76b5d6ac".
 *
 * The closure was not lying about the code; it was measuring a fixture whose
 * documents had all just been written by the current builder. Three separate
 * defects were hiding behind that:
 *
 *   1. THE RECORD REFERENCE WAS NEVER SEARCHABLE ANYWHERE. It is the first
 *      eight hex characters of the Evidence UUID, used as a label whenever a
 *      record has no title. The indexed body holds titles, filenames, intake
 *      identity and extracted text — never the id — and neither surface
 *      matched on the id column either. The full UUID worked on the Evidence
 *      list and nowhere else.
 *
 *   2. A PARTIAL PHONE NUMBER FOUND THE RECORD ON ONE SURFACE ONLY. The
 *      Evidence list matched the indexed E.164 column with the digits of what
 *      was typed; global search did a literal `contains` of the typed string,
 *      so "1234 5678" found the record in one place and not the other.
 *
 *   3. A DOCUMENT WRITTEN BY AN OLDER BUILDER WAS NEVER REFRESHED. The
 *      reindex looked for evidence with NO document; a record that already
 *      had one was invisible to every repair path. So every record indexed
 *      before intake identity was added to the projection stayed unfindable
 *      by those identifiers, and each reindex reported success.
 *
 * So this suite asserts the CONTRACT — which identifiers resolve, on which
 * surface — and it asserts it on both an old record and a new one, because
 * those are the two cases that differ and only one of them was ever tested.
 *
 * The data is shaped so a false positive is impossible: a second workspace
 * holds a deliberately similar Customer ID and a phone number sharing the same
 * final digits, and every identifier from the first workspace is asked for
 * from the second.
 */

import {
  SEARCH_PROJECTION_VERSION,
  evidenceRecordRef,
} from "@proovra/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import {
  seedOwnedWorkspace,
  seedUser,
  setAccountPlan,
  type FixtureDeps,
} from "./point7/product-fixtures.js";

describe("EVIDENCE IDENTIFIER SEARCH — contract (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: typeof import("../src/db.js")["prisma"];
  let deps: FixtureDeps;

  // Workspace A — the record every probe is looking for.
  let teamA: string;
  let ownerA: string;
  let tokenA: string;
  /** Indexed by the CURRENT builder. */
  let newEvidenceId: string;
  /** Document deliberately written the way the previous builder wrote one. */
  let oldEvidenceId: string;

  // Workspace B — deliberately similar, and must never leak.
  let teamB: string;
  let ownerB: string;
  let tokenB: string;

  const CUSTOMER_ID = "CUST-SEARCH-9174";
  const PHONE_TYPED = "+49 174 906 1823";
  const PHONE_E164 = "+491749061823";
  /** Same final digits as A's number, different subscriber. */
  const B_CUSTOMER_ID = "CUST-SEARCH-9175";
  const B_PHONE_E164 = "+491759061823";

  const seedIntakeRecord = async (opts: {
    teamId: string;
    ownerUserId: string;
    organizationId: string;
    customerId: string;
    phoneE164: string;
    phoneTyped: string;
    label: string;
  }) => {
    const link = await prisma.workflowIntakeLink.create({
      data: {
        teamId: opts.teamId,
        workflowTemplateSlug: "general-evidence-record",
        workflowTemplateVersion: 1,
        workflowTemplateSnapshot: {},
        intakeMode: "EXTERNAL_ONE_TIME",
        // Both are NOT NULL with no default; the product always supplies them.
        allowedAcceptedKinds: [],
        ipAllowlistCidrs: [],
        tokenHash: `hash-${deps.tag}-${opts.customerId}-${Math.random().toString(36).slice(2)}`,
        expiresAtUtc: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        createdByUserId: opts.ownerUserId,
        customerId: opts.customerId,
        recipientLabel: opts.label,
        recipientPhone: opts.phoneTyped,
        recipientPhoneE164: opts.phoneE164,
      } as never,
      select: { id: true },
    });
    const evidence = await prisma.evidence.create({
      data: {
        ownerUserId: opts.ownerUserId,
        teamId: opts.teamId,
        organizationId: opts.organizationId,
        type: "PHOTO",
        status: "SIGNED",
        captureMethod: "EXTERNAL_INTAKE_UPLOAD",
        intakeCustomerId: opts.customerId,
      } as never,
      select: { id: true },
    });
    await prisma.workflowIntakeSession.create({
      data: {
        intakeLinkId: link.id,
        evidenceId: evidence.id,
        expiresAtUtc: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      } as never,
    });
    return evidence.id;
  };

  const globalSearch = async (token: string, teamId: string, q: string) => {
    const res = await harness.app.inject({
      method: "GET",
      url: `/v1/search?teamId=${teamId}&q=${encodeURIComponent(q)}`,
      headers: { authorization: `Bearer ${token}` },
    });
    if (res.statusCode !== 200) return { status: res.statusCode, ids: [] as string[] };
    // The envelope is `{ rows, nextBeforeUtc }` — reading `results` returned
    // an empty array for every probe, which made the isolation assertions pass
    // without asking anything.
    const body = JSON.parse(res.body) as {
      rows?: Array<{ evidenceId?: string | null; sourceId?: string }>;
    };
    const rows = body.rows ?? [];
    return {
      status: 200,
      ids: rows.map((r) => r.evidenceId ?? r.sourceId ?? "").filter(Boolean),
    };
  };

  const evidenceSearch = async (token: string, teamId: string, q: string) => {
    const res = await harness.app.inject({
      method: "GET",
      url: `/v1/evidence?scope=all&limit=100&teamId=${teamId}&search=${encodeURIComponent(q)}`,
      headers: { authorization: `Bearer ${token}` },
    });
    if (res.statusCode !== 200) return { status: res.statusCode, ids: [] as string[] };
    const body = JSON.parse(res.body) as { items?: Array<{ id: string }> };
    return { status: 200, ids: (body.items ?? []).map((r) => r.id) };
  };

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    await import("../src/register-shared-runtime.js");

    const { signJwt } = await import("../src/services/jwt.js");
    const secret = process.env.AUTH_JWT_SECRET!;
    deps = {
      prisma: prisma as never,
      tag: `idsearch-${Date.now().toString(36)}`,
      mintToken: (userId, email) =>
        signJwt(
          {
            sub: userId,
            provider: "EMAIL",
            email,
            authMethod: "PASSWORD",
            authAt: Math.floor(Date.now() / 1000),
          },
          secret,
          60 * 60,
        ),
    };

    const a = await seedUser(deps, "id-a");
    ownerA = a.userId;
    tokenA = deps.mintToken(a.userId, "id-a@example.test");
    await setAccountPlan(deps, a.userId, "TEAM");
    const wsA = await seedOwnedWorkspace(deps, {
      ownerUserId: a.userId,
      billingPlan: "TEAM",
      billingStatus: "ACTIVE",
    });
    teamA = wsA.teamId;

    const b = await seedUser(deps, "id-b");
    ownerB = b.userId;
    tokenB = deps.mintToken(b.userId, "id-b@example.test");
    await setAccountPlan(deps, b.userId, "TEAM");
    const wsB = await seedOwnedWorkspace(deps, {
      ownerUserId: b.userId,
      billingPlan: "TEAM",
      billingStatus: "ACTIVE",
    });
    teamB = wsB.teamId;

    newEvidenceId = await seedIntakeRecord({
      teamId: teamA,
      ownerUserId: ownerA,
      organizationId: wsA.organizationId,
      customerId: CUSTOMER_ID,
      phoneE164: PHONE_E164,
      phoneTyped: PHONE_TYPED,
      label: "Contributor A",
    });
    oldEvidenceId = await seedIntakeRecord({
      teamId: teamA,
      ownerUserId: ownerA,
      organizationId: wsA.organizationId,
      customerId: CUSTOMER_ID,
      phoneE164: PHONE_E164,
      phoneTyped: PHONE_TYPED,
      label: "Contributor A",
    });

    // Workspace B — similar enough that a missing tenant predicate shows up.
    await seedIntakeRecord({
      teamId: teamB,
      ownerUserId: ownerB,
      organizationId: wsB.organizationId,
      customerId: B_CUSTOMER_ID,
      phoneE164: B_PHONE_E164,
      phoneTyped: "+49 175 906 1823",
      label: "Contributor B",
    });

    const { indexEvidence } = await import(
      "../src/services/search/evidence-indexing.service.js"
    );
    for (const [teamId, id] of [
      [teamA, newEvidenceId],
      [teamA, oldEvidenceId],
    ] as const) {
      const r = await indexEvidence({ teamId, evidenceId: id });
      expect(r.ok, `indexing ${id} failed`).toBe(true);
    }
    // and workspace B's record, so it is genuinely present in the index
    const bEvidence = await prisma.evidence.findFirstOrThrow({
      where: { teamId: teamB },
      select: { id: true },
    });
    await indexEvidence({ teamId: teamB, evidenceId: bEvidence.id });

    /*
     * THE OLD RECORD. Rewritten to what the PREVIOUS builder produced: a body
     * with no intake identity, stamped with the version that produced it.
     * This is the production state — not a hypothetical, and not something the
     * fixture would ever reach on its own, which is exactly why the previous
     * closure could not see it.
     */
    await prisma.evidenceSearchDocument.updateMany({
      where: { teamId: teamA, documentType: "EVIDENCE", sourceId: oldEvidenceId },
      data: { searchableText: "old-body.png", projectionVersion: 1 },
    });
  });

  afterAll(async () => {
    await harness?.cleanup?.();
  });

  // =========================================================================
  // THE CONTRACT — a record indexed by the CURRENT builder
  // =========================================================================

  it("the Evidence list finds the record by every identifier a person can hold", async () => {
    const ref = evidenceRecordRef(newEvidenceId);
    for (const [name, q] of [
      ["Customer ID", CUSTOMER_ID],
      ["phone as typed", PHONE_TYPED],
      ["phone E.164", PHONE_E164],
      ["phone with 00 prefix", PHONE_E164.replace("+", "00")],
      ["partial phone", "9061823"],
      ["contributor name", "Contributor A"],
      ["full Evidence UUID", newEvidenceId],
      ["record reference", ref],
    ] as const) {
      const r = await evidenceSearch(tokenA, teamA, q);
      expect(r.status, `${name} → HTTP`).toBe(200);
      expect(r.ids, `${name} did not find the record`).toContain(newEvidenceId);
    }
  });

  it("global search finds the record by every identifier too", async () => {
    const ref = evidenceRecordRef(newEvidenceId);
    for (const [name, q] of [
      ["Customer ID", CUSTOMER_ID],
      ["phone as typed", PHONE_TYPED],
      ["phone E.164", PHONE_E164],
      ["partial phone", "9061823"],
      ["contributor name", "Contributor A"],
      ["full Evidence UUID", newEvidenceId],
      ["record reference", ref],
    ] as const) {
      const r = await globalSearch(tokenA, teamA, q);
      expect(r.status, `${name} → HTTP`).toBe(200);
      expect(r.ids, `${name} did not find the record`).toContain(newEvidenceId);
    }
  });

  it("the record reference is the one Operations prints", () => {
    // Operations renders `record ${evidence.id.slice(0, 8)}`. If that ever
    // stops agreeing with what search accepts, the product is once again
    // showing an identifier it will not answer to.
    expect(evidenceRecordRef(newEvidenceId)).toBe(
      newEvidenceId.slice(0, 8).toLowerCase(),
    );
    expect(evidenceRecordRef(newEvidenceId)).toHaveLength(8);
  });

  // =========================================================================
  // OLD RECORD vs NEW RECORD — is it code, or is it data?
  // =========================================================================

  it("a stale document is still findable by identifiers that do not use the body", async () => {
    // The id arms match the document's `sourceId` column, so they work on a
    // document of any age. This is why the record reference fix repairs
    // production immediately, with no reindex.
    const ref = evidenceRecordRef(oldEvidenceId);
    for (const q of [oldEvidenceId, ref]) {
      const r = await globalSearch(tokenA, teamA, q);
      expect(r.ids, `"${q}" should find the stale record`).toContain(oldEvidenceId);
    }
  });

  it("a stale document CANNOT be found by identity, because its body predates them", async () => {
    // The honest half. Customer ID and phone live in the indexed body, so no
    // query change can reach a document written before they were indexed —
    // only rewriting the document can. This is the production data defect,
    // reproduced.
    const r = await globalSearch(tokenA, teamA, CUSTOMER_ID);
    expect(r.ids).not.toContain(oldEvidenceId);
    expect(r.ids, "the current record must still be found").toContain(
      newEvidenceId,
    );
  });

  it("the Evidence list finds the stale record anyway — it reads live rows", async () => {
    // The two surfaces fail for different reasons, which is why the report
    // "search is broken" needed splitting before it could be fixed.
    const r = await evidenceSearch(tokenA, teamA, CUSTOMER_ID);
    expect(r.ids).toContain(oldEvidenceId);
  });

  it("the reindex repairs the stale document, and then identity finds it", async () => {
    const { runWorkspaceReindex } = await import(
      "../src/services/search/reindex.service.js"
    );

    const before = await prisma.evidenceSearchDocument.findFirstOrThrow({
      where: { teamId: teamA, documentType: "EVIDENCE", sourceId: oldEvidenceId },
      select: { projectionVersion: true },
    });
    expect(before.projectionVersion).toBeLessThan(SEARCH_PROJECTION_VERSION);

    const result = await runWorkspaceReindex({ teamId: teamA, includeCases: false });
    expect(result.evidence.stale, "the stale document was not detected").toBeGreaterThan(0);

    const after = await prisma.evidenceSearchDocument.findFirstOrThrow({
      where: { teamId: teamA, documentType: "EVIDENCE", sourceId: oldEvidenceId },
      select: { projectionVersion: true, searchableText: true },
    });
    expect(after.projectionVersion).toBe(SEARCH_PROJECTION_VERSION);
    expect(after.searchableText).toContain(CUSTOMER_ID);

    const r = await globalSearch(tokenA, teamA, CUSTOMER_ID);
    expect(r.ids, "identity still does not find the repaired record").toContain(
      oldEvidenceId,
    );
  });

  it("a second reindex does nothing — the repair is idempotent", async () => {
    const { runWorkspaceReindex } = await import(
      "../src/services/search/reindex.service.js"
    );
    const result = await runWorkspaceReindex({ teamId: teamA, includeCases: false });
    expect(result.evidence.stale).toBe(0);
    expect(result.evidence.orphans).toBe(0);
    expect(result.evidence.indexed).toBe(0);
  });

  // =========================================================================
  // ISOLATION — nothing from workspace A is reachable from workspace B
  // =========================================================================

  it("workspace B cannot find workspace A's record by ANY identifier", async () => {
    const ref = evidenceRecordRef(newEvidenceId);
    for (const [name, q] of [
      ["Customer ID", CUSTOMER_ID],
      ["phone as typed", PHONE_TYPED],
      ["phone E.164", PHONE_E164],
      ["partial phone", "9061823"],
      ["full Evidence UUID", newEvidenceId],
      ["record reference", ref],
    ] as const) {
      const g = await globalSearch(tokenB, teamB, q);
      const e = await evidenceSearch(tokenB, teamB, q);
      expect(g.ids, `global search leaked A's record via ${name}`).not.toContain(
        newEvidenceId,
      );
      expect(e.ids, `evidence search leaked A's record via ${name}`).not.toContain(
        newEvidenceId,
      );
    }
  });

  it("asking workspace A's search for workspace B's teamId is refused, not answered", async () => {
    // The scope is not a filter the caller chooses; it is an authorization
    // decision. A member of B asking about A must not get an empty list that
    // looks like "no results" — they must be refused.
    const res = await harness.app.inject({
      method: "GET",
      url: `/v1/search?teamId=${teamA}&q=${encodeURIComponent(CUSTOMER_ID)}`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect([401, 403, 404]).toContain(res.statusCode);
  });

  it("a similar identifier in B finds B's record and only B's", async () => {
    // The near-miss data earns its keep here: if the Customer ID match were
    // loosened to a prefix, or the phone match to "any 7 digits", this fails.
    const r = await evidenceSearch(tokenB, teamB, B_CUSTOMER_ID);
    expect(r.ids).not.toContain(newEvidenceId);
    expect(r.ids).not.toContain(oldEvidenceId);
    expect(r.ids.length).toBeGreaterThan(0);
  });

  // =========================================================================
  // ANTI-ENUMERATION — the reference is a reference, not a wildcard
  // =========================================================================

  it("a fragment shorter than a full reference is not treated as one", async () => {
    // Seven characters is not a shorter reference, it is a fragment. Answering
    // it would let a caller walk the id space one character at a time.
    const short = evidenceRecordRef(newEvidenceId).slice(0, 7);
    const r = await globalSearch(tokenA, teamA, short);
    expect(r.ids).not.toContain(newEvidenceId);
  });

  it("a reference matches by PREFIX, never in the middle of another id", async () => {
    // The middle eight characters of the record's own id must not find it —
    // that would be the substring implementation, and its false positives are
    // unexplainable to an operator.
    const middle = newEvidenceId.replace(/-/g, "").slice(12, 20);
    const r = await globalSearch(tokenA, teamA, middle);
    expect(r.ids).not.toContain(newEvidenceId);
  });
});
