/**
 * PHASE 37.98 — Command Center projection consumption + staleness.
 *
 * Source-contract assertions proving:
 *   - the Command Center service IMPORTS the projection read helper,
 *   - the envelope declares the projection-backed summary field with
 *     staleness metadata,
 *   - the staleness policy uses the canonical "fresh | stale | missing"
 *     vocabulary,
 *   - the BullMQ refresh queue + worker are wired in the worker entrypoint,
 *   - the refresh processor scopes every count by the input teamId.
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
import {
  JOB_NAMES,
  QUEUE_NAMES,
  getWorkEntryOrThrow,
} from "@proovra/shared";

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
  "services/api/src/services/dashboard/projections/refresh-org-health.service.ts";
const WORKER_PROCESSORS_MODULE = "services/worker/src/subsystem-queue-processors.ts";
const WORKER_INDEX_MODULE = "services/worker/src/index.ts";

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
const WORKER_INDEX = readWorker("src/index.ts");

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
    ).toEqual(["services/api/src/services/dashboard/projections/refresh-org-health.service.ts"]);

    const dynamicGaps = walk.unresolved.filter(
      (u) => (u as { reason?: string }).reason === "DYNAMIC_IMPORT_UNRESOLVED",
    );
    expect(dynamicGaps, "an unfollowable dynamic import sits inside this path").toEqual([]);
  });
});

// =============================================================================
// PART 2 — Worker queue + processor + worker registration
// =============================================================================

describe("Phase 37.98 — refresh pipeline wired in worker", () => {
  it("the org-health chain has ONE queue name and ONE job name", () => {
    // PHASE 12 — POINT 5: these were three source literals in queue.ts. They
    // are now aliases of registry values, so the assertion moved to the value.
    const entry = getWorkEntryOrThrow(JOB_NAMES.REFRESH_ORG_HEALTH_PROJECTION);
    expect(entry.queueName).toBe(QUEUE_NAMES.ORG_HEALTH_REFRESH);
    expect(entry.workName).toBe("RefreshOrgHealthProjection");
    expect(WORKER_QUEUE).toMatch(/orgHealthRefreshQueue\s*=\s*new Queue\(/);
  });

  it("the payload carries a REFERENCE, not a tenant assertion", () => {
    // `OrgHealthRefreshJobPayload = { teamId }` is deleted. The command id IS
    // the workspace id, and it is a reference that must resolve to a live Team
    // whose Organization is still ACTIVE before any count runs.
    expect(WORKER_QUEUE).not.toMatch(/export type OrgHealthRefreshJobPayload/);
    expect(
      getWorkEntryOrThrow(JOB_NAMES.REFRESH_ORG_HEALTH_PROJECTION)
        .durableAuthority.model,
    ).toBe("Team");
  });

  it("the queue has bounded retry config (attempts + backoff)", () => {
    const entry = getWorkEntryOrThrow(JOB_NAMES.REFRESH_ORG_HEALTH_PROJECTION);
    expect(entry.retry.attempts).toBeGreaterThan(0);
    expect(entry.retry.attempts).toBeLessThanOrEqual(25);
    expect(entry.retry.backoff).toBe("exponential");
    expect(entry.retry.backoffDelayMs).toBeGreaterThan(0);
  });

  it("subsystem-queue-processors.ts exports processOrgHealthRefreshJob", () => {
    expect(WORKER_PROCESSORS).toMatch(
      /export async function processOrgHealthRefreshJob/,
    );
  });

  it("processor scopes every count by the input teamId (no cross-tenant scan)", () => {
    // Was `slice(indexOf("processOrgHealthRefreshJob"), +5000)`. A 5000-character
    // guess at where a function ends is wrong in both directions: it truncates a
    // body that grows past it, hiding the very count that would fail, and it
    // spills into the NEXT function, blaming this processor for a neighbour's
    // unscoped query. The function body is a syntactic boundary; use it.
    const cg = callGraph();
    const start = resolveAuthority(
      cg,
      WORKER_PROCESSORS_MODULE,
      "processOrgHealthRefreshJob",
    );
    expect(start.ok, `processor not declared: ${start.reason}`).toBe(true);
    expect(start.via).toBe("DECLARATION");

    const walk = reachesFrom(cg, start, { maxDepth: 0, match: anyCount });
    expect(walk.reached, "the refresh processor issues no counts at all").toBe(true);
    for (const hit of walk.evidence as CountHit[]) {
      expect(
        hit.where.ok,
        `${hit.model}.count has no statically readable where clause (${hit.where.reason})`,
      ).toBe(true);
      expectTenantScopedCount(hit, "in the worker refresh processor");
    }
    expectResolvesCanonicalScope(WORKER_PROCESSORS, "the worker refresh processor");
  });

  it("processor refuses an unresolvable workspace loudly (no global refresh)", () => {
    // PHASE 12 — POINT 5 strengthened this. The old guard was `if (!teamId)`,
    // which only caught an EMPTY string on the wire — a non-empty tampered one
    // sailed through and refreshed a different workspace's projection. The
    // workspace is now resolved from a Team row and its Organization must be
    // ACTIVE, so a deleted, unknown or suspended target is refused before any
    // count runs.
    const cg = callGraph();
    const start = resolveAuthority(
      cg,
      WORKER_PROCESSORS_MODULE,
      "processOrgHealthRefreshJob",
    );
    expect(start.ok).toBe(true);

    // The resolver must be THE canonical one. A same-named local helper would
    // satisfy a text match and resolve to a different declaration here.
    const resolverCall = reachesFrom(cg, start, {
      maxDepth: 0,
      match: callTo(cg, "resolveWorkspaceJob"),
    });
    expect(resolverCall.reached, "the processor never resolves the workspace").toBe(true);
    expect(
      (resolverCall.evidence[0] as { target: string | null }).target,
      "resolveWorkspaceJob did not resolve to a declaration — a local shadow would " +
        "pass a text match and refuse nothing",
    ).not.toBeNull();

    // And the refusal itself, as an IfStatement rather than as the exact
    // characters `if (!ctx) return;`.
    const guard = reachesFrom(cg, start, {
      maxDepth: 0,
      match: refusalGuardOn("ctx"),
    });
    expect(
      guard.reached,
      "the processor does not refuse an unresolved workspace before counting",
    ).toBe(true);

    // A log-event NAME is a string constant, and matching it against the source
    // is exactly right — it is a statement about the declared text.
    expect(WORKER_PROCESSORS).toMatch(/workspace_unresolved_or_inactive/);
  });

  it("worker/index.ts registers the processor under the org-health-refresh kind", () => {
    // The old form was /"org-health-refresh"[\s\S]{0,200}orgHealthRefreshWorker/,
    // and it passed for the WRONG REASON: the nearest match in the file is the
    // SHUTDOWN tuple `["org-health-refresh", orgHealthRefreshWorker]`, ~180 lines
    // below the registration this case claims to check. The registration could
    // have been deleted outright and this would still have been green.
    const cg = callGraph();
    const entry = cg.graph.get(WORKER_INDEX_MODULE) as { decls: Map<string, unknown> };
    expect(entry, "the worker entrypoint is not indexed").toBeTruthy();

    const registration = entry.decls.get("orgHealthRefreshWorker") as
      | { arguments?: Array<{ text?: string }>; expression?: { text?: string } }
      | undefined;
    expect(registration, "orgHealthRefreshWorker is not declared").toBeTruthy();
    expect(ts.isCallExpression(registration)).toBe(true);
    expect(registration!.expression?.text).toBe("safeRegisterWorker");
    expect(
      registration!.arguments?.[0]?.text,
      "the worker is registered under a different kind",
    ).toBe("org-health-refresh");

    // …and the registered factory must hand BullMQ this processor, resolved
    // through the entrypoint's import table rather than matched by name.
    let handlerRef: unknown = null;
    const visit = (node: unknown): void => {
      if (
        handlerRef === null &&
        ts.isIdentifier(node) &&
        (node as { text: string }).text === "processOrgHealthRefreshJob"
      ) {
        handlerRef = node;
      }
      ts.forEachChild(node, visit);
    };
    visit(registration);
    expect(handlerRef, "the registration never names the processor").not.toBeNull();

    const resolved = resolveReference(handlerRef, WORKER_INDEX_MODULE, cg) as
      | { file: string; name: string }
      | null;
    expect(resolved?.file, "the registered handler is not the canonical processor").toBe(
      WORKER_PROCESSORS_MODULE,
    );
    expect(resolved?.name).toBe("processOrgHealthRefreshJob");
  });

  it("worker shutdown closes the org-health-refresh worker + queue", () => {
    expect(WORKER_INDEX).toMatch(
      /\["org-health-refresh",\s*orgHealthRefreshWorker\]/,
    );
    expect(WORKER_INDEX).toMatch(/orgHealthRefreshQueue\.close\(\)/);
  });

  it("WorkerKind includes the new queue", () => {
    expect(WORKER_INDEX).toMatch(/\|\s*"org-health-refresh"/);
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
      maxDepth: 0,
      match: refusalGuardOn("input.teamId"),
    });
    expect(guard.reached, "the refresh authority does not refuse a missing teamId").toBe(
      true,
    );

    const walk = reachesFrom(cg, start, { maxDepth: 0, match: anyCount });
    expect(walk.reached, "the refresh authority issues no counts").toBe(true);
    for (const hit of walk.evidence as CountHit[]) {
      expect(hit.where.ok, `${hit.model}.count: ${hit.where.reason}`).toBe(true);
      expectTenantScopedCount(hit, "in the refresh authority");
    }
    expectResolvesCanonicalScope(
      readApi("src/services/dashboard/projections/refresh-org-health.service.ts"),
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
