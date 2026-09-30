/**
 * PHASE 37.98 — Command Center projection consumption + staleness.
 *
 * Source-contract assertions proving:
 *   - the Command Center service IMPORTS the projection read helper,
 *   - the envelope declares the projection-backed summary field with
 *     staleness metadata,
 *   - the staleness policy uses the canonical "fresh | stale | missing"
 *     vocabulary,
 *   - the projection is refreshed ON READ by the Command Center, through the
 *     one shared authority, which scopes every count by the input teamId.
 *
 * ET-Q-07 (2026-09-30) — the last two bullets used to read "the BullMQ refresh
 * queue + worker are wired in the worker entrypoint" and "the refresh processor
 * scopes every count". The `org-health-refresh` queue had no producer and was
 * retired with its processor; see PART 2. The five-window history below is kept
 * as written — two of the five windows it lists belonged to that processor.
 *
 * PHASE 13 (NEW-047, 2026-08-17) — THE WINDOWS ARE GONE.
 * ---------------------------------------------------------------------------
 * Five assertions in this file measured how many CHARACTERS separated two
 * pieces of text and called the answer a relationship:
 *
 *   /buildProjectionSummary[\s\S]{0,3000}prisma\.evidence\.count\(…{0,80}teamId/
 *   /buildProjectionSummary[\s\S]{0,3000}prisma\.case\.count\(…{0,80}teamId/
 *   /import\s*\{[\s\S]{0,200}?\}\s*from\s*"\.\/projections\/refresh-org-health…/
 *   WORKER_PROCESSORS.slice(indexOf("processOrgHealthRefreshJob"), +5000)   ×2
 *   /"org-health-refresh"[\s\S]{0,200}orgHealthRefreshWorker/
 *
 * A docblock added between a function and the query it describes breaks the
 * first two while the code is unchanged — the sibling defect in
 * verify-module-reachability, where a six-line comment reported a live 940-line
 * RBAC authority as dead. And the failure runs the other way too: the last one
 * was being satisfied by the SHUTDOWN tuple 180 lines below the registration it
 * claimed to check, so "the worker is registered" was never actually asserted.
 *
 * Every one of them now asks the syntax tree. The declaration is resolved
 * through the file's own import table and the call graph is walked from it, so
 * a wrapper is one hop, a comment is not a node, and distance is not an input.
 *
 * What deliberately REMAINS matched against source text: the DECLARED SHAPE of
 * the envelope (field names and their TypeScript types), a log-event string and
 * two negative existence checks. Those are statements ABOUT the text, none of
 * them spans a window, and checking them against the text is correct.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { buildCallGraph } from "../scripts/capability-authority/call-graph.mjs";
import { prismaAccess } from "../scripts/capability-authority/tenant-binding.mjs";
import {
  reachesFrom,
  resolveAuthority,
  resolveReference,
  ts,
  whereKeysOf,
} from "../scripts/capability-authority/structural-reach.mjs";

/**
 * The structural cases parse the whole API + worker + package trees through the
 * compiler API. That is seconds, not milliseconds, and the 5s default would turn
 * a passing assertion into a timeout that reads like a failure of the subject.
 */
vi.setConfig({ testTimeout: 300_000 });

const CMD_CENTER_MODULE =
  "services/api/src/services/dashboard/command-center.service.ts";
const PROJECTION_MODULE =
  "packages/shared-runtime/src/org-health-projection.ts";

/** What a matched Prisma count contributes, once its `where` has been read. */
type CountHit = {
  model: string;
  where: { ok: boolean; keys?: string[]; reason?: string };
};

/**
 * WORKSPACE-SCOPE CONVERGENCE — what "tenant-scoped" means for a count now.
 *
 * These checks read the top-level KEYS of a `where` clause and used to demand
 * a literal `teamId`. That was never quite the invariant: on `Evidence` and
 * `Case` — the two models whose `team_id` is NULLABLE — a literal
 * `teamId: <workspace>` is BOUNDED but INCOMPLETE. It omits a personal
 * workspace's legacy NULL-team rows, so a projection built that way passed
 * this test while silently under-counting the workspace it claimed to
 * describe.
 *
 * The canonical scope is carried in an `AND` arm (`AND: [scope]`), so `AND` is
 * accepted here. `AND` on its own would be a weaker assertion than the one it
 * replaces, which is why every call site below ALSO asserts that the module
 * under test resolves the canonical authority — see
 * `expectResolvesCanonicalScope`. Together they say: bounded, and bounded by
 * the one rule that is complete.
 */
