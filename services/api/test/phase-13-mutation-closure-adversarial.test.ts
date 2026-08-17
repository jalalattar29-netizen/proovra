/**
 * PHASE 13 §B — THE ADVERSARIAL BATTERY FOR MUTATION CLOSURE.
 *
 * Every case here is a defect this module actually produced while being built,
 * and each one had the same shape: a confident number that was wrong in the
 * reassuring direction.
 *
 *   - `\bGRANT` matched the TYPE NAME `GrantProbe` inside a pure `SELECT`, so
 *     three read-only queries were reported as raw-SQL mutations.
 *   - A depth-bounded per-entrypoint DFS exhausted its budget and reported 103
 *     writers as DEAD_UNREACHABLE while organization routes plainly reach them.
 *   - `Object.keys()` on a Map is `[]`, so all fifteen BullMQ families were
 *     reported as having no processor.
 *   - The registry's shared module constants were read as identifiers, so every
 *     entry appeared to declare a producer module named `SHARED_ENQUEUE`.
 *   - `AUTHENTICATED_SUBJECT` was counted as "no authorization", turning 81
 *     correct self-bindings into findings that would have buried a real one.
 *
 * These assert the answer the module must give, not that it gives one.
 */

import { strict as assert } from "node:assert";
import { createRequire } from "node:module";
import { describe, it, vi } from "vitest";

import {
  MUTATION_FAMILIES,
  classifyMutationFamily,
  deriveDelegates,
  deriveMutationInvariants,
  evaluateMutationClosure,
  readWorkRegistry,
  terminalWriterAt,
  writerBucket,
} from "../scripts/capability-authority/mutation-closure.mjs";

const require = createRequire(import.meta.url);
/** @type {any} */
const ts = require("typescript");

vi.setConfig({ testTimeout: 300_000 });

