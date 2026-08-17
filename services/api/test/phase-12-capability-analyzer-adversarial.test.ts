/**
 * PHASE 12 — THE ADVERSARIAL BATTERY FOR THE CAPABILITY ANALYZER.
 *
 * Every parser defect found while building this analyzer had the same shape: it
 * did not crash, it did not warn, it produced a confident number that was wrong.
 * A nested template literal made a route look uncalled. A guard hoisted into a
 * shared options constant made eleven admin routes look unauthenticated. A
 * `{ preHandler }` shorthand hid seven more. `apiBase()` in the PayPal client
 * imported six of PayPal's endpoints into this system's inventory. None of those
 * would have failed a test that only asked "does it run".
 *
 * So these cases are the defects, written down. Each one is an idiom the tree
 * actually contains, and each asserts the answer the analyzer must give — not
 * that it gives SOME answer. They call the PRODUCTION modules; a copied
 * validator would prove only that the copy agrees with itself.
 */

import { strict as assert } from "node:assert";
import { describe, it, vi } from "vitest";

import {
  INTERP,
  candidatePaths,
  literalUnionOf,
  matches,
  normalizePath,
  parse,
  resolvePathExpr,
  segMatch,
} from "../scripts/capability-authority/analyzer.mjs";

// ---------------------------------------------------------------------------
// Harness: parse a fragment and hand a chosen expression to the real resolver.
// ---------------------------------------------------------------------------

/**
 * The live-tree cases parse ~1,700 source files through the compiler API. That is
 * seconds, not milliseconds, and the 5s default turns a passing assertion into a
 * timeout that reads like a failure of the thing being tested.
 */
const ANALYZER_TIMEOUT_MS = 180_000;
vi.setConfig({ testTimeout: ANALYZER_TIMEOUT_MS });

type Ctx = {
  lookupConst?: (n: string) => string | undefined;
  lookupNode?: (n: string) => unknown;
  resolveCall?: (n: string, call: unknown) => string | undefined;
};

/** Resolves the FIRST argument of the first call to `fn` in `source`. */
function resolveFirstArg(source: string, fn: string, ctx: Ctx = {}): { resolved: boolean; value?: string } {
  const sf = parse("fixture.tsx", source) as any;
  const ts = requireTs();
  let found: unknown = null;
  const visit = (node: any) => {
    if (found) return;
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : null;
      if (name === fn) found = node.arguments?.[0] ?? null;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  assert.ok(found !== null, `fixture did not contain a call to ${fn}()`);
  return resolvePathExpr(found, { lookupConst: () => undefined, ...ctx }) as never;
}

function requireTs() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require("typescript");
}

/** Parses `source` and returns the literal union of the first `${…}` span. */
function unionOfFirstSpan(source: string): string[] | null {
  const sf = parse("fixture.ts", source) as any;
  const ts = requireTs();
  let span: unknown = null;
  const visit = (node: any) => {
    if (span) return;
    if (ts.isTemplateExpression(node)) span = node.templateSpans[0].expression;
    ts.forEachChild(node, visit);
  };
  visit(sf);
  assert.ok(span !== null, "fixture had no template expression");
  return literalUnionOf(span) as never;
}

