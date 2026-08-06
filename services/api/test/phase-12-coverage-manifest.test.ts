/**
 * PHASE 12 — machine-checked frontend/mobile ↔ API coverage manifest.
 *
 * Direction 1 (client → server): every `apiFetch("/v1/…" | "/public/…")`
 * call in apps/web + apps/mobile must match a registered API route —
 * disconnected client actions = 0.
 *
 * Direction 2 (server → consumer): every registered route must either have a
 * product consumer (its literal path appears in apps/web / apps/mobile
 * source) or belong to a REGISTERED non-product category (webhook, cron,
 * SCIM/SSO/IdP-called, public share/verify, external portal, service-to-
 * service, platform-admin API used via generic fetchers). A route matching
 * neither is an unclassified/dead route and fails.
 */
import { readdirSync, readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO = resolve(__dirname, "../../..");

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const f = join(dir, e.name);
    if (e.isDirectory()) {
      if (/node_modules|\.next|dist|\.expo/.test(e.name)) continue;
      walk(f, out);
    } else out.push(f);
  }
  return out;
}
const read = (f: string) => readFileSync(f, "utf8").replace(/\r\n/g, "\n");

// ── registered routes ───────────────────────────────────────────────────────
const routes = new Set<string>();
for (const f of walk(resolve(REPO, "services/api/src/routes"))) {
  if (!f.endsWith(".ts")) continue;
  const b = read(f);
  for (const m of b.matchAll(/app\.(get|post|patch|put|delete)(?:<[^>]*>)?\(\s*\n?\s*[`"']([^`"']+)[`"']/g)) {
    routes.add(m[2]);
  }
}

// ── client calls + full client corpus ───────────────────────────────────────
const clientFiles: string[] = [];
for (const root of ["apps/web", "apps/mobile/src", "apps/mobile/app"]) {
  for (const f of walk(resolve(REPO, root))) {
    if (!/\.(ts|tsx)$/.test(f) || /__tests__|\.test\.|\.render\./.test(f)) continue;
    clientFiles.push(f);
  }
}
const clientCorpus = clientFiles.map(read).join("\n");
const clientCalls = new Set<string>();
for (const m of clientCorpus.matchAll(/apiFetch\(\s*[`"']([^`"']+)/g)) {
  // Cut at query/whitespace; interpolations become :p; an interpolation glued
  // to a non-'/' boundary is query-building — truncate the path there.
  let raw = m[1].split(/[?\s]/)[0].replace(/\$\{[^}]*\}/g, ":p");
  // Multi-line interpolations survive as an unbalanced "${…" — the tail is
  // unknown, so the path is a PREFIX; mark it for prefix matching.
  let prefixOnly = false;
  const tpl = raw.indexOf("${");
  if (tpl >= 0) { raw = raw.slice(0, tpl); prefixOnly = true; }
  const glued = raw.search(/[^/:]:p/);
  if (glued >= 0) { raw = raw.slice(0, glued + 1); prefixOnly = true; }
  raw = raw.replace(/\/$/, "");
  if (raw.length > 3 && raw.startsWith("/")) clientCalls.add(prefixOnly ? raw + "/*" : raw);
}

// Segment-wise match: a client ':p' segment matches ANY route segment (param
// OR literal — dynamic-action templates fan out to sibling literal routes);
// a client literal must equal the route literal or hit a route ':param'.
function matchesRoute(path: string): boolean {
  const prefixOnly = path.endsWith("/*");
  const cseg = path.replace(/\/\*$/, "").split("/").filter(Boolean);
  outer: for (const r of routes) {
    const rseg = r.split("/").filter(Boolean);
    if (prefixOnly ? rseg.length < cseg.length : rseg.length !== cseg.length) continue;
    for (let i = 0; i < cseg.length; i++) {
      const c = cseg[i], q = rseg[i];
      if (c === ":p" || q.startsWith(":") || c === q) continue;
      continue outer;
    }
    return true;
  }
  return false;
}

// ── EXECUTABLE SYMBOL-LEVEL ROUTE REGISTRY (replaces the old regex categories) ─
//
// Direction 2 is now driven by an explicit per-route classification registry
// (docs/architecture/route-classification/slice-{a,b,c}.json). Routes NOT in
// that registry are auto-classified WEB/MOBILE_PRODUCT_CONSUMER by proving a
// real client-corpus consumer. The union must EXACTLY equal the registered
// route set — no prefix exemptions, no phantom classifications, no duplicates.
type ClassEntry = {
  route: string;
  methods?: string[];
  registeringFile?: string;
  class: string;
  consumer?: string | null;
  proofSuite?: string | null;
  note?: string;
};
const CLASSIFICATION_DIR = resolve(REPO, "docs/architecture/route-classification");
const classified = new Map<string, ClassEntry>();
const duplicateClassifications: string[] = [];
for (const slice of ["slice-a.json", "slice-b.json", "slice-c.json", "slice-d.json", "slice-e.json"]) {
  const arr = JSON.parse(read(join(CLASSIFICATION_DIR, slice))) as ClassEntry[];
  for (const e of arr) {
    if (classified.has(e.route)) duplicateClassifications.push(e.route);
    classified.set(e.route, e);
  }
}

// A registered route is "product-consumed" when its literal (or literal prefix
// before the first path param) appears in the web/mobile source corpus.
function isProductConsumed(route: string): boolean {
  const litPrefix = route.split("/:")[0];
  return clientCorpus.includes(route) || (litPrefix.length > 6 && clientCorpus.includes(litPrefix));
}

describe("Phase 12 — coverage manifest (direction 1)", () => {
  it("routes and client calls were both discovered (extractors alive)", () => {
    expect(routes.size).toBeGreaterThan(500);
    expect(clientCalls.size).toBeGreaterThan(300);
  });

  it("disconnected client actions = 0 (every apiFetch path matches a registered route)", () => {
    const disconnected = [...clientCalls]
      .filter((p) => p.startsWith("/v1") || p.startsWith("/public"))
      .filter((p) => !matchesRoute(p));
    expect(disconnected, `client calls with no matching route:\n${disconnected.join("\n")}`).toEqual([]);
  });
});

describe("Phase 12 — executable route registry (direction 2)", () => {
  it("no duplicate classification entries across the registry slices", () => {
    expect(duplicateClassifications, duplicateClassifications.join(", ")).toEqual([]);
  });

  it("classifications for nonexistent routes = 0 (every classified route is registered)", () => {
    const phantom = [...classified.keys()].filter((r) => !routes.has(r));
    expect(phantom, `classified but not registered:\n${phantom.join("\n")}`).toEqual([]);
  });

  it("unclassified routes = 0 (every registered route is product-consumed OR in the registry)", () => {
    const unclassified = [...routes].filter((r) => !classified.has(r) && !isProductConsumed(r));
    expect(
      unclassified,
      `registered routes neither product-consumed nor classified (${unclassified.length}):\n${unclassified.slice(0, 40).join("\n")}`,
    ).toEqual([]);
  });

  it("every registry entry's registering file + proof suite exist on disk", () => {
    const missing: string[] = [];
    for (const e of classified.values()) {
      if (e.registeringFile) {
        const p = e.registeringFile.split(":")[0];
        if (!existsSync(resolve(REPO, p))) missing.push(`registeringFile ${p} (route ${e.route})`);
      }
      if (e.proofSuite) {
        const p = e.proofSuite.startsWith("services/") || e.proofSuite.startsWith("apps/") || e.proofSuite.startsWith("e2e/")
          ? e.proofSuite
          : join("services/api", e.proofSuite);
        if (!existsSync(resolve(REPO, p.split(":")[0]))) missing.push(`proofSuite ${e.proofSuite} (route ${e.route})`);
      }
    }
    expect(missing, missing.join("\n")).toEqual([]);
  });

  // ── CONVERGENCE METRICS — must reach zero for Phase-12 closure ─────────────
  it("DEAD_LEGACY_ROUTE = 0", () => {
    const dead = [...classified.values()].filter((e) => e.class === "DEAD_LEGACY_ROUTE").map((e) => e.route);
    expect(dead, `dead legacy routes still registered (${dead.length}):\n${dead.join("\n")}`).toEqual([]);
  });

  // MISSING_PRODUCT_CONSUMER — the wiring backlog.
  //
  // PHASE 12 CAPABILITY-PRESERVATION AUDIT (2026-07-28). The earlier pass drove
  // this metric toward zero by DELETING routes with no product consumer. The
  // audit rejected that: missing product wiring was itself the discovered
  // defect, so "zero callers" is NOT proof of obsolescence. Those capabilities
  // were RESTORED from HEAD (services/api/src/routes + backing services) and are
  // re-registered here as MISSING_PRODUCT_CONSUMER — capability preserved,
  // product wiring pending. See
  // docs/architecture/route-classification/deleted-capability-manifest.json
  // (ACCIDENTAL_CAPABILITY_LOSS = 0, UNPROVEN = 0 after restore).
  //
  // Phase-12 CLOSURE still requires this backlog to reach zero — but ONLY by
  // WIRING each capability into the product (add a real consumer) or by proving
  // SUPERSEDED_WITH_FULL_BEHAVIORAL_PARITY / DEAD_DUPLICATE parity. It may never
  // be closed by silent deletion. This test enforces that: the backlog is a
  // well-formed set of REAL registered routes that each carry a preservation
  // note, and it may only shrink (ratchet), never grow.
  const MISSING_BACKLOG_BASELINE = 131; // audited restore backlog, 2026-07-28 (zero deletions; all preserved)
  it("MISSING_PRODUCT_CONSUMER backlog is registered, documented, and ratchets down (never fake-closed by deletion)", () => {
    const missing = [...classified.values()].filter((e) => e.class === "MISSING_PRODUCT_CONSUMER");
    const malformed: string[] = [];
    for (const e of missing) {
      if (!routes.has(e.route)) malformed.push(`not registered: ${e.route}`);
      if (!e.registeringFile) malformed.push(`no registeringFile: ${e.route}`);
      if (!e.note) malformed.push(`no preservation note: ${e.route}`);
    }
    expect(malformed, malformed.join("\n")).toEqual([]);
    // Ratchet: the wiring backlog may shrink (wiring / proven-parity removal) but
    // never grow beyond the audited baseline.
    expect(
      missing.length,
      `wiring backlog grew above audited baseline (${missing.length} > ${MISSING_BACKLOG_BASELINE}) — a new unwired capability appeared; wire it or classify with proof`,
    ).toBeLessThanOrEqual(MISSING_BACKLOG_BASELINE);
  });
});

// ── PHASE 12 — behavioral chain registry (security/commercial/destructive) ──
//
// Each sensitive client operation maps to the EXECUTING behavioral suites that
// prove its chain (client/HTTP entry → context → lifecycle → membership →
// authorization → policy → writer → audit). A URL-string match is never the
// sole proof here: every referenced suite drives real code (Fastify inject,
// jsdom render, node:test contract, or the live-DB integration gates) and runs
// in the repository gates. This registry machine-checks that none of those
// proof suites silently disappears.
describe("Phase 12 — behavioral chain registry", () => {
  const CHAINS: Array<{ op: string; suites: string[] }> = [
    { op: "login/post-login destination + SSO callbacks", suites: ["services/api/test/phase-11-auth-destination-safety.test.ts", "services/api/test/phase-10-mandatory-sso-switch.test.ts"] },
    { op: "workspace switch + context safety", suites: ["apps/web/__tests__/render/context-safety.render.test.tsx", "apps/web/__tests__/render/context-safety-route-nav.render.test.tsx"] },
    { op: "invitations (issue/accept, workspace assignments)", suites: ["services/api/test/p2-invitation-coherence.test.ts"] },
    { op: "enterprise provisioning", suites: ["services/api/test/phase2-enterprise-provisioning.test.ts"] },
    { op: "SSO/SCIM reconciliation", suites: ["services/api/test/phase-10-mandatory-sso-switch.test.ts"] },
    { op: "organization security policy", suites: ["services/api/test/phase-10-closure-matrix.test.ts"] },
    { op: "break-glass", suites: ["services/api/test/phase-10-break-glass-runtime.test.ts"] },
    { op: "support access", suites: ["services/api/test/phase-10-support-runtime.test.ts"] },
    { op: "evidence create/upload/finalize", suites: ["services/api/test/phase-30-9-client-uploads.test.ts", "services/api/test/phase-37-98-reviewer-workflow-lifecycle.integration.test.ts"] },
    { op: "case + bulk operations", suites: ["services/api/test/phase-37-95-cross-tenant-runtime-probe.integration.test.ts"] },
    { op: "legal hold / destruction", suites: ["apps/web/__tests__/legal-hold-create-step-up.test.ts", "services/api/test/phase-5-lifecycle-hold-gate-union.test.ts"] },
    { op: "billing checkout / seats / storage", suites: ["services/api/test/phase9-collaboration-team-billing-parity.test.ts", "apps/web/__tests__/render/phase10-no-personal-ux.render.test.tsx"] },
    { op: "deep links (web+mobile+API)", suites: ["services/api/test/phase-11-tenant-routes.test.ts", "apps/web/__tests__/render/phase11-deep-link-navigation.render.test.tsx", "apps/mobile/test/deep-link.contract.test.mjs"] },
    { op: "audit query/export", suites: ["services/api/test/phase-11-tenant-routes.test.ts", "apps/web/__tests__/render/phase11-audit-surface.render.test.tsx"] },
  ];
  for (const chain of CHAINS) {
    it(`chain proof suites exist: ${chain.op}`, () => {
      for (const s of chain.suites) {
        expect(existsSync(resolve(REPO, s)), `${chain.op}: missing suite ${s}`).toBe(true);
      }
    });
  }
});
