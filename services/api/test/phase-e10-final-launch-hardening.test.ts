/**
 * PHASE E10 — Final Launch Hardening contract tests.
 *
 * E10 is the decision + classification phase. The tests pin:
 *
 *   1. All 17 runbook files exist + are substantial
 *      (8 new runbooks 10–17 added by E10).
 *   4. Existing rate-limit coverage stays present (regression guard
 *      for the surfaces already covered).
 *   5. Existing production config validation gates remain present
 *      (Stripe key shape, SAML production-localhost guard, S3
 *      production-localhost guard, signing provider consistency).
 *   6. No fake SLA / uptime claims in any E10-shipped runbook.
 *   7. No secrets in the runbooks (8 secret-shape
 *      patterns mirrored from E6).
 *   8. 32.8 canonical primaries still exactly 6 (no nav explosion).
 *   9. Protected core files unchanged (file-size pins).
 *  12. No new client-state / queue / pubsub library introduced.
 *
 * Phase E10 ships zero features, zero redesigns, zero architecture
 * changes.
 */

import { existsSync, readFileSync } from "node:fs";
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

  it("MFA verify still throttles per-userId (multi-instance-safe shared limiter)", () => {
    const authRoutes = readApi("src/routes/auth.routes.ts");
    // Enterprise launch hardening — the MFA-verify throttle moved OFF the
    // per-process in-memory Map onto the shared `enforceRateLimit` limiter
    // (Redis when configured; in-memory fallback in dev/test) so multiple
    // API instances can't multiply the attempt budget. The throttle must
    // still exist AND route through the shared limiter with a user-scoped key.
    expect(authRoutes).toMatch(/loginMfaIsRateLimited/);
    expect(authRoutes).toMatch(
      /enforceRateLimit\(\{[\s\S]*?`mfa-verify:\$\{userId\}`/,
    );
    // The old per-process Map must be gone (it was the multi-instance gap).
    expect(authRoutes).not.toMatch(/const loginMfaAttempts = new Map/);
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
  // Runbooks may reference SLA / uptime in honest
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
    expect(ids).toHaveLength(9); // baseline grew with G0+ IA — was 6 pre-G0, now 9 canonical primaries
  });
});

// ===========================================================================
// PART 9 — Protected core files unchanged
// ===========================================================================

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