describe("capability analyzer — consumer path resolution", () => {
  it("1. resolves a direct literal apiFetch path", () => {
    const r = resolveFirstArg(`apiFetch("/v1/cases");`, "apiFetch");
    assert.equal(r.value, "/v1/cases");
  });

  it("2. resolves a direct literal fetch path", () => {
    const r = resolveFirstArg(`fetch("/v1/evidence");`, "fetch");
    assert.equal(r.value, "/v1/evidence");
  });

  it("3. resolves a path split across several lines", () => {
    const r = resolveFirstArg(
      `apiFetch(\n  "/v1/reviewer-ops/queue",\n  { method: "GET" },\n);`,
      "apiFetch",
    );
    assert.equal(r.value, "/v1/reviewer-ops/queue");
  });

  it("4. resolves a NESTED template used as a query suffix", () => {
    // The idiom that made a whole family of routes look uncalled: the inner
    // template resolves to something starting with `?`, which is not part of
    // route identity and is dropped by normalization rather than corrupting it.
    const r = resolveFirstArg(
      "apiFetch(`/v1/audit/tenant${qs ? `?${qs}` : \"\"}`);",
      "apiFetch",
    );
    assert.equal(normalizePath(candidatePaths(r.value!)[1] ?? r.value!), "/v1/audit/tenant");
  });

  it("5. lets an interpolated segment satisfy a :param segment", () => {
    const r = resolveFirstArg("apiFetch(`/v1/cases/${id}`);", "apiFetch");
    assert.ok(matches("/v1/cases/:id", normalizePath(r.value!)));
  });

  it("6. REFUSES to let an interpolated segment satisfy a LITERAL segment", () => {
    // Allowing this credits the update-by-id call as a caller of the list route,
    // manufacturing the exact "this endpoint is wired" claim the analyzer exists
    // to prevent. Over-matching hides an orphan; under-matching only costs a
    // human a written disposition. The two errors are not symmetric.
    assert.equal(segMatch("endpoints", INTERP), false);
    assert.equal(matches("/v1/integrations/webhooks/endpoints", `/v1/integrations/webhooks/${INTERP}`), false);
  });

  it("7. resolves an identifier bound to a route constant", () => {
    const r = resolveFirstArg(`apiFetch(EXPORT_PATH);`, "apiFetch", {
      lookupConst: (n) => (n === "EXPORT_PATH" ? "/v1/admin/audit-log/export" : undefined),
    });
    assert.equal(r.value, "/v1/admin/audit-log/export");
  });

  it("8. resolves a path assembled by string concatenation", () => {
    const r = resolveFirstArg(`fetch(BASE + "/v1/ping");`, "fetch", {
      lookupConst: (n) => (n === "BASE" ? "" : undefined),
    });
    assert.equal(r.value, "/v1/ping");
  });

  it("9. reads the path out of a URL constructor", () => {
    const r = resolveFirstArg(`fetch(new URL("/v1/health", base));`, "fetch");
    assert.equal(r.value, "/v1/health");
  });

  it("10. resolves a path bound to a local before the request", () => {
    // `const url = ...; apiFetch(url)` — reading only string LITERAL bindings
    // lost every one of these, and the loss showed up as an unresolvable
    // request rather than as a missing route.
    const src = "const url = `/v1/reviewer-workspace?teamId=${teamId}`; apiFetch(url);";
    const sf = parse("fixture.ts", src) as any;
    const ts = requireTs();
    let binding: unknown = null;
    const visit = (n: any) => {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === "url") binding = n.initializer;
      ts.forEachChild(n, visit);
    };
    visit(sf);
    const r = resolveFirstArg(src, "apiFetch", { lookupNode: (n) => (n === "url" ? binding : undefined) });
    assert.equal(normalizePath(r.value!), "/v1/reviewer-workspace");
  });

  it("11. resolves a helper that RETURNS a path", () => {
    const r = resolveFirstArg(`apiFetch(buildUrl(null));`, "apiFetch", {
      resolveCall: (n) => (n === "buildUrl" ? "/v1/me/inbox" : undefined),
    });
    assert.equal(r.value, "/v1/me/inbox");
  });

  it("12. treats an encoding helper as ONE segment, not a path", () => {
    const r = resolveFirstArg("apiFetch(`/v1/cases/${encodeURIComponent(id)}`);", "apiFetch");
    assert.equal(r.value, `/v1/cases/${INTERP}`);
    assert.ok(matches("/v1/cases/:id", r.value!));
  });

  it("13. resolves both branches of a conditional path", () => {
    const r = resolveFirstArg(`apiFetch(a ? "/v1/x" : "/v1/y");`, "apiFetch");
    assert.ok(r.resolved);
    assert.ok(r.value === "/v1/x" || r.value === "/v1/y");
  });

  it("14. refuses an unresolvable identifier rather than guessing", () => {
    const r = resolveFirstArg(`fetch(someRuntimeUrl);`, "fetch");
    assert.equal(r.resolved, false);
  });

  it("15. drops the query string from route identity but keeps the path", () => {
    assert.equal(normalizePath("/v1/cases?teamId=abc&cursor=1"), "/v1/cases");
  });

  it("16. drops a trailing slash", () => {
    assert.equal(normalizePath("/v1/cases/"), "/v1/cases");
  });

  it("17. rewrites the /v1/workspaces alias onto the registered /v1/teams route", () => {
    // `workspace-alias.plugin.ts` rewrites in an onRequest hook BEFORE Fastify
    // matches, so a caller of /v1/workspaces/:id really is a caller of the
    // registered /v1/teams/:id handler. Comparing raw strings misses every one.
    assert.equal(normalizePath("/v1/workspaces/abc/members"), "/v1/teams/abc/members");
    assert.equal(normalizePath("/v1/workspaces"), "/v1/teams");
  });

  it("18. does not rewrite a path that merely starts with the same letters", () => {
    assert.equal(normalizePath("/v1/workspaces-summary"), "/v1/workspaces-summary");
  });

  it("19. offers the literal-only reading of a final mixed segment", () => {
    const cands = candidatePaths(`/v1/admin/audit-log/export${INTERP}`);
    assert.ok(cands.includes("/v1/admin/audit-log/export"));
  });

  it("20. does NOT shorten a final segment that is purely a parameter", () => {
    // Shortening it would credit `/v1/cases/${id}` as a call to `GET /v1/cases`.
    const cands = candidatePaths(`/v1/cases/${INTERP}`);
    assert.ok(!cands.includes("/v1/cases"));
  });

  it("21. matches a wildcard route pattern", () => {
    assert.ok(matches("/v1/proxy/*", "/v1/proxy/a/b"));
  });

  it("22. enumerates an inline literal-union parameter", () => {
    const union = unionOfFirstSpan(
      'function postAction(itemKey: string, action: "read" | "unread" | "dismiss") { return `/v1/me/inbox/items/${action}`; }',
    );
    assert.deepEqual(union, ["read", "unread", "dismiss"]);
  });

  it("23. enumerates a NAMED literal-union type alias", () => {
    const union = unionOfFirstSpan(
      'type Action = "start" | "assign"; function run(action: Action) { return `/v1/ops/workflows/${action}`; }',
    );
    assert.deepEqual(union, ["start", "assign"]);
  });

  it("24. returns null for an interpolation with no literal-union type", () => {
    const union = unionOfFirstSpan("function run(id: string) { return `/v1/cases/${id}`; }");
    assert.equal(union, null);
  });

  it("25. the interpolation marker is a NAMED token, never whitespace", () => {
    // An earlier revision used a quoted space; an encoding accident turned it
    // into a NUL byte, and because every use was mangled identically the bug had
    // no symptom at all. A token that cannot be typo'd invisibly costs nothing.
    assert.equal(INTERP, "<interp>");
    assert.ok(INTERP.length > 1);
    assert.ok(!/\s/.test(INTERP));
  });
});

