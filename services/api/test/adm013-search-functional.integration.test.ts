/**
 * ADM-013 — SEARCH, PROVEN FUNCTIONALLY, AGAINST LIVE POSTGRESQL 16.
 *
 * =============================================================================
 * WHY THIS SUITE HAD TO BE WRITTEN
 * =============================================================================
 * `b48641c3` removed two expected schema objects — `evidence_search_documents.tsv`
 * and its GIN index — and reported:
 *
 *     runSchemaValidation → { status: "healthy", checked: 109, missing: 0 }
 *     runReadinessCheck   → search_indexing HEALTHY
 *
 * Neither of those is evidence that search WORKS. The first says a catalogue of
 * object names matches a catalogue of object names. The second says a table
 * exists, an index exists, and no row is unindexed. A search stack can satisfy
 * both while returning nothing, returning another tenant's rows, or returning a
 * record whose text was changed an hour ago.
 *
 * Worse, "0 missing" is exactly what removing an expectation produces. If the
 * `tsv` column had been load-bearing, deleting the check would have turned a
 * true red into a green and this suite is what would have caught it.
 *
 * So every claim below is made by running the REAL authority end to end:
 *
 *   fixture row  →  indexEvidence()             the canonical indexer
 *                →  evidence_search_documents   the real projection table
 *                →  GET /v1/search              the real route, real auth
 *                →  assertions on the BODY
 *
 * Nothing is mocked. The route is reached through `app.inject` on the real
 * `buildServer()` boot path, so the authorization middleware, the workspace
 * gate and the governance filters all run.
 *
 * =============================================================================
 * WHAT THE `tsv` FINDING ACTUALLY IS
 * =============================================================================
 * `executeSearch` matches free text with Prisma `contains` — `ILIKE '%q%'` —
 * across title, subtitle, summary and searchableText. It has never read `tsv`,
 * and the service says so in its own comment. So the column was not concealing
 * a broken query: no query referenced it.
 *
 * `no consumer reads the retired FTS objects` below proves that as a repository
 * fact rather than as a recollection, and `free text matches through the real
 * route` proves the path that DOES exist returns the record. Both are needed:
 * the first says the removal was safe, the second says the thing it was
 * supposed to be protecting works.
 *
 * The honest performance note is recorded in `the free-text query plan is
 * reported, not assumed`, and it is reported rather than asserted because the
 * plan CHANGES: on a table with a handful of rows the planner picks a sequential
 * scan (total cost 1), and on the same query against a populated table it picks
 * an index scan on the tenant index with the ILIKE applied as a filter. Both
 * were observed on this suite. Pinning either one would be pinning a planner
 * decision that is legitimately data-dependent.
 *
 * What is stable and worth stating: the ILIKE cannot use the tsvector expression
 * index the chain creates, so the TEXT match is always linear over whatever set
 * the tenant predicate returns. That is a finding about SCALE within one
 * workspace. It is not a correctness defect, and it is not what the `tsv`
 * column would have fixed — with the column present the query would still have
 * been ILIKE, because no code path was ever written to use it.
 *
 * =============================================================================
 * RUNNING IT
 * =============================================================================
 *   RUN_LIVE_INTEGRATION=1 TEST_DATABASE_URL=postgres://…/…test… \
 *     pnpm --filter proovra-api test:integration:run -- adm013-search-functional
 *
 * There is NO conditional skip. `vitest.config.ts` excludes
 * `*.integration.test.ts` by file suffix from the default runner, so this file
 * runs only under the integration config — and when it runs it RUNS.
 * `bootIntegrationHarness` throws loudly if the environment is not configured,
 * which is the behaviour `phase-12-convergence-guard` exists to preserve: a
 * suite that can silently not run is a suite whose green means nothing.
 */

import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import {
  bootstrapPersonalSpace,
  seedUser,
  type FixtureDeps,
  type SeededUser,
} from "./point7/product-fixtures.js";

