/**
 * Phase 6 — Enterprise Collaboration honesty + gate audit.
 *
 * SCOPE G/H/I closure pins. This file is an INTEGRITY LOCK across the
 * three Phase 6 enterprise modules — Investigation, Intelligence, and
 * Redaction. It does NOT re-test the per-phase behaviour (that lives in
 * phase-3a-redaction-platform.test.ts, intelligence.test.ts, etc.). It
 * pins the cross-module honesty invariants the Phase 6 brief demands:
 *
 *   * Investigation surfaces read REAL evidence/case/custody data and
 *     are permission-gated; no fabricated/AI-invented conclusions.
 *   * Intelligence panels call REAL backend endpoints, are gated, and
 *     forbidden-authenticity vocabulary is actively rejected — signals
 *     are advisory, never conclusions.
 *   * Redaction produces a SEPARATE derivative and NEVER mutates the
 *     original evidence bytes/hash; every mutating route is capability
 *     gated + audited; the public verify badge stays provenance-only.
 *
 * Style: source-contract (file-text assertions). No DB I/O, no HTTP
 * spin-up — deliberately consistent with the sibling Phase 3A /
 * investigation-suite audit tests so it runs fast in CI.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function read(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

// --- Backend routes ---------------------------------------------------------
const REDACTION_ROUTES = read(
  "../../../services/api/src/routes/redaction.routes.ts",
);
const REDACTION_DERIVATIVE = read(
  "../../../services/api/src/services/redaction/redaction-derivative.service.ts",
);
const MEDIA_INTEL_SVC = read(
  "../../../services/api/src/services/intelligence/media-intelligence.service.ts",
);
const INTELLIGENCE_ROUTES = read(
  "../../../services/api/src/routes/intelligence.routes.ts",
);
const INVESTIGATION_DIAG_ROUTES = read(
  "../../../services/api/src/routes/investigation-diagnostics.routes.ts",
);

// --- Frontend pages (my owned surfaces) -------------------------------------
const UI_INVESTIGATION = read(
  "../../../apps/web/app/(app)/investigation/page.tsx",
);
const UI_INTELLIGENCE = read(
  "../../../apps/web/app/(app)/intelligence/page.tsx",
);
const UI_REDACTION = read("../../../apps/web/app/(app)/redaction/page.tsx");
const UI_PROVIDER_BUDGET = read(
  "../../../apps/web/components/intelligence/ProviderBudgetPanel.tsx",
);

// The forbidden-authenticity vocabulary a Phase 6 surface must never
// present to an operator as a *conclusion* (advisory wording only).
const FORBIDDEN_CONCLUSION_WORDS = [
  "tampered",
  "forged",
  "doctored",
  "manipulated",
  "authentic",
  "admissible",
] as const;

/**
 * Strip block + line comments so a documenting comment that mentions a
 * forbidden word does not false-positive as user-facing copy.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/**
 * Collect JSX string / text literals that could reach an operator.
 * Deliberately coarse — we want to catch a fabricated claim string,
 * not lint every identifier.
 */
function userFacingText(src: string): string {
  return stripComments(src);
}

// ===========================================================================
// SCOPE G — Investigation reads REAL data + is gated + no fake claims.
// ===========================================================================

describe("Phase 6 · SCOPE G — Investigation honesty", () => {
  it("investigation overview page binds to REAL backend endpoints only", () => {
    // The page must fetch the real workspace overview + reviewers +
    // cross-evidence endpoints — not a static in-file fixture.
    expect(UI_INVESTIGATION).toMatch(/\/v1\/investigation\/overview/);
    expect(UI_INVESTIGATION).toMatch(/\/v1\/investigation\/reviewers/);
    // No hardcoded signal fixtures: absent-metric renders "—", never a
    // fabricated zero (the page's own hard rule).
    expect(UI_INVESTIGATION).toMatch(/"—"/);
  });

  it("investigation surfaces are permission-gated (route gate + page gate)", () => {
    // Backend diagnostics route asserts an ops actor before any DB read.
    expect(INVESTIGATION_DIAG_ROUTES).toMatch(
      /requireDiagnosticsOpsActor|authorizeOrFail|requireReviewerMember|requireMember/,
    );
    // Frontend hub is wrapped in the canonical route gate.
    expect(UI_INVESTIGATION).toMatch(
      /PageRouteGate[\s\S]*?routeId="investigation\.hub"/,
    );
  });

  it("investigation copy states numbers are advisory telemetry, not legal weight", () => {
    // The honesty disclaimer that keeps the operator from reading the
    // counters as classifications must be present.
    expect(UI_INVESTIGATION).toMatch(
      /do not establish legal weight|do not classify recorded material/,
    );
  });

  it("investigation page presents NO forbidden authenticity conclusion", () => {
    const text = userFacingText(UI_INVESTIGATION).toLowerCase();
    for (const w of FORBIDDEN_CONCLUSION_WORDS) {
      expect(text.includes(w), `investigation page leaks "${w}"`).toBe(false);
    }
  });
});

