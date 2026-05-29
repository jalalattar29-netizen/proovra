/**
 * PHASE R8 — Enterprise Identity & Security Activation guardrails.
 *
 * R8 is an AUDIT-FIRST phase. It documents the existing identity
 * infrastructure honestly, extends the bounded SECURITY_EVENT_TYPES
 * vocabulary with 14 R8 identity events, and pins the canonical
 * auth + SCIM + tenant-isolation guards against regression.
 *
 * R8 does NOT pretend to ship full TOTP / SAML SP / SCIM group sync
 * in this phase. Those are honestly deferred to dedicated sub-phases
 * (R8.1 / R8.2 / R8.3). See the audit doc + final report for the
 * scoping decision.
 *
 * Hard contract pinned here:
 *
 *   1. R8 vocabulary additions present + bounded.
 *   2. No parallel auth route file introduced.
 *   3. No parallel SCIM route file introduced.
 *   4. No parallel security-event service introduced.
 *   5. Canonical auth + SCIM + identity files preserved in size.
 *   6. Existing Phase 17/19 security events preserved.
 *   7. Tenant-isolation guards preserved.
 *   8. No raw token / OTP / secret logging anti-patterns in
 *      auth + identity routes.
 *   9. No workflow/persona authorization regression.
 *   10. Capture / custody / TSA / report files unchanged.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function repoPath(rel: string): string {
  return fileURLToPath(new URL(`../../../${rel}`, import.meta.url));
}
function apiPath(rel: string): string {
  return fileURLToPath(new URL(`../${rel}`, import.meta.url));
}
function readRepo(rel: string): string {
  return readFileSync(repoPath(rel), "utf8");
}
function readApi(rel: string): string {
  return readFileSync(apiPath(rel), "utf8");
}

const SHARED_SECURITY = readFileSync(
  fileURLToPath(
    new URL(`../../../packages/shared/src/security.ts`, import.meta.url),
  ),
  "utf8",
);

// =============================================================================
// PART 1 — R8 audit + final docs exist
// =============================================================================

describe("R8 Part 1 — audit + final report docs exist", () => {
  it("audit doc exists and is substantial", () => {
    const audit = readRepo("docs/security/R8_IDENTITY_ARCHITECTURE_AUDIT.md");
    expect(audit.length).toBeGreaterThan(5000);
    expect(audit).toMatch(/R8 — Identity Architecture Audit/);
    expect(audit).toMatch(/MFA/);
    expect(audit).toMatch(/SAML/);
    expect(audit).toMatch(/SCIM/);
    expect(audit).toMatch(/Security event/i);
    expect(audit).toMatch(/Tenant isolation/i);
  });

  it("final report doc exists and is substantial", () => {
    const doc = readRepo("docs/security/R8_ENTERPRISE_IDENTITY_SECURITY.md");
    expect(doc.length).toBeGreaterThan(6000);
    expect(doc).toMatch(/PHASE R8/);
    expect(doc).toMatch(/MFA model/);
    expect(doc).toMatch(/SSO \/ SAML/);
    expect(doc).toMatch(/SCIM architecture/);
    expect(doc).toMatch(/Security-event architecture/);
    expect(doc).toMatch(/Remaining risks/);
  });

  it("final report honestly names deferral phases (R8.1 / R8.2 / R8.3)", () => {
    const doc = readRepo("docs/security/R8_ENTERPRISE_IDENTITY_SECURITY.md");
    expect(doc).toMatch(/R8\.1/);
    expect(doc).toMatch(/R8\.2/);
    expect(doc).toMatch(/R8\.3/);
  });
});

// =============================================================================
// PART 2 — R8 event vocabulary present + bounded
// =============================================================================

describe("R8 Part 2 — bounded R8 identity event vocabulary", () => {
  const R8_EVENTS: ReadonlyArray<string> = [
    "mfa_enrollment_started",
    "mfa_enrollment_completed",
    "mfa_factor_added",
    "mfa_factor_removed",
    "mfa_verification_succeeded",
    "mfa_verification_failed",
    "auth_login_failed",
    "sso_login_succeeded",
    "sso_login_failed",
    "scim_user_provisioned",
    "scim_user_deprovisioned",
    "scim_group_synced",
    "api_key_issued",
    "api_key_revoked",
  ];

  it("SECURITY_EVENT_TYPES contains every R8 identity event", () => {
    for (const event of R8_EVENTS) {
      expect(
        SHARED_SECURITY,
        `SECURITY_EVENT_TYPES must include R8 event "${event}"`,
      ).toMatch(new RegExp(`"${event}"`));
    }
  });

  it("R8 event vocabulary is appended (existing events untouched)", () => {
    // The R8 additions follow the "Phase 25.7" governance section.
    // Specifically check the immediately-preceding entries remain.
    expect(SHARED_SECURITY).toMatch(/"governance_export_snapshot_created"/);
    expect(SHARED_SECURITY).toMatch(/"governance_lifecycle_drift_detected"/);
  });

  it("R8 additions are labeled with the Phase R8 comment marker", () => {
    expect(SHARED_SECURITY).toMatch(/Phase R8/);
  });
});

// =============================================================================
// PART 3 — Existing Phase 17 / 19 / 22 events preserved
// =============================================================================

describe("R8 Part 3 — pre-R8 security events preserved (no regression)", () => {
  // Spot-check a representative event from each pre-R8 phase. Full
  // bounded-set integrity is enforced by upstream phase tests.
  const PRE_R8_EVENTS: ReadonlyArray<string> = [
    // Phase 17 identity
    "member_invited",
    "member_revoked",
    "capability_granted",
    "delegated_admin_granted",
    "org_security_policy_updated",
    "permission_denied",
    // Phase 19 step-up
    "mfa_policy_updated",
    "step_up_started",
    "step_up_approved",
    "trusted_device_added",
    "session_revoked",
    "suspicious_login_detected",
    // Phase 22 workflow
    "workflow_template_created",
    "workflow_export_blocked",
  ];

  for (const event of PRE_R8_EVENTS) {
    it(`pre-R8 event "${event}" remains in the bounded vocabulary`, () => {
      expect(SHARED_SECURITY).toMatch(new RegExp(`"${event}"`));
    });
  }
});

// =============================================================================
// PART 4 — No parallel auth / SCIM / security-event surfaces introduced
// =============================================================================

describe("R8 Part 4 — no parallel identity infrastructure introduced", () => {
  function listAllRouteFiles(): string[] {
    const out: string[] = [];
    const dir = apiPath("src/routes");
    for (const name of readdirSync(dir)) {
      const full = `${dir}/${name}`;
      try {
        if (statSync(full).isFile() && /\.ts$/.test(name)) out.push(name);
      } catch {
        /* ignore */
      }
    }
    return out;
  }

  it("no new parallel auth route file (`mfa.routes.ts` is an identity sub-domain shipped by R8.1.1, NOT a parallel auth system)", () => {
    const FORBIDDEN_NAMES = [
      "auth2.routes.ts",
      "auth-v2.routes.ts",
      "enterprise-auth.routes.ts",
      "auth-enterprise.routes.ts",
      "totp.routes.ts",
      "saml.routes.ts",
    ];
    const files = listAllRouteFiles();
    for (const forbidden of FORBIDDEN_NAMES) {
      expect(
        files.includes(forbidden),
        `R8 forbids parallel auth route file ${forbidden} — use canonical routes/auth.routes.ts + routes/sso-auth.routes.ts + routes/identity-security.routes.ts.`,
      ).toBe(false);
    }
  });

  it("no new SCIM route file (no `scim2.routes.ts` / `scim-v2.routes.ts`)", () => {
    const FORBIDDEN_NAMES = [
      "scim2.routes.ts",
      "scim-v2.routes.ts",
      "provisioning.routes.ts",
    ];
    const files = listAllRouteFiles();
    for (const forbidden of FORBIDDEN_NAMES) {
      expect(
        files.includes(forbidden),
        `R8 forbids parallel SCIM route file ${forbidden} — use canonical routes/scim.routes.ts.`,
      ).toBe(false);
    }
  });

  it("no parallel security-event service (canonical is services/security/security-event.service.ts)", () => {
    function listAllSvcFiles(dirAbs: string): string[] {
      const out: string[] = [];
      const stack: string[] = [dirAbs];
      while (stack.length > 0) {
        const dir = stack.pop()!;
        let entries: string[];
        try {
          entries = readdirSync(dir);
        } catch {
          continue;
        }
        for (const name of entries) {
          const full = `${dir}/${name}`;
          try {
            const st = statSync(full);
            if (st.isFile() && /security-event/.test(name)) out.push(full);
            else if (st.isDirectory()) stack.push(full);
          } catch {
            /* ignore */
          }
        }
      }
      return out;
    }
    const matches = listAllSvcFiles(apiPath("src/services"));
    // The single canonical service.
    const canonical = matches.find((f) =>
      f.replace(/\\/g, "/").endsWith("/services/security/security-event.service.ts"),
    );
    expect(
      canonical,
      "canonical security-event.service.ts must exist under services/security/",
    ).toBeTruthy();
    expect(
      matches.length,
      "only one security-event service file allowed",
    ).toBe(1);
  });
});

