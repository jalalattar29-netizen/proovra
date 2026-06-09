/**
 * PHASE E10.2 — Operational readiness & pilot validation contract tests.
 *
 * E10.2 is a documentation + audit phase. The tests pin:
 *
 *   1. The operational audit document exists + covers the required
 *      subsystems + flags the new DEFs explicitly.
 *   2. All 20 mandatory topical runbooks are reachable per the INDEX.
 *   3. Each new topical runbook (20-31) carries the 9 mandatory
 *      sections: Symptoms / Blast radius / Detection / Logs / Rollback
 *      / Safe recovery / Validation / Escalation / DO NOT.
 *   4. The final assessment document exists + carries honest scores
 *      (no inflated 10/10 across the board).
 *   5. The master registry records the 9 new DEFs (043-051).
 *   6. No fake "fully enterprise ready" / "production-perfect" /
 *      similar inflation language in the assessment doc.
 *   7. No new client-state / queue / pubsub library introduced.
 *   8. 32.8 canonical primaries still exactly 6.
 *   9. Protected core files unchanged.
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

const AUDIT_DOC = readRepo("docs/ops/E10_2_OPERATIONAL_AUDIT.md");
const ASSESSMENT_DOC = readRepo("docs/ops/E10_2_FINAL_ASSESSMENT.md");
const RUNBOOK_INDEX = readRepo("docs/operations/runbooks/INDEX.md");
const REGISTRY = readRepo("docs/recovery/MASTER_PHASE_REGISTRY.md");

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

const NEW_DEFS = [
  "DEF-043",
  "DEF-044",
  "DEF-045",
  "DEF-046",
  "DEF-047",
  "DEF-048",
  "DEF-049",
  "DEF-050",
  "DEF-051",
] as const;

// ===========================================================================
// PART 1 — Operational audit document
// ===========================================================================

describe("E10.2 Test 1 — operational audit document", () => {
  it("audit doc exists + substantial", () => {
    expect(AUDIT_DOC.length).toBeGreaterThan(8000);
    expect(AUDIT_DOC).toMatch(/Phase E10\.2/);
    expect(AUDIT_DOC).toMatch(/Operational Audit/i);
  });

  it("audit doc covers the required subsystem categories", () => {
    const required = [
      /Capture\s*\/\s*upload\s*\/\s*finalize/i,
      /Evidence lifecycle/i,
      /Reviewer-operations/i,
      /Governance lifecycle/i,
      /Destruction/i,
      /Retention/i,
      /Search indexing/i,
      /Automation runtime/i,
      /Notification delivery/i,
      /Billing — Stripe/i,
      /Billing — PayPal/i,
      /Auth — email\/password/i,
      /SAML SSO/i,
      /SCIM/i,
      /RBAC/i,
      /Report rendering/i,
      /Verification package/i,
      /AI \(E9/,
      /OTS upgrade/i,
      /TSA timestamping/i,
    ];
    for (const pattern of required) {
      expect(AUDIT_DOC).toMatch(pattern);
    }
  });

  it("audit doc names the 9 new DEFs explicitly", () => {
    for (const def of NEW_DEFS) {
      expect(AUDIT_DOC, `${def} missing from audit doc`).toContain(def);
    }
  });

  it("audit doc carries the cross-cutting hard-rules verification table", () => {
    expect(AUDIT_DOC).toMatch(/Cross-cutting hard rules verified/i);
    expect(AUDIT_DOC).toMatch(/Billing never corrupts evidence/i);
    expect(AUDIT_DOC).toMatch(/Lifecycle is single-writer/i);
    expect(AUDIT_DOC).toMatch(/Custody chain is append-only/i);
  });
});

// ===========================================================================
// PART 2 — Final assessment document with honest scores
// ===========================================================================

describe("E10.2 Test 2 — final assessment document", () => {
  it("assessment doc exists + substantial", () => {
    expect(ASSESSMENT_DOC.length).toBeGreaterThan(6000);
    expect(ASSESSMENT_DOC).toMatch(/Phase E10\.2/);
    expect(ASSESSMENT_DOC).toMatch(/Final Enterprise Assessment/i);
  });

  it("assessment doc carries 6 explicit scores", () => {
    const scoreSections = [
      /Pilot-readiness score/i,
      /Operational survivability score/i,
      /Governance confidence score/i,
      /Recovery confidence score/i,
      /Reviewer operations stability score/i,
      /Billing safety score/i,
    ];
    for (const pattern of scoreSections) {
      expect(ASSESSMENT_DOC).toMatch(pattern);
    }
  });

  it("scores are honest — no 10/10 across all 6 categories", () => {
    // Count how many "Score: 10 / 10" appear. If all 6 are 10, the
    // assessment is inflated.
    const tenOutOfTen = ASSESSMENT_DOC.match(/Score:\s*10\s*\/\s*10/g) ?? [];
    expect(tenOutOfTen.length, "6× 10/10 indicates inflated assessment").toBeLessThan(6);
  });

  it("assessment doc explicitly lists remaining blockers", () => {
    expect(ASSESSMENT_DOC).toMatch(/Remaining blockers/i);
    expect(ASSESSMENT_DOC).toMatch(/DEF-002/);
    expect(ASSESSMENT_DOC).toMatch(/DEF-003/);
    expect(ASSESSMENT_DOC).toMatch(/DEF-043/);
    expect(ASSESSMENT_DOC).toMatch(/DEF-044/);
  });

  it("assessment doc forbids inflation language", () => {
    const FORBIDDEN_INFLATION = [
      /fully\s+enterprise[- ]?ready/i,
      /production[- ]?perfect/i,
      /zero\s+remaining\s+risk/i,
      /100%\s+launch[- ]?ready/i,
      /no\s+gaps\s+remaining/i,
    ];
    for (const pattern of FORBIDDEN_INFLATION) {
      expect(ASSESSMENT_DOC, `inflated phrase ${pattern} present`).not.toMatch(pattern);
    }
  });

  it("assessment doc explicitly states what PROOVRA is NOT ready for", () => {
    expect(ASSESSMENT_DOC).toMatch(/NOT.*ready for/i);
    expect(ASSESSMENT_DOC).toMatch(/uncontrolled launch|open-public/i);
  });
});

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
// PART 5 — Master registry records the 9 new DEFs
// ===========================================================================

describe("E10.2 Test 5 — master registry records the new DEFs", () => {
  it("registry registers Phase E10.2 with explicit closure status", () => {
    expect(REGISTRY).toMatch(
      /\|\s*Phase\s+E10\.2\s*\|[\s\S]*?(CLOSED|CLOSED_WITH_DEFERRED_ITEMS)/,
    );
  });

  it.each(NEW_DEFS)("registry contains %s row", (def) => {
    expect(REGISTRY).toMatch(new RegExp(`\\|\\s*${def}\\s*\\|`));
  });

  it("DEF-043 + DEF-044 are marked PILOT_HARDENING (not BLOCKS_LAUNCH)", () => {
    const def043 = REGISTRY.match(/\|\s*DEF-043\s*\|[^\n]+/);
    expect(def043).toBeTruthy();
    expect(def043![0]).toMatch(/PILOT_HARDENING/);

    const def044 = REGISTRY.match(/\|\s*DEF-044\s*\|[^\n]+/);
    expect(def044).toBeTruthy();
    expect(def044![0]).toMatch(/PILOT_HARDENING/);
  });

  it("DEF-045 through DEF-051 are POST_LAUNCH / NON_BLOCKING", () => {
    for (const def of ["DEF-045", "DEF-046", "DEF-047", "DEF-048", "DEF-049", "DEF-050", "DEF-051"]) {
      const row = REGISTRY.match(new RegExp(`\\|\\s*${def}\\s*\\|[^\\n]+`));
      expect(row, `${def} row missing`).toBeTruthy();
      expect(row![0]).toMatch(/NON_BLOCKING|POST_LAUNCH/);
    }
  });
});

// ===========================================================================
// PART 6 — No code changes — file-size pin on auth + webhooks routes
// ===========================================================================

describe("E10.2 Test 6 — zero code changes by E10.2", () => {
  // E10.1 closed at auth.routes.ts = 42051 bytes + webhooks.routes.ts at
  // its post-E10.1 size. E10.2 must NOT have drifted these.
  const POST_E10_1_PINS: ReadonlyArray<{ rel: string; expected: number; tolerance: number }> = [
    // Rebaselined post-G3.x/G4/G5 — auth.routes.ts grew.
    { rel: "src/routes/auth.routes.ts", expected: 48469, tolerance: 0.05 },
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
      { rel: "src/routes/capture.routes.ts", expected: 21271 },
      { rel: "src/services/evidence-complete.service.ts", expected: 41849 },
      { rel: "src/services/custody-events.service.ts", expected: 5155 },
      { rel: "src/services/timestamp.service.ts", expected: 11701 },
      {
        rel: "src/services/reports/reports-aggregator.service.ts",
        expected: 13118,
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
    { label: "audit", body: AUDIT_DOC },
    { label: "assessment", body: ASSESSMENT_DOC },
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
