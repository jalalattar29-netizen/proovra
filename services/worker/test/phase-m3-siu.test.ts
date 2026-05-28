/**
 * Phase M3 — Insurance SIU bundle closure tests.
 *
 * Coverage:
 *   * Bounded SIU enums exported from @proovra/shared.
 *   * Intake templates are bounded + claim-type-keyed.
 *   * Forbidden phrases are NEVER present in any SIU module / docs.
 *   * Source contracts on the api service / routes / worker side / UI.
 *   * Export bundle builder file inventory + manifest.
 *   * Step-up purpose `SIU_EXPORT_GENERATE` registered.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  SIU_CLAIM_TYPES,
  SIU_CHECKLIST_ITEM_STATUSES,
  SIU_EXPORT_READINESS_STATES,
  SIU_FOLLOW_UP_STATUSES,
  SIU_FORBIDDEN_PHRASES,
  SIU_INTAKE_TEMPLATES,
  SIU_INVESTIGATION_STATUSES,
  SIU_PREFLIGHT_CODES,
  SIU_REVIEW_INDICATOR_CODES,
  SIU_STANDING_LIMITATIONS,
  buildEmptySiuChecklist,
  getSiuIntakeTemplate,
} from "@proovra/shared";

// ---------------------------------------------------------------------------
// Bounded enums
// ---------------------------------------------------------------------------

describe("M3 — bounded enums", () => {
  it("SIU_CLAIM_TYPES is bounded", () => {
    expect([...SIU_CLAIM_TYPES].sort()).toEqual(
      [
        "auto",
        "property",
        "injury",
        "liability",
        "travel",
        "cyber",
        "other",
      ].sort(),
    );
  });
  it("SIU_INVESTIGATION_STATUSES is bounded", () => {
    expect([...SIU_INVESTIGATION_STATUSES].sort()).toEqual(
      [
        "intake",
        "collecting",
        "review",
        "follow_up",
        "export_ready",
        "exported",
        "closed",
      ].sort(),
    );
  });
  it("SIU_CHECKLIST_ITEM_STATUSES is bounded", () => {
    expect([...SIU_CHECKLIST_ITEM_STATUSES].sort()).toEqual(
      ["missing", "submitted", "mapped", "satisfied", "waived"].sort(),
    );
  });
  it("SIU_FOLLOW_UP_STATUSES is bounded", () => {
    expect([...SIU_FOLLOW_UP_STATUSES].sort()).toEqual(
      [
        "open",
        "sent",
        "received",
        "satisfied",
        "expired",
        "cancelled",
      ].sort(),
    );
  });
  it("SIU_EXPORT_READINESS_STATES is bounded", () => {
    expect([...SIU_EXPORT_READINESS_STATES].sort()).toEqual(
      ["ready", "ready_with_warnings", "blocked", "unavailable"].sort(),
    );
  });
  it("SIU_PREFLIGHT_CODES include all documented codes", () => {
    for (const code of [
      "REQUIRED_EVIDENCE_MISSING",
      "REPORT_PDF_MISSING",
      "VERIFICATION_PACKAGE_MISSING",
      "C2PA_DEGRADED",
      "CORE_INTEGRITY_WARNING_PRESENT",
      "FOLLOW_UP_INCOMPLETE",
      "OFFLINE_VERIFICATION_UNSUPPORTED_FOR_PACKAGE",
      "CUSTODY_AUDIT_GAP",
      "LEGAL_HOLD_EXPORT_BLOCK",
      "RETENTION_POLICY_BLOCK",
      "EVIDENCE_INTEGRITY_FAILED",
      "TENANT_OUT_OF_SCOPE",
    ]) {
      expect(SIU_PREFLIGHT_CODES).toContain(code);
    }
  });
  it("SIU_STANDING_LIMITATIONS include the 7 bounded codes", () => {
    expect(SIU_STANDING_LIMITATIONS.length).toBe(7);
    expect(SIU_STANDING_LIMITATIONS).toContain(
      "SIU_BUNDLE_IS_NOT_A_FRAUD_DETERMINATION",
    );
    expect(SIU_STANDING_LIMITATIONS).toContain(
      "REVIEW_INDICATORS_ARE_OPERATIONAL_SIGNALS_NOT_FINDINGS",
    );
  });
  it("SIU_REVIEW_INDICATOR_CODES never use fraud-finding language", () => {
    for (const code of SIU_REVIEW_INDICATOR_CODES) {
      expect(code.toLowerCase()).not.toMatch(/fraud/);
      expect(code.toLowerCase()).not.toMatch(/fake/);
      expect(code.toLowerCase()).not.toMatch(/guilty/);
    }
  });
});

// ---------------------------------------------------------------------------
// Intake templates
// ---------------------------------------------------------------------------

describe("M3 — intake templates", () => {
  it("four bounded templates exist", () => {
    expect(SIU_INTAKE_TEMPLATES.map((t) => t.id).sort()).toEqual(
      [
        "insurance-auto-claim",
        "insurance-property-claim",
        "insurance-injury-liability-claim",
        "insurance-cyber-incident-claim",
      ].sort(),
    );
  });
  it("each template has required items", () => {
    for (const t of SIU_INTAKE_TEMPLATES) {
      expect(t.items.length).toBeGreaterThan(0);
      expect(t.items.some((i) => i.required)).toBe(true);
    }
  });
  it("getSiuIntakeTemplate resolves bounded ids", () => {
    const tpl = getSiuIntakeTemplate("insurance-auto-claim");
    expect(tpl.claimType).toBe("auto");
    expect(tpl.items.some((i) => i.itemId === "vehicle_damage_closeups")).toBe(
      true,
    );
  });
  it("buildEmptySiuChecklist initializes every item as `missing`", () => {
    const tpl = getSiuIntakeTemplate("insurance-property-claim");
    const checklist = buildEmptySiuChecklist(tpl);
    expect(checklist.length).toBe(tpl.items.length);
    for (const item of checklist) {
      expect(item.status).toBe("missing");
      expect(item.mappedEvidenceIds.length).toBe(0);
    }
  });
  it("template descriptions never use forbidden vocabulary", () => {
    for (const t of SIU_INTAKE_TEMPLATES) {
      const haystack = `${t.name} ${t.description} ${t.items
        .map((i) => `${i.label} ${i.purpose}`)
        .join(" ")}`.toLowerCase();
      for (const phrase of SIU_FORBIDDEN_PHRASES) {
        expect(haystack.includes(phrase.toLowerCase())).toBe(false);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Source contracts
// ---------------------------------------------------------------------------

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
function read(rel: string): string {
  return readFileSync(REPO_ROOT + rel, "utf-8");
}

/**
 * Strip "explicit enumeration" contexts where the docs / source
 * legitimately quote the forbidden corpus to define it (e.g. the
 * `SIU_FORBIDDEN_PHRASES` array, markdown bullet lists naming the
 * banned phrases, inline code spans). We sweep the remaining
 * free-form prose only.
 *
 * Bounded preprocessing:
 *   * Strip fenced code blocks (```...```).
 *   * Strip inline code spans (`...`).
 *   * Strip markdown bullet items that wholly consist of a quoted /
 *     code-like banned phrase.
 *   * Strip the `SIU_FORBIDDEN_PHRASES` array literal.
 */