describe("capability analyzer — route registration and authorization", () => {
  // These read the LIVE tree through the production route analyzer, so a
  // regression in either the parser or the source is caught by the same test.
  let cached: { routes: any[]; index: any } | null = null;

  async function live() {
    if (cached !== null) return cached;
    const { indexApiFunctions, extractRoutes } = await import("../scripts/capability-authority/routes.mjs");
    const index = indexApiFunctions();
    const { routes } = extractRoutes(index);
    cached = { routes, index };
    return cached;
  }

  const find = (routes: any[], method: string, p: string) =>
    routes.find((r) => r.route === p && r.methods.some((m: string) => m.toUpperCase() === method));

  async function authOf(method: string, p: string) {
    const { routes, index } = await live();
    const { classifyRouteAuth } = await import("../scripts/capability-authority/routes.mjs");
    const r = find(routes, method, p);
    assert.ok(r !== undefined, `route not registered: ${method} ${p}`);
    return classifyRouteAuth(r, index) as { authClassification: string; gates: string[] };
  }

  it("26. resolves a guard held in a shared options CONSTANT", async () => {
    // `const ADMIN_PRE = { preHandler: requirePlatformAdmin }` passed to eleven
    // analytics routes. Reading only inline object literals made every one look
    // unguarded — an analyzer bug that presents as a five-alarm security finding.
    const { routes, index } = await live();
    const { classifyRouteAuth } = await import("../scripts/capability-authority/routes.mjs");
    const analytics = routes.filter((r: any) => r.registeringFile.endsWith("analytics.routes.ts"));
    assert.ok(analytics.length > 0, "analytics routes not found");
    for (const r of analytics) {
      const c = classifyRouteAuth(r, index) as { authClassification: string };
      assert.notEqual(c.authClassification, "PUBLIC_UNGUARDED");
    }
  });

  it("27. resolves the `{ preHandler }` SHORTHAND property", async () => {
    // A shorthand assignment is a different node kind with no `.initializer` at
    // all; handling only PropertyAssignment silently skipped every route written
    // this way, including seven organization bulk-invite and seat CSV routes.
    const { routes, index } = await live();
    const { classifyRouteAuth } = await import("../scripts/capability-authority/routes.mjs");
    const orgReports = routes.filter((r: any) =>
      r.registeringFile.endsWith("organizations-reports.routes.ts"),
    );
    assert.ok(orgReports.length > 0);
    for (const r of orgReports) {
      const c = classifyRouteAuth(r, index) as { authClassification: string };
      assert.notEqual(c.authClassification, "PUBLIC_UNGUARDED");
    }
  });

  it("28. finds a guard called INSIDE the handler body", async () => {
    // `POST /v1/reviewer-ops/reconcile` checks its cron secret on the first line
    // of the handler. A preHandler-only reading reported it unauthenticated —
    // the false alarm this whole investigation started from.
    const c = await authOf("POST", "/v1/reviewer-ops/reconcile");
    assert.equal(c.authClassification, "CRON_SECRET");
  });

  it("29. classifies a signature-verified provider webhook", async () => {
    const c = await authOf("POST", "/stripe");
    assert.equal(c.authClassification, "WEBHOOK_SIGNATURE");
  });

  it("30. classifies the SCIM bearer surface", async () => {
    const { routes, index } = await live();
    const { classifyRouteAuth } = await import("../scripts/capability-authority/routes.mjs");
    const scim = routes.filter((r: any) => r.route.startsWith("/v2/scim"));
    assert.ok(scim.length > 0, "no SCIM routes registered");
    for (const r of scim) {
      const c = classifyRouteAuth(r, index) as { authClassification: string };
      assert.ok(
        ["SCIM_BEARER", "MULTI_GATE"].includes(c.authClassification),
        `${r.route} classified ${c.authClassification}`,
      );
    }
  });

  it("31. expands a LOOP-generated route registration", async () => {
    // `for (const [leg] of [["suspend"],["resume"]]) app.post(`/v1/admin/orgs/:id/${leg}`)`
    // registers two routes. A parser that cannot resolve the template reports a
    // dynamic-unresolved REGISTRATION, which is an admitted blind spot in the
    // route inventory itself.
    const { routes } = await live();
    assert.ok(find(routes, "POST", "/v1/admin/orgs/:id/suspend"), "suspend leg missing");
    assert.ok(find(routes, "POST", "/v1/admin/orgs/:id/resume"), "resume leg missing");
  });

  it("32. registers zero dynamically-unresolvable routes", async () => {
    const { extractRoutes, indexApiFunctions } = await import("../scripts/capability-authority/routes.mjs");
    const { dynamicUnresolved } = extractRoutes(indexApiFunctions());
    assert.deepEqual(dynamicUnresolved, []);
  });

  it("33. leaves NO route in AUTHORIZATION_UNRESOLVED", async () => {
    // An unresolved gate is not a passing state. A confident wrong answer about
    // a security gate is worse than an admitted gap, so the analyzer is allowed
    // to say "unresolved" — but the tree is not allowed to contain one.
    const { routes, index } = await live();
    const { classifyRouteAuth } = await import("../scripts/capability-authority/routes.mjs");
    const unresolved = routes
      .map((r: any) => ({ r, c: classifyRouteAuth(r, index) as { authClassification: string } }))
      .filter((x: any) => x.c.authClassification === "AUTHORIZATION_UNRESOLVED")
      .map((x: any) => `${x.r.method} ${x.r.route}`);
    assert.deepEqual(unresolved, []);
  });

  it("34. classifies a development-only registration as such, not as a product surface", async () => {
    const { routes, index } = await live();
    const { classifyRouteAuth } = await import("../scripts/capability-authority/routes.mjs");
    const devOnly = routes.filter((r: any) => r.devOnly);
    assert.ok(devOnly.length > 0, "expected at least one dev-gated registration");
    for (const r of devOnly) {
      const c = classifyRouteAuth(r, index) as { authClassification: string };
      assert.equal(c.authClassification, "DEVELOPMENT_ONLY");
    }
  });

  it("35. keeps the four SAML operator routes AUTHENTICATED (FINAL-002)", async () => {
    // These declared `{ config: { requireAuth: true } }`, which nothing in this
    // service reads. `req.user` is populated only by `requireAuth`, so every one
    // of them answered 401 to a legitimately signed-in OWNER/ADMIN and SAML
    // certificate rotation was unreachable in production.
    for (const [method, p] of [
      ["POST", "/v1/auth/saml/:connectionId/ingest-metadata"],
      ["POST", "/v1/auth/saml/:connectionId/test-connection"],
      ["PUT", "/v1/auth/saml/:connectionId/certificate-next"],
      ["DELETE", "/v1/auth/saml/:connectionId/certificate-next"],
    ] as const) {
      const c = await authOf(method, p);
      assert.notEqual(c.authClassification, "PUBLIC_UNGUARDED", `${method} ${p} is unguarded`);
    }
  });

  it("36. no route declares its gate as inert Fastify `config` (FINAL-002 anti-resurrection)", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    const nodePath = await import("node:path");
    const { REPO } = await import("../scripts/capability-authority/analyzer.mjs");
    const dir = nodePath.join(REPO as string, "services/api/src/routes");
    const offenders: string[] = [];
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".ts")) continue;
      // The comment recording FINAL-002 quotes the defective idiom verbatim, so
      // a raw text match flags the very file that documents the fix. Comments
      // are stripped first: the assertion is about CODE.
      const text = readFileSync(nodePath.join(dir, f), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
      if (/\{\s*config:\s*\{\s*requireAuth/.test(text)) offenders.push(f);
    }
    assert.deepEqual(offenders, []);
  });
});

