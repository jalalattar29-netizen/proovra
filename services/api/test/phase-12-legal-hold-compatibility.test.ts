/**
 * PHASE 12 POINT 1 / C2 — Legal-Hold COMPATIBILITY_TEMPORARY dispositions.
 *
 * Six operations are retained rather than deleted:
 *
 *   GET  /v1/governance/legal-holds
 *   POST /v1/governance/legal-holds
 *   POST /v1/governance/legal-holds/:id/release
 *   GET  /v1/governance/case-legal-holds
 *   POST /v1/governance/case-legal-holds
 *   POST /v1/governance/case-legal-holds/:id/release
 *
 * The disposition rule was: DELETE only with full parity, zero callers AND no
 * migration or external dependency; otherwise RETAIN as a thin adapter over
 * ONE canonical authority with machine-checked removal conditions.
 *
 * Parity holds and there are zero callers, but the migration condition does
 * not: legacy `case_legal_holds` / `legal_holds` rows are not yet backfilled
 * into `evidence_legal_holds`, and these paths are how an un-backfilled hold
 * stays readable and releasable. So they are RETAINED — and this suite is the
 * machine check that keeps the retention honest:
 *
 *   1. Every one of the six delegates to the canonical authority. No second
 *      placement / release / list implementation may creep back in.
 *   2. They stay caller-free, so the day the migration lands they can be
 *      deleted without touching a product surface.
 *   3. The removal conditions are DOCUMENTED at the routes, so the next
 *      operator does not have to reconstruct why they still exist.
 *   4. `releaseLegalHoldAnyStore` still reports which store answered — the
 *      signal that tells us when condition 1 (backfill complete) is met.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO = resolve(__dirname, "../../..");
const read = (f: string) => readFileSync(f, "utf8").replace(/\r\n/g, "\n");

const ROUTES = read(resolve(REPO, "services/api/src/routes/governance.routes.ts"));
const CANONICAL = read(
  resolve(REPO, "services/api/src/services/governance/legal-hold.service.ts"),
);

const COMPATIBILITY_OPERATIONS = [
  { method: "GET", route: "/v1/governance/legal-holds" },
  { method: "POST", route: "/v1/governance/legal-holds" },
  { method: "POST", route: "/v1/governance/legal-holds/:id/release" },
  { method: "GET", route: "/v1/governance/case-legal-holds" },
  { method: "POST", route: "/v1/governance/case-legal-holds" },
  { method: "POST", route: "/v1/governance/case-legal-holds/:id/release" },
] as const;

/** Source of the ONE canonical authority these adapters must call. */
const CANONICAL_ENTRYPOINTS = [
  "placeCanonicalLegalHold",
  "releaseLegalHoldAnyStore",
  "listEvidenceScopedLegalHoldsLegacyShape",
  "listCaseScopedLegalHoldsLegacyShape",
] as const;

/**
 * Command-level implementations that must exist in exactly ONE place. If one
 * of these reappears inside the route module, the adapter has grown back into
 * a second authority and the retention is no longer safe.
 */
const AUTHORITY_ONLY_SYMBOLS = [
  "placeLegalHold",
  "releaseLegalHold",
  "listLegalHoldsForTeam",
] as const;

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const f = join(dir, e.name);
    if (e.isDirectory()) {
      if (/node_modules|\.next|dist|\.expo|coverage/.test(e.name)) continue;
      walk(f, out);
    } else out.push(f);
  }
  return out;
}