// =============================================================================
// PART 5 — Canonical auth + identity + SCIM files preserved (size pins)
// =============================================================================

describe("R8 Part 5 — canonical identity files preserved in size", () => {
  // R8 must not have modified the canonical auth / identity / SCIM
  // route files at all. Tight ±5% bound on each — EXCEPT auth.routes
  // and sso-auth.routes, which were legitimately grown by R8.1.2's
  // login-time MFA integration (verify endpoint, MFA-gate helper,
  // pending-cookie helpers, OIDC MFA branch). Their new baselines
  // are pinned here with the same ±5% bound around the post-R8.1.2
  // size so further drift is still caught.
  const PINS: ReadonlyArray<{ rel: string; expectedBytes: number }> = [
    // R8.1.3 baseline (was 32109 after R8.1.2; further grew when the
    // durable-challenge gate + ENROLLMENT_REQUIRED branch landed).
    // R8.1.9 rebaselined: +session-light endpoint added in R8.1.9 Part 1.
    // Phase E10.1 rebaselined: +per-IP rate limit on login +
    // password-reset (DEF-037 closure; ~30 lines of bounded hardening).
    // Rebaselined post-G3.x/G4/G5 — auth.routes.ts grew with MFA
    // step-up + per-IP rate-limit + governance-aware enrollment.
    { rel: "src/routes/auth.routes.ts", expectedBytes: 48469 },
    // R8.1.3 baseline (was 15823 after R8.1.2; grew for the SSO
    // durable-challenge + enrollment-required branches).
    { rel: "src/routes/sso-auth.routes.ts", expectedBytes: 18565 },
    { rel: "src/routes/identity.routes.ts", expectedBytes: 31353 },
    {
      rel: "src/routes/identity-security.routes.ts",
      // Final Closure Remediation Part D — rebaselined from 18952 to
      // 30979 bytes. The file grew by ~12 KB across post-R8 phases as
      // bounded step-up + recovery-flow endpoints landed (none of
      // which are R8-attributable; this pin protects against further
      // unaudited growth, not the historical R8 baseline). The
      // bounded-±5% window continues to detect drift relative to the
      // current canonical size.
      expectedBytes: 30979,
    },
    { rel: "src/routes/scim.routes.ts", expectedBytes: 11446 },
    { rel: "src/routes/admin-identity.routes.ts", expectedBytes: 30763 },
  ];

  for (const { rel, expectedBytes } of PINS) {
    it(`${rel} is within ±5% of the R8 audit baseline (${expectedBytes} bytes)`, () => {
      const fullPath = apiPath(rel);
      const st = statSync(fullPath);
      const low = Math.floor(expectedBytes * 0.95);
      const high = Math.ceil(expectedBytes * 1.05);
      expect(
        st.size,
        `${rel} size ${st.size} drifted out of R8 window [${low}, ${high}]. R8 should NOT modify canonical auth/identity files.`,
      ).toBeGreaterThanOrEqual(low);
      expect(st.size).toBeLessThanOrEqual(high);
    });
  }
});