function expectTenantScopedCount(hit: CountHit, context: string): void {
  const keys = hit.where.keys ?? [];
  const bounded = keys.includes("teamId") || keys.includes("AND");
  expect(
    bounded,
    `prisma.${hit.model}.count ${context} is not tenant-scoped ` +
      `(where keys: ${keys.join(", ") || "<none>"})`,
  ).toBe(true);
}

/**
 * The companion half: the module really does build its filter from the
 * canonical workspace authority rather than assembling an `AND` of its own.
 */
function expectResolvesCanonicalScope(source: string, context: string): void {
  // Both entry points into the ONE authority count. `workspaceEvidenceWhere` /
  // `workspaceCaseWhere` resolve the workspace's owner themselves;
  // `evidenceScopeFor` / `caseScopeFor` are the pure projections a caller that
  // already holds a proven context uses, and the Command Center uses those
  // because it resolves the workspace once per envelope rather than once per
  // section. They are the same rule reached two ways, not two rules.
  expect(
    /workspace(Evidence|Case)Where\s*\(|(evidence|case)ScopeFor\s*\(/.test(source),
    `${context} must resolve the canonical workspace scope`,
  ).toBe(true);
}

/** Built once; the graph is the same for every case in this file. */
let CALL_GRAPH: ReturnType<typeof buildCallGraph> | null = null;
const callGraph = () => (CALL_GRAPH ??= buildCallGraph());

// ---------------------------------------------------------------------------
// Node matchers. Each reads ONE node and its own children — never a slice of
// the file, and never a distance between two nodes.
// ---------------------------------------------------------------------------

/** Any Prisma `count`, with its `where` predicate keys read structurally. */
const anyCount = (node: unknown): CountHit | null => {
  const access = prismaAccess(node) as { model: string; op: string } | null;
  if (!access || access.op !== "count") return null;
  return { model: access.model, where: whereKeysOf(node) as CountHit["where"] };
};

/**
 * A call to `name`, RESOLVED through the calling file's import table.
 *
 * The resolution is the point: a local helper that happens to share the name
 * resolves to itself and is reported as a different target, so "the processor
 * calls the canonical workspace resolver" cannot be satisfied by a same-named
 * function declared next to it.
 */
const callTo =
  (cg: unknown, name: string) =>
  (node: unknown, file: string): { name: string; target: string | null } | null => {
    if (!ts.isCallExpression(node)) return null;
    const callee = (node as { expression: { text?: string } }).expression;
    if (!ts.isIdentifier(callee) || callee.text !== name) return null;
    const target = resolveReference(callee, file, cg) as
      | { file: string; name: string }
      | null;
    return { name, target: target ? `${target.file}#${target.name}` : null };
  };

/** `if (!<subject>) return;` — a refusal, read as an IfStatement, not as text. */
const refusalGuardOn =
  (subject: string) =>
  (node: unknown): { guard: string } | null => {
    if (!ts.isIfStatement(node)) return null;
    const stmt = node as {
      expression: { operator?: number; operand?: { getText(): string } };
      thenStatement: unknown;
      elseStatement?: unknown;
    };
    if (!ts.isPrefixUnaryExpression(stmt.expression)) return null;
    if (stmt.expression.operator !== ts.SyntaxKind.ExclamationToken) return null;
    // `getText()` here is the OPERAND node's own span — `ctx`, `input.teamId` —
    // not a window cut out of the file.
    if (stmt.expression.operand?.getText() !== subject) return null;
    const then = stmt.thenStatement;
    const bare =
      ts.isReturnStatement(then) ||
      (ts.isBlock(then) &&
        (then as { statements: unknown[] }).statements.some((s) =>
          ts.isReturnStatement(s),
        )) ||
      ts.isThrowStatement(then) ||
      (ts.isBlock(then) &&
        (then as { statements: unknown[] }).statements.some((s) =>
          ts.isThrowStatement(s),
        ));
    return bare ? { guard: `!${subject}` } : null;
  };

function readApi(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../${rel}`, import.meta.url)),
    "utf8",
  );
}
function readWorker(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../worker/${rel}`, import.meta.url)),
    "utf8",
  );
}

// The projection service is no longer read as TEXT at all: every question this
// file asks of it — the missing-teamId refusal, the tenant scoping of its
// counts, the scoping of its read — is now asked of the syntax tree, so there
// is nothing left for a source string to answer.
const CMD_CENTER = readApi("src/services/dashboard/command-center.service.ts");
const WORKER_QUEUE = readWorker("src/queue.ts");
const WORKER_PROCESSORS = readWorker("src/subsystem-queue-processors.ts");

// =============================================================================
// PART 1 — Command Center now imports + consumes projection
// =============================================================================

