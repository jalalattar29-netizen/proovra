/**
 * PHASE 12 — ROUTE↔CONSUMER CLOSURE GATE.
 *
 * This suite used to drive `verify-route-consumers.mjs`, which was its own text
 * scanner and its own opinion about what is registered and what calls it. That
 * scanner is retired (FINAL-001): it needed a repair per idiom, and while it
 * existed the system had two answers to "how many routes have a consumer" —
 * 773 from it, 785 from the hand-maintained map — with no way to say which was
 * measuring anything. The gate now drives the ONE canonical generator.
 *
 * THE THREE QUESTIONS ARE KEPT SEPARATE, on purpose.
 *
 *   AnalyzerIntegrity  — did the measurement resolve everything it saw? Any
 *                        unresolved request, unreviewed origin, ambiguous call
 *                        site or classification conflict is a hole in the
 *                        INSTRUMENT and fails here immediately.
 *
 *   BacklogDidNotGrow  — a ratchet over the routes still awaiting a reviewed
 *                        disposition. It may shrink; it may never grow. This is
 *                        the gate that stays green while the work is finished.
 *
 *   ClassificationClosure — zero undisposed routes. This is NOT asserted green
 *                        here, because it is not green: 225 routes with no
 *                        product consumer still carry no reviewed disposition.
 *                        It is carried as an OPEN row in the canonical ledger
 *                        (FINAL-001) and by the generator's own exit code, so
 *                        the open work is visible in exactly one place instead
 *                        of being quietly absorbed into a passing suite.
 *
 * Conflating those three is how a ratchet with an unresolved baseline comes to
 * look like a closed classification.
 */

import { describe, expect, it, vi } from "vitest";

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- the generator is an .mjs authority; see capability-authority-modules.d.ts
import { build } from "../scripts/generate-runtime-capability-map.mjs";

vi.setConfig({ testTimeout: 180_000 });

type Artifact = {
  totals: Record<string, number> & { byDisposition: Record<string, number> };
  problems: Array<Record<string, unknown>>;
  routes: Array<{
    routeId: string;
    disposition: string | null;
    dispositionSource: string | null;
    dispositionEvidence: string | null;
    productConsumers: unknown[];
    machineConsumers: unknown[];
    result: string;
    productionRegistered: boolean;
  }>;
};

/**
 * The published backlog ratchet.
 *
 * This is the number of registered routes with no product consumer and no
 * REVIEWED disposition, at the moment the canonical authority replaced the
 * hand-maintained column. It is allowed to fall and nothing else. Raising it
 * requires editing this line, which is the point: a backlog that can grow
 * silently is not a backlog, it is a habit.
 */
const UNDISPOSED_RATCHET = 210;

let cached: Artifact | null = null;
const artifact = (): Artifact => {
  if (cached === null) cached = build() as Artifact;
  return cached;
};