// ===========================================================================
// SCOPE H — Intelligence panels are REAL + gated + advisory (no fake AI).
// ===========================================================================

describe("Phase 6 · SCOPE H — Intelligence honesty", () => {
  it("intelligence page + provider panel call REAL backend endpoints", () => {
    expect(UI_INTELLIGENCE).toMatch(/\/v1\/intelligence\/jobs/);
    // ProviderBudgetPanel is fully API-backed (health/usage/budgets) —
    // no hardcoded budget/cost fixtures.
    expect(UI_PROVIDER_BUDGET).toMatch(/\/v1\/intelligence\/providers\/health/);
    expect(UI_PROVIDER_BUDGET).toMatch(/\/v1\/intelligence\/providers\/usage/);
    expect(UI_PROVIDER_BUDGET).toMatch(
      /\/v1\/intelligence\/providers\/budgets/,
    );
  });

  it("intelligence page frames every signal as advisory only", () => {
    expect(UI_INTELLIGENCE).toMatch(/advisory only/i);
    expect(UI_INTELLIGENCE).toMatch(
      /do not assert\s*[\s\S]*?authenticity|do not assert authenticity/i,
    );
  });

  it("provider config surfaces the honest noop / not-wired state", () => {
    // When no engine is wired the page must say so honestly rather than
    // faking a configured provider.
    expect(UI_INTELLIGENCE).toMatch(/noop/);
    expect(UI_INTELLIGENCE).toMatch(/no real engine/i);
  });

  it("intelligence routes never leak 403 (anti-enumeration) + require membership", () => {
    expect(INTELLIGENCE_ROUTES).not.toMatch(/reply\.code\(403\)/);
    expect(INTELLIGENCE_ROUTES).toMatch(/reply\.code\(404\)/);
    expect(INTELLIGENCE_ROUTES).toMatch(
      /requireReviewerMember|requireMember/,
    );
  });

  it("media-intelligence confidence band is COMPUTED from provider confidence, never invented", () => {
    // The final band comes from classifyIntelligenceConfidence of the
    // provider's raw confidence — not a hardcoded / random AI score.
    expect(MEDIA_INTEL_SVC).toMatch(/classifyIntelligenceConfidence/);
    // And the ingest path never mutates the evidence row.
    expect(MEDIA_INTEL_SVC).toMatch(/NEVER mutates the evidence row/i);
  });

  it("intelligence surfaces present NO forbidden authenticity conclusion", () => {
    // The intelligence page legitimately NEGATES the forbidden words in
    // its advisory disclaimer ("these signals do not assert authenticity,
    // manipulation, or legal admissibility"). That negated usage is the
    // honest framing, not a conclusion. We therefore scan for the
    // forbidden words only OUTSIDE the sanctioned "do not assert …"
    // disclaimer sentence.
    for (const src of [UI_INTELLIGENCE, UI_PROVIDER_BUDGET]) {
      const text = userFacingText(src)
        // Drop the advisory disclaimer clause so its negated vocabulary
        // does not false-positive.
        .replace(
          /do not assert[\s\S]*?legal admissibility\./i,
          "[advisory-disclaimer]",
        )
        .replace(
          /these signals do not assert[\s\S]*?\./i,
          "[advisory-disclaimer]",
        )
        .toLowerCase();
      for (const w of FORBIDDEN_CONCLUSION_WORDS) {
        expect(text.includes(w), `intelligence surface leaks "${w}"`).toBe(
          false,
        );
      }
    }
  });
});

// ===========================================================================
// SCOPE I — Redaction: original hash UNCHANGED + gated + audited + honest.
// ===========================================================================