// =============================================================================
// PART 6 — Canonical platform-audit-log + security-event services preserved
// =============================================================================

describe("R8 Part 6 — canonical audit + security-event services preserved", () => {
  it("platform-audit-log.service.ts still exports appendPlatformAuditLog", () => {
    const src = readApi("src/services/platform-audit-log.service.ts");
    expect(src).toMatch(/export[\s\S]*?appendPlatformAuditLog/);
  });

  it("security-event service still consumes the bounded vocabulary", () => {
    const src = readApi("src/services/security/security-event.service.ts");
    expect(src).toMatch(/SECURITY_EVENT_TYPES/);
    expect(src).toMatch(/SECURITY_EVENT_SEVERITIES/);
  });
});

// =============================================================================
// PART 7 — Tenant isolation guards preserved
// =============================================================================

describe("R8 Part 7 — tenant isolation guards preserved", () => {
  it("identity.routes.ts still defines + uses requireIdentityActor", () => {
    const src = readApi("src/routes/identity.routes.ts");
    expect(src).toMatch(/requireIdentityActor/);
  });

  it("identity-security.routes.ts still uses requireSecurityActor", () => {
    const src = readApi("src/routes/identity-security.routes.ts");
    expect(src).toMatch(/requireSecurityActor/);
  });

  it("scim.routes.ts still requires team-scoped auth via authenticateScimRequest", () => {
    const src = readApi("src/routes/scim.routes.ts");
    expect(src).toMatch(/authenticateScimRequest/);
  });
});