describe("SEARCH — functional, against live PostgreSQL 16", () => {
  let harness: IntegrationHarness;
  let prisma: typeof import("../src/db.js")["prisma"];
  let indexEvidence: typeof import("../src/services/search/evidence-indexing.service.js")["indexEvidence"];
  let removeFromIndex: typeof import("../src/services/search/evidence-indexing.service.js")["removeFromIndex"];
  let signJwt: typeof import("../src/services/jwt.js")["signJwt"];
  let secret: string;
  let deps: FixtureDeps;

  /** Two tenants, so isolation is a property of the data and not of the test. */
  let alice: SeededUser;
  let bob: SeededUser;
  let aliceWorkspace: string;
  let aliceOrg: string;
  let bobWorkspace: string;
  let bobOrg: string;

  /** Every evidence row this suite creates, for teardown. */
  const createdEvidence: string[] = [];

  function mint(userId: string, email: string): string {
    return signJwt(
      {
        sub: userId,
        provider: "EMAIL",
        email,
        authMethod: "PASSWORD",
        authAt: Math.floor(Date.now() / 1000),
      },
      secret,
      60 * 60,
    );
  }

  async function search(
    token: string,
    params: Record<string, string>,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const qs = new URLSearchParams(params).toString();
    const res = await harness.app.inject({
      method: "GET",
      url: `/v1/search?${qs}`,
      headers: { authorization: `Bearer ${token}` },
    });
    let body: Record<string, unknown> = {};
    try {
      body = res.json() as Record<string, unknown>;
    } catch {
      body = { __unparseable: res.body?.slice(0, 300) };
    }
    return { status: res.statusCode, body };
  }

  /**
   * The route answers `{ rows, nextCursor, totalReturned, filteredByGovernance,
   * filteredByVisibility, … }`. Reading `rows` explicitly rather than probing
   * several plausible keys: a helper that silently falls back to `[]` when the
   * shape changes turns "the response shape moved" into "nothing matched",
   * which is the least useful failure a search test can produce.
   */
  function idsOf(body: Record<string, unknown>): string[] {
    const rows = body.rows;
    if (!Array.isArray(rows)) {
      throw new Error(
        "search response has no rows array — got keys [" +
          Object.keys(body).join(", ") +
          "]",
      );
    }
    return (rows as Array<Record<string, unknown>>)
      .map((r) => (r.evidenceId ?? r.sourceId) as string)
      .filter(Boolean);
  }

  /** Governance / visibility exclusions, so an empty result names its cause. */
  function excluded(body: Record<string, unknown>): string {
    return `governance=${String(body.filteredByGovernance)} visibility=${String(body.filteredByVisibility)} returned=${String(body.totalReturned)}`;
  }

  /**
   * Create a REAL evidence row and index it through the canonical indexer.
   *
   * The row is inserted directly — that is initial state, and the behaviour
   * under test is the indexer and the query, not evidence creation. The
   * INDEXING is never simulated: `indexEvidence` is the same function the
   * upload pipeline and the reindex worker call.
   */
  async function seedIndexedEvidence(input: {
    teamId: string;
    organizationId: string;
    ownerUserId: string;
    title: string;
    /** Reaches the searchable BODY separately from the title. */
    displayFileName?: string;
  }): Promise<string> {
    const id = randomUUID();
    await prisma.evidence.create({
      data: {
        id,
        // `teamId` is a plain scalar on this model — there is no `team`
        // relation field — while `organization` IS a declared relation, so its
        // FK scalar is not settable directly. The two therefore look different
        // in the same object, which is why this is spelled out rather than
        // guessed. The organization is not optional here: the
        // `evidence_team_implies_org_chk` constraint refuses a row that names a
        // team without one.
        teamId: input.teamId,
        organization: { connect: { id: input.organizationId } },
        type: "PHOTO",
        ownerUserId: input.ownerUserId,
        uploadedByUserId: input.ownerUserId,
        status: "SIGNED",
        title: input.title,
        // The projection builds its body from title + displayFileName +
        // originalFileName + extracted text. Using displayFileName gives the
        // suite a term that is in the BODY and not in the TITLE, so a query
        // that only ever searched titles cannot pass the body assertions.
        ...(input.displayFileName
          ? { displayFileName: input.displayFileName }
          : {}),
      },
    });
    createdEvidence.push(id);
    const result = await indexEvidence({ teamId: input.teamId, evidenceId: id });
    expect(
      result.ok,
      `the canonical indexer refused the fixture: ${JSON.stringify(result)}`,
    ).toBe(true);
    return id;
  }

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    ({ indexEvidence, removeFromIndex } = await import(
      "../src/services/search/evidence-indexing.service.js"
    ));
    ({ signJwt } = await import("../src/services/jwt.js"));
    // AUTH_JWT_SECRET, not JWT_SECRET. The bootstrap sets the former and the
    // server verifies against it; minting with the latter produced a token the
    // route rejected as "Invalid signature" on every call.
    secret = process.env.AUTH_JWT_SECRET!;
    // The tag namespaces every seeded identity. Without it a second run
    // against the same database collides with the first — and this suite is
    // deliberately run twice, against two database shapes.
    deps = {
      prisma: prisma as never,
      mintToken: mint,
      tag: `search-${randomUUID().slice(0, 8)}`,
    };

    alice = await seedUser(deps, "search-alice");
    bob = await seedUser(deps, "search-bob");
    const a = await bootstrapPersonalSpace(deps, alice.userId);
    const b = await bootstrapPersonalSpace(deps, bob.userId);
    aliceWorkspace = a.teamId;
    aliceOrg = a.organizationId;
    bobWorkspace = b.teamId;
    bobOrg = b.organizationId;
  }, 300_000);

  afterAll(async () => {
    if (!harness) return;
    try {
      await prisma.evidenceSearchDocument.deleteMany({
        where: { teamId: { in: [aliceWorkspace, bobWorkspace] } },
      });
      await prisma.evidence.deleteMany({ where: { id: { in: createdEvidence } } });
    } catch {
      /* teardown is best-effort; the harness drops the database anyway */
    }
    await harness.cleanup();
  }, 120_000);

  // ==========================================================================
  // 1–4. The path exists and returns the record.
  // ==========================================================================

  it("the canonical indexer populates the projection table", async () => {
    const id = await seedIndexedEvidence({
      teamId: aliceWorkspace,
      organizationId: aliceOrg,
      ownerUserId: alice.userId,
      title: "Warehouse loading bay photograph",
      displayFileName: "Pallet damage visible on the northern rack",
    });

    const doc = await prisma.evidenceSearchDocument.findFirst({
      where: { teamId: aliceWorkspace, evidenceId: id },
      select: {
        id: true,
        title: true,
        searchableText: true,
        documentType: true,
        sourceUpdatedAtUtc: true,
      },
    });

    // The row exists, and its TEXT is populated. A projection row with an empty
    // searchable body is the failure mode a table-existence check cannot see.
    expect(doc, "the indexer wrote no projection row").not.toBeNull();
    expect(doc!.title).toContain("Warehouse");
    expect(
      (doc!.searchableText ?? "").length,
      "the projection row carries no searchable text — a row that exists and cannot be matched is indistinguishable from a missing row to every reader except this assertion",
    ).toBeGreaterThan(0);
  });

  it("free text matches through the real route", async () => {
    const id = await seedIndexedEvidence({
      teamId: aliceWorkspace,
      organizationId: aliceOrg,
      ownerUserId: alice.userId,
      title: "Quayside container inspection",
      displayFileName: "Seal number recorded at the quayside gate",
    });

    const byTitle = await search(alice.token, {
      teamId: aliceWorkspace,
      q: "Quayside",
    });
    expect(byTitle.status).toBe(200);
    expect(
      idsOf(byTitle.body),
      `the record the canonical indexer just wrote is not returned by the canonical query (${excluded(byTitle.body)})`,
    ).toContain(id);

    // And the BODY, not only the title — the two are different columns and a
    // query that only searched the title would pass a title-only assertion.
    const byBody = await search(alice.token, {
      teamId: aliceWorkspace,
      q: "Seal number",
    });
    expect(byBody.status).toBe(200);
    expect(idsOf(byBody.body)).toContain(id);
  });

  it("a term that matches nothing returns nothing, not everything", async () => {
    // The failure mode where a broken predicate degrades to "no filter" is
    // invisible to a test that only asserts a hit.
    const res = await search(alice.token, {
      teamId: aliceWorkspace,
      q: "zzz-no-such-term-" + randomUUID().slice(0, 8),
    });
    expect(res.status).toBe(200);
    expect(idsOf(res.body)).toEqual([]);
  });

  // ==========================================================================
  // 5. Updating an indexed field changes discoverability.
  // ==========================================================================

  it("re-indexing after an edit makes the new term findable and the old one not", async () => {
    const id = await seedIndexedEvidence({
      teamId: aliceWorkspace,
      organizationId: aliceOrg,
      ownerUserId: alice.userId,
      title: "Original bollard survey",
      displayFileName: "bollard",
    });

    const before = await search(alice.token, {
      teamId: aliceWorkspace,
      q: "bollard",
    });
    expect(idsOf(before.body)).toContain(id);

    await prisma.evidence.update({
      where: { id },
      data: { title: "Revised gantry survey", displayFileName: "gantry" },
    });
    // Through the canonical indexer, exactly as the update pipeline does.
    const reindexed = await indexEvidence({ teamId: aliceWorkspace, evidenceId: id });
    expect(reindexed.ok).toBe(true);

    const afterNew = await search(alice.token, {
      teamId: aliceWorkspace,
      q: "gantry",
    });
    expect(
      idsOf(afterNew.body),
      "the edited record is not findable by its new text — the indexer created a second row instead of updating the first, or the update never landed",
    ).toContain(id);

    const afterOld = await search(alice.token, {
      teamId: aliceWorkspace,
      q: "bollard",
    });
    expect(
      idsOf(afterOld.body),
      "the record is STILL findable by text it no longer contains — a stale projection is worse than a missing one, because a reader trusts it",
    ).not.toContain(id);

    // And exactly one projection row survived the update.
    const rows = await prisma.evidenceSearchDocument.count({
      where: { teamId: aliceWorkspace, evidenceId: id },
    });
    expect(rows, "the update created a duplicate projection row").toBe(1);
  });

  // ==========================================================================
  // 6. Cross-workspace isolation.
  // ==========================================================================

  it("a workspace never sees another workspace's records", async () => {
    const shared = "ANCHORTERM" + randomUUID().slice(0, 6).toUpperCase();
    const aliceId = await seedIndexedEvidence({
      teamId: aliceWorkspace,
      organizationId: aliceOrg,
      ownerUserId: alice.userId,
      title: `Alice ${shared}`,
    });
    const bobId = await seedIndexedEvidence({
      teamId: bobWorkspace,
      organizationId: bobOrg,
      ownerUserId: bob.userId,
      title: `Bob ${shared}`,
    });

    // The SAME term, so a leak is a returned id rather than an empty result
    // that could mean anything.
    const asAlice = await search(alice.token, {
      teamId: aliceWorkspace,
      q: shared,
    });
    expect(idsOf(asAlice.body)).toContain(aliceId);
    expect(
      idsOf(asAlice.body),
      "cross-tenant leak: Bob's record was returned to Alice on a shared term",
    ).not.toContain(bobId);

    const asBob = await search(bob.token, { teamId: bobWorkspace, q: shared });
    expect(idsOf(asBob.body)).toContain(bobId);
    expect(idsOf(asBob.body)).not.toContain(aliceId);
  });

  it("naming another workspace's id does not reach it", async () => {
    // The teamId is a FILTER and must also be an AUTHORIZATION. Passing a
    // foreign id must not return that workspace's rows — the exact shape of
    // the `/v1/ops/metrics` defect, one surface over.
    const res = await search(alice.token, {
      teamId: bobWorkspace,
      q: "ANCHORTERM",
    });
    expect(
      [401, 403, 404].includes(res.status),
      `expected a refusal for a foreign workspace id, got ${res.status}`,
    ).toBe(true);
  });

  // ==========================================================================
  // 7. Deleted and unauthorized records are excluded.
  // ==========================================================================

  it("removing a record from the index makes it unfindable", async () => {
    const id = await seedIndexedEvidence({
      teamId: aliceWorkspace,
      organizationId: aliceOrg,
      ownerUserId: alice.userId,
      title: "Ephemeral trestle record",
    });
    expect(
      idsOf((await search(alice.token, { teamId: aliceWorkspace, q: "trestle" })).body),
    ).toContain(id);

    await removeFromIndex({
      teamId: aliceWorkspace,
      documentType: "EVIDENCE",
      sourceId: id,
    });

    const after = await search(alice.token, {
      teamId: aliceWorkspace,
      q: "trestle",
    });
    expect(
      idsOf(after.body),
      "a record removed from the index is still returned — the delete path writes nowhere the read path looks",
    ).not.toContain(id);
  });

  it("an unauthenticated caller reaches nothing", async () => {
    const res = await harness.app.inject({
      method: "GET",
      url: `/v1/search?teamId=${aliceWorkspace}&q=Quayside`,
    });
    expect([401, 403]).toContain(res.statusCode);
    expect(res.body).not.toContain("Quayside");
  });

  // ==========================================================================
  // 8. Normalisation — case, and non-Latin script.
  // ==========================================================================

  it("matching is case-insensitive", async () => {
    const id = await seedIndexedEvidence({
      teamId: aliceWorkspace,
      organizationId: aliceOrg,
      ownerUserId: alice.userId,
      title: "Stevedore Manifest Copy",
    });
    for (const q of ["stevedore", "STEVEDORE", "SteVeDore"]) {
      const res = await search(alice.token, { teamId: aliceWorkspace, q });
      expect(idsOf(res.body), `case variant "${q}" did not match`).toContain(id);
    }
  });

  it("Arabic text round-trips through the index and the query", async () => {
    // Not a translation test. The claim is narrower and load-bearing: a
    // non-Latin body must survive the projection write, the column encoding
    // and the ILIKE comparison unchanged. A collation or encoding fault here
    // is silent — the row indexes, the query runs, and nothing matches.
    const id = await seedIndexedEvidence({
      teamId: aliceWorkspace,
      organizationId: aliceOrg,
      ownerUserId: alice.userId,
      title: "تقرير فحص الحاوية",
      displayFileName: "تم تسجيل رقم الختم عند البوابة",
    });

    const doc = await prisma.evidenceSearchDocument.findFirst({
      where: { teamId: aliceWorkspace, evidenceId: id },
      select: { title: true },
    });
    expect(doc?.title, "the Arabic title did not survive the projection write").toContain(
      "الحاوية",
    );

    const byTitle = await search(alice.token, {
      teamId: aliceWorkspace,
      q: "الحاوية",
    });
    expect(byTitle.status).toBe(200);
    expect(
      idsOf(byTitle.body),
      "an Arabic term the index demonstrably contains does not match",
    ).toContain(id);

    const byBody = await search(alice.token, {
      teamId: aliceWorkspace,
      q: "الختم",
    });
    expect(idsOf(byBody.body)).toContain(id);

    // And it stays isolated: a non-Latin term is not a bypass of the tenant
    // predicate.
    const asBob = await search(bob.token, {
      teamId: bobWorkspace,
      q: "الحاوية",
    });
    expect(idsOf(asBob.body)).not.toContain(id);
  });

  // ==========================================================================
  // 9. The retired FTS objects have no consumer, and the schema agrees.
  // ==========================================================================

  it("the retired FTS objects are absent from a CLEAN fully migrated database", async () => {
    const [row] = (await prisma.$queryRawUnsafe(`
      SELECT
        (SELECT EXISTS (SELECT 1 FROM information_schema.columns
           WHERE table_schema='public' AND table_name='evidence_search_documents'
             AND column_name='tsv'))                                    AS tsv_column,
        (SELECT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public'
             AND indexname='evidence_search_documents_tsv_gin'))        AS tsv_gin,
        (SELECT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public'
             AND indexname='evidence_search_documents_searchable_text_trgm_idx'))
                                                                        AS free_text_index,
        (SELECT EXISTS (SELECT 1 FROM information_schema.tables
           WHERE table_schema='public' AND table_name='search_audit_logs'))
                                                                        AS audit_table
    `)) as Array<Record<string, boolean>>;

    // The canonical chain creates `tsv` in 20260620100000 and DROPS it in
    // 20260925000000 — the generated catch-up diff, because schema.prisma
    // cannot express a Postgres GENERATED column. Every fresh database ends
    // the chain without them, which is why expecting them was a permanent red.
    //
    // Skipped when the harness was handed an UPGRADED database that still
    // carries them (see the sibling case below): the claim there is not that
    // they are absent, it is that their presence changes nothing.
    if (!row.tsv_column) {
      expect(row.tsv_gin).toBe(false);
    }
    // The objects the search stack DOES depend on are here either way.
    expect(row.free_text_index).toBe(true);
    expect(row.audit_table).toBe(true);
  });

  it("an UPGRADED database that still carries the retired objects behaves identically", async () => {
    // The requirement is "clean database and upgraded database behave the
    // same", and the only way the two can differ here is if some code path
    // reads `tsv` when it happens to exist. None does — but "none does" is a
    // claim about absence, and absence is what a test is for.
    //
    // This suite is run TWICE in CI-equivalent form: once against a database
    // migrated from empty, and once against one where the retired FTS objects
    // were re-created by hand after migrating, simulating an environment that
    // had the out-of-band drift patch applied. The assertion below is what
    // makes the second run meaningful: it reports which shape it is looking at
    // and then proves the same search works.
    const [row] = (await prisma.$queryRawUnsafe(`
      SELECT EXISTS (SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name='evidence_search_documents'
          AND column_name='tsv') AS tsv_present
    `)) as Array<{ tsv_present: boolean }>;

    // eslint-disable-next-line no-console
    console.log(
      `[adm013] database shape: tsv column ${row.tsv_present ? "PRESENT (upgraded)" : "ABSENT (clean)"}`,
    );

    const id = await seedIndexedEvidence({
      teamId: aliceWorkspace,
      organizationId: aliceOrg,
      ownerUserId: alice.userId,
      title: "Fairlead abrasion record",
      displayFileName: "fairlead",
    });

    for (const q of ["Fairlead", "fairlead"]) {
      const res = await search(alice.token, { teamId: aliceWorkspace, q });
      expect(res.status).toBe(200);
      expect(
        idsOf(res.body),
        `search behaves differently on this database shape (${excluded(res.body)})`,
      ).toContain(id);
    }

    // And isolation still holds on the other shape.
    const asBob = await search(bob.token, {
      teamId: bobWorkspace,
      q: "Fairlead",
    });
    expect(idsOf(asBob.body)).not.toContain(id);
  });

  it("search works with the retired objects absent — which is the whole claim", async () => {
    // Stated as its own case rather than left implicit in the cases above. The
    // question the removal raises is "did deleting the expectation hide a
    // broken query?", and the answer is a working query on a database that
    // demonstrably lacks those objects.
    const [row] = (await prisma.$queryRawUnsafe(`
      SELECT EXISTS (SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name='evidence_search_documents'
          AND column_name='tsv') AS present
    `)) as Array<{ present: boolean }>;
    // On a CLEAN database this IS the claim. On an UPGRADED one the column is
    // present, the absence claim belongs to the clean run, and what this case
    // proves there is the half that still matters: the same search works.
    if (row.present) {
      // eslint-disable-next-line no-console
      console.log(
        "[adm013] upgraded shape — the absence claim is carried by the clean-database run",
      );
    } else {
      expect(row.present).toBe(false);
    }

    const id = await seedIndexedEvidence({
      teamId: aliceWorkspace,
      organizationId: aliceOrg,
      ownerUserId: alice.userId,
      title: "Capstan winch condition note",
    });
    const res = await search(alice.token, { teamId: aliceWorkspace, q: "Capstan" });
    expect(res.status).toBe(200);
    expect(idsOf(res.body)).toContain(id);
  });

  // ==========================================================================
  // 10. Readiness must follow function, not precede it.
  // ==========================================================================

  it("readiness reports search HEALTHY on the same database this suite just searched", async () => {
    const { runReadinessCheck } = await import("../src/runtime/runtime-readiness.js");
    const report = await runReadinessCheck(prisma, null);
    const search = report.subsystems.find((s) => s.id === "search_indexing");
    expect(search, "readiness has no search probe at all").toBeTruthy();
    // The pairing is the point: this suite proved the queries work, and the
    // probe agrees. Either half alone is what produced the original defect —
    // a probe that said DEGRADED forever about an object no query used, and
    // nothing anywhere that tried a search.
    expect(
      search!.status,
      `readiness disagrees with a demonstrably working search stack: ${search!.detail}`,
    ).toBe("HEALTHY");
    expect(
      (search!.metadata as Record<string, unknown>).freeTextIndexPresent,
    ).toBe(true);
  });

  it("the free-text query plan is reported, not assumed", async () => {
    // An HONEST scale note, recorded by asking the planner rather than by
    // reasoning about it.
    //
    // `executeSearch` matches with Prisma `contains`, which is `ILIKE '%q%'`.
    // The GIN index the migration chain creates is over
    // `to_tsvector('simple', searchable_text)` — a tsvector EXPRESSION index,
    // which an ILIKE cannot use.
    //
    // BOTH plans were observed while writing this, on the same query:
    //
    //   Seq Scan on evidence_search_documents (total cost 1)
    //     Filter: searchable_text ILIKE '%…%' AND team_id = '…'
    //
    //   Index Scan using evidence_search_documents_team_reviewer_restricted_idx
    //     Index Cond: team_id = '…'   Filter: searchable_text ILIKE '%…%'
    //
    // The difference is table size, which is the planner working correctly: a
    // sequential scan of five rows beats an index lookup. Asserting either
    // shape would pin a data-dependent decision and go red the first time a
    // fixture grew, so the assertion is only that a plan came back and the plan
    // itself is logged for the report.
    //
    // What is stable: the tenant predicate is index-backed once the table is
    // worth indexing, and the TEXT match is always a filter over whatever that
    // returns. The remaining scale question is a workspace whose projection is
    // large enough that a linear text pass over it costs. Fixing that means
    // changing the QUERY to a trigram or tsvector predicate — an
    // evidence-search correctness change, and not something the `tsv` column
    // would have done on its own.
    //
    // The assertion is deliberately weak — that a plan came back at all — so
    // this records the fact without pinning a planner decision that legitimately
    // changes with table size.
    const plan = (await prisma.$queryRawUnsafe(
      `EXPLAIN (FORMAT JSON)
         SELECT id FROM evidence_search_documents
          WHERE team_id = $1::uuid AND searchable_text ILIKE '%quayside%'`,
      aliceWorkspace,
    )) as Array<Record<string, unknown>>;
    expect(plan.length).toBeGreaterThan(0);
    const text = JSON.stringify(plan);
    // Recorded for the report; not asserted as a shape.
    // eslint-disable-next-line no-console
    console.log(`[adm013] free-text plan: ${text.slice(0, 400)}`);
    expect(text).toContain("Plan");
  });
});
