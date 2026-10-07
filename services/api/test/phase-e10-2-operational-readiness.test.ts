/**
 * PHASE E10.2 — Operational readiness & pilot validation contract tests.
 *
 * E10.2 is a documentation + audit phase. The tests pin:
 *
 *   1. All 20 mandatory topical runbooks are reachable per the INDEX.
 *   2. Each new topical runbook (20-31) carries the 9 mandatory
 *      sections: Symptoms / Blast radius / Detection / Logs / Rollback
 *      / Safe recovery / Validation / Escalation / DO NOT.
 *   3. No fake "fully enterprise ready" / "production-perfect" /
 *      similar inflation language in the runbook INDEX.
 *   4. No new client-state / queue / pubsub library introduced.
 *   5. 32.8 canonical primaries still exactly 6.
 *   6. Protected core files unchanged.
 *
 * Phase E10.2 ships ZERO code changes. The contract tests assert this
 * by file-size pinning the auth.routes.ts + webhooks.routes.ts files
 * to their E10.1 post-closure sizes (no further drift allowed).
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function repoPath(rel: string): string {
  return fileURLToPath(new URL(`../../../${rel}`, import.meta.url));
}
function webPath(rel: string): string {
  return fileURLToPath(new URL(`../../../apps/web/${rel}`, import.meta.url));
}
function apiPath(rel: string): string {
  return fileURLToPath(new URL(`../${rel}`, import.meta.url));
}
function readRepo(rel: string): string {
  return readFileSync(repoPath(rel), "utf8");
}
function readWeb(rel: string): string {
  return readFileSync(webPath(rel), "utf8");
}

const RUNBOOK_INDEX = readRepo("docs/operations/runbooks/INDEX.md");

const NEW_RUNBOOKS = [
  "20-reviewer-queue-failure.md",
  "21-immutable-storage-drift.md",
  "22-billing-provider-outage.md",
  "23-paypal-webhook-recovery.md",
  "24-resend-email-failure.md",
  "25-twilio-failure.md",
  "26-redis-outage.md",
  "27-search-index-recovery.md",
  "28-retention-job-failure.md",
  "29-governance-reconciliation.md",
  "30-tsa-provider-failure.md",
  "31-ots-anchor-delay.md",
] as const;

const MANDATORY_TOPICAL_RUNBOOKS = [
  "incident-response",
  "reviewer-queue-failure",
  "upload-stall-recovery",
  "immutable-storage-drift",
  "billing-provider-outage",
  "stripe-webhook-recovery",
  "paypal-webhook-recovery",
  "resend-email-failure",
  "twilio-failure",
  "SAML-login-failure",
  "redis-outage",
  "search-index-recovery",
  "retention-job-failure",
  "governance-reconciliation",
  "TSA-provider-failure",
  "OTS-anchor-delay",
  "report-render-failure",
  "verification-package-failure",
  "AI-provider-outage",
  "recovery-restore-validation",
] as const;

// ===========================================================================
// PART 3 — Runbook INDEX + 20 mandatory topical names reachable
// ===========================================================================

describe("E10.2 Test 3 — runbook INDEX completeness", () => {
  it("runbook INDEX.md exists + substantial", () => {
    expect(RUNBOOK_INDEX.length).toBeGreaterThan(1500);
    expect(RUNBOOK_INDEX).toMatch(/Runbook Index/i);
  });

  it.each(MANDATORY_TOPICAL_RUNBOOKS)(
    "topical name %s is mapped in the INDEX",
    (topical) => {
      expect(RUNBOOK_INDEX).toContain(topical);
    },
  );

  it("INDEX accounts for all 32 runbook files in the directory", () => {
    // Sanity check: the "all runbooks in this directory" table should
    // mention each of the 12 new runbook files we added.
    for (const name of NEW_RUNBOOKS) {
      const short = name.replace(/\.md$/, "").replace(/^\d{2}-/, "");
      expect(RUNBOOK_INDEX, `${short} missing from INDEX`).toContain(short);
    }
  });
});

// ===========================================================================
// PART 4 — Each new runbook carries the 9 mandatory sections
// ===========================================================================

describe("E10.2 Test 4 — runbook structure compliance", () => {
  // The prompt requires every runbook to have these 9 sections.
  const REQUIRED_SECTIONS = [
    /##\s*Symptoms/i,
    /##\s*Blast radius/i,
    /##\s*Detection/i,
    /##\s*Logs to inspect/i,
    /##\s*Rollback procedure/i,
    /##\s*Safe recovery procedure/i,
    /##\s*Validation steps/i,
    /##\s*Escalation conditions/i,
    /##\s*DO NOT DO THIS/i,
  ];

  for (const runbookName of NEW_RUNBOOKS) {
    describe(`runbook ${runbookName}`, () => {
      const body = readRepo(`docs/operations/runbooks/${runbookName}`);

      it("file exists + substantial", () => {
        expect(body.length).toBeGreaterThan(1500);
      });

      it.each(REQUIRED_SECTIONS)("carries section %s", (pattern) => {
        expect(body).toMatch(pattern);
      });
    });
  }
});

// ===========================================================================
// PART 6 — No code changes — file-size pin on auth + webhooks routes
// ===========================================================================

describe("E10.2 Test 6 — zero code changes by E10.2", () => {
  // E10.1 closed at auth.routes.ts = 42051 bytes + webhooks.routes.ts at
  // its post-E10.1 size. E10.2 must NOT have drifted these.
  const POST_E10_1_PINS: ReadonlyArray<{ rel: string; expected: number; tolerance: number }> = [
    // Rebaselined post-G3.x/G4/G5 — auth.routes.ts grew.
    // Phase EV: rebaselined post enterprise email verification (verify +
    // resend + register-dispatch extracted into email-verification.service.ts).
    // Rebaselined 2026-09-16 (D13): 56683 -> 59567. A password reset now ends
    // every session issued before it (revokeAllSessionsForUser after the
    // token is spent); the file had already grown to the edge of the band.
    { rel: "src/routes/auth.routes.ts", expected: 59567, tolerance: 0.05 },
  ];
  for (const { rel, expected, tolerance } of POST_E10_1_PINS) {
    it(`${rel} unchanged at the post-E10.1 baseline`, () => {
      const fullPath = apiPath(rel);
      expect(existsSync(fullPath)).toBe(true);
      const st = statSync(fullPath);
      const low = Math.floor(expected * (1 - tolerance));
      const high = Math.ceil(expected * (1 + tolerance));
      expect(st.size).toBeGreaterThanOrEqual(low);
      expect(st.size).toBeLessThanOrEqual(high);
    });
  }

  it("the 5 protected core files remain green", () => {
    const PINS = [
      { rel: "src/routes/capture.routes.ts", expected: 21793 },
      // Rebaselined 2026-09-09 (OTS INTEGRITY DECOUPLING): 46,824 → 51,943.
      // This is a ±10% band, and the accumulated audited growth since 46,824
      // had reached its edge. Finalization now enters the OTS lifecycle
      // itself, enqueueing the canonical UPGRADE_OTS work after the
      // transaction commits — OpenTimestamps used to be stamped inside the
      // REPORT job, so a record reached the calendar only if its plan included
      // reports, while Pricing lists OTS under "Every plan includes". The
      // finalize transaction, custody chain and sealing are untouched; the
      // enqueue runs strictly after the commit, beside the report request.
      // Rebaselined 2026-09-29 (LIFECYCLE STABILIZATION): 55,620 -> 59,356. Audited
      // growth: duplicate completion repeats no retention, custody or fan-out
      // (audit D11); publication approval honoured at the finalize claim (D3);
      // the signed VersionId of each original is hashed and recorded (D14).
      // Rebaselined 2026-09-29 (EVIDENCE-LIFECYCLE REMEDIATION, TSA batch): 59,356 -> 59,826 — finalize persists the token-read imprint beside the request digest (ET-TSA-03) and the validation facts + bounded failure code (ET-TSA-01/06).
      // Rebaselined 2026-09-29: 59,826 -> 59,931 — the finalize claim refuses a released (soft-deleted) reservation (ET-DC-01).
      // Rebaselined 2026-09-29: 59,931 -> 60,529 — ET-SEC-11: a REPORTED record's repeat complete is alreadyFinalized (+ duplicate-finalize security event)
      // Rebaselined 2026-09-29: 60,529 -> 60,968 — ET-SM-03: retention targets and the lock snapshot address the sealed version
      // Rebaselined 2026-09-30: 60,968 -> 61,257 — ET-SEC-28: the storage check runs under the workspace capacity lock
      // Rebaselined 2026-09-30: 61,257 -> 63,476 — ET-ACQ-03: the one-time completion fan-out is claimed durably and re-driven on a retry
      // Rebaselined 2026-09-30: 63,476 -> 67,985 — ET-ACQ-04: oversize is refused from HEAD sizes before any GET; digests are computed before the transaction
      // Rebaselined 2026-09-30: 67,985 -> 68,686 — ET-ACQ-05: the checklist plan comes from the owner's capture session and its template
      // Rebaselined 2026-09-30: 68,686 -> 69,911 — ET-COM-04: the completion transaction takes the issuance decision once and stores the record's earned funding fact
      // Rebaselined 2026-09-30: 69,911 -> 71,631 — ET-SM-07 / ET-PKG-07: the completion transaction records the first integrity check and finalizes every record NOT_PUBLISHED
      // Rebaselined 2026-10-01: 71,631 -> 79,841 — UC-ARCH-003: completeEvidence is the ONE finalization authority (EVIDENCE_COMPLETED custody, reviewer workflow and evidence.complete audit moved in from the web route, exactly once for every channel); UC-TRUST-003 persists the signing-key fingerprint; UC-STR-002 refuses a part set that differs from the claimed seal plan.
      // Rebaselined 2026-10-07: 79,841 -> 80,111 — the TIMESTAMP_APPLIED custody payload records what the RFC 3161 validation established (tsaValidation: trust anchor, token certificates, nonce, policy) for timestamp-validation.json.
      { rel: "src/services/evidence-complete.service.ts", expected: 80111 },
      {
              // Rebaselined 2026-07-31 (PHASE 12 POINT 3): Case-Evidence physical
      // convergence. The artifact query filtered `prisma.evidence` by the legacy
      // `Evidence.caseId` mirror column, which the canonical model no longer
      // declares and 20271104000000 physically drops; it survived only because
      // `whereBase` is typed `Record<string, unknown>`, so the compiler could
      // not see the stale field. It now filters through the ONE runtime
      // authority, CaseEvidenceLink. Sanctioned, audited growth — the pin is
      // moved to the current size so it keeps catching UNAUDITED drift.
      // Rebaselined 2026-08-24 (WORKSPACE-SCOPE CONVERGENCE). The summary
      // counts and the artifact list each built their own `where`, both keyed
      // on a strict `teamId` equality. On a personal workspace that omits the
      // owner's legacy NULL-team Evidence, so the page under-reported its
      // reports and packages — and because the two filters were separate, a
      // fix to one could still leave the header contradicting the rows. Both
      // now consume ONE `workspaceEvidenceWhere` resolved at the top of the
      // function. Sanctioned, audited growth — the pin moves to the current
      // size so it keeps catching UNAUDITED drift.
      // Rebaselined 2026-08-26 (REPORTS SEARCH + CASE NAME). Two changes:
      // search matched `title` alone while the row DISPLAYS a cascade of
      // `title` -> `displayFileName` -> `originalFileName`, so a user could
      // read a name on screen, type it, and get nothing back; and the row
      // rendered "Case #f2b146" because only `caseId` was selected. Search now
      // covers all three fields, and the case's name travels on the existing
      // `caseLinks` select — one query, no N+1. Sanctioned, audited growth —
      // the pin moves to the current size so it keeps catching UNAUDITED
      // drift.
      // Rebaselined 2026-08-26 (SCALABLE REPORTS). `filterByLifecycle` ran
      // AFTER pagination, over the 25 rows already fetched, so "Report
      // pending" searched 9% of a 278-record workspace and reported a count
      // from that slice. It is now `lifecycleWhere`, a predicate on the query,
      // alongside a `count` on the same predicate so the header states the
      // real total; and the six workspace aggregations became skippable
      // (`includeSummary`) because a filter cannot change them and recomputing
      // them per keystroke is what made the page feel like it reloaded.
      // Sanctioned, audited growth — the pin moves so it keeps catching
      // UNAUDITED drift.
      // Rebaselined 2026-09-08 (COMMERCIAL + OUTPUT LIFECYCLE CLOSURE). The
      // lifecycle was `available ? "ready" : finalized ? "pending" :
      // "not_requested"` — absence read as pending, with no commercial input
      // and no reference to whether generation had ever been requested. Three
      // live consequences: every finalized record on a plan without reports
      // read "generating" forever; `failed` was unreachable, so the page's own
      // Retry control had never rendered for anybody; and `unavailable` was
      // declared and unreachable, so the page could not say the honest thing.
      // The derivation now consumes the shared three-axis state machine, and
      // the page fetches the durable generation request and the record-aware
      // eligibility in the SAME batch it already ran for reports and packages.
      // Sanctioned, audited growth — the pin moves to the current size so it
      // keeps catching UNAUDITED drift.
      // Rebaselined 2026-09-09 (RELIABILITY CLOSURE): 29,360 → 34,034. The
      // aggregator projected the lifecycle and stopped one step short of the
      // ACTION, so the Reports page re-derived a verb from the legacy
      // five-value vocabulary — a mapping that is lossy in exactly the two
      // places that decide whether a button should exist. `BLOCKED` collapses
      // into `not_requested`, so the page offered Generate for a record whose
      // canonical action is NONE; every `TERMINAL_FAILURE` collapses into
      // `failed`, so it offered Retry for terminals nothing will reopen. Both
      // clicks were refused as already-terminal and reported as success. The
      // canonical action, its terminal class and per-artifact downloadability
      // are now projected from the same pure authority Evidence Detail reads,
      // in the batch that was already running. Sanctioned, audited growth —
      // the pin moves to the current size so it keeps catching UNAUDITED
      // drift.
      // Rebaselined 2026-09-25 (REPORTS TILE ⇔ FILTER PARITY): 34,034 →
      // 39,740. The summary tiles each had their own arithmetic and the
      // pending/failed filters read a platform-wide 5,000-row request scan, so
      // a tile disagreed with its own filter and another workspace's requests
      // could leak in. Both now read one workspace-scoped classification
      // (`classifyWorkspaceOutputs`) through `lifecycleWhere`. Sanctioned,
      // audited growth — the pin moves so it keeps catching UNAUDITED drift.
      // Rebaselined 2026-09-28 (REPORT ARTIFACT LIFECYCLES, e9efd55): 39,740 →
      // 45,508. Audited diff: the summary gained the `packagesFailed`,
      // `reportsNotRequested`, `packagesNotRequested` and
      // `totalArtifactVersions` tiles, each counted by the same workspace
      // classification the filters read (one extra batched read of report,
      // package and request rows per page); each row now carries its OWN
      // `teamId` so an action targets the record's workspace rather than the
      // selected one. No new authority, no platform-wide scan. Sanctioned,
      // audited growth — the pin moves so it keeps catching UNAUDITED drift.
      // Rebaselined 2026-09-29 (EVIDENCE OUTPUT LIFECYCLE): 45,508 → 50,778.
      // Audited diff: the summary and list share one finalized population
      // (not deleted, not trashed / pending destruction / destroyed); four
      // truthful buckets (not issued by plan, first issuance pending, package
      // missing for the latest report, subscription check pending) with a
      // filter each; restricted cases filtered; eligibility defaults to
      // UNRESOLVED instead of ELIGIBLE. No new authority, no platform scan.
      rel: "src/services/reports/reports-aggregator.service.ts",
        expected: 50778,
      },
    ];
    for (const { rel, expected } of PINS) {
      const fullPath = apiPath(rel);
      expect(existsSync(fullPath)).toBe(true);
      const st = statSync(fullPath);
      const low = Math.floor(expected * 0.9);
      const high = Math.ceil(expected * 1.1);
      expect(st.size).toBeGreaterThanOrEqual(low);
      expect(st.size).toBeLessThanOrEqual(high);
    }
  });
});

// ===========================================================================
// PART 7 — IA preservation
// ===========================================================================

describe("E10.2 Test 7 — 32.8 IA preserved", () => {
  it("canonical primaries still exactly 6", () => {
    const groups = readWeb("lib/navigation/canonicalNavigationGroups.ts");
    const m = groups.match(
      /CANONICAL_PRIMARY_ROUTE_IDS[\s\S]*?new Set\(\[([\s\S]*?)\]\)/,
    );
    expect(m).toBeTruthy();
    const ids = Array.from(m![1]!.matchAll(/["']([^"']+)["']/g)).map(
      (mm) => mm[1]!,
    );
    expect(ids).toHaveLength(9); // baseline grew with G0+ IA — was 6 pre-G0, now 9 canonical primaries
  });
});

// ===========================================================================
// PART 8 — No fake inflation language in audit or assessment
// ===========================================================================

describe("E10.2 Test 8 — no fake inflation language in any E10.2 doc", () => {
  const E10_2_DOCS = [
    { label: "INDEX", body: RUNBOOK_INDEX },
  ];

  const FORBIDDEN_INFLATION_PATTERNS = [
    /\b99\.999*%\s+uptime\b/i,
    /\bzero\s+downtime\s+guaranteed\b/i,
    /\bbattle-tested\s+at\s+scale\b/i,
    /\bfully\s+enterprise[- ]?ready\b/i,
    /\b100%\s+(?:secure|reliable|uptime)\b/i,
    /\bSOC\s*2\s+(?:compliant|certified)\b/i,
    /\bISO\s*27001\s+(?:compliant|certified)\b/i,
    /\bHIPAA\s+(?:compliant|certified)\b/i,
  ];

  for (const doc of E10_2_DOCS) {
    describe(`doc — ${doc.label}`, () => {
      it.each(FORBIDDEN_INFLATION_PATTERNS)(
        "does NOT match %s",
        (pattern) => {
          expect(doc.body).not.toMatch(pattern);
        },
      );
    });
  }
});

// ===========================================================================
// PART 9 — No new state / queue / pubsub library introduced
// ===========================================================================

describe("E10.2 Test 9 — no new state / queue libraries", () => {
  it("web package.json carries none of the forbidden client-state libraries", () => {
    const pkg = JSON.parse(readWeb("package.json")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = {
      ...(pkg.dependencies ?? {}),
      ...(pkg.devDependencies ?? {}),
    };
    for (const forbidden of [
      "@tanstack/react-query",
      "react-query",
      "swr",
      "redux",
      "zustand",
      "socket.io-client",
    ]) {
      expect(deps[forbidden], `forbidden web dep ${forbidden}`).toBeUndefined();
    }
  });
});