// =============================================================================
// PART 8 — No raw token / OTP / secret logging anti-patterns
// =============================================================================

describe("R8 Part 8 — no raw token / OTP / secret logging in auth/identity routes", () => {
  const FORBIDDEN_PATTERNS: ReadonlyArray<RegExp> = [
    // console.log(token), console.log(secret), console.log(otp) — any
    // direct log of these identifiers is a hard anti-pattern.
    /console\.log\([^)]*\btoken\b[^)]*\)/,
    /console\.log\([^)]*\bsecret\b[^)]*\)/,
    /console\.log\([^)]*\botp\b[^)]*\)/i,
    /console\.log\([^)]*\bpassword\b[^)]*\)/,
    // Logger calls that include these primitives.
    /\.info\([^)]*\bplaintextOtp\b[^)]*\)/i,
    /\.warn\([^)]*\bplaintextOtp\b[^)]*\)/i,
    /\.error\([^)]*\brawSecret\b[^)]*\)/,
  ];

  const SWEEP_FILES = [
    "src/routes/auth.routes.ts",
    "src/routes/sso-auth.routes.ts",
    "src/routes/identity.routes.ts",
    "src/routes/identity-security.routes.ts",
    "src/routes/scim.routes.ts",
    "src/routes/admin-identity.routes.ts",
  ];

  for (const rel of SWEEP_FILES) {
    it(`${rel} contains no raw token/secret/OTP logging`, () => {
      const src = readApi(rel);
      for (const pattern of FORBIDDEN_PATTERNS) {
        expect(
          src,
          `${rel} contains forbidden logging anti-pattern ${pattern}`,
        ).not.toMatch(pattern);
      }
    });
  }
});

// =============================================================================
// PART 9 — No workflow/persona authorization regression
// =============================================================================

describe("R8 Part 9 — no workflow/persona authorization regression", () => {
  it("routeAccessResolver still consults capabilities + active-space only", () => {
    const src = readFileSync(
      fileURLToPath(
        new URL(
          `../../../apps/web/lib/navigation/routeAccessResolver.ts`,
          import.meta.url,
        ),
      ),
      "utf8",
    );
    expect(src).not.toMatch(/\.workflowProfile\b/);
    expect(src).not.toMatch(/\.primaryWorkflow\b/);
    expect(src).not.toMatch(/\.workflowTags\b/);
    expect(src).not.toMatch(/\.personaProfile\b/);
  });

  it("workflowExposureResolver still documents the no-authorization contract", () => {
    const src = readFileSync(
      fileURLToPath(
        new URL(
          `../../../apps/web/lib/navigation/workflowExposureResolver.ts`,
          import.meta.url,
        ),
      ),
      "utf8",
    );
    expect(src).toMatch(/Workflow NEVER changes/i);
  });
});

// =============================================================================
// PART 10 — Capture / custody / TSA / report / package unchanged
// =============================================================================

describe("R8 Part 10 — canonical capture/custody/TSA/report files unchanged", () => {
  const PINS: ReadonlyArray<{ rel: string; expectedBytes: number }> = [
    { rel: "src/routes/capture.routes.ts", expectedBytes: 21271 },
    { rel: "src/services/evidence-complete.service.ts", expectedBytes: 41849 },
    { rel: "src/services/custody-events.service.ts", expectedBytes: 5155 },
    { rel: "src/services/timestamp.service.ts", expectedBytes: 7535 },
    {
      rel: "src/services/reports/reports-aggregator.service.ts",
      expectedBytes: 13118,
    },
  ];

  for (const { rel, expectedBytes } of PINS) {
    it(`${rel} is within ±10% of the CR1.5 baseline`, () => {
      const fullPath = apiPath(rel);
      const st = statSync(fullPath);
      const low = Math.floor(expectedBytes * 0.9);
      const high = Math.ceil(expectedBytes * 1.1);
      expect(
        st.size,
        `${rel} size ${st.size} drifted out of window [${low}, ${high}]`,
      ).toBeGreaterThanOrEqual(low);
      expect(st.size).toBeLessThanOrEqual(high);
    });
  }
});