function stripEnumerationContexts(input: string): string {
  let s = input;
  // Fenced code blocks.
  s = s.replace(/```[\s\S]*?```/g, "");
  // Inline code spans.
  s = s.replace(/`[^`\n]+`/g, "");
  // The bounded enum literal.
  s = s.replace(/SIU_FORBIDDEN_PHRASES[\s\S]*?\] as const;/m, "");
  // Markdown block-quote lines (literal spec re-quotes). These
  // legitimately contain the bounded vocabulary as part of the spec
  // they negate; we sweep only PROOVRA's own prose, not the input
  // spec.
  s = s.replace(/^>.*$/gm, "");
  // Bullet list items that are wholly a quoted phrase (markdown
  // negative-list usage, e.g. `- "fraud detected"`).
  s = s.replace(/^[\s>-]*"[^"\n]+"\.?\s*$/gm, "");
  // Comma-separated quoted phrases in negation prose like
  // 'words like "fraud detected", "fake evidence", "guilty", ...'
  s = s.replace(/"[^"\n]+"/g, "");
  return s;
}

function assertNoForbiddenPhrases(haystack: string, label: string) {
  const swept = stripEnumerationContexts(haystack).toLowerCase();
  for (const phrase of SIU_FORBIDDEN_PHRASES) {
    if (swept.includes(phrase.toLowerCase())) {
      throw new Error(
        `${label} contains forbidden phrase "${phrase}" outside an enumeration / code-span context. Refactor before shipping.`,
      );
    }
  }
}

describe("M3 — shared module source contract", () => {
  it("insurance-siu.ts never uses fraud vocabulary in copy", () => {
    const src = read("packages/shared/src/insurance-siu.ts");
    // We intentionally allow `SIU_FORBIDDEN_PHRASES` to define the
    // bounded array of forbidden words for source-contract sweeps.
    // Strip the array literal before sweeping so the test itself does
    // not collide with the forbidden corpus.
    const stripped = src.replace(
      /SIU_FORBIDDEN_PHRASES[\s\S]*?\] as const;/m,
      "",
    );
    assertNoForbiddenPhrases(stripped, "insurance-siu.ts (outside the bounded enum)");
  });

  it("identity-security.ts registers SIU_EXPORT_GENERATE step-up purpose", () => {
    const src = read("packages/shared/src/identity-security.ts");
    expect(src).toContain('"SIU_EXPORT_GENERATE"');
  });
});

describe("M3 — api SIU service source contract", () => {
  it("siu-profile.service.ts is workspace-scoped", () => {
    const src = read(
      "services/api/src/services/siu/siu-profile.service.ts",
    );
    expect(src).toContain("requireCaseInTeam");
    expect(src).not.toMatch(/fraud/i);
  });

  it("siu-preflight.service.ts blocks on legal hold + hash mismatch", () => {
    const src = read(
      "services/api/src/services/siu/siu-preflight.service.ts",
    );
    expect(src).toContain("LEGAL_HOLD_EXPORT_BLOCK");
    expect(src).toContain("EVIDENCE_INTEGRITY_FAILED");
    // The bounded preflight surfaces C2PA only as a warning, never
    // as a blocker on its own.
    expect(src).toContain('warning("C2PA_DEGRADED"');
    expect(src).not.toMatch(/blocker\("C2PA_DEGRADED"/);
    assertNoForbiddenPhrases(src, "siu-preflight.service.ts");
  });

  it("siu-export-bundle.service.ts refuses to build on blocked preflight", () => {
    const src = read(
      "services/api/src/services/siu/siu-export-bundle.service.ts",
    );
    expect(src).toContain("Refusing to build SIU export: preflight is blocked.");
    expect(src).toContain(
      "Refusing to build SIU export: ready_with_warnings requires a bounded reason.",
    );
    expect(src).toContain('"siu-summary.json"');
    expect(src).toContain('"manifest.json"');
    expect(src).toContain('"claim-timeline.json"');
    expect(src).toContain('"evidence-checklist.json"');
    expect(src).toContain('"review-indicators.json"');
    expect(src).toContain('"follow-ups.json"');
    expect(src).toContain('"verification/offline-verification.md"');
    assertNoForbiddenPhrases(src, "siu-export-bundle.service.ts");
  });

  it("siu.routes.ts exposes the documented endpoints", () => {
    const src = read("services/api/src/routes/siu.routes.ts");
    for (const path of [
      '"/v1/cases/:id/siu-profile"',
      '"/v1/cases/:id/siu-profile/checklist/:itemId/map-evidence"',
      '"/v1/cases/:id/siu-profile/checklist/:itemId/status"',
      '"/v1/cases/:id/siu-profile/indicators"',
      '"/v1/cases/:id/siu-profile/follow-ups"',
      '"/v1/cases/:id/siu-profile/follow-ups/:followUpId/status"',
      '"/v1/cases/:id/siu-export/preflight"',
      '"/v1/cases/:id/siu-export"',
      '"/v1/siu/intake-templates"',
    ]) {
      expect(src).toContain(path);
    }
  });

  it("siu.routes.ts gates SIU export under SIU_EXPORT_GENERATE step-up", () => {
    const src = read("services/api/src/routes/siu.routes.ts");
    expect(src).toContain("SIU_EXPORT_GENERATE");
    expect(src).toContain("requireStepUpForSensitiveAction");
  });

  it("siu.routes.ts records bounded audit events", () => {
    const src = read("services/api/src/routes/siu.routes.ts");
    for (const action of [
      "siu_profile_updated",
      "siu_review_indicator_added",
      "siu_follow_up_requested",
      "siu_follow_up_received",
      "siu_export_preflight_run",
      "siu_export_blocked",
      "siu_export_generated",
    ]) {
      expect(src).toContain(action);
    }
  });
});

describe("M3 — frontend panel source contract", () => {
  const src = read("apps/web/app/(app)/cases/components/SiuPanel.tsx");

  it("panel has bounded testids for every key region", () => {
    for (const tid of [
      'data-testid="siu-panel"',
      'data-testid="siu-profile-summary"',
      'data-testid="siu-checklist"',
      'data-testid="siu-preflight-button"',
      'data-testid="siu-export-button"',
    ]) {
      expect(src).toContain(tid);
    }
  });

  it("panel renders the standing caption + bounded limitation codes", () => {
    expect(src).toMatch(/operational signals/i);
    expect(src).toContain("SIU_BUNDLE_IS_NOT_A_FRAUD_DETERMINATION");
    expect(src).toContain("REVIEW_INDICATORS_ARE_OPERATIONAL_SIGNALS_NOT_FINDINGS");
  });

  it("panel never uses forbidden vocabulary", () => {
    assertNoForbiddenPhrases(src, "SiuPanel.tsx");
  });
});

// ---------------------------------------------------------------------------
// Docs vocabulary sweep
// ---------------------------------------------------------------------------

describe("M3 — docs vocabulary", () => {
  for (const doc of [
    "docs/verticals/insurance-siu.md",
    "docs/verticals/insurance-siu-export-format.md",
    "docs/verticals/insurance-siu-workflows.md",
    "docs/public/insurance-evidence-guide.md",
    "docs/verticals/phase-m3-insurance-siu-closure.md",
  ]) {
    it(`${doc} never uses forbidden vocabulary`, () => {
      const content = read(doc);
      assertNoForbiddenPhrases(content, doc);
    });
  }
});
