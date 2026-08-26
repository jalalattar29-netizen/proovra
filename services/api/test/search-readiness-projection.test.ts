/**
 * The diagnostics endpoint's readiness projection.
 *
 * Source-contract assertions over the route, in the style of the other search
 * suites here. What they protect is the property the production defect
 * violated: the numerator and the denominator must measure ONE population,
 * and the state must come from persisted facts rather than from the shape of
 * the numbers.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname_ = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname_, "..", "..", "..");
const read = (rel: string) => readFileSync(resolve(REPO, rel), "utf8");
/** Source with comments removed — these assertions are about CODE. */
const code = (rel: string) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const ROUTES = code("services/api/src/routes/search.routes.ts");
/**
 * The extracted fact collector.
 *
 * The queries these cases pin used to live INLINE in the diagnostics route,
 * which is why nothing else in the product could ask whether a workspace's
 * index was healthy without calling the endpoint — and why the operations
 * source that needed the answer invented a proxy instead. The properties are
 * unchanged; the module that holds them is named here.
 */
const HEALTH = code("services/api/src/services/search/search-health.service.ts");
const REINDEX = code("services/api/src/services/search/reindex.service.ts");
const PROJECTION = code("packages/shared/src/search-projection.ts");
const READINESS = code("packages/shared/src/search-readiness.ts");

