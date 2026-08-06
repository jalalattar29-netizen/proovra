/**
 * PHASE 12 — symbol-level STAYS-REMOVED guard.
 *
 * Every route deleted in the Phase-12 convergence (DEAD_LEGACY supersession +
 * Tier-2 speculative removal) must never be re-registered. This scans ALL
 * route source files and asserts none registers a removed path. It is the
 * anti-resurrection contract referenced by the executable route registry.
 *
 * A route is "registered" here iff a route file contains `"<path>"` or
 * `'<path>'` as an app.<method>() argument literal — we match the exact path
 * string inside a quote to avoid flagging prose/comments that merely mention it.
 */
import { readdirSync, readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROUTES_DIR = resolve(__dirname, "../src/routes");
const routeSource = readdirSync(ROUTES_DIR)
  .filter((f) => f.endsWith(".ts"))
  .map((f) => readFileSync(join(ROUTES_DIR, f), "utf8"))
  .join("\n");

// Paths that MUST NOT be registered by any route file again.
//
// PHASE 12 CAPABILITY-PRESERVATION AUDIT (2026-07-28) — this list is now EMPTY.
// The earlier convergence pass deleted ~140 routes on a "zero consumers ⇒
// obsolete" heuristic. The audit rejected that heuristic in full: missing
// product wiring was itself the discovered defect, so absence of a caller is
// NOT proof of obsolescence, and — per the mandate — a coding agent cannot
// classify a deletion as approved product-scope removal. NO deletion could be
// proven to SUPERSEDED_WITH_FULL_BEHAVIORAL_PARITY at the required bar ("zero
// callers, passing tsc and deleted tests are not parity proof"): even the
// governance→lifecycle / search→unified twins have web-consumed canonical
// siblings but their full server-behavior parity (pagination, step-up purposes,
// handler composition) was not proven. Every route + backing service was
// therefore RESTORED from HEAD; the preserved-but-unwired capabilities are
// tracked as MISSING_PRODUCT_CONSUMER in the executable registry (slice-e.json,
// phase-12-coverage-manifest.test.ts). Route count may drop again ONLY when a
// removal is proven — via full behavioral parity or a product-approved scope
// decision — never by silent deletion. See
// docs/architecture/route-classification/deleted-capability-manifest.json.
// PHASE 12B — every entry below is a PROVEN removal (full behavioral parity +
// caller migration + one-writer convergence), never a "zero consumers" guess.
const REMOVED_ROUTES: readonly string[] = [
  // WAVE 1.2 (2026-07-28): legacy teamId-keyed OrganizationSecurityPolicy pair.
  // Parallel writer of the ONE organization_security_policy row (unversioned,
  // no step-up). Fields folded into canonical PATCH /v1/security-policy
  // (org-keyed, versioned, optimistic-concurrency, step-up). Zero product
  // consumers existed; the upsertOrgSecurityPolicy writer was deleted.
  "/v1/identity/policy",
  // WAVE 2A (2026-07-29): user-session derivative completion callbacks.
  // READY/FAILED now has exactly ONE authority — the worker-side writer
  // (atomic QUEUED→RENDERING claim; stale/replay rejection; anti-overwrite) —
  // so an authenticated user session can no longer forge a "rendered" state.
  "/v1/redaction/derivatives/:id/mark-ready",
  "/v1/redaction/derivatives/:id/mark-failed",
];

describe("Phase 12 — removed routes stay removed", () => {
  it("every REMOVED_ROUTES entry is a documented proven removal", () => {
    // The list may only grow through the deletion doctrine: target authority
    // proven, callers migrated, parity proven, writer deleted, guard added.
    expect(REMOVED_ROUTES).toEqual([
      "/v1/identity/policy",
      "/v1/redaction/derivatives/:id/mark-ready",
      "/v1/redaction/derivatives/:id/mark-failed",
    ]);
  });
  it("the API-side derivative completion writers stay deleted (worker is the ONE authority)", () => {
    const svc = readFileSync(
      resolve(__dirname, "../src/services/redaction/redaction-derivative.service.ts"),
      "utf8",
    );
    expect(svc).not.toMatch(/export (async )?function markDerivativeReady/);
    expect(svc).not.toMatch(/export (async )?function markDerivativeFailed/);
    // The worker-side writer exists with the claim + stale guards.
    const writer = readFileSync(
      resolve(__dirname, "../../worker/src/redaction/redaction-derivative-writer.ts"),
      "utf8",
    );
    expect(writer).toMatch(/claimDerivativeForRender/);
    expect(writer).toMatch(/state: "QUEUED" \}/); // atomic claim precondition
    expect(writer).toMatch(/state: "RENDERING" \}/); // atomic completion precondition
  });
  it("the legacy upsertOrgSecurityPolicy writer symbol stays deleted", () => {
    const svc = readFileSync(
      resolve(__dirname, "../src/services/identity/org-security-policy.service.ts"),
      "utf8",
    );
    expect(svc).not.toMatch(/export (async )?function upsertOrgSecurityPolicy/);
    expect(svc).not.toMatch(/export (async )?function getOrgSecurityPolicy\b/);
  });
  for (const path of REMOVED_ROUTES) {
    it(`does not re-register ${path}`, () => {
      const registered = routeSource.includes(`"${path}"`) || routeSource.includes(`'${path}'`);
      expect(registered, `${path} is registered again — it was deleted in Phase 12`).toBe(false);
    });
  }
});

// ── PHASE 12B WAVE 0.3 — eradicated parallel destructive authorities ─────────
//
// `src/retention-cleanup.ts` was a standalone sweep that soft-deleted
// retention-expired evidence with ZERO legal-hold / lifecycle / policy checks —
// a parallel destructive authority bypassing the canonical hold-aware chain
// (retention-reconciliation.worker → DestructionReview → destruction-
// orchestrator.worker, which enforces EvidenceLegalHold + CaseLegalHold + 4B
// LegalHold + immutable retention with an in-phase re-check). Deleted with its
// `retention:run` npm script after proving the canonical chain covers retention
// expiry. It must never return.
describe("Phase 12B — parallel destructive authorities stay removed", () => {
  it("retention-cleanup.ts (hold-bypassing sweep) stays deleted", () => {
    expect(existsSync(resolve(__dirname, "../src/retention-cleanup.ts"))).toBe(false);
  });
  it("the retention:run npm script stays removed", () => {
    const pkg = JSON.parse(
      readFileSync(resolve(__dirname, "../package.json"), "utf8"),
    ) as { scripts?: Record<string, string> };
    expect(pkg.scripts?.["retention:run"]).toBeUndefined();
    // No other script may resurrect a direct destructive sweep either.
    const destructive = Object.values(pkg.scripts ?? {}).filter((s) =>
      /retention-cleanup/.test(s),
    );
    expect(destructive).toEqual([]);
  });
});