describe("capability authority — one authority, no parallel opinions", () => {
  it("37. the generated map is fresh against the current tree", async () => {
    const { build } = await import("../scripts/generate-runtime-capability-map.mjs");
    const { readFileSync } = await import("node:fs");
    const nodePath = await import("node:path");
    const { REPO } = await import("../scripts/capability-authority/analyzer.mjs");
    const onDisk = JSON.parse(
      readFileSync(nodePath.join(REPO as string, "docs/architecture/current-runtime-capability-map.json"), "utf8"),
    );
    const fresh = (build as () => any)();
    assert.equal(onDisk.routeInventoryHash, fresh.routeInventoryHash, "route inventory drifted");
    assert.equal(onDisk.consumerInventoryHash, fresh.consumerInventoryHash, "consumer inventory drifted");
    assert.equal(onDisk.generatorHash, fresh.generatorHash, "generator changed without regenerating the map");
  });

  it("38. the analyzer publishes every request it could not resolve", async () => {
    const { build } = await import("../scripts/generate-runtime-capability-map.mjs");
    const fresh = (build as () => any)();
    assert.equal(fresh.totals.DynamicUnresolvedConsumers, 0);
    assert.equal(fresh.totals.UnreviewedOriginConsumers, 0);
    assert.equal(fresh.totals.AmbiguousConsumerSites, 0);
    // A zero here must mean "all answered", not "none looked for": the reviewed
    // manifests are what answered them, and they must be non-empty.
    const { readFileSync } = await import("node:fs");
    const nodePath = await import("node:path");
    const { REPO } = await import("../scripts/capability-authority/analyzer.mjs");
    const manifests = nodePath.join(REPO as string, "services/api/scripts/capability-authority/manifests");
    for (const f of ["origin-resolutions.json", "dynamic-resolutions.json", "consumer-resolutions.json"]) {
      const m = JSON.parse(readFileSync(nodePath.join(manifests, f), "utf8"));
      assert.ok(m.entries.length > 0, `${f} is empty`);
      for (const e of m.entries) {
        assert.ok(typeof e.site === "string" && e.site.includes(":"), `${f}: entry without a source site`);
        assert.ok(typeof e.evidence === "string" && e.evidence.length > 0, `${f}: entry without evidence`);
      }
    }
  });

  it("39. no classification conflicts survive generation", async () => {
    const { build } = await import("../scripts/generate-runtime-capability-map.mjs");
    const fresh = (build as () => any)();
    assert.deepEqual(fresh.problems, []);
  });

  it("40. the retired text verifier is a wrapper, not a second opinion", async () => {
    const { readFileSync } = await import("node:fs");
    const nodePath = await import("node:path");
    const { REPO } = await import("../scripts/capability-authority/analyzer.mjs");
    const text = readFileSync(
      nodePath.join(REPO as string, "services/api/scripts/verify-route-consumers.mjs"),
      "utf8",
    );
    assert.ok(
      text.includes("generate-runtime-capability-map.mjs"),
      "verify-route-consumers must delegate to the canonical generator",
    );
    // The tell of a resurrected parallel authority: its own route inventory.
    assert.ok(!/CONSUMER_TREES/.test(text), "verify-route-consumers grew its own consumer inventory again");
  });
});