/** Parse a fragment and hand every node to the real detector. */
function writersIn(source: string): Array<{ kind: string; target: string; op: string }> {
  const sf = ts.createSourceFile("fixture.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: Array<{ kind: string; target: string; op: string }> = [];
  const visit = (n: any) => {
    const w = terminalWriterAt(n, source);
    if (w) out.push({ kind: w.kind, target: w.target, op: w.op });
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

describe("phase 13 §B — terminal writer detection", () => {
  it("1. detects a Prisma write through ANY receiver, keyed on the model", () => {
    const found = writersIn(`
      async function f(tx: any, repo: any) {
        await prisma.evidence.update({ where: { id }, data: {} });
        await tx.case.create({ data: {} });
        await someOtherName.caseAccess.deleteMany({ where: {} });
        await repo.client.teamMember.upsert({ where: {}, create: {}, update: {} });
      }
    `);
    const targets = found.filter((w) => w.kind === "DATABASE").map((w) => `${w.target}.${w.op}`).sort();
    assert.deepEqual(targets, [
      "case.create",
      "caseAccess.deleteMany",
      "evidence.update",
      "teamMember.upsert",
    ]);
  });

  it("2. a read is NOT a mutation, however it is spelled", () => {
    const found = writersIn(`
      async function f() {
        await prisma.evidence.findMany({ where: {} });
        await prisma.case.count();
        await prisma.teamMember.findUnique({ where: {} });
      }
    `);
    assert.deepEqual(found, []);
  });

  it("3. raw SQL is judged by its STATEMENT, not by words in the call", () => {
    // The regression: `GrantProbe` and `externalReviewGrant` made a read-only
    // SELECT look like a `GRANT` statement.
    const readOnly = writersIn(`
      async function f() {
        type GrantProbe = { id: string };
        const rows = await prisma.$queryRawUnsafe<GrantProbe[]>(
          \`SELECT "id", "state" FROM "external_review_grants" WHERE "id" = $1 LIMIT 1\`,
        );
      }
    `);
    assert.deepEqual(readOnly, [], "a read-only SELECT was reported as a raw-SQL mutation");

    const writes = writersIn(`
      async function f() {
        await prisma.$executeRawUnsafe(\`UPDATE "upload_sessions" SET "state" = $1 WHERE "id" = $2\`);
        await prisma.$executeRawUnsafe(\`DELETE FROM "evidence_semantic_chunks" WHERE "evidence_id" = $1\`);
      }
    `);
    assert.equal(writes.length, 2);
    assert.deepEqual(writes.map((w) => w.target).sort(), ["evidence_semantic_chunks", "upload_sessions"]);
  });

  it("4. the canonical enqueue is the producer authority, and the work name is recovered", () => {
    const found = writersIn(`
      async function f() {
        await enqueueCanonicalWork({ workName: JOB_NAMES.GENERATE_REPORT, payload: {} });
      }
    `);
    const q = found.filter((w) => w.kind === "QUEUE");
    assert.equal(q.length, 1);
    assert.equal(q[0].target, "GENERATE_REPORT", "the work name was not recovered from the enqueue call");
  });

  it("5. every delegate comes from the schema, and the set is not a stub", () => {
    const delegates = deriveDelegates();
    assert.ok(delegates.has("captureSession"));
    assert.ok(delegates.has("organizationMembership"));
    assert.ok(delegates.size > 200, `implausibly small delegate set: ${delegates.size}`);
  });
});

describe("phase 13 §B — family classification", () => {
  it("6. every family a writer can receive is one of the fourteen", () => {
    const samples = [
      { kind: "DATABASE", target: "evidence", op: "update" },
      { kind: "DATABASE", target: "organizationMembership", op: "create" },
      { kind: "DATABASE", target: "teamMember", op: "delete" },
      { kind: "RAW_SQL", target: "evidence_legal_holds", op: "$executeRaw" },
      { kind: "QUEUE", target: "GENERATE_REPORT", op: "enqueueCanonicalWork" },
      { kind: "EXTERNAL", target: "EMAIL", op: "deliverEmail" },
    ];
    for (const s of samples) {
      const fam = classifyMutationFamily(s);
      assert.ok(fam !== null, `unclassified: ${s.kind} ${s.target}`);
      assert.ok(MUTATION_FAMILIES.includes(fam as never), `family outside the fourteen: ${fam}`);
    }
  });

  it("7. a snake_case raw-SQL table is classified like its camelCase model", () => {
    assert.equal(
      classifyMutationFamily({ kind: "RAW_SQL", target: "evidence_legal_holds", op: "$executeRaw" }),
      "LEGAL_HOLD_RETENTION_DELETION",
    );
  });
});

describe("phase 13 §B — invariants", () => {
  const routeFacts = (id: string, source: string, resolved = true, org = "ENFORCED_BY_CANONICAL_EVALUATOR") =>
    [id, { routeId: id, tenantIdSource: source, tenantBindingResolved: resolved, organizationLifecycleRequirement: org }] as const;

  it("8. a SELF-BOUND route is authorized, not a missing-authorization finding", () => {
    // The regression: `AUTHENTICATED_SUBJECT` means "every access carried a
    // self predicate", which IS the authorization decision for account-owned
    // data. Counting it produced 81 findings that were nothing of the sort.
    const facts = new Map([routeFacts("POST /v1/identity/data-export", "AUTHENTICATED_SUBJECT")]);
    const inv = deriveMutationInvariants(
      { file: "x.ts", kind: "DATABASE", entryRoutes: ["POST /v1/identity/data-export"], entryJobs: [] },
      facts as never,
      new Map(),
    );
    assert.equal(inv.authorizationBeforeMutation, true);
    assert.deepEqual(inv.ungovernedEntryRoutes, []);
  });

  it("9. a route whose tenancy is UNRESOLVED IS a missing-authorization finding", () => {
    const facts = new Map([routeFacts("POST /v1/x", "UNRESOLVED", false, "NOT_REACHED")]);
    const inv = deriveMutationInvariants(
      { file: "x.ts", kind: "DATABASE", entryRoutes: ["POST /v1/x"], entryJobs: [] },
      facts as never,
      new Map(),
    );
    assert.equal(inv.authorizationBeforeMutation, false);
    assert.deepEqual(inv.ungovernedEntryRoutes, ["POST /v1/x"]);
    assert.equal(inv.tenantBinding, "UNBOUND");
  });

  it("10. an external effect INSIDE a transaction is unsafe and says so", () => {
    const inside = deriveMutationInvariants(
      { file: "x.ts", kind: "EXTERNAL", insideTransaction: true, entryRoutes: [], entryJobs: [] },
      new Map() as never,
      new Map(),
    );
    assert.equal(inside.externalSideEffectBoundary, "INSIDE_TRANSACTION_UNSAFE");
    const outside = deriveMutationInvariants(
      { file: "x.ts", kind: "EXTERNAL", insideTransaction: false, entryRoutes: [], entryJobs: [] },
      new Map() as never,
      new Map(),
    );
    assert.equal(outside.externalSideEffectBoundary, "AFTER_COMMIT_OR_OUTBOX");
  });

  it("11. conservation is asserted, not assumed", () => {
    const writers = new Map<string, any>([
      ["a", { primaryFamily: "CASE", entryRoutes: ["GET /x"], entryJobs: [], entryModules: [], invariants: {} }],
      ["b", { primaryFamily: null, entryRoutes: ["GET /y"], entryJobs: [], entryModules: [], invariants: {} }],
      ["c", { primaryFamily: "CASE", entryRoutes: [], entryJobs: [], entryModules: [], nonRequestDisposition: "REGISTERED_CLI", invariants: {} }],
    ]);
    const c = evaluateMutationClosure(writers as never);
    assert.equal(c.TerminalWriters, 3);
    assert.equal(c.ReachableSensitiveMutations, 2);
    assert.equal(c.ClassifiedSensitiveMutations, 1);
    assert.equal(c.UnclassifiedMutationWriters, 1);
    assert.equal(c.NonRequestWriters, 1);
    assert.equal(c.MutationConservationHolds, true);
  });
});

describe("phase 13 §1.3 — AUTHENTICATED_SUBJECT is scope-limited", () => {
  const facts = (id: string, source: string, dataScope: string) =>
    new Map([
      [
        id,
        {
          routeId: id,
          tenantIdSource: source,
          dataScope,
          tenantBindingResolved: true,
          organizationLifecycleRequirement: "ENFORCED_BY_CANONICAL_EVALUATOR",
        },
      ],
    ]);
  const inv = (id: string, source: string, dataScope: string) =>
    deriveMutationInvariants(
      { file: "x.ts", kind: "DATABASE", entryRoutes: [id], entryJobs: [] },
      facts(id, source, dataScope) as never,
      new Map(),
    );

  it("14. a user-self mutation authorized by the authenticated subject PASSES", () => {
    assert.equal(inv("POST /v1/identity/data-export", "AUTHENTICATED_SUBJECT", "GLOBAL_USER_SELF").authorizationBeforeMutation, true);
  });

  it("15. a WORKSPACE mutation authorized only by the authenticated subject FAILS", () => {
    const r = inv("POST /v1/x", "AUTHENTICATED_SUBJECT", "WORKSPACE_SCOPED");
    assert.equal(r.authorizationBeforeMutation, false, '"I am signed in" is not a tenant authorization');
    assert.deepEqual(r.ungovernedEntryRoutes, ["POST /v1/x"]);
  });

  it("16. an ORGANIZATION mutation authorized only by the authenticated subject FAILS", () => {
    assert.equal(inv("POST /v1/orgs/:id/x", "AUTHENTICATED_SUBJECT", "ORGANIZATION_SCOPED").authorizationBeforeMutation, false);
  });

  it("17. a tenant id taken from the request plus a session is NOT authorization", () => {
    // `NONE` is the verdict "no tenant authority was reached at all"; on a
    // tenant-scoped route that is the same hole as a bare session.
    assert.equal(inv("POST /v1/y", "NONE", "WORKSPACE_AND_ORGANIZATION").authorizationBeforeMutation, false);
  });

  it("18. the authenticated subject PLUS a canonical tenant authority passes", () => {
    for (const source of ["MEMBERSHIP_LOOKUP", "CANONICAL_EVALUATOR_GUARD", "RESOURCE_OWNER_COLUMN", "NAMED_AUTHORITY", "BEARER_TOKEN_SUBJECT", "PLATFORM_SCOPE"]) {
      assert.equal(
        inv("POST /v1/z", source, "WORKSPACE_SCOPED").authorizationBeforeMutation,
        true,
        `${source} should satisfy a workspace mutation`,
      );
    }
  });

  it("19. an UNRESOLVED authority fails in every scope", () => {
    for (const scope of ["GLOBAL_USER_SELF", "WORKSPACE_SCOPED", "ORGANIZATION_SCOPED", "PUBLIC_DATA"]) {
      assert.equal(inv("POST /v1/q", "UNRESOLVED", scope).authorizationBeforeMutation, false, scope);
    }
  });
});

describe("phase 13 §1.1 — the disjoint writer buckets", () => {
  const w = (over: Record<string, unknown>) => ({
    entryRoutes: [],
    entryJobs: [],
    entryModules: [],
    entrySchedules: [],
    primaryFamily: "CASE",
    invariants: {},
    ...over,
  });

  it("20. every writer lands in exactly one bucket, by precedence", () => {
    assert.equal(writerBucket(w({ entryRoutes: ["GET /x"], entryJobs: ["JOB q"] })), "ROUTE_ATTRIBUTED_REACHABLE");
    assert.equal(writerBucket(w({ entryJobs: ["JOB q"] })), "JOB_ATTRIBUTED_REACHABLE");
    assert.equal(writerBucket(w({ entryModules: ["MODULE f.ts"] })), "MODULE_SCOPED_REACHABLE");
    assert.equal(writerBucket(w({ nonRequestDisposition: "REGISTERED_CLI" })), "REGISTERED_CLI");
    assert.equal(writerBucket(w({ nonRequestDisposition: "RECONCILER_OR_SWEEP" })), "STARTUP_OR_SCHEDULED");
    assert.equal(writerBucket(w({ nonRequestDisposition: "DEAD_UNREACHABLE_WRITER" })), "DEAD_UNREACHABLE");
  });

  it("20b. a SCHEDULE attribution outranks module scope and never reads as a queue job", () => {
    // A `setInterval` is not a queue. Folding a timer-driven sweep into
    // JOB_ATTRIBUTED_REACHABLE would claim an idempotency key and a retry
    // policy that a timer does not have; leaving it in MODULE_SCOPED_REACHABLE
    // would trip a gate that exists to catch a much weaker fact.
    assert.equal(
      writerBucket(w({ entrySchedules: ["SCHEDULE services/worker/src/index.ts:575"] })),
      "STARTUP_OR_SCHEDULED",
    );
    assert.equal(
      writerBucket(w({ entryJobs: ["JOB q"], entrySchedules: ["SCHEDULE x"] })),
      "JOB_ATTRIBUTED_REACHABLE",
    );
    assert.equal(
      writerBucket(w({ entryModules: ["MODULE f.ts"], entrySchedules: ["SCHEDULE x"] })),
      "STARTUP_OR_SCHEDULED",
    );
  });

  it("20c. a schedule-attributed writer is REACHABLE and is not a module-scope finding", () => {
    const c = evaluateMutationClosure(
      new Map([["a", w({ entrySchedules: ["SCHEDULE services/worker/src/index.ts:575"] })]]) as never,
    );
    assert.equal(c.ReachableSensitiveMutations, 1);
    assert.equal(c.ModuleScopedAttributionWriters, 0);
    assert.equal(c.DeadUnreachableWritersPending, 0);
    assert.equal(c.MutationWriterConservationHolds, true);
  });

  it("20d. a preserved writer is its own bucket and is still counted as unreached", () => {
    // PRESERVED_PLANNED_WRITER must never read as reachable: it is a standing
    // statement that the code does NOT run. A preservation that quietly moved a
    // writer into a reachable bucket would be an exemption, not a record.
    assert.equal(
      writerBucket(w({ nonRequestDisposition: "PRESERVED_PLANNED_WRITER" })),
      "PRESERVED_PLANNED_WRITER",
    );
    const c = evaluateMutationClosure(
      new Map([["a", w({ nonRequestDisposition: "PRESERVED_PLANNED_WRITER" })]]) as never,
    );
    assert.equal(c.ReachableSensitiveMutations, 0);
    assert.equal(c.PreservedPlannedWriters, 1);
    assert.equal(c.DeadUnreachableWritersPending, 0);
    assert.equal(c.MutationWriterConservationHolds, true);
  });

  it("20e. an unreached writer with NO preservation still reports as pending", () => {
    const c = evaluateMutationClosure(
      new Map([["a", w({ nonRequestDisposition: "DEAD_UNREACHABLE_WRITER" })]]) as never,
    );
    assert.equal(c.DeadUnreachableWritersPending, 1, "a dead writer must stay visible");
    assert.equal(c.PreservedPlannedWriters, 0);
  });

  it("21. a writer with no bucket at all is UNRESOLVED, never dropped", () => {
    // The failure this prevents: a writer that matches no rule silently
    // vanishing from the total, which is how 1222 - 1143 = 79 became a number
    // nobody could account for.
    assert.equal(writerBucket(w({})), "UNRESOLVED");
    const c = evaluateMutationClosure(new Map([["a", w({})]]) as never);
    assert.equal(c.UnresolvedWriters, 1);
    assert.equal(c.MutationWriterConservationHolds, false, "an unresolved writer must break the identity");
  });

  it("22. the bucket totals sum to the writer count", () => {
    const writers = new Map<string, any>([
      ["a", w({ entryRoutes: ["GET /x"] })],
      ["b", w({ entryJobs: ["JOB q"] })],
      ["c", w({ nonRequestDisposition: "REGISTERED_CLI" })],
      ["d", w({ nonRequestDisposition: "DEAD_UNREACHABLE_WRITER" })],
    ]);
    const c = evaluateMutationClosure(writers as never);
    const summed = Object.values(c.byWriterBucket as Record<string, number>).reduce((s, n) => s + n, 0);
    assert.equal(summed, c.TerminalWriters);
    assert.equal(c.MutationWriterConservationHolds, true);
    assert.equal(c.WriterBucketOverlaps, 0);
    assert.equal(c.WriterBucketMissing, 0);
  });
});

describe("phase 13 §B — the canonical work registry is read, not re-derived", () => {
  it("12. the registry parses with real module paths, not constant NAMES", () => {
    // The regression: `canonicalProducer: SHARED_ENQUEUE` was read as the
    // identifier text, so every entry declared a module that does not exist and
    // 36 fabricated "registry problems" followed.
    const registry = readWorkRegistry();
    assert.ok(registry.length >= 15, `registry implausibly small: ${registry.length}`);
    for (const e of registry) {
      assert.ok(
        String(e.canonicalProducer).includes("/"),
        `producer is not a module path: ${e.workName} -> ${e.canonicalProducer}`,
      );
      assert.ok(
        String(e.canonicalProcessor).includes("/"),
        `processor is not a module path: ${e.workName} -> ${e.canonicalProcessor}`,
      );
    }
  });

  it("13. every BullMQ entry declares an idempotency strategy", () => {
    const bullmq = readWorkRegistry().filter((e: Record<string, any>) => String(e.transport).toLowerCase() === "bullmq");
    assert.ok(bullmq.length > 0);
    for (const e of bullmq) {
      assert.ok(
        Array.isArray(e.idempotency) && e.idempotency.length > 0,
        `${e.workName} is retryable with no declared idempotency strategy`,
      );
    }
  });
});
