/**
 * Operations aggregation — scope-summary shape + admin-security leak-proof
 * INVARIANTS (2026-07-15).
 *
 * These pin query-scoping facts that cannot be exercised without a live
 * tenant DB (the DB-backed paths are covered by the `test:tenant:live`
 * harness). They complement the RUNTIME derivation tests in
 * phase-operational-eligibility.test.ts — here we prove the aggregation
 * (a) exposes the filter-independent actual-item override signal, and
 * (b) scopes admin-security sources to adjudicator (OWNER/ADMIN) teams so
 * they can never enter an ordinary member's aggregation, Bell, or Security
 * filter.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// THE shared recipient-visibility predicate, called rather than regex-matched.
import { isVisibleToRecipient } from "../src/routes/me-inbox.routes.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(
  resolve(HERE, "../src/routes/me-inbox.routes.ts"),
  "utf8",
);

describe("scopeSummary actual-item override signal", () => {
  it("scopeSummary carries a filter-independent per-category breakdown", () => {
    expect(SRC).toMatch(/scopeSummary\s*=\s*\{/);
    expect(SRC).toMatch(/byCategory:\s*\{[\s\S]*?scopeCategoryCount/);
    expect(SRC).toMatch(/const scopeCategoryCount =/);
  });

  it("scopeSummary carries a filter-independent deadline posture", () => {
    expect(SRC).toMatch(/deadlines:\s*\{[\s\S]*?dueSoon:[\s\S]*?overdue:/);
  });

  it("the scope set is built from ACTIVE, non-suppressed, non-dismissed items", () => {
    // scopeItems is the membership-authorized set the summary derives from.
    expect(SRC).toMatch(/const scopeItems = allItems\.filter/);
    // It resolves through THE shared visibility predicate rather than carrying
    // its own copy of the rule — four hand-written copies is how the badge and
    // the list come to disagree.
    expect(SRC).toMatch(/if \(!isVisibleToRecipient\(it, nowMs\)\) return false;/);

    // And the rule itself does what this test is named for.
    const now = Date.parse("2026-08-21T12:00:00.000Z");
    const base = { suppressedInApp: false, dismissedAt: null, snoozedUntil: null };
    expect(isVisibleToRecipient(base, now)).toBe(true);
    expect(isVisibleToRecipient({ ...base, suppressedInApp: true }, now)).toBe(false);
    expect(
      isVisibleToRecipient({ ...base, dismissedAt: new Date(now - 1).toISOString() }, now),
    ).toBe(false);
  });
});

describe("admin-security leak-proofing (§5)", () => {
  it("mfa_recovery_pending is scoped to adjudicator (OWNER/ADMIN) teams", () => {
    // The query window for pending MFA recovery must use adjudicatorTeamIds,
    // which is empty for a non-admin — so the category never enters their set.
    const window = SRC.slice(
      SRC.indexOf("mfaRecoveryRequest"),
      SRC.indexOf("mfaRecoveryRequest") + 400,
    );
    expect(window).toMatch(/adjudicatorTeamIds/);
  });

  it("communication_failure is scoped to adjudicator (OWNER/ADMIN) teams", () => {
    const window = SRC.slice(
      SRC.indexOf("communicationMessage"),
      SRC.indexOf("communicationMessage") + 400,
    );
    expect(window).toMatch(/adjudicatorTeamIds/);
  });

  it("personal security_event_high is scoped to the caller's own userId", () => {
    // Anchor on the real Prisma call (`prisma.securityEvent.findMany`), not
    // the drift-handling comment that mentions the query name.
    const at = SRC.lastIndexOf("prisma.securityEvent.findMany");
    expect(at).toBeGreaterThan(-1);
    const window = SRC.slice(at, at + 200);
    expect(window).toMatch(/where:\s*\{\s*userId/);
  });

  it("adjudicatorTeamIds is derived from OWNER/ADMIN roles only", () => {
    expect(SRC).toMatch(/adjudicatorTeamIds/);
    // The role gate that builds the adjudicator set.
    expect(SRC).toMatch(/role === "OWNER"[\s\S]{0,40}role === "ADMIN"/);
  });
});
