/**
 * HOME'S REQUEST SHAPE — no accidental waterfalls.
 *
 * Home was profiled in an organization workspace on the local fixture. Its
 * reads arrive in TWO waves, and only the first boundary is a real dependency:
 * every workspace-scoped read needs the `teamId` that the platform context
 * resolves, so nothing after it can start earlier than that.
 *
 * There was a third wave, and it was not a dependency at all — the global
 * runtime badge awaited readiness, then incidents, then escalations, three
 * independent questions asked one at a time. It runs on every app page, so the
 * cost was paid everywhere and paid in serial round trips.
 *
 * These are source-contract tests: what they protect is the SHAPE that produced
 * the measurements, since the measurements themselves belong to the run that
 * took them.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const WEB = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "apps/web",
);
const read = (rel: string) => readFileSync(resolve(WEB, rel), "utf8");

const HOME_DATA = read("components/home-experience/useHomeData.ts");
const RUNTIME_STATE = read("lib/useGlobalRuntimeState.ts");

const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

describe("the global runtime badge asks its three questions together", () => {
  const tick = (() => {
    const code = stripComments(RUNTIME_STATE);
    return code.slice(
      code.indexOf("async function tickOnce()"),
      code.indexOf("void tickOnce();"),
    );
  })();

  it("issues readiness, incidents and escalations concurrently", () => {
    expect(tick).toContain("await Promise.allSettled([");
    // One await for all three, not one each.
    const awaits = tick.match(/await apiFetch\(/g) ?? [];
    expect(awaits).toHaveLength(3);
    const gathered = tick.slice(
      tick.indexOf("await Promise.allSettled(["),
      tick.indexOf("if (cancelled || !mountedRef.current) return;"),
    );
    for (const path of [
      "/admin/runtime/readiness",
      "/v1/ops/incidents",
      "/v1/reviewer-ops/escalations",
    ]) {
      expect(gathered, `${path} must be inside the concurrent group`).toContain(path);
    }
  });

  it("uses allSettled, so one source failing keeps the other two", () => {
    expect(tick).not.toContain("await Promise.all([");
  });

  it("each source keeps its own access gate and refusal latch", () => {
    /*
     * Concurrency must not quietly widen what gets requested. A source the
     * caller may not read is still not read, and a settled refusal (401/403/404)
     * still latches that source off for the workspace instead of being retried
     * on every tick.
     */
    for (const source of ["readiness", "incidents", "escalations"] as const) {
      expect(tick).toContain(`access.${source}`);
      expect(tick).toContain(`refusedRef.current.has("${source}")`);
      expect(tick).toContain(`refusedRef.current.add("${source}")`);
      expect(tick).toContain(`nextErrors.${source} = true;`);
    }
  });

  it("the staleness guards still run once, after all three have settled", () => {
    const afterGather = tick.slice(tick.indexOf("await Promise.allSettled(["));
    expect(afterGather).toContain("if (cancelled || !mountedRef.current) return;");
    expect(afterGather).toContain("if (generationRef.current !== myGeneration) return;");
  });
});

describe("Home's own reads are one wave", () => {
  const body = stripComments(HOME_DATA);

  it("every read is started before any of them is awaited", () => {
    /*
     * The promises are created first and gathered once. Creating them inside
     * the await list would be the same code and the same behaviour; creating
     * them one `await` at a time would not.
     */
    /*
     * THE PROPERTY IS UNCHANGED; THE SHAPE IS NOT.
     *
     * The gather used to be one `await Promise.all([...])` destructured into
     * ten names. Home now publishes each response as it lands, so the ten
     * promises are handed to `track(...)` instead — created first, exactly as
     * before, then awaited together so the caller still knows when the run is
     * over. What this test protects is that no read WAITS for another to be
     * created, and that is what the window below still measures.
     */
    const gather = body.slice(
      body.indexOf("await Promise.all(["),
      body.indexOf("// `orgs` is intentionally read via `orgsRef`"),
    );
    for (const promise of [
      "ccPromise",
      "trustPromise",
      "billingPromise",
      "reportsPromise",
      "intakeLinksPromise",
      "inboxPromise",
      "communicationsPromise",
      "evidenceListPromise",
      "recordsByTypePromise",
      "operationsSummaryPromise",
    ]) {
      expect(gather, `${promise} must be gathered, not awaited alone`).toContain(promise);
    }
  });

  it("nothing in the hook awaits one read before starting the next", () => {
    const reload = body.slice(
      body.indexOf("const reload = useCallback"),
      body.indexOf("await Promise.all(["),
    );
    expect(
      reload,
      "a bare await inside reload would serialize the reads it precedes",
    ).not.toMatch(/await apiFetch\(/);
  });

  it("no tab-scoped fetch exists to defer — the tabs share one view model", () => {
    /*
     * Overview, Operations and Analytics are three views of ONE normalized
     * model, so there is no inactive-tab request blocking the first useful
     * content and nothing to lazy-load. The only other calls on this surface
     * are user-triggered actions (retry a delivery, open a download).
     */
    const sections = stripComments(
      read("components/home-experience/HomeSections.tsx"),
    );
    const calls = sections.match(/await apiFetch\(/g) ?? [];
    expect(calls.length).toBeLessThanOrEqual(2);
    expect(sections).not.toContain("useEffect(() => {\n    void apiFetch");
  });

  it("a slice that has not arrived is never rendered as 'unavailable'", () => {
    /*
     * Why Home does not paint progressively. `null` is a MEANINGFUL value to
     * this normalizer — the Phase 4C note is explicit that a failed operations
     * summary becomes an honest "unavailable" and must never fall back to a
     * substitute. Rendering before a read lands would therefore assert
     * something false about the workspace rather than merely look unfinished,
     * so the model is built once, from settled inputs.
     */
    expect(HOME_DATA).toContain("it never falls back to the feed");
    expect(body).toContain('setState({ status: "ready", viewModel });');
    const gatherToRender = body.slice(
      body.indexOf("] = await Promise.all(["),
      body.indexOf('setState({ status: "ready", viewModel });'),
    );
    expect(
      gatherToRender.match(/setState\(/g) ?? [],
      "an intermediate setState would publish a partial model",
    ).toHaveLength(0);
  });
});