describe("Phase 12 C2 — Legal-Hold compatibility adapters", () => {
  it("all six operations are still REGISTERED (retention, not silent deletion)", () => {
    const missing = COMPATIBILITY_OPERATIONS.filter(
      (op) => !ROUTES.includes(`"${op.route}"`),
    ).map((op) => `${op.method} ${op.route}`);
    expect(
      missing,
      `retained operations that vanished without the removal conditions being met:\n${missing.join("\n")}`,
    ).toEqual([]);
  });

  it("each one is labelled COMPATIBILITY_TEMPORARY with its removal conditions", () => {
    expect(ROUTES).toContain("COMPATIBILITY_TEMPORARY");
    // The three conditions must be written down, not folded into "later".
    expect(ROUTES).toMatch(/REMOVAL CONDITIONS/);
    expect(ROUTES).toMatch(/backfill migration/i);
    expect(ROUTES).toMatch(/ZERO product\/machine callers/i);
    expect(ROUTES).toMatch(/no second authority/i);
  });

  it("every adapter delegates to the ONE canonical Legal-Hold authority", () => {
    for (const entry of CANONICAL_ENTRYPOINTS) {
      expect(ROUTES, `${entry} is not called by the adapters`).toContain(`${entry}(`);
      expect(CANONICAL, `${entry} is not exported by the canonical service`).toMatch(
        new RegExp(`export (async )?function ${entry}\\b`),
      );
    }
  });

  it("no second placement / release / list authority survives in the route module", () => {
    const reintroduced = AUTHORITY_ONLY_SYMBOLS.filter((s) =>
      // A call, not a comment mention.
      new RegExp(`(?<![A-Za-z])${s}\\(`).test(ROUTES),
    );
    expect(
      reintroduced,
      `a second Legal-Hold authority reappeared in governance.routes.ts: ${reintroduced.join(", ")}`,
    ).toEqual([]);
  });

  it("the six operations have ZERO product callers, so removal stays a one-step change", () => {
    const clientCorpus: string[] = [];
    for (const root of ["apps/web", "apps/mobile/src", "apps/mobile/app"]) {
      for (const f of walk(resolve(REPO, root))) {
        if (!/\.(ts|tsx)$/.test(f)) continue;
        if (/__tests__|\.test\.|\.render\./.test(f)) continue;
        clientCorpus.push(read(f));
      }
    }
    const corpus = clientCorpus.join("\n");
    const called = [
      "/v1/governance/legal-holds",
      "/v1/governance/case-legal-holds",
    ].filter((p) => corpus.includes(p));
    expect(
      called,
      `a product surface started calling a COMPATIBILITY_TEMPORARY path — wire it to /v1/lifecycle/legal-holds instead:\n${called.join("\n")}`,
    ).toEqual([]);
  });

  it("removal condition 1 is now MET — the release resolves only the canonical store", () => {
    // This guard used to prove the release could still TELL the three stores
    // apart, because that was the only way to observe when the backfill had
    // finished. PHASE 12 POINT 3 completed the runtime cutover: the legacy
    // fallbacks were removed, so the signal has reached its terminal value.
    //
    // The guard is inverted rather than deleted. It now proves the cutover
    // cannot silently regress — if a legacy fallback is ever reintroduced,
    // this fails.
    expect(CANONICAL).toMatch(/store:\s*"CANONICAL"/);
    expect(CANONICAL).not.toMatch(/store:\s*"CASE_LEGAL_HOLD"/);
    expect(CANONICAL).not.toMatch(/store:\s*"LIFECYCLE_LEGAL_HOLD"/);
    // …and no legacy delegate may be reachable from the canonical authority.
    expect(CANONICAL).not.toMatch(/client\.caseLegalHold\./);
    expect(CANONICAL).not.toMatch(/client\.legalHold\./);
  });

  it("the canonical surface the adapters will hand off to is registered", () => {
    const lifecycle = read(
      resolve(REPO, "services/api/src/routes/product-and-lifecycle.routes.ts"),
    );
    expect(lifecycle).toContain('"/v1/lifecycle/legal-holds"');
  });
});

// ===========================================================================
// PHASE 12 POINT 3 RECOVERY — the six adapters were reconstructed after being
// deleted before their owner-run migration condition was satisfied. These
// assertions pin what "thin canonical delegate" means, so a future
// reconstruction cannot quietly grow a second authority or a legacy fallback.
// ===========================================================================

/** Drop `//` and block-comment lines so a source pin cannot match prose. */
function CODE_ONLY(src: string): string {
  return src
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n");
}