describe("Phase 37.98 — Command Center consumes projection", () => {
  // PHASE 13 §4 (2026-08-17) — the assertion now requires BOTH names.
  //
  // It pinned the single-name form `import { readLatestOrgHealthProjection }`,
  // which was correct while nothing refreshed the projection. Nothing did:
  // `refreshOrgHealthProjection` had no caller anywhere, so this read always
  // found the row missing and always fell back to two of eight counters. The
  // command centre now refreshes on a missing-or-stale read, so the READ and the
  // REFRESH must both come from the one projection service — a second refresher
  // elsewhere would be the parallel authority this file exists to prevent.
  it("imports the read AND the refresh from the one projection service", () => {
    // The old form matched the import's brace list inside a 200-character
    // window — the exact construct a six-line comment broke in
    // verify-module-reachability. Both names are now resolved through the
    // module's own import table, which also proves what the regex could only
    // imply: that each one leads to the SAME projection service and not merely
    // to a nearby brace list.
    const cg = callGraph();
    for (const name of ["readLatestOrgHealthProjection", "refreshOrgHealthProjection"]) {
      const bound = resolveAuthority(cg, CMD_CENTER_MODULE, name);
      expect(bound.ok, `${name} is not bound in the command centre: ${bound.reason}`).toBe(
        true,
      );
      expect(bound.via).toBe("IMPORT");
      expect(
        bound.file,
        `${name} must come from the ONE projection service — a second refresher elsewhere ` +
          "would be the parallel authority this file exists to prevent",
      ).toBe(PROJECTION_MODULE);
    }
  });

  it("the envelope build path REACHES both the read and the refresh", () => {
    const cg = callGraph();
    const start = resolveAuthority(cg, CMD_CENTER_MODULE, "buildProjectionSummary");
    expect(start.ok).toBe(true);

    for (const name of ["readLatestOrgHealthProjection", "refreshOrgHealthProjection"]) {
      const walk = reachesFrom(cg, start, { maxDepth: 0, match: callTo(cg, name) });
      expect(walk.reached, `buildProjectionSummary never calls ${name}`).toBe(true);
      expect(
        (walk.evidence[0] as { target: string | null }).target,
        `${name} resolved somewhere other than the projection service`,
      ).toBe(`${PROJECTION_MODULE}#${name}`);
    }
  });

  it("refreshes only when the read finds the projection missing or stale", () => {
    // The staleness DECISION is a named local, and its presence is a statement
    // about the declared source rather than a reachability question.
    expect(CMD_CENTER).toMatch(/\bconst projectionStale =/);
  });

  it("envelope declares projectionSummary with the canonical staleness shape", () => {
    expect(CMD_CENTER).toMatch(/\bprojectionSummary:\s*\{/);
    expect(CMD_CENTER).toMatch(
      /projectionStatus:\s*"fresh"\s*\|\s*"stale"\s*\|\s*"missing"/,
    );
    expect(CMD_CENTER).toMatch(/projectionRefreshedAt:/);
    expect(CMD_CENTER).toMatch(/projectionAgeSeconds:/);
    expect(CMD_CENTER).toMatch(/usedLiveFallback:\s*boolean/);
    expect(CMD_CENTER).toMatch(/\bteamId:\s*string/);
  });

  it("envelope counts include the projection-backed fields", () => {
    expect(CMD_CENTER).toMatch(/evidenceCount:\s*number/);
    expect(CMD_CENTER).toMatch(/caseCount:\s*number/);
    expect(CMD_CENTER).toMatch(/pendingReportCount:\s*number/);
    expect(CMD_CENTER).toMatch(/pendingPackageCount:\s*number/);
    expect(CMD_CENTER).toMatch(/openIncidentCount:\s*number/);
    expect(CMD_CENTER).toMatch(/slaBreachCount:\s*number/);
    expect(CMD_CENTER).toMatch(/governanceBlockerCount:\s*number/);
    expect(CMD_CENTER).toMatch(/recentVerificationCount:\s*number/);
  });

  it("projection-summary helper has a bounded freshness threshold", () => {
    expect(CMD_CENTER).toMatch(/PROJECTION_FRESH_THRESHOLD_SEC\s*=\s*\d+/);
  });

  /**
   * PHASE 13 (NEW-047, 2026-08-17) — THE QUESTION IS NOW ASKED STRUCTURALLY.
   *
   * This case used to be two regexes with a 3000-character window:
   *
   *   /buildProjectionSummary[\s\S]{0,3000}prisma\.evidence\.count\(
   *      \s*\{\s*where:\s*\{[\s\S]{0,80}teamId/
   *
   * which asks "how many characters apart do these two pieces of text appear?".
   * That is not the question. The question is whether `buildProjectionSummary`
   * REACHES a tenant-scoped count, and the two answers come apart in both
   * directions: a docblock added between the declaration and the query breaks
   * the window while the code is unchanged (the sibling defect in
   * verify-module-reachability, where a six-line comment reported a live RBAC
   * authority as dead), and an unrelated `prisma.evidence.count` belonging to a
   * NEIGHBOURING function inside the window satisfies it while
   * `buildProjectionSummary` itself queries nothing.
   *
   * It is now answered by walking the resolved call graph from the declaration.
   * Distance is not an input. Comments are not nodes. A count in the next
   * function along is not reached, and a count behind a wrapper is.
   */
  it("falls back to bounded live counts, in buildProjectionSummary's OWN body", () => {
    const cg = callGraph();
    const start = resolveAuthority(cg, CMD_CENTER_MODULE, "buildProjectionSummary");
    expect(
      start.ok,
      `buildProjectionSummary is not a declaration in ${CMD_CENTER_MODULE}: ${start.reason}`,
    ).toBe(true);
    expect(start.via).toBe("DECLARATION");
    expect(start.file).toBe(CMD_CENTER_MODULE);

    // Depth 0 is the FUNCTION BODY — a syntactic boundary, not a character
    // count. It is the exact claim being made ("the fallback path queries
    // evidence + case counts ONLY"), and it is why a neighbouring function's
    // `prisma.evidence.count` a few hundred lines away cannot satisfy it while
    // a docblock inserted anywhere inside cannot break it.
    const own = reachesFrom(cg, start, {
      maxDepth: 0,
      match: (node) => {
        const access = prismaAccess(node) as { model: string; op: string } | null;
        if (!access || access.op !== "count") return null;
        return { model: access.model, where: whereKeysOf(node) };
      },
    });

    expect(own.startResolved).toBe(true);
    expect(own.reached, "buildProjectionSummary itself issues no Prisma count").toBe(true);

    const models = [...new Set(own.evidence.map((e) => e.model as string))].sort();
    expect(
      models,
      "the bounded fallback must be evidence + case and nothing else",
    ).toEqual(["case", "evidence"]);

    // EVERY count must be scoped by teamId in the PREDICATE. The old window
    // accepted `teamId` appearing anywhere in the next 80 characters, which a
    // `select: { teamId: true }` projection would have satisfied.
    for (const hit of own.evidence as CountHit[]) {
      expect(
        hit.where.ok,
        `prisma.${hit.model}.count has no statically readable where clause ` +
          `(${hit.where.reason}) — an unreadable predicate is an analysis gap, ` +
          "not proof of scoping",
      ).toBe(true);
      expectTenantScopedCount(hit, "in the bounded fallback");
    }
    expectResolvesCanonicalScope(CMD_CENTER, "the bounded fallback");
  });

  /**
   * The other half of the same question, and the half a character window could
   * never answer at all: the projection READ lives in a DIFFERENT MODULE, and
   * the walk has to cross the import to find it.
   *
   * A negative here would be meaningless if the walk had quietly given up, so
   * the unfollowable edges are asserted rather than assumed away.
   */
  it("reaches the projection read ACROSS the module boundary", () => {
    const cg = callGraph();
    const start = resolveAuthority(cg, CMD_CENTER_MODULE, "buildProjectionSummary");
    expect(start.ok).toBe(true);

    const walk = reachesFrom(cg, start, {
      match: (node) => {
        const access = prismaAccess(node) as { model: string; op: string } | null;
        if (!access || access.model !== "orgHealthProjection") return null;
        return { model: access.model, op: access.op };
      },
    });

    expect(
      walk.reached,
      "the walk never reached readLatestOrgHealthProjection's own query — the import was not followed",
    ).toBe(true);
    expect(
      [...new Set(walk.evidence.map((e) => e.file as string))],
      "the projection query must be attributed to the module that declares it",
    ).toEqual(["packages/shared-runtime/src/org-health-projection.ts"]);

    const dynamicGaps = walk.unresolved.filter(
      (u) => (u as { reason?: string }).reason === "DYNAMIC_IMPORT_UNRESOLVED",
    );
    expect(dynamicGaps, "an unfollowable dynamic import sits inside this path").toEqual([]);
  });
});

// =============================================================================
// PART 2 — There is NO worker refresh pipeline (ET-Q-07, 2026-09-30)
// =============================================================================
//
// This part used to be "refresh pipeline wired in worker": nine cases proving
// that an `org-health-refresh` queue, its `processOrgHealthRefreshJob`
// processor, its registration, its WorkerKind member and its shutdown were all
// present and correct. They were — and every one of those cases was green
// while the pipeline did nothing, because the queue had a consumer and NO
// producer: `enqueueOrgHealthRefreshJob` had zero callers in every commit. A
// suite that proves a chain is wired without proving anything feeds it is how
// a dead queue stays CURRENT_RUNTIME.
//
// The queue, the processor, the registration and the enqueue helper are
// deleted. What made the projection fresh was never that pipeline; it is the
// read-time refresh PART 1 proves (`buildProjectionSummary` ->
// `refreshOrgHealthProjection`), and PART 3 below still proves that authority
// refuses a missing teamId and tenant-scopes every count — the two properties
// the processor cases were really about, asserted where the counts live.
//
// That the queue STAYS retired is pinned by the one resurrection guard,
// `services/worker/test/et-q-07-retired-queues-resurrection-guard.test.ts`.

describe("Phase 37.98 — the projection has one writer path, and it is not a queue", () => {
  it("the worker no longer carries an org-health refresh processor", () => {
    expect(WORKER_PROCESSORS).not.toMatch(
      /export async function processOrgHealthRefreshJob/,
    );
  });

  it("the payload type that carried a tenant assertion stays deleted", () => {
    // `OrgHealthRefreshJobPayload = { teamId }` was removed in PHASE 12 POINT 5
    // and must not come back with a resurrected queue.
    expect(WORKER_QUEUE).not.toMatch(/export type OrgHealthRefreshJobPayload/);
  });
});

// =============================================================================
// PART 3 — Refresh service contract (unchanged-from-Phase-37.97; reasserted)
// =============================================================================

describe("Phase 37.98 — refresh service contract reassertion", () => {
  it("refresh service requires teamId + scopes every count by teamId", () => {
    // The old form scanned the WHOLE FILE for `.count({…})` and tested the
    // matched text for the substring `teamId`. Both halves were wrong: a count
    // belonging to any other function in the module was attributed to this
    // authority, and `select: { teamId: true }` — a projection, not a predicate —
    // satisfied it.
    const cg = callGraph();
    const start = resolveAuthority(cg, PROJECTION_MODULE, "refreshOrgHealthProjection");
    expect(start.ok, `refreshOrgHealthProjection not declared: ${start.reason}`).toBe(true);

    const guard = reachesFrom(cg, start, {
      // `maxDepth: 1`: the refusal now lives in `computeOrgHealthCounts`,
      // which `refreshOrgHealthProjection` calls before anything else. One
      // hop, one authority — and the guard is STRICTER than it was, because it
      // also rejects a whitespace-only id.
      maxDepth: 1,
      match: refusalGuardOn("input.teamId"),
    });
    expect(guard.reached, "the refresh authority does not refuse a missing teamId").toBe(
      true,
    );

    // One hop: `refreshOrgHealthProjection` -> `computeOrgHealthCounts`. The
    // counts moved there so BOTH hosts share them; requiring them in the outer
    // function would forbid the very extraction that removed the duplicate.
    const walk = reachesFrom(cg, start, { maxDepth: 1, match: anyCount });
    expect(walk.reached, "the refresh authority issues no counts").toBe(true);
    for (const hit of walk.evidence as CountHit[]) {
      expect(hit.where.ok, `${hit.model}.count: ${hit.where.reason}`).toBe(true);
      expectTenantScopedCount(hit, "in the refresh authority");
    }
    expectResolvesCanonicalScope(
      readFileSync(fileURLToPath(new URL("../../../packages/shared-runtime/src/org-health-projection.ts", import.meta.url)), "utf8"),
      "the refresh authority",
    );
  });

  it("readLatestOrgHealthProjection filters by teamId (no global read)", () => {
    const cg = callGraph();
    const start = resolveAuthority(cg, PROJECTION_MODULE, "readLatestOrgHealthProjection");
    expect(start.ok).toBe(true);

    const walk = reachesFrom(cg, start, {
      maxDepth: 0,
      match: (node) => {
        const access = prismaAccess(node) as { model: string; op: string } | null;
        if (!access || access.model !== "orgHealthProjection") return null;
        return { op: access.op, where: whereKeysOf(node) };
      },
    });
    expect(walk.reached, "the read helper queries no projection row").toBe(true);
    for (const hit of walk.evidence as Array<{
      op: string;
      where: CountHit["where"];
    }>) {
      expect(hit.where.ok, `${hit.op}: ${hit.where.reason}`).toBe(true);
      expect(hit.where.keys, "the projection read is not tenant-scoped").toContain("teamId");
    }
  });
});
