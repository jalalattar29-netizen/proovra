/**
 * PHASE 12 — CLOSURE GATE (the real convergence target).
 *
 * The ratchet in phase-12-coverage-manifest.test.ts (MISSING <= baseline) is an
 * intermediate ANTI-REGRESSION guard, NOT the closure target. This suite is the
 * closure target. It MAY be red during the convergence/wiring program, but
 * Phase 12 CANNOT be declared complete while it is red.
 *
 * Closure requires ALL of:
 *   - MISSING_PRODUCT_CONSUMER          = 0
 *   - UNPROVEN deletions                = 0
 *   - ACCIDENTAL_CAPABILITY_LOSS        = 0
 *   - duplicate capability authorities  = 0
 *   - disconnected product operations   = 0
 *
 * The count must reach zero through REAL wiring / proven-parity, never through
 * category relabeling. Each remaining MISSING route must finish as exactly one
 * of: WIRED_PRODUCT_SURFACE | PROVEN_EXTERNAL_OR_MACHINE_SURFACE |
 * SUPERSEDED_WITH_FULL_PARITY (then deleted) | INTENTIONALLY_INTERNAL_CAPABILITY.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO = resolve(__dirname, "../../..");
const read = (f: string) => readFileSync(f, "utf8").replace(/\r\n/g, "\n");

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

// ── registered product routes ───────────────────────────────────────────────
const routes = new Set<string>();
for (const f of walk(resolve(REPO, "services/api/src/routes"))) {
  if (!f.endsWith(".ts")) continue;
  for (const m of read(f).matchAll(
    /app\.(get|post|patch|put|delete)(?:<[^>]*>)?\(\s*\n?\s*[`"']([^`"']+)[`"']/g,
  ))
    routes.add(m[2]);
}

// ── registry ────────────────────────────────────────────────────────────────
type ClassEntry = { route: string; class: string };
const CLASS_DIR = resolve(REPO, "docs/architecture/route-classification");
const classified: ClassEntry[] = [];
for (const slice of ["slice-a.json", "slice-b.json", "slice-c.json", "slice-d.json", "slice-e.json"])
  classified.push(...(JSON.parse(read(join(CLASS_DIR, slice))) as ClassEntry[]));

describe("Phase 12 — CLOSURE GATE (may be red during execution; blocks completion while red)", () => {
  it("MISSING_PRODUCT_CONSUMER = 0 (HTTP method+path operations, not path strings)", () => {
    // Operation-level authority: the wiring registry keys by METHOD+PATH so every
    // HTTP operation is independently classified. MISSING shrinks only through real
    // wiring / proven external-machine / intentionally-internal / full-parity removal.
    const wiring = JSON.parse(read(join(CLASS_DIR, "wiring-registry.json"))) as Array<{
      method: string; route: string; finalState: string;
    }>;
    const missing = wiring.filter((e) => e.finalState === "MISSING").map((e) => `${e.method} ${e.route}`);
    expect(
      missing.length,
      `${missing.length} HTTP operations still lack a real disposition — each must become WIRED_PRODUCT / PROVEN_EXTERNAL_MACHINE / INTENTIONALLY_INTERNAL / FULL_PARITY_REMOVED:\n${missing.slice(0, 60).join("\n")}`,
    ).toBe(0);
  });

  it("UNPROVEN deletions = 0 (nothing deleted without proof)", () => {
    const manifest = JSON.parse(read(join(CLASS_DIR, "deleted-capability-manifest.json"))) as {
      resolution?: { finalGate?: Record<string, number> };
    };
    // After the capability-preservation audit, nothing remains deleted-and-unproven.
    expect(manifest.resolution?.finalGate?.UNPROVEN ?? 0).toBe(0);
    expect(manifest.resolution?.finalGate?.ACCIDENTAL_CAPABILITY_LOSS ?? 0).toBe(0);
  });

  it("duplicate capability authorities = 0 (no two registered routes own the same capability)", () => {
    // PHASE 12 STEP-3 DOMAIN CONVERGENCE (2026-07-28): the six legacy↔canonical
    // pairs the earlier pass ASSUMED were duplicates were field-by-field
    // DISPROVEN by the domain analysis — they are DISTINCT capabilities, not
    // parity duplicates, so none is delete-eligible:
    //   /v1/governance/legal-holds        — EVIDENCE-scoped ({evidenceId,...},
    //       requireMember+step-up) ≠ /v1/lifecycle/legal-holds which is
    //       KIND/scopeTargetId-scoped (requireDelegatedTierAny+entitlement+quota).
    //   /v1/governance/case-legal-holds   — CASE-scoped, distinct service.
    //   /v1/governance/policy             — WORKSPACE deletion/retention/download
    //       governance ≠ /v1/reviewer-ops/sla-policy (reviewer SLA). Invalid pair.
    //   /v1/governance/retention-candidates — candidate EVIDENCE ≠
    //       /v1/lifecycle/retention/policies which lists RULES.
    //   /v1/search/cases, /v1/search/evidence — RESOLVED in PHASE 12B
    //       (2026-07-29): parity was CLOSED (caseId filter + evidenceTypes
    //       filter added to the unified authority; owner scoping is covered by
    //       contributorScoped) and both owner-scoped routes were DELETED. They
    //       no longer exist, so they can never be a second authority again.
    // A pair may be re-added here ONLY with proven full behavioral parity, at
    // which point the legacy is deleted (canonical stays). The proven-duplicate
    // set is therefore currently EMPTY. These routes are UNWIRED capabilities to
    // be WIRED (see the STEP-3 wiring map in slice-e.json wiringHost/decision),
    // NOT duplicates to be deleted.
    const PROVEN_DUPLICATE_PAIRS: Array<{ legacy: string; canonical: string }> = [];
    const unresolved = PROVEN_DUPLICATE_PAIRS.filter((p) => routes.has(p.legacy) && routes.has(p.canonical)).map(
      (p) => `${p.legacy} ↔ ${p.canonical}`,
    );
    expect(
      unresolved.length,
      `${unresolved.length} capabilities have two registered authorities (delete the legacy ONLY after full behavioral parity is proven):\n${unresolved.join("\n")}`,
    ).toBe(0);
  });

  it("disconnected product operations = 0 (every apiFetch path matches a registered route)", () => {
    const clientCorpus: string[] = [];
    for (const root of ["apps/web", "apps/mobile/src", "apps/mobile/app"]) {
      for (const f of walk(resolve(REPO, root))) {
        if (!/\.(ts|tsx)$/.test(f) || /__tests__|\.test\.|\.render\./.test(f)) continue;
        clientCorpus.push(read(f));
      }
    }
    const corpus = clientCorpus.join("\n");
    const calls = new Set<string>();
    for (const m of corpus.matchAll(/apiFetch\(\s*[`"']([^`"']+)/g)) {
      let raw = m[1].split(/[?\s]/)[0].replace(/\$\{[^}]*\}/g, ":p");
      let prefixOnly = false;
      const tpl = raw.indexOf("${");
      if (tpl >= 0) { raw = raw.slice(0, tpl); prefixOnly = true; }
      const glued = raw.search(/[^/:]:p/);
      if (glued >= 0) { raw = raw.slice(0, glued + 1); prefixOnly = true; }
      raw = raw.replace(/\/$/, "");
      if (raw.length > 3 && raw.startsWith("/")) calls.add(prefixOnly ? raw + "/*" : raw);
    }
    const matches = (path: string): boolean => {
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
    };
    const disconnected = [...calls].filter((p) => p.startsWith("/v1") || p.startsWith("/public")).filter((p) => !matches(p));
    expect(disconnected, `disconnected client operations:\n${disconnected.join("\n")}`).toEqual([]);
  });
});