describe("Phase 12 Point 3 — restored adapters hold no legacy dependence", () => {
  /** Just the six compatibility handlers, not the whole route module. */
  const BLOCK = (() => {
    const a = ROUTES.indexOf("COMPATIBILITY_TEMPORARY — Legal-Hold adapters");
    const b = ROUTES.indexOf("GET governance status badge for one evidence");
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(a);
    return ROUTES.slice(a, b);
  })();

  it("all six operations are registered", () => {
    for (const op of COMPATIBILITY_OPERATIONS) {
      expect(BLOCK, `${op.method} ${op.route}`).toContain(`"${op.route}"`);
    }
  });

  it("no legacy Prisma delegate is reachable from the adapters", () => {
    expect(BLOCK).not.toMatch(/\.caseLegalHold\s*\./);
    expect(BLOCK).not.toMatch(/\.legalHold\s*\./);
  });

  it("the adapters touch NO Prisma client at all — they only delegate", () => {
    expect(BLOCK).not.toMatch(/\bprisma\s*\./);
    expect(BLOCK).not.toMatch(/\$queryRaw|\$executeRaw/);
  });

  it("no legacy-table fallback survives", () => {
    // Comments legitimately NAME the retired tables when explaining the
    // removal conditions, so this asserts on EXECUTABLE lines only — a
    // documentation mention must not read as a live dependency, and stripping
    // the prose is what makes the assertion mean what it says.
    const code = CODE_ONLY(BLOCK);
    expect(code).not.toMatch(/case_legal_holds/);
    expect(code).not.toMatch(/[^_]legal_holds/);
    // The optional-subsystem degradation that answered 200-with-empty on a
    // missing table must not come back: an unreadable canonical store must
    // never be reported as "no holds".
    expect(BLOCK).not.toMatch(/isPrismaTableOrColumnMissing/);
    expect(BLOCK).not.toMatch(/subsystemEnabled/);
  });

  it("every mutation is capability-gated and target-bound step-up gated", () => {
    const manage =
      BLOCK.match(/requireMember\([^)]*"governance\.legal_hold\.manage"\)/g) ?? [];
    expect(manage.length).toBe(4);
    const place = BLOCK.match(/purpose:\s*"LEGAL_HOLD_PLACE"/g) ?? [];
    const release = BLOCK.match(/purpose:\s*"LEGAL_HOLD_RELEASE"/g) ?? [];
    expect(place.length).toBe(2);
    expect(release.length).toBe(2);
  });

  it("both reads gate on the READ capability, never on manage", () => {
    const read =
      BLOCK.match(/requireMember\([^)]*"governance\.policy\.read"\)/g) ?? [];
    expect(read.length).toBe(2);
  });

  it("the release adapters evaluate the approval gate BEFORE step-up", () => {
    for (const marker of [
      '"/v1/governance/legal-holds/:id/release"',
      '"/v1/governance/case-legal-holds/:id/release"',
    ]) {
      const start = BLOCK.indexOf(marker);
      expect(start, marker).toBeGreaterThan(-1);
      const body = BLOCK.slice(start, start + 2600);
      const approvalAt = body.indexOf("assertReleaseApproval(");
      const stepUpAt = body.indexOf("requireStepUpForSensitiveAction(");
      expect(approvalAt, marker).toBeGreaterThan(-1);
      expect(stepUpAt, marker).toBeGreaterThan(-1);
      expect(approvalAt, `${marker}: approval must precede step-up`).toBeLessThan(
        stepUpAt,
      );
    }
  });

  it("a cross-workspace target is concealed, not described", () => {
    expect(BLOCK).toMatch(/target_not_in_workspace/);
    expect(BLOCK).toMatch(/code:\s*"evidence_not_found"/);
    expect(BLOCK).toMatch(/code:\s*"case_not_found"/);
  });

  it("the release adapters re-read the row rather than fabricating success", () => {
    expect(BLOCK).toMatch(/code:\s*"hold_not_found"/);
  });
});
