/**
 * PHASE E10 — Final Launch Hardening contract tests.
 *
 * E10 is the decision + classification phase. The tests pin:
 *
 *   1. The phase doc + all 17 runbook files exist + are substantial
 *      (8 new runbooks 10–17 added by E10).
 *   2. The launch readiness inventory covers the 21 required areas.
 *   3. The critical-flow smoke checklist enumerates 15 entries.
 *   4. Existing rate-limit coverage stays present (regression guard
 *      for the surfaces already covered).
 *   5. Existing production config validation gates remain present
 *      (Stripe key shape, SAML production-localhost guard, S3
 *      production-localhost guard, signing provider consistency).
 *   6. No fake SLA / uptime claims in any E10-shipped doc.
 *   7. No secrets in the phase doc or runbooks (8 secret-shape
 *      patterns mirrored from E6).
 *   8. 32.8 canonical primaries still exactly 6 (no nav explosion).
 *   9. Protected core files unchanged (file-size pins).
 *  10. Master registry records Phase E10 + the 6 new DEFs.
 *  11. Every open DEF in the registry carries an explicit
 *      classification keyword (LAUNCH_BLOCKER / PILOT_BLOCKER /
 *      POST_LAUNCH / INFORMATIONAL / NON_BLOCKING / RESOLVED).
 *  12. No new client-state / queue / pubsub library introduced.
 *
 * Phase E10 ships zero features, zero redesigns, zero architecture
 * changes.
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
function readApi(rel: string): string {
  return readFileSync(apiPath(rel), "utf8");
}

const PHASE_DOC = readRepo("docs/product/PHASE_E10_FINAL_LAUNCH_HARDENING.md");
const REGISTRY = readRepo("docs/recovery/MASTER_PHASE_REGISTRY.md");

// E10 ships runbooks 10–17 (in addition to E6's 00–09).
const E10_RUNBOOKS = [
  "10-support-triage.md",
  "11-incident-response.md",
  "12-failed-upload-report-package.md",
  "13-billing-failure.md",
  "14-external-intake-failure.md",
  "15-saml-sso-failure.md",
  "16-ai-unavailable.md",
  "17-monitoring-readiness.md",
] as const;

// All 17 runbooks combined (8 from E10 + 9 from E6 + rehearsal log).
const ALL_RUNBOOKS = [
  // E6 set
  "00-rehearsal-log.md",
  "01-db-restore.md",
  "02-object-storage-restore.md",
  "03-worker-restart.md",
  "04-automation-recovery.md",
  "05-webhook-retry-recovery.md",
  "06-signing-key-recovery.md",
  "07-degraded-mode-startup.md",
  "08-report-package-regen.md",
  "09-audit-custody-validation.md",
  // E10 set
  ...E10_RUNBOOKS,
] as const;

function readRunbook(name: string): string {
  return readRepo(`docs/operations/runbooks/${name}`);
}

// Forbidden fake-launch-claim regexes (extension of the E6 forbidden list).
const FORBIDDEN_LAUNCH_CLAIM_PATTERNS: ReadonlyArray<RegExp> = [
  /\b99\.999*%\s+uptime\b/i,
  /\b100%\s+uptime\b/i,
  /\bzero\s+downtime\s+guaranteed\b/i,
  /\bzero\s+downtime\s+promised\b/i,
  /\bguaranteed\s+RPO\b/i,
  /\bguaranteed\s+RTO\b/i,
  /\bRPO\s*[:=]?\s*0\b/i,
  /\bRTO\s*[:=]?\s*0\b/i,
  /\bmulti[- ]?region\s+active[- ]?active\b/i,
  /\bgeo[- ]?redundant\b/i,
  /\bkubernetes\s+HA\b/i,
  /\bbatteries[- ]?included\s+SLA\b/i,
  /\bautomatic\s+failover\s+(?:guaranteed|enabled)\b/i,
  /\bdisaster\s+recovery\s+certified\b/i,
  /\bDR\s+(?:certified|verified|guaranteed)\b/i,
  /\b(?:bullet|hack)proof\s+(?:infrastructure|launch)\b/i,
  /\bSOC\s*2\s+(?:compliant|certified)\b/i,
  /\bISO\s*27001\s+(?:compliant|certified)\b/i,
  /\bHIPAA\s+(?:compliant|certified)\b/i,
  /\bGDPR\s+(?:compliant|certified)\b/i,
];

// Forbidden secret shapes (mirror of E6).
const FORBIDDEN_SECRET_SHAPES: ReadonlyArray<RegExp> = [
  /\bsk_live_[A-Za-z0-9]{8,}/,
  /\bsk_test_[A-Za-z0-9]{8,}/,
  /\bpk_live_[A-Za-z0-9]{8,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bASIA[0-9A-Z]{16}\b/,
  /-----BEGIN\s+(?:RSA\s+|EC\s+)?PRIVATE\s+KEY-----/,
  /-----BEGIN\s+OPENSSH\s+PRIVATE\s+KEY-----/,
  /\bxoxb-[0-9A-Za-z-]{20,}/,
  /\bghp_[A-Za-z0-9]{20,}/,
];

// ===========================================================================
// PART 1 — Phase doc + runbooks exist + substantial
// ===========================================================================

describe("E10 Test 1 — phase doc + all 17 runbooks present", () => {
  it("phase doc exists at docs/product/PHASE_E10_FINAL_LAUNCH_HARDENING.md", () => {
    expect(PHASE_DOC.length).toBeGreaterThan(6000);
    expect(PHASE_DOC).toMatch(/PHASE E10/);
  });

  it.each(ALL_RUNBOOKS)("runbook %s exists and is non-trivial", (name) => {
    const path = repoPath(`docs/operations/runbooks/${name}`);
    expect(existsSync(path), `${name} missing`).toBe(true);
    const body = readRunbook(name);
    expect(body.length, `${name} too short`).toBeGreaterThan(1500);
  });

  it.each(E10_RUNBOOKS)("E10 runbook %s carries Prerequisites + Forbidden sections", (name) => {
    const body = readRunbook(name);
    expect(body, `${name} missing Prerequisites`).toMatch(/Prerequisites/i);
    expect(body, `${name} missing Forbidden`).toMatch(/Forbidden/i);
  });
});

// ===========================================================================
// PART 2 — Launch readiness inventory covers the 21 areas
// ===========================================================================

describe("E10 Test 2 — launch readiness inventory coverage", () => {
  const REQUIRED_AREAS = [
    /Auth\s*\/\s*login\s*\/\s*session/i,
    /MFA/i,
    /SAML\s*SP/i,
    /SCIM/i,
    /Capture\s*\/\s*upload\s*\/\s*finalize/i,
    /Report\s+generation/i,
    /Verification\s+package/i,
    /Public\s+verify/i,
    /External\s+intake/i,
    /External\s+review/i,
    /Evidence\s+requests/i,
    /Automation\s*\/\s*webhooks/i,
    /Analytics/i,
    /\bAI\b/i,
    /Billing/i,
    /Email\s*\/\s*SMS/i,
    /Storage\s*\(/i,
    /Database/i,
    /Redis\s*\/\s*queues/i,
    /Worker\s+runtime/i,
    /Trust\s+Center/i,
    /DR\s+runbooks/i,
    /Support\s+readiness/i,
  ];

  it.each(REQUIRED_AREAS)("inventory names area %s", (pattern) => {
    expect(PHASE_DOC).toMatch(pattern);
  });

  it("phase doc has a table column for Blocking + Evidence", () => {
    expect(PHASE_DOC).toMatch(/Status\s*\|\s*Risk\s*\|\s*Blocking\?\s*\|\s*Evidence/i);
  });
});

// ===========================================================================
// PART 3 — Critical flow smoke checklist (15 entries)
// ===========================================================================

describe("E10 Test 3 — critical flow smoke checklist", () => {
  // The 15 enumerated smoke flows. Each must appear in the phase doc.
  const SMOKE_FLOWS = [
    /Signup\s*→\s*login/i,
    /Workspace\s+creation/i,
    /Capture\s+evidence/i,
    /Finish\s*\/\s*sign/i,
    /Report\s+ready/i,
    /Report\s+download/i,
    /Verification\s+package\s+download/i,
    /Public\s+verify\s+page/i,
    /External\s+intake\s+link/i,
    /External\s+reviewer\s+grant/i,
    /Automation\s+rule\s+execution/i,
    /Webhook\s+delivery\s+retry/i,
    /AI\s+disabled\s+fallback/i,
    /Billing\s+checkout/i,
    /Support\s*\/\s*demo\s+request/i,
  ];

  it.each(SMOKE_FLOWS)("smoke checklist includes %s", (pattern) => {
    expect(PHASE_DOC).toMatch(pattern);
  });

  it("smoke checklist guards against silent success", () => {
    // The phase doc uses the phrase "Silent success" (quoted) for the
    // table column header and "silent success" or "silent-success" in
    // the surrounding prose. Each smoke entry carries a "Not OK if ..."
    // clause stating the silent-success guard explicitly.
    expect(PHASE_DOC).toMatch(/silent[- ]?success/i);
    expect(PHASE_DOC).toMatch(/Not OK if/);
  });
});

// ===========================================================================
// PART 4 — Existing rate-limit coverage stays present (regression guard)
// ===========================================================================

describe("E10 Test 4 — existing rate-limit coverage preserved", () => {
  it("public verify route still enforces a per-IP rate limit", () => {
    const evidenceRoutes = readApi("src/routes/evidence.routes.ts");
    expect(evidenceRoutes).toMatch(/VERIFY_RATE_LIMIT/);
  });

  it("external intake route still enforces per-IP + per-token rate limits", () => {
    const intakeRoutes = readApi("src/routes/external-intake.routes.ts");
    expect(intakeRoutes).toMatch(/enforceRateLimit/);
  });

  it("MFA verify still throttles per-userId", () => {
    const authRoutes = readApi("src/routes/auth.routes.ts");
    // The audit confirmed an in-memory loginMfaAttempts map; the source
    // grep MUST find the throttle logic. If the throttle moves, this
    // test fires immediately.
    expect(authRoutes).toMatch(/loginMfaAttempts|mfa.*attempt.*limit/i);
  });
});

// ===========================================================================
// PART 5 — Production config validation gates remain present
// ===========================================================================

describe("E10 Test 5 — production config validation gates", () => {
  const CONFIG_SRC = readApi("src/config/index.ts");

  it("runStartupConfigValidation exists + throws on production violations", () => {
    expect(CONFIG_SRC).toMatch(/runStartupConfigValidation/);
    expect(CONFIG_SRC).toMatch(/ProductionConfigError/);
  });

  it("DATABASE_URL + AUTH_JWT_SECRET are required in production", () => {
    expect(CONFIG_SRC).toMatch(/DATABASE_URL/);
    expect(CONFIG_SRC).toMatch(/AUTH_JWT_SECRET/);
  });

  it("Stripe key shape validation rejects pk_* in STRIPE_SECRET_KEY slot", () => {
    expect(CONFIG_SRC).toMatch(/STRIPE_SECRET_KEY/);
    expect(CONFIG_SRC).toMatch(/stripe_key_shape_invalid|pk_live_|pk_test_/);
  });

  it("SAML production safety rejects localhost ACS URLs in production", () => {
    expect(CONFIG_SRC).toMatch(/SAML/);
    expect(CONFIG_SRC).toMatch(/localhost|127\.0\.0\.1/);
  });

  it("S3 production safety rejects localhost endpoint in production", () => {
    expect(CONFIG_SRC).toMatch(/S3_ENDPOINT/);
  });

  it("signing provider consistency is enforced", () => {
    expect(CONFIG_SRC).toMatch(/SIGNER_PROVIDER|aws-kms|local-pem/);
  });
});

// ===========================================================================
// PART 6 — No fake SLA / uptime claims in E10-shipped docs
// ===========================================================================

describe("E10 Test 6 — no fake launch claims in phase doc / runbooks", () => {
  // The phase doc intentionally references SLA / uptime in honest
  // DISCLAIMER context ("PROOVRA does NOT advertise an SLA"). Strip
  // such disclaimer paragraphs before greppping so the test catches
  // ADVERTISING claims, not bounded honest disclaimers.
  const isClaimShaped = (body: string, pattern: RegExp): boolean => {
    // Sanitise: drop lines containing "NOT" / "does not" / "no " near
    // the forbidden token. Then re-test.
    const sanitised = body
      .split(/\n/)
      .filter((line) => {
        if (!pattern.test(line)) return true;
        // Keep the line only if it does NOT contain a negation token.
        return !/\b(?:NOT|not|never|no|without|does not|cannot|don't|doesn't)\b/i.test(line);
      })
      .join("\n");
    return pattern.test(sanitised);
  };

  it.each(FORBIDDEN_LAUNCH_CLAIM_PATTERNS)(
    "phase doc does NOT assert %s as a claim",
    (pattern) => {
      expect(
        isClaimShaped(PHASE_DOC, pattern),
        `phase doc contains a claim matching ${pattern}`,
      ).toBe(false);
    },
  );

  for (const runbookName of E10_RUNBOOKS) {
    describe(`runbook ${runbookName}`, () => {
      const body = readRunbook(runbookName);
      it.each(FORBIDDEN_LAUNCH_CLAIM_PATTERNS)(
        "does NOT assert %s as a claim",
        (pattern) => {
          expect(
            isClaimShaped(body, pattern),
            `${runbookName} contains a claim matching ${pattern}`,
          ).toBe(false);
        },
      );
    });
  }
});

// ===========================================================================
// PART 7 — No secrets in phase doc / runbooks
// ===========================================================================

describe("E10 Test 7 — no secret values in phase doc / runbooks", () => {
  it.each(FORBIDDEN_SECRET_SHAPES)(
    "phase doc does NOT contain a secret matching %s",
    (pattern) => {
      expect(PHASE_DOC).not.toMatch(pattern);
    },
  );

  for (const runbookName of E10_RUNBOOKS) {
    describe(`runbook ${runbookName}`, () => {
      const body = readRunbook(runbookName);
      it.each(FORBIDDEN_SECRET_SHAPES)(
        "does NOT contain a secret matching %s",
        (pattern) => {
          expect(body).not.toMatch(pattern);
        },
      );
    });
  }
});

// ===========================================================================
// PART 8 — IA preservation: 32.8 canonical primaries still 6
// ===========================================================================

describe("E10 Test 8 — 32.8 IA preserved", () => {
  it("canonical primaries still exactly 6", () => {
    const groups = readWeb("lib/navigation/canonicalNavigationGroups.ts");
    const m = groups.match(
      /CANONICAL_PRIMARY_ROUTE_IDS[\s\S]*?new Set\(\[([\s\S]*?)\]\)/,
    );
    expect(m).toBeTruthy();
    const ids = Array.from(m![1]!.matchAll(/["']([^"']+)["']/g)).map(
      (mm) => mm[1]!,
    );
    expect(ids).toHaveLength(6);
  });
});

// ===========================================================================
// PART 9 — Protected core files unchanged
// ===========================================================================

describe("E10 Test 9 — protected core files unchanged by E10", () => {
  const PINS: ReadonlyArray<{ rel: string; expectedBytes: number }> = [
    { rel: "src/routes/capture.routes.ts", expectedBytes: 18308 },
    { rel: "src/services/evidence-complete.service.ts", expectedBytes: 41849 },
    { rel: "src/services/custody-events.service.ts", expectedBytes: 4446 },
    { rel: "src/services/timestamp.service.ts", expectedBytes: 6033 },
    {
      rel: "src/services/reports/reports-aggregator.service.ts",
      expectedBytes: 13118,
    },
  ];
  for (const { rel, expectedBytes } of PINS) {
    it(`${rel} stays within ±10% (${expectedBytes} bytes)`, () => {
      const fullPath = apiPath(rel);
      expect(existsSync(fullPath)).toBe(true);
      const st = statSync(fullPath);
      const low = Math.floor(expectedBytes * 0.9);
      const high = Math.ceil(expectedBytes * 1.1);
      expect(st.size).toBeGreaterThanOrEqual(low);
      expect(st.size).toBeLessThanOrEqual(high);
    });
  }
});

// ===========================================================================
// PART 10 — Master registry records Phase E10 + the 6 new DEFs
// ===========================================================================

describe("E10 Test 10 — master registry updated", () => {
  it("registry records Phase E10 with explicit closure status", () => {
    expect(REGISTRY).toMatch(
      /\|\s*Phase\s+E10\s*\|[\s\S]*?(CLOSED|CLOSED_WITH_DEFERRED_ITEMS)/,
    );
  });

  it("registry records the 6 new DEFs opened by E10", () => {
    for (const def of [
      "DEF-037",
      "DEF-038",
      "DEF-039",
      "DEF-040",
      "DEF-041",
      "DEF-042",
    ]) {
      expect(REGISTRY, `${def} missing from registry`).toMatch(
        new RegExp(`\\|\\s*${def}\\s*\\|`),
      );
    }
  });

  it("DEF-037 + DEF-038 land as BLOCKS_LAUNCH OR were RESOLVED by Phase E10.1 (inverse-pin flip per CR1.7 §10.1)", () => {
    // Phase E10 opened DEF-037 + DEF-038 as BLOCKS_LAUNCH. Phase E10.1
    // resolved both by adding per-IP rate limits + Stripe webhook
    // idempotency. The inverse-pin flip per CR1.7 §10.1: either the
    // BLOCKS_LAUNCH classification stays (pre-E10.1 close) OR the row
    // is now RESOLVED with an E10.1 reference (post-E10.1 close).
    const def037 = REGISTRY.match(/\|\s*DEF-037\s*\|[^\n]+/);
    expect(def037, "DEF-037 row missing").toBeTruthy();
    expect(def037![0]).toMatch(/BLOCKS_LAUNCH|RESOLVED/);
    if (/RESOLVED/.test(def037![0])) {
      expect(def037![0]).toMatch(/E10\.1/);
    }

    const def038 = REGISTRY.match(/\|\s*DEF-038\s*\|[^\n]+/);
    expect(def038, "DEF-038 row missing").toBeTruthy();
    expect(def038![0]).toMatch(/BLOCKS_LAUNCH|RESOLVED/);
    if (/RESOLVED/.test(def038![0])) {
      expect(def038![0]).toMatch(/E10\.1/);
    }
  });
});

// ===========================================================================
// PART 11 — Every open DEF carries an explicit classification keyword
// ===========================================================================

describe("E10 Test 11 — every open DEF carries a classification", () => {
  // Phase E10 DEF classification table in the phase doc enumerates
  // every open DEF + label. Each open DEF id MUST appear with one of
  // the canonical classification keywords.
  const CLASSIFICATION_KEYWORDS = [
    /LAUNCH_BLOCKER/i,
    /PILOT_BLOCKER/i,
    /BLOCKS_LAUNCH/i,
    /BLOCKS_ENTERPRISE_PILOT/i,
    /POST_LAUNCH/i,
    /POST-LAUNCH/i,
    /INFORMATIONAL/i,
    /NON_BLOCKING/i,
    /RESOLVED/i,
    /SUPERSEDED/i,
    /CANCELLED/i,
    // Phase E10.1 introduced PILOT_HARDENING for medium-severity code-side
    // gaps that don't block initial pilot but should close before scaling.
    // Inverse-pin flip per CR1.7 §10.1.
    /PILOT_HARDENING/i,
    // Phase R10 introduced R11_CERTIFICATION for items deferred to the
    // R11 formal a11y / browser certification phase. Inverse-pin flip
    // per CR1.7 §10.1.
    /R11_CERTIFICATION/i,
    // Phase R11 introduced R11_1_INFRASTRUCTURE (Playwright + axe-core
    // CI build-out) and DOCUMENTED_LIMITATION (browser-quirk runbook
    // entries). Inverse-pin flip per CR1.7 §10.1.
    /R11_1_INFRASTRUCTURE/i,
    /DOCUMENTED_LIMITATION/i,
  ];
  function isClassified(row: string): boolean {
    return CLASSIFICATION_KEYWORDS.some((p) => p.test(row));
  }

  // Extract every DEF row from §6 of the master registry.
  const defRows = Array.from(REGISTRY.matchAll(/\|\s*(DEF-\d{3})\s*\|[^\n]+/g));

  it("registry contains at least 30 DEF rows", () => {
    expect(defRows.length).toBeGreaterThanOrEqual(30);
  });

  for (const m of defRows) {
    const defId = m[1]!;
    const row = m[0];
    it(`${defId} row carries an explicit classification keyword`, () => {
      expect(
        isClassified(row),
        `${defId} row has no classification: ${row.slice(0, 200)}`,
      ).toBe(true);
    });
  }
});

// ===========================================================================
// PART 12 — No new client-state / queue / pubsub library introduced
// ===========================================================================

describe("E10 Test 12 — no new state / queue libraries", () => {
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
      "pusher-js",
      "ably",
    ]) {
      expect(deps[forbidden], `forbidden web dep ${forbidden}`).toBeUndefined();
    }
  });
});
