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
const REINDEX = code("services/api/src/services/search/reindex.service.ts");
const PROJECTION = code("packages/shared/src/search-projection.ts");
const READINESS = code("packages/shared/src/search-readiness.ts");

describe("Search readiness — one eligibility population", () => {
  it("every eligibility clause is EMITTED from the shared predicate", () => {
    // The rule previously existed three times: in the diagnostics SQL, in the
    // reindex SQL, and in the projection builder. Three copies of a predicate
    // that must agree forever is how "175 of 393" becomes unexplainable.
    expect(ROUTES).toMatch(/searchIndexableLifecycleSql/);
    expect(REINDEX).toMatch(/searchIndexableLifecycleSql/);
    expect(PROJECTION).toMatch(/isSearchIndexableLifecycle/);

    // No hand-written copy of the list survives in either query.
    const handWritten = /NOT IN\s*\n?\s*\('DESTROYED','PENDING_DESTRUCTION'\)/;
    expect(ROUTES).not.toMatch(handWritten);
    expect(REINDEX).not.toMatch(handWritten);
    // …nor a second literal comparison in the builder.
    expect(PROJECTION).not.toMatch(/lifecycle === "DESTROYED"\s*\)\s*\{/);
  });

  it("the numerator and the denominator are scoped to one workspace", () => {
    // Both counts are bound to the SAME `team_id` parameter. A count that
    // leaked across a tenant boundary would disclose the existence — and the
    // number — of records in another workspace.
    // Both counting queries bind the workspace explicitly.
    expect(ROUTES).toMatch(/FROM evidence\s*\n\s*WHERE team_id = \$1::uuid/);
    expect(ROUTES).toMatch(
      /FROM evidence_search_documents\s*\n\s*WHERE team_id = \$\{teamId\}::uuid/,
    );
    // Neither query has an unscoped path.
    expect(ROUTES).not.toMatch(/FROM evidence\s*\n\s*GROUP BY/);
  });

  it("the endpoint answers authorization before it describes the index", () => {
    // From the route registration to its readiness call. The import of
    // `deriveSearchReadiness` sits at the top of the file, so the CALL is the
    // anchor — the import would slice backwards and measure nothing.
    const handler = ROUTES.slice(
      ROUTES.indexOf("/v1/search/diagnostics"),
      ROUTES.indexOf("deriveSearchReadiness({"),
    );
    expect(handler.length).toBeGreaterThan(0);
    // `requireSearchActor` runs — and returns — before any count is taken, so
    // an unauthorized actor never receives a number about the workspace.
    const gate = handler.indexOf("requireSearchActor");
    const firstCount = handler.indexOf("$queryRawUnsafe");
    expect(gate).toBeGreaterThan(0);
    expect(gate).toBeLessThan(firstCount);
    expect(handler).toMatch(/if \(!actor\) return;/);
  });
});

describe("Search readiness — state from persisted facts", () => {
  it("readiness is derived, not classified inline", () => {
    expect(ROUTES).toMatch(/deriveSearchReadiness\(\{/);
    // The inputs are the eligible population, what the index holds, and when
    // the index last advanced. Nothing else.
    const call = ROUTES.slice(
      ROUTES.indexOf("deriveSearchReadiness({"),
      ROUTES.indexOf("});", ROUTES.indexOf("deriveSearchReadiness({")),
    );
    expect(call).toMatch(/eligibleCount: evidenceIndexable/);
    expect(call).toMatch(/indexedCount: indexedEvidence/);
    expect(call).toMatch(/lastIndexedAtUtc/);
    expect(call).not.toMatch(/plan|tier|isPersonal|name/i);
  });

  it("the index's last write is read from the persisted column", () => {
    // `indexed_at_utc` is the evidence that a run is progressing. Without it
    // the endpoint can only compare two numbers, which is exactly what could
    // not distinguish a live backfill from one that never started.
    expect(ROUTES).toMatch(/MAX\(indexed_at_utc\)\s*AS last_indexed/);
    expect(ROUTES).toMatch(/lastIndexedAtUtc: Date \| null = null;/);
  });

  it("the projection carries what the client needs to avoid guessing", () => {
    const payload = ROUTES.slice(
      ROUTES.indexOf("readiness: {"),
      ROUTES.indexOf("},", ROUTES.indexOf("readiness: {")),
    );
    for (const field of [
      "state",
      "eligibleCount",
      "indexedCount",
      "outstandingCount",
      "lastIndexedAtUtc",
      "progressing",
      "failureReason",
      "shouldPoll",
      "resultsAreComplete",
      "canRecover",
    ]) {
      expect(payload).toContain(field);
    }
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