describe("capability authority — analyzer integrity", () => {
  it("resolves every request it saw, or says so out loud", () => {
    const t = artifact().totals;
    // Each of these is a hole in the INSTRUMENT, not in the product. A non-zero
    // value here means some number elsewhere in this artifact is a guess.
    expect({
      DynamicUnresolvedConsumers: t.DynamicUnresolvedConsumers,
      DynamicUnresolvedRouteRegistrations: t.DynamicUnresolvedRouteRegistrations,
      UnreviewedOriginConsumers: t.UnreviewedOriginConsumers,
      AmbiguousConsumerSites: t.AmbiguousConsumerSites,
      UnmatchedConsumerCalls: t.UnmatchedConsumerCalls,
      AuthorizationUnresolved: t.AuthorizationUnresolved,
    }).toEqual({
      DynamicUnresolvedConsumers: 0,
      DynamicUnresolvedRouteRegistrations: 0,
      UnreviewedOriginConsumers: 0,
      AmbiguousConsumerSites: 0,
      UnmatchedConsumerCalls: 0,
      AuthorizationUnresolved: 0,
    });
  });

  it("no browser call reaches the API on the wrong origin", () => {
    // A relative `/v1/...` handed to raw `fetch` in the web tree is served by
    // the Next origin, which has no rewrite for it: the call 404s at runtime
    // while looking perfectly correct in review. AUDIT-002 was three of these.
    expect(artifact().totals.WrongOriginConsumers).toBe(0);
  });

  it("no classification is contradicted by the tree", () => {
    // Includes UNREACHABLE_ALIAS_REGISTRATION — a route registered under
    // `/v1/workspaces`, which the alias plugin rewrites away before routing, so
    // both spellings 404 (FINAL-005).
    expect(artifact().problems).toEqual([]);
  });

  it("every reviewed disposition carries source evidence", () => {
    const naked = artifact()
      .routes.filter((r) => r.dispositionSource === "REVIEWED")
      .filter((r) => !r.dispositionEvidence || r.dispositionEvidence.trim().length === 0)
      .map((r) => r.routeId);
    expect(naked, `reviewed dispositions without evidence:\n${naked.join("\n")}`).toEqual([]);
  });

  it("a derived disposition names the fact that forced it", () => {
    const derived = artifact().routes.filter((r) => r.dispositionSource === "DERIVED");
    expect(derived.length).toBeGreaterThan(0);
    const naked = derived.filter((r) => !r.dispositionEvidence).map((r) => r.routeId);
    expect(naked, `derived dispositions without evidence:\n${naked.join("\n")}`).toEqual([]);
  });
});

describe("capability authority — the backlog ratchet", () => {
  it("the undisposed backlog did not grow", () => {
    const undisposed = artifact().totals.UndisposedRoutes;
    expect(
      undisposed,
      `the undisposed backlog GREW to ${undisposed} (ratchet ${UNDISPOSED_RATCHET}). ` +
        "Every registered route with no product consumer needs exactly one reviewed " +
        "disposition in scripts/capability-authority/manifests/route-dispositions.json.",
    ).toBeLessThanOrEqual(UNDISPOSED_RATCHET);
  });

  it("reports the closure distance honestly rather than absorbing it", () => {
    const t = artifact().totals;
    // Deliberately a REPORT, not an assertion of zero. Asserting zero here would
    // require either finishing 225 product judgements or quietly lowering the
    // bar, and the second is how a hand-maintained column happens.
    // eslint-disable-next-line no-console
    console.log(
      "CLASSIFICATION CLOSURE:",
      JSON.stringify({
        RegisteredRoutes: t.RegisteredRoutes,
        ProductConsumerRoutes: t.ProductConsumerRoutes,
        MachineOnlyConsumerRoutes: t.MachineOnlyConsumerRoutes,
        UndisposedRoutes: t.UndisposedRoutes,
        byDisposition: t.byDisposition,
      }),
    );
    expect(t.RegisteredRoutes).toBe(
      t.ProductConsumerRoutes + t.MachineOnlyConsumerRoutes + t.NoConsumerRoutes,
    );
  });
});

describe("capability authority — one authority", () => {
  it("counts conserve: every route lands in exactly one result bucket", () => {
    const rows = artifact().routes;
    const connected = rows.filter((r) => r.result === "PRODUCT_CONNECTED").length;
    const disposed = rows.filter((r) => r.result.startsWith("DISPOSED_")).length;
    const undisposed = rows.filter((r) => r.result === "UNDISPOSED").length;
    expect(connected + disposed + undisposed).toBe(rows.length);
    expect(undisposed).toBe(artifact().totals.UndisposedRoutes);
  });

  it("a route counted as product-connected really has a product caller", () => {
    const lying = artifact()
      .routes.filter((r) => r.result === "PRODUCT_CONNECTED" && r.productConsumers.length === 0)
      .map((r) => r.routeId);
    expect(lying).toEqual([]);
  });
});
