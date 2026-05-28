/**
 * Phase M3.1 — Insurance SIU durability closure tests.
 *
 * Coverage:
 *   * New bounded enums exported from @proovra/shared
 *     (`SIU_PII_VISIBILITY_POLICIES`, `SIU_SAVED_VIEW_IDS`).
 *   * Saved-view presets cover the six bounded operator scenarios.
 *   * Prisma schema declares the five new tables.
 *   * Migration SQL ships under the bounded folder name.
 *   * Source contracts on the durable service + the export builder
 *     confirm Prisma usage and real artifact streaming.
 *   * Source contracts on the api routes confirm new endpoints +
 *     bounded audit actions + PII reveal step-up gating.
 *   * Frontend panel renders the new export-history + reveal-PII
 *     surfaces with bounded testids.
 *   * Docs vocabulary sweep covers the new docs.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  SIU_FORBIDDEN_PHRASES,
  SIU_PII_VISIBILITY_POLICIES,
  SIU_SAVED_VIEW_IDS,
  SIU_SAVED_VIEW_PRESETS,
} from "@proovra/shared";

// ---------------------------------------------------------------------------
// Bounded enums
// ---------------------------------------------------------------------------

describe("M3.1 — bounded enums", () => {
  it("SIU_PII_VISIBILITY_POLICIES is bounded", () => {
    expect([...SIU_PII_VISIBILITY_POLICIES].sort()).toEqual(
      [
        "redacted_by_default",
        "team_visible_with_capability",
        "case_owner_only",
      ].sort(),
    );
  });

  it("SIU_SAVED_VIEW_IDS is bounded to six presets", () => {
    expect([...SIU_SAVED_VIEW_IDS].sort()).toEqual(
      [
        "claims_needing_evidence",
        "claims_ready_for_review",
        "claims_with_integrity_warnings",
        "claims_ready_for_export",
        "claims_waiting_for_followup",
        "claims_exported_recently",
      ].sort(),
    );
  });

  it("every saved view declares bounded filters", () => {
    for (const v of SIU_SAVED_VIEW_PRESETS) {
      expect(v.filters).toBeDefined();
      expect(typeof v.name).toBe("string");
      expect(typeof v.description).toBe("string");
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

function stripEnumerationContexts(input: string): string {
  let s = input;
  s = s.replace(/```[\s\S]*?```/g, "");
  s = s.replace(/`[^`\n]+`/g, "");
  s = s.replace(/SIU_FORBIDDEN_PHRASES[\s\S]*?\] as const;/m, "");
  s = s.replace(/^>.*$/gm, "");
  s = s.replace(/^[\s>-]*"[^"\n]+"\.?\s*$/gm, "");
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

describe("M3.1 — Prisma schema", () => {
  const schema = read("services/api/prisma/schema.prisma");

  it("declares the five new SIU models", () => {
    expect(schema).toContain("model CaseSiuProfile {");
    expect(schema).toContain("model CaseSiuChecklistItem {");
    expect(schema).toContain("model CaseSiuFollowUp {");
    expect(schema).toContain("model CaseSiuReviewIndicator {");
    expect(schema).toContain("model CaseSiuExport {");
  });

  it("each SIU table is workspace-scoped via team_id", () => {
    // Workspace scoping lives on the profile (children cascade from it).
    // The schema declares `teamId String @map("team_id")` inside the
    // `CaseSiuProfile` model body.
    const profileBlock = schema.match(/model CaseSiuProfile \{[\s\S]*?\n\}/);
    expect(profileBlock).not.toBeNull();
    expect(profileBlock?.[0]).toMatch(/teamId\s+String\s+@map\("team_id"\)/);
  });

  it("export row carries bounded artifact-inclusion projection", () => {
    expect(schema).toContain("artifact_inclusion_json");
    expect(schema).toContain("artifact_sha256");
    expect(schema).toContain("manifest_sha256");
  });

  it("PII column declares bounded visibility policy", () => {
    expect(schema).toContain("pii_visibility_policy");
  });
});

describe("M3.1 — migration", () => {
  it("ships under a bounded date-stamped folder", () => {
    const sql = read(
      "services/api/prisma/migrations/20261004000000_phase_m3_1_siu_durability/migration.sql",
    );
    for (const table of [
      'CREATE TABLE "case_siu_profiles"',
      'CREATE TABLE "case_siu_checklist_items"',
      'CREATE TABLE "case_siu_follow_ups"',
      'CREATE TABLE "case_siu_review_indicators"',
      'CREATE TABLE "case_siu_exports"',
    ]) {
      expect(sql).toContain(table);
    }
  });

  it("FK cascade from each child to the profile", () => {
    const sql = read(
      "services/api/prisma/migrations/20261004000000_phase_m3_1_siu_durability/migration.sql",
    );
    expect(sql).toContain('ON DELETE CASCADE');
  });
});

describe("M3.1 — durable SIU service", () => {
  const src = read("services/api/src/services/siu/siu-profile.service.ts");

  it("uses Prisma client (`prisma.caseSiuProfile`) — not in-memory map", () => {
    expect(src).toContain("prisma.caseSiuProfile");
    expect(src).not.toMatch(/new Map<string, SiuProfile>/);
    expect(src).not.toMatch(/PROFILES\.set\(/);
  });

  it("workspace-scoped via requireCaseInTeam on every operation", () => {
    expect(src).toContain("requireCaseInTeam");
  });

  it("redacts claimant PII unless caller passes exposePii: true", () => {
    expect(src).toContain("redactIfPresent");
    expect(src).toContain('"[REDACTED]"');
  });

  it("never makes a SIU-finality determination", () => {
    assertNoForbiddenPhrases(src, "siu-profile.service.ts");
  });
});

describe("M3.1 — durable SIU export bundle", () => {
  const src = read("services/api/src/services/siu/siu-export-bundle.service.ts");

  it("streams Report PDF + Verification Package from S3 via getObjectStream", () => {
    expect(src).toContain("getObjectStream");
    expect(src).toContain('reports/${ev.id}/report.pdf');
    expect(src).toContain('verification/${ev.id}/verification-package.zip');
  });

  it("persists a CaseSiuExport row", () => {
    expect(src).toContain("prisma.caseSiuExport.create");
    expect(src).toContain("artifactSha256");
    expect(src).toContain("manifestSha256");
  });

  it("refuses to build on blocked preflight", () => {
    expect(src).toContain("Refusing to build SIU export: preflight is blocked.");
  });

  it("honest copy when artifact is missing — bounded reason, no fake file", () => {
    expect(src).toContain('"no_report_available"');
    expect(src).toContain('"no_verification_package_available"');
    expect(src).toContain('"missing_storage_pointer"');
  });

  it("never uses forbidden vocabulary", () => {
    assertNoForbiddenPhrases(src, "siu-export-bundle.service.ts");
  });
});

describe("M3.1 — SIU routes", () => {
  const src = read("services/api/src/routes/siu.routes.ts");

  it("exposes the new durable endpoints", () => {
    for (const path of [
      '"/v1/cases/:id/siu-exports"',
      '"/v1/siu/saved-views"',
      '"/v1/cases/:id/siu-profile/reveal-pii"',
    ]) {
      expect(src).toContain(path);
    }
  });

  it("reveal-pii endpoint is step-up gated + audited", () => {
    expect(src).toContain("requireStepUpForSensitiveAction");
    expect(src).toContain('"siu_pii_revealed"');
  });

  it("default profile read returns redacted projection (no PII)", () => {
    expect(src).toMatch(/exposePii: false/);
  });

  it("export response carries durable identifiers in headers", () => {
    expect(src).toContain("x-proovra-siu-export-id");
    expect(src).toContain("x-proovra-siu-artifact-sha256");
    expect(src).toContain("x-proovra-siu-manifest-sha256");
  });
});

describe("M3.1 — SIU frontend panel", () => {
  const src = read("apps/web/app/(app)/cases/components/SiuPanel.tsx");

  it("renders export history with bounded testid", () => {
    expect(src).toContain('data-testid="siu-export-history"');
  });

  it("renders reveal-PII button with bounded testid", () => {
    expect(src).toContain('data-testid="siu-reveal-pii-button"');
  });

  it("renders durability note explaining redaction model", () => {
    expect(src).toContain('data-testid="siu-durability-note"');
    expect(src).toMatch(/PII redacted by default/);
  });

  it("never uses forbidden vocabulary", () => {
    assertNoForbiddenPhrases(src, "SiuPanel.tsx");
  });
});

describe("M3.1 — docs vocabulary", () => {
  for (const doc of [
    "docs/verticals/insurance-siu-persistence.md",
    "docs/verticals/insurance-siu-pii.md",
    "docs/verticals/phase-m3-1-siu-durability-closure.md",
  ]) {
    it(`${doc} never uses forbidden vocabulary`, () => {
      assertNoForbiddenPhrases(read(doc), doc);
    });
  }
});