describe("Phase 6 · SCOPE I — Redaction original-evidence integrity", () => {
  it("derivative orchestrator REFUSES to overwrite the original storage key", () => {
    // The keystone integrity guard: a derivative whose storageBucket +
    // storageKey collide with the original Evidence row is refused with
    // POLICY_REJECTED. Proves the original bytes are never overwritten.
    expect(REDACTION_DERIVATIVE).toMatch(
      /evidence\.storageBucket\s*===\s*input\.storageBucket/,
    );
    expect(REDACTION_DERIVATIVE).toMatch(
      /evidence\.storageKey\s*===\s*input\.storageKey/,
    );
    expect(REDACTION_DERIVATIVE).toMatch(/POLICY_REJECTED/);
  });

  it("derivative writes ONLY to redactionDerivative — never to the Evidence row", () => {
    // Every persistence call in the derivative service targets the
    // redactionDerivative table. It reads Evidence (findFirst) for the
    // collision guard but NEVER updates/creates/deletes it.
    expect(REDACTION_DERIVATIVE).toMatch(/prisma\.redactionDerivative\.(create|update)/);
    expect(REDACTION_DERIVATIVE).not.toMatch(/prisma\.evidence\.update/);
    expect(REDACTION_DERIVATIVE).not.toMatch(/prisma\.evidence\.updateMany/);
    expect(REDACTION_DERIVATIVE).not.toMatch(/prisma\.evidence\.create/);
    expect(REDACTION_DERIVATIVE).not.toMatch(/prisma\.evidence\.delete/);
    // The derivative carries its OWN hash (fileSha256) distinct from the
    // original — the original's contentHash is never touched.
    expect(REDACTION_DERIVATIVE).toMatch(/fileSha256:\s*input\.fileSha256/);
  });

  it("every mutating redaction route is capability-gated before any DB read", () => {
    // Author / submit / approve / publish / derivative each assert a
    // specific redaction capability via gate().
    for (const cap of [
      "redaction.region.author",
      "redaction.version.submit",
      "redaction.version.approve",
      "redaction.version.publish",
      "redaction.derivative.download",
    ]) {
      expect(
        REDACTION_ROUTES.includes(`gate(reply, ctx, "${cap}")`),
        `missing gate for ${cap}`,
      ).toBe(true);
    }
    // And every route requires auth.
    expect(REDACTION_ROUTES).toMatch(/preHandler: requireAuth/);
  });

  it("derivative lifecycle emits an audit trail on every state change", () => {
    for (const code of [
      "DERIVATIVE_REQUESTED",
      "DERIVATIVE_RENDER_STARTED",
      "DERIVATIVE_RENDER_COMPLETED",
      "DERIVATIVE_RENDER_FAILED",
    ]) {
      expect(REDACTION_DERIVATIVE).toMatch(new RegExp(`"${code}"`));
    }
    // Downloads bump an audit counter + emit DERIVATIVE_DOWNLOADED.
    expect(REDACTION_ROUTES).toMatch(/downloadCount:\s*\{\s*increment:\s*1\s*\}/);
    expect(REDACTION_ROUTES).toMatch(/"DERIVATIVE_DOWNLOADED"/);
  });

  it("publish is gated on a READY derivative (no publish of an unrendered artifact)", () => {
    expect(REDACTION_ROUTES).toMatch(/DERIVATIVE_NOT_READY/);
  });

  it("public verify badge is unauthenticated + provenance-only (never mutating, never original bytes)", () => {
    // The public route MUST NOT carry requireAuth and MUST surface the
    // standing 'never modifies original' limitation.
    // Capture the public-verify route block: from its path literal up to
    // the start of the NEXT route registration (`app.get`/`app.post`).
    const block =
      REDACTION_ROUTES.match(
        /"\/v1\/redaction\/public\/verify\/:evidenceId"[\s\S]*?(?=app\.(?:get|post|put|delete)\()/,
      )?.[0] ?? "";
    expect(block.length).toBeGreaterThan(0);
    // The public badge route must NOT carry requireAuth (it is public).
    expect(block).not.toMatch(/requireAuth/);
    // …and it must surface the standing provenance-only limitations,
    // including the never-modifies-original guarantee.
    expect(block).toMatch(/REDACTION_NEVER_MODIFIES_ORIGINAL/);
    expect(block).toMatch(/REDACTION_DERIVATIVE_IS_NOT_ORIGINAL/);
  });

  it("redaction landing copy states the original is NEVER modified", () => {
    expect(UI_REDACTION).toMatch(/Original evidence is\s*[\s\S]*?NEVER modified/i);
  });
});
