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
const HOOK = read("lib/useGlobalRuntimeState.ts");

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

  it("the runtime badge's FIRST read waits for idle, not for mount", () => {
    /*
     * The badge is chrome. It reads three endpoints from the SIDEBAR, so it
     * reads them on every authenticated page, and it used to fire the first
     * read synchronously on mount — in the same wave as the page's own data.
     *
     * Readiness alone costs 144 SQL statements and ~120-150ms server-side on
     * the local fixture, 65 of those being catalog EXISTS probes from the
     * runtime schema validator re-run per request. Measured in Chrome with 2ms
     * of database round-trip latency added, it was the most expensive thing on
     * Home — for a dot in the sidebar.
     *
     * Deferring it is only safe because UNKNOWN never collapses into HEALTHY;
     * the pill renders "Status pending" until the answer arrives. The test
     * below holds that rule.
     */
    expect(HOOK).toMatch(/requestIdleCallback/);
    expect(HOOK).toMatch(/FIRST_TICK_DEADLINE_MS/);
    // A hard deadline, so a page that never idles still gets its status.
    expect(HOOK).toMatch(/setTimeout\(startFirstTick, FIRST_TICK_DEADLINE_MS\)/);
    // And the immediate call is gone.
    expect(HOOK).not.toMatch(/\n\s*void tickOnce\(\);\n\s*const handle = window\.setInterval/);
  });

  it("the deferred first read is still cancelled on unmount", () => {
    // A deferred callback that outlives its component writes into a hook that
    // is gone, or worse, into the next workspace's state.
    expect(HOOK).toMatch(/cancelIdleCallback/);
    expect(HOOK).toMatch(/clearTimeout\(timeoutHandle\)/);
    expect(HOOK).toMatch(/if \(cancelled\) return;/);
  });

  it("waiting for the runtime state is never rendered as healthy", () => {
    // The whole basis for deferring it. If UNKNOWN ever became HEALTHY, the
    // deferral would turn a slow answer into a false all-clear.
    const indicator = read("components/operational/GlobalRuntimeIndicator.tsx");
    expect(indicator).toMatch(/UNKNOWN: "Status pending"/);
    expect(HOOK).toMatch(/UNKNOWN never collapses into HEALTHY/);
  });

  it("the billing overview is read once when two components ask together", () => {
    /*
     * The sidebar storage widget and Home's data hook both read
     * `/v1/billing/overview`. The widget is in the shell, so on Home they
     * mount together and the page issued the request twice — measured in
     * Chrome on every Home load.
     */
    const widget = read("components/app-shell-v2/SidebarStorageWidget.tsx");
    const home = read("components/home-experience/useHomeData.ts");
    expect(widget).toMatch(/inFlightGet<BillingOverview>\("\/v1\/billing\/overview"/);
    expect(home).toMatch(/inFlightGet<\s*HomeBillingInput\s*>\("\/v1\/billing\/overview"/);
  });

  it("the coalescer is not a cache — nothing survives the request", () => {
    /*
     * A TTL cache here would serve a stale storage figure after an upload, and
     * would block Home's own focus revalidation. Only CONCURRENT callers share
     * a response, and the entry is dropped as soon as it settles — including
     * when it rejects, so a failure cannot poison the next read.
     */
    const coalescer = read("lib/inFlightGet.ts");
    expect(coalescer).toMatch(/inFlight\.delete\(key\)/);
    expect(coalescer).toMatch(/\.finally\(/);
    /*
     * The CODE, with prose removed, and whole identifiers only. `/ttl/i`
     * against the whole file matched the word "settles" — the kind of false
     * positive that makes a guard look strict while proving nothing.
     */
    const code = coalescer
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((l) => !/^\s*\/\//.test(l))
      .join("\n");
    expect(code).not.toMatch(/\b(ttl|maxAge|expiresAt|cacheFor)\b/i);
    expect(code).not.toMatch(/setTimeout/);
  });

  it("the API origin is preconnected from the one authority that knows it", () => {
    /*
     * The API is a different origin, so the browser cannot start DNS/TCP/TLS
     * for it until something asks — and the first thing that asks is a
     * provider mounting after the bundle parses. Measured from CDP (Resource
     * Timing zeroes the connection phases for a cross-origin response with no
     * Timing-Allow-Origin, and would have reported 0ms server time), the first
     * two API requests each paid ~306ms of connection setup on this host.
     *
     * The origin must come from `apiBaseUrl()`. A literal or a second env read
     * would preconnect to the wrong host in exactly the deployments where it
     * matters.
     */
    const layout = read("app/layout.tsx");
    expect(layout).toMatch(/rel="preconnect"/);
    expect(layout).toMatch(/apiBaseUrl\(\)/);
    // Credentialed: an anonymous preconnect opens a different connection from
    // the one a credentialed request needs, and buys nothing.
    expect(layout).toMatch(/crossOrigin="use-credentials"/);
    expect(layout).not.toMatch(/rel="preconnect" href="http/);
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