describe("Search readiness — one eligibility population", () => {
  it("every eligibility clause is EMITTED from the shared predicate", () => {
    // The rule previously existed three times: in the diagnostics SQL, in the
    // reindex SQL, and in the projection builder. Three copies of a predicate
    // that must agree forever is how "175 of 393" becomes unexplainable.
    expect(HEALTH).toMatch(/searchIndexableLifecycleSql/);
    expect(ROUTES).toMatch(/searchIndexableLifecycleSql/);
    expect(REINDEX).toMatch(/searchIndexableLifecycleSql/);
    expect(PROJECTION).toMatch(/isSearchIndexableLifecycle/);

    // No hand-written copy of the list survives in either query.
    const handWritten = /NOT IN\s*\n?\s*\('DESTROYED','PENDING_DESTRUCTION'\)/;
    expect(HEALTH).not.toMatch(handWritten);
    expect(ROUTES).not.toMatch(handWritten);
    expect(REINDEX).not.toMatch(handWritten);
    // …nor a second literal comparison in the builder.
    expect(PROJECTION).not.toMatch(/lifecycle === "DESTROYED"\s*\)\s*\{/);
  });

  it("the numerator and the denominator are scoped to one workspace", () => {
    // Both counts are bound to the SAME `team_id` parameter. A count that
    // leaked across a tenant boundary would disclose the existence — and the
    // number — of records in another workspace.
    // Both counting queries bind the workspace explicitly, in the module that
    // now owns them.
    expect(HEALTH).toMatch(/FROM evidence\s*\n\s*WHERE team_id = \$1::uuid/);
    expect(HEALTH).toMatch(
      /FROM evidence_search_documents\s*\n\s*WHERE team_id = \$1::uuid/,
    );
    // Neither query has an unscoped path.
    expect(HEALTH).not.toMatch(/FROM evidence\s*\n\s*GROUP BY/);
    // …and every raw query in it is tenant-bound, not just the two above.
    for (const sql of HEALTH.match(/SELECT[\s\S]*?`/g) ?? []) {
      if (!/FROM (evidence|evidence_search_documents)/.test(sql)) continue;
      expect(sql).toMatch(/team_id = \$1::uuid/);
    }
  });

  it("the endpoint answers authorization before it describes the index", () => {
    // From the route registration to its readiness call. The import of
    // `deriveSearchReadiness` sits at the top of the file, so the CALL is the
    // anchor — the import would slice backwards and measure nothing.
    // From the route registration to the point where it asks for the facts.
    // The import sits at the top of the file, so the CALL is the anchor — an
    // import would slice backwards and measure nothing.
    const handler = ROUTES.slice(
      ROUTES.indexOf("/v1/search/diagnostics"),
      ROUTES.indexOf("collectWorkspaceSearchHealthFacts({"),
    );
    expect(handler.length).toBeGreaterThan(0);
    // `requireSearchActor` runs — and returns — before any count is taken, so
    // an unauthorized actor never receives a number about the workspace.
    const gate = handler.indexOf("requireSearchActor");
    expect(gate).toBeGreaterThan(0);
    expect(handler).toMatch(/if \(!actor\) return;/);
    // No count is taken inside the gated span before the gate itself.
    const firstCount = handler.indexOf("$queryRaw");
    if (firstCount >= 0) expect(gate).toBeLessThan(firstCount);
  });
});

describe("Search readiness — state from persisted facts", () => {
  it("readiness is derived, not classified inline", () => {
    // ONE CALLER OF THE RULE, and it is the module that gathered the facts.
    // The route consumes its verdict; the operations probe consumes the same
    // function. A second call site would be a second place for the inputs to
    // drift.
    expect(HEALTH).toMatch(/deriveSearchReadiness\(\{/);
    expect(ROUTES).not.toMatch(/deriveSearchReadiness\(\{/);
    // The inputs are the eligible population, what the index holds, what is
    // awaiting removal, the run row and the queue. Nothing else.
    const call = HEALTH.slice(
      HEALTH.indexOf("deriveSearchReadiness({"),
      HEALTH.indexOf("});", HEALTH.indexOf("deriveSearchReadiness({")),
    );
    expect(call).toMatch(/eligibleCount: facts\.eligibleCount/);
    expect(call).toMatch(/indexedCount: facts\.indexedEvidenceCount/);
    expect(call).toMatch(/lastIndexedAtUtc/);
    expect(call).not.toMatch(/plan|tier|isPersonal|name/i);
  });

  it("the index's last write is read from the persisted column", () => {
    // `indexed_at_utc` is the evidence that a run is progressing. Without it
    // the endpoint can only compare two numbers, which is exactly what could
    // not distinguish a live backfill from one that never started.
    expect(HEALTH).toMatch(/MAX\(indexed_at_utc\) AS last_indexed/);
    expect(HEALTH).toMatch(/lastIndexedAtUtc: Date \| null = null;/);
  });

  it("the projection is assembled by the SHARED projector, not by hand", () => {
    // The route used to build the readiness object literal itself, and the
    // console declared a matching type of its own. Two declarations of one
    // wire contract is how a field is added on the server and read as
    // `undefined` in the client — for a readiness projection that means the
    // page falls back to inventing a state.
    expect(ROUTES).toMatch(/readiness: projectSearchReadiness\(readiness, \{/);
    // …and no hand-assembled literal survives beside it.
    expect(ROUTES).not.toMatch(/readiness: \{\s*state: readiness\.state/);
  });

  it("the shared projection declares every field the client needs", () => {
    // Asserted against the TYPE, which is what both sides compile against —
    // not against a slice of the route body, which measured whichever fields
    // happened to be typed out at that call site.
    const shape = READINESS.slice(
      READINESS.indexOf("export type SearchReadinessProjection = {"),
      READINESS.indexOf("export function projectSearchReadiness"),
    );
    expect(shape.length).toBeGreaterThan(0);
    for (const field of [
      "state",
      "eligibleCount",
      "indexedCount",
      "outstandingCount",
      "unresolvedRemovals",
      "lastIndexedAtUtc",
      "progressing",
      "runStatus",
      "runStartedAtUtc",
      "runFinishedAtUtc",
      "failureReason",
      "degradedCapabilities",
      "shouldPoll",
      "resultsAreComplete",
      "canRecover",
    ]) {
      expect(shape).toContain(field);
    }
  });

  it("the console imports that type instead of restating it", () => {
    const page = code("apps/web/app/(app)/search/page.tsx");
    // It is imported from the shared package…
    expect(page).toMatch(/type SearchReadinessProjection,/);
    // …and no local declaration of the same contract survives.
    expect(page).not.toMatch(/type SearchReadinessProjection = \{/);
  });

  it("the recovery control is gated on a server-side capability", () => {
    // Reindex is an operator action. `canRecover` is projected from the actor's
    // reviewer capability — the client is never asked to decide it from a role
    // string or a plan.
    expect(ROUTES).toMatch(/canRecover: actor\.isReviewerCapable === true/);
  });

  it("no state is inferred from a result count anywhere in the model", () => {
    expect(READINESS).not.toMatch(/results?\.length|rowCount|totalReturned/);
    expect(READINESS).not.toMatch(/\bplan\b|enterprise|personal/i);
    // The input type has nowhere to put one, which is the structural version
    // of the same guarantee.
    expect(READINESS).toMatch(/export type SearchReadinessInput = \{/);
  });
});
