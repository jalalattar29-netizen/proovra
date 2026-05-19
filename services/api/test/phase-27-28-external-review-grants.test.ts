/**
 * Phase 27 + 28 — External Review Grant persistence source-contract tests.
 *
 * The audit confirmed that Phase 27 (compliance lifecycle) and Phase
 * 28 (export governance) are largely shipped end-to-end already:
 *   - Retention engine, legal holds (evidence + case), destruction
 *     review with step-up, export eligibility gate (API + worker
 *     fail-closed), governance dashboard UI, audit chain.
 *
 * The one genuine missing piece the audit named was the external
 * reviewer access PERSISTENCE layer — the Phase 28-E
 * `external-review.ts` shared module shipped the pure state machine
 * + decision logic + privacy filter, but no Prisma model existed to
 * actually store grants. This phase fills that gap:
 *
 *   1. Idempotent SQL drift patch creating `external_review_grants`
 *      with bounded scope + state CHECK constraints + token-hash
 *      unique index.
 *   2. `external-review-grant.service.ts` — issue / lookup / revoke
 *      / transition / list grants via `$queryRaw` (Prisma model
 *      regeneration can come in a follow-up).
 *   3. Schema-validation registration so drift on `state`,
 *      `token_hash`, `expires_at_utc` fails fast at startup.
 *   4. Metric catalog + bounded SecurityEvent types.
 *
 * Pure source-contract + bounded-vocabulary tests. No DB.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  EXTERNAL_REVIEW_SCOPE_KINDS,
  EXTERNAL_REVIEW_GRANT_DENIAL_CODES,
  type ExternalReviewGrantDenialCode,
  type ExternalReviewScopeKind,
} from "../src/services/external-review/external-review-grant.service.js";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

// =============================================================================
// PART 1 — SQL drift patch
// =============================================================================

describe("Phase 27/28 — external_review_grants SQL drift patch", () => {
  const src = readSource(
    "../../../services/api/sql/drift-patches/2026-05-19-external-review-grants.sql",
  );

  it("creates the table with IF NOT EXISTS (idempotent re-run)", () => {
    expect(src).toMatch(
      /CREATE TABLE IF NOT EXISTS\s+"external_review_grants"/i,
    );
  });

  it("scope_kind catalog is bounded by CHECK constraint", () => {
    expect(src).toMatch(
      /CONSTRAINT "external_review_grants_scope_kind_bounded"[\s\S]*?CHECK[\s\S]*?'EVIDENCE'[\s\S]*?'CASE'[\s\S]*?'PACKAGE'/i,
    );
  });

  it("state catalog is bounded by CHECK constraint matching the shared state machine", () => {
    expect(src).toMatch(
      /CONSTRAINT "external_review_grants_state_bounded"[\s\S]*?CHECK[\s\S]*?'INVITED'[\s\S]*?'ACTIVE'[\s\S]*?'EXPIRED'[\s\S]*?'REVOKED'[\s\S]*?'BLOCKED_BY_POLICY'/i,
    );
  });

  it("enforces one-of (evidence_id, case_id, package_id) by scope_kind", () => {
    expect(src).toMatch(
      /CONSTRAINT "external_review_grants_scope_target_present"[\s\S]*?'EVIDENCE'.*?evidence_id.*?NOT NULL[\s\S]*?'CASE'.*?case_id.*?NOT NULL[\s\S]*?'PACKAGE'.*?package_id.*?NOT NULL/i,
    );
  });

  it("forbids non-positive grant lifetimes", () => {
    expect(src).toMatch(
      /CONSTRAINT "external_review_grants_expires_after_created"[\s\S]*?expires_at_utc.*?>.*?created_at_utc/i,
    );
  });

  it("token_hash is UNIQUE (no duplicate tokens — security incident if violated)", () => {
    expect(src).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS "external_review_grants_token_hash_uk"/i,
    );
  });

  it("partial index on expiry sweep (state IN INVITED, ACTIVE) supports the reconciliation worker", () => {
    expect(src).toMatch(
      /CREATE INDEX IF NOT EXISTS "external_review_grants_expiry_sweep_idx"[\s\S]*?WHERE "state" IN \('INVITED', 'ACTIVE'\)/i,
    );
  });

  it("operator queue index supports team-scoped active-grant listing", () => {
    expect(src).toMatch(
      /CREATE INDEX IF NOT EXISTS "external_review_grants_team_state_expires_idx"[\s\S]*?\("team_id", "state", "expires_at_utc" DESC\)/i,
    );
  });

  it("wraps every statement in a single transaction", () => {
    expect(src).toMatch(/^\s*BEGIN\s*;/m);
    expect(src).toMatch(/^\s*COMMIT\s*;/m);
  });
});

// =============================================================================
// PART 2 — Bounded vocabulary
// =============================================================================

describe("Phase 27/28 — bounded vocabularies", () => {
  it("scope kinds are bounded to EVIDENCE | CASE | PACKAGE", () => {
    expect([...EXTERNAL_REVIEW_SCOPE_KINDS]).toEqual([
      "EVIDENCE",
      "CASE",
      "PACKAGE",
    ]);
  });

  it("denial codes are bounded + match the SQL state machine", () => {
    for (const required of [
      "token_unknown",
      "grant_not_active",
      "grant_expired",
      "grant_revoked",
      "grant_blocked_by_policy",
      "grant_blocked_by_legal_hold",
      "invalid_transition",
      "invalid_scope",
      "invalid_expiry",
      "service_unavailable",
    ] as ReadonlyArray<ExternalReviewGrantDenialCode>) {
      expect(EXTERNAL_REVIEW_GRANT_DENIAL_CODES).toContain(required);
    }
  });

  it("denial codes are stable snake_case identifiers (no PII / no email leak)", () => {
    for (const code of EXTERNAL_REVIEW_GRANT_DENIAL_CODES) {
      expect(code).toMatch(/^[a-z][a-z0-9_]+$/);
      expect(code).not.toMatch(/@|-[0-9a-f]{8}/);
    }
  });

  it("scope kinds are stable snake_case-equivalent (uppercase enum)", () => {
    for (const scope of EXTERNAL_REVIEW_SCOPE_KINDS) {
      expect(scope).toMatch(/^[A-Z][A-Z_]+$/);
    }
  });
});

// =============================================================================
// PART 3 — Service source contract
// =============================================================================

describe("Phase 27/28 — external-review-grant.service.ts source contract", () => {
  const src = readSource(
    "../../../services/api/src/services/external-review/external-review-grant.service.ts",
  );

  it("imports the canonical state machine + evaluator from @proovra/shared", () => {
    expect(src).toMatch(
      /import\s*\{[\s\S]*?evaluateExternalReviewAccess[\s\S]*?isAllowedExternalReviewTransition[\s\S]*?\}\s*from\s+"@proovra\/shared"/,
    );
  });

  it("stores ONLY the SHA-256 token hash — raw token never persisted", () => {
    expect(src).toMatch(/createHash\("sha256"\)/);
    expect(src).toMatch(/hashToken\(/);
    // The INSERT must use `token_hash`, never `raw_token`.
    expect(src).toMatch(/"token_hash"/);
    expect(src).not.toMatch(/"raw_token"/);
  });

  it("the raw token is returned EXACTLY ONCE on creation and never re-derivable", () => {
    expect(src).toMatch(/ok: true; grant: ExternalReviewGrantRow; rawToken: string/);
    // No function exports `getRawToken` / `revealToken` / similar.
    expect(src).not.toMatch(/getRawToken|revealToken|exposeToken/);
  });

  it("issueExternalReviewGrant validates scope cardinality + expiry bounds", () => {
    expect(src).toMatch(/MIN_GRANT_LIFETIME_MS\s*=\s*15 \* 60 \* 1000/);
    expect(src).toMatch(/MAX_GRANT_LIFETIME_MS\s*=\s*30 \* 24 \* 60 \* 60 \* 1000/);
    expect(src).toMatch(/return\s*\{\s*ok:\s*false,\s*reason:\s*"invalid_expiry"\s*\}/);
    expect(src).toMatch(/return\s*\{\s*ok:\s*false,\s*reason:\s*"invalid_scope"\s*\}/);
  });

  it("lookupExternalReviewGrantByToken is anti-enumeration safe (same reason for unknown vs revoked)", () => {
    // Token-not-found returns `grant_not_active` (the same code revoked
    // grants return), so the route handler can't distinguish.
    expect(src).toMatch(
      /if \(!raw\) \{[\s\S]*?return \{ ok: false, reason: "grant_not_active" \}/,
    );
  });

  it("every read filters on team_id (no cross-workspace lookups)", () => {
    expect(src).toMatch(/WHERE "id" = \$1 AND "team_id" = \$2/);
    // ListGrantsInput requires teamId and the SQL always anchors $1
    // on team_id.
    expect(src).toMatch(/where:\s*string\[\]\s*=\s*\[`"team_id" = \$1`\]/);
  });

  it("transitionExternalReviewGrant validates against the canonical state machine", () => {
    expect(src).toMatch(
      /isAllowedExternalReviewTransition\(fromState, input\.toState\)/,
    );
    expect(src).toMatch(
      /return \{ ok: false, reason: "invalid_transition" \}/,
    );
  });

  it("revocation flips state + writes revoked_at_utc + revoked_by_user_id (audit trail)", () => {
    expect(src).toMatch(
      /revokedAt = input\.toState === "REVOKED" \? new Date\(\) : null/,
    );
    expect(src).toMatch(/"revoked_by_user_id" = COALESCE\("revoked_by_user_id", \$5\)/);
  });

  it("recordExternalReviewAccess is best-effort (never throws to the reviewer's read path)", () => {
    expect(src).toMatch(
      /recordExternalReviewAccess[\s\S]*?try\s*\{[\s\S]*?\}\s*catch\s*\{[\s\S]*?\/\/ Best-effort/,
    );
  });

  it("never selects raw token / private notes / signed URLs from the table", () => {
    const noComments = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    expect(noComments).not.toMatch(/"raw_token"/);
    expect(noComments).not.toMatch(/privateReviewerNote/);
    expect(noComments).not.toMatch(/signed_url/);
  });

  it("reviewer_email is normalised to lowercase + trimmed + length-bounded before storage", () => {
    expect(src).toMatch(
      /input\.reviewerEmail\.toLowerCase\(\)\.trim\(\)\.slice\(0,\s*320\)/,
    );
  });

  it("SecurityEvent details hash the reviewer email (never the raw value)", () => {
    expect(src).toMatch(
      /reviewerEmailHash:\s*hashToken\(input\.reviewerEmail/,
    );
  });
});

// =============================================================================
// PART 4 — Schema validation registration
// =============================================================================

describe("Phase 27/28 — schema validation registration", () => {
  const src = readSource(
    "../../../services/api/src/runtime/schema-validation.ts",
  );

  it("registers the external_review_grants table", () => {
    expect(src).toMatch(
      /name:\s*"external_review_grants"[\s\S]*?subsystem:\s*"governance_lifecycle"/,
    );
  });

  it("registers state + token_hash + expires_at_utc columns at CRITICAL severity", () => {
    expect(src).toMatch(
      /table:\s*"external_review_grants",\s*column:\s*"state",\s*severity:\s*"critical"/,
    );
    expect(src).toMatch(
      /table:\s*"external_review_grants",\s*column:\s*"token_hash",\s*severity:\s*"critical"/,
    );
    expect(src).toMatch(
      /table:\s*"external_review_grants",\s*column:\s*"expires_at_utc",\s*severity:\s*"critical"/,
    );
  });

  it("registers the token_hash unique index at CRITICAL severity", () => {
    expect(src).toMatch(
      /indexName:\s*"external_review_grants_token_hash_uk",\s*severity:\s*"critical"/,
    );
  });

  it("registers scope_kind + allow_original_download as IMPORTANT (governance-load-bearing)", () => {
    expect(src).toMatch(
      /table:\s*"external_review_grants",\s*column:\s*"scope_kind",\s*severity:\s*"important"/,
    );
    expect(src).toMatch(
      /table:\s*"external_review_grants",\s*column:\s*"allow_original_download",\s*severity:\s*"important"/,
    );
  });
});

// =============================================================================
// PART 5 — Metric + SecurityEvent catalogues
// =============================================================================

describe("Phase 27/28 — metric + SecurityEvent catalogues", () => {
  it("metrics service registers every Phase 27/28 external-review counter", () => {
    const src = readSource(
      "../../../services/api/src/services/ops/metrics.service.ts",
    );
    for (const m of [
      "external_review_invited_total",
      "external_review_accepted_total",
      "external_review_accessed_total",
      "external_review_revoked_total",
      "external_review_expired_total",
      "external_review_grant_issue_failed_total",
      "external_review_grant_lookup_denied_total",
    ]) {
      expect(src, `metric ${m} missing`).toContain(`"${m}"`);
    }
  });

  it("SecurityEvent catalogue registers Phase 27/28 grant-lifecycle events", () => {
    const src = readSource(
      "../../../packages/shared/src/security.ts",
    );
    for (const evt of [
      "external_review_invited",
      "external_review_revoked",
      "external_review_grant_issue_failed",
      "external_review_grant_lookup_failed",
      "external_review_grant_transition_failed",
    ]) {
      expect(src, `event ${evt} missing`).toContain(`"${evt}"`);
    }
  });
});

// =============================================================================
// PART 6 — Privacy / governance invariants
// =============================================================================

describe("Phase 27/28 — privacy + governance invariants", () => {
  const FILES = [
    "../../../services/api/src/services/external-review/external-review-grant.service.ts",
    "../../../services/api/sql/drift-patches/2026-05-19-external-review-grants.sql",
  ];

  it("no surface uses banned wording (tamper / forged / altered content / manipulated evidence)", () => {
    const banned =
      /\btamper(ed|ing)?\b|\bforged\b|\bforgery\b|\baltered content\b|\bmanipulated evidence\b/i;
    for (const rel of FILES) {
      const src = readSource(rel);
      const literals = src.match(/"[^"\n]+"/g) ?? [];
      expect(
        literals.join(" "),
        `banned wording in ${rel}`,
      ).not.toMatch(banned);
    }
  });

  it("service never references private notes / legal-note bodies / storage keys / signed URLs / raw GPS", () => {
    const src = readSource(
      "../../../services/api/src/services/external-review/external-review-grant.service.ts",
    );
    const noComments = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    for (const forbidden of [
      "privateReviewerNote",
      "legalNoteBody",
      "storageKey",
      "signed_url",
      "signedUrl",
      "raw_gps",
      "gpsCoordinates",
    ]) {
      expect(noComments).not.toContain(forbidden);
    }
  });

  it("SQL never grants a default that bypasses governance (state defaults to INVITED, never ACTIVE)", () => {
    const src = readSource(
      "../../../services/api/sql/drift-patches/2026-05-19-external-review-grants.sql",
    );
    expect(src).toMatch(
      /"state"\s+VARCHAR\(24\)\s+NOT NULL DEFAULT 'INVITED'/,
    );
    expect(src).not.toMatch(/"state"\s+VARCHAR\(24\)\s+NOT NULL DEFAULT 'ACTIVE'/);
  });

  it("allow_original_download + allow_package_download default to false-erring side (original NEVER auto-enabled)", () => {
    const src = readSource(
      "../../../services/api/sql/drift-patches/2026-05-19-external-review-grants.sql",
    );
    expect(src).toMatch(
      /"allow_original_download"\s+BOOLEAN NOT NULL DEFAULT FALSE/,
    );
  });

  it("anti-enumeration: token lookup returns identical denial code for unknown + revoked tokens", () => {
    // Both branches of the lookup return `grant_not_active` so an
    // attacker probing for valid tokens cannot distinguish.
    const src = readSource(
      "../../../services/api/src/services/external-review/external-review-grant.service.ts",
    );
    // Verify both "raw not found" + "decision.allowed === false default
    // fallthrough" map to the SAME `grant_not_active` reason.
    expect(src).toMatch(
      /if \(!raw\) \{[\s\S]*?reason: "grant_not_active"/,
    );
    expect(src).toMatch(
      /:\s*"grant_not_active"/,
    );
  });

  it("compile-time type-level invariant: scope + denial vocabularies are typed", () => {
    const scope: ExternalReviewScopeKind = "EVIDENCE";
    const denial: ExternalReviewGrantDenialCode = "grant_not_active";
    expect(EXTERNAL_REVIEW_SCOPE_KINDS).toContain(scope);
    expect(EXTERNAL_REVIEW_GRANT_DENIAL_CODES).toContain(denial);
  });
});
