/**
 * Phase M3.2 — SIU governance + export persistence closure tests.
 *
 * Coverage:
 *   * New bounded enums: `SIU_CAPABILITIES`, `SIU_EXPORT_STATUSES`,
 *     `SIU_SAVED_VIEW_VISIBILITY`.
 *   * `SIU_PII_REVEAL` step-up purpose registered.
 *   * Prisma schema declares `CaseSiuSavedView`.
 *   * M3.2 migration ships under the bounded folder.
 *   * SIU capability evaluator never depends on the bounded permission
 *     enum (no `evaluateMemberAccess` call) and falls back to case
 *     owner.
 *   * SIU export bundle uploads bytes to S3 and writes `failed` on
 *     upload error.
 *   * SIU export download service streams from S3 and refuses on
 *     wrong status.
 *   * SIU routes expose the new endpoints with bounded testids in
 *     the frontend.
 *   * PII reveal uses `SIU_PII_REVEAL` and NEVER `SIU_EXPORT_GENERATE`.
 *   * Frontend renders download links + storage-key safety note.
 *   * Docs vocabulary sweep covers the new docs.
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  SIU_CAPABILITIES,
  SIU_EXPORT_STATUSES,
  SIU_FORBIDDEN_PHRASES,
  SIU_SAVED_VIEW_VISIBILITY,
} from "@proovra/shared";

// ---------------------------------------------------------------------------
// Bounded enums
// ---------------------------------------------------------------------------

describe("M3.2 — bounded enums", () => {
  it("SIU_CAPABILITIES is bounded to three values", () => {
    expect([...SIU_CAPABILITIES].sort()).toEqual(
      ["siu.pii.view", "siu.pii.edit", "siu.pii.export"].sort(),
    );
  });

  it("SIU_EXPORT_STATUSES is bounded", () => {
    expect([...SIU_EXPORT_STATUSES].sort()).toEqual(
      ["pending", "generated", "failed", "downloaded", "cancelled"].sort(),
    );
  });

  it("SIU_SAVED_VIEW_VISIBILITY is bounded", () => {
    expect([...SIU_SAVED_VIEW_VISIBILITY].sort()).toEqual(
      ["private", "team", "organization"].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// Source contracts
// ---------------------------------------------------------------------------

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
function read(rel: string): string {
  return readFileSync(REPO_ROOT + rel, "utf-8");
}
function exists(rel: string): boolean {
  return existsSync(REPO_ROOT + rel);
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

describe("M3.2 — step-up purpose", () => {
  it("registers SIU_PII_REVEAL", () => {
    const src = read("packages/shared/src/identity-security.ts");
    expect(src).toContain('"SIU_PII_REVEAL"');
  });
});

describe("M3.2 — Prisma schema + migration", () => {
  it("schema declares CaseSiuSavedView", () => {
    const schema = read("services/api/prisma/schema.prisma");
    expect(schema).toContain("model CaseSiuSavedView {");
    expect(schema).toContain("@@map(\"case_siu_saved_views\")");
  });

  it("M3.2 migration ships under the bounded folder", () => {
    const sql = read(
      "services/api/prisma/migrations/20261005000000_phase_m3_2_siu_governance_export/migration.sql",
    );
    expect(sql).toContain('CREATE TABLE "case_siu_saved_views"');
    expect(sql).toContain('"visibility" varchar(16) NOT NULL DEFAULT \'private\'');
  });
});

describe("M3.2 — SIU capability evaluator", () => {
  const src = read("services/api/src/services/siu/siu-capabilities.service.ts");

  it("returns bounded `SiuCapabilityDecision` shape", () => {
    expect(src).toContain('"case_owner_fallback"');
    expect(src).toContain('"denied_by_default"');
  });

  it("does NOT depend on the bounded permission enum yet", () => {
    // The bounded fallback path lives in the implementation today —
    // no actual import or invocation for `evaluateMemberAccess`.
    // We only allow the symbol to appear inside doc comments.
    const stripped = src
      .split("\n")
      .filter((line) => !/^\s*\*/.test(line) && !/^\s*\/\//.test(line))
      .join("\n");
    expect(stripped).not.toMatch(/evaluateMemberAccess/);
  });

  it("never claims a SIU finality determination", () => {
    assertNoForbiddenPhrases(src, "siu-capabilities.service.ts");
  });
});

describe("M3.2 — SIU saved-view service (RESTORED by capability preservation)", () => {
  // Phase 12 Tier-2 deleted the /v1/siu/saved-views family because it had
  // zero product consumers. The Phase 12 capability-preservation audit
  // REVERSED that: zero consumers is not proof of obsolescence — the
  // absent caller was the wiring defect, not evidence the capability was
  // dead. The service and its routes were restored from HEAD and are
  // tracked as MISSING_PRODUCT_CONSUMER pending product wiring, so the
  // former "stays removed" pins are obsolete and would now re-delete a
  // preserved capability.
  it("siu-saved-views.service.ts is PRESENT (restored, not resurrected by accident)", () => {
    expect(exists("services/api/src/services/siu/siu-saved-views.service.ts")).toBe(
      true,
    );
  });
});

describe("M3.2 — SIU export bundle", () => {
  const src = read("services/api/src/services/siu/siu-export-bundle.service.ts");

  it("uploads the bundle ZIP via putObjectBuffer", () => {
    expect(src).toContain("putObjectBuffer");
    expect(src).toContain('contentType: "application/zip"');
  });

  it("writes `failed` row on upload failure with bounded error code", () => {
    expect(src).toContain('"siu_export_upload_failed"');
    expect(src).toContain("finalStatus");
  });

  it("storage-key path follows the bounded convention", () => {
    expect(src).toContain('`siu-exports/${input.teamId}/${input.caseId}/');
  });

  it("download function refuses on wrong status", () => {
    expect(src).toContain("downloadSiuExportArtifact");
    expect(src).toContain("only generated or downloaded exports are retrievable");
  });

  it("never claims a SIU finality determination", () => {
    assertNoForbiddenPhrases(src, "siu-export-bundle.service.ts");
  });
});

describe("M3.2 — SIU routes", () => {
  const src = read("services/api/src/routes/siu.routes.ts");

  it("PII reveal uses SIU_PII_REVEAL and not SIU_EXPORT_GENERATE", () => {
    // Find the reveal-pii route body. The bounded purpose `SIU_PII_REVEAL`
    // must be present somewhere in the route's call site.
    expect(src).toContain('purpose: "SIU_PII_REVEAL"');
    // The reveal-pii route MUST NOT reuse `SIU_EXPORT_GENERATE`.
    const revealIdx = src.indexOf('"/v1/cases/:id/siu-profile/reveal-pii"');
    expect(revealIdx).toBeGreaterThan(0);
    const revealBlockEnd = src.indexOf("// -----", revealIdx + 100);
    const revealBlock = src.slice(
      revealIdx,
      revealBlockEnd > 0 ? revealBlockEnd : src.length,
    );
    expect(revealBlock).not.toContain('"SIU_EXPORT_GENERATE"');
  });

  // Capability preservation (see the saved-view service describe above):
  // these routes were restored from HEAD after the Tier-2 deletion was
  // reversed. They are registered and tracked as MISSING_PRODUCT_CONSUMER
  // pending product wiring — pinning them as ABSENT would re-delete a
  // preserved capability, so the pin now asserts they are PRESENT.
  it("saved-view CRUD endpoints are registered (restored capability)", () => {
    for (const path of [
      '"/v1/siu/saved-views/custom"',
      '"/v1/siu/saved-views"',
      '"/v1/siu/saved-views/:id"',
      '"/v1/siu/saved-views/:id/use"',
    ]) {
      expect(src).toContain(path);
    }
  });

  it("exposes the download endpoint", () => {
    expect(src).toContain(
      '"/v1/cases/:id/siu-exports/:exportId/download"',
    );
  });

  it("download endpoint audits with bounded action", () => {
    expect(src).toContain('"siu_export_downloaded"');
  });

  it("download endpoint NEVER returns the storage key in the response", () => {
    // The download endpoint streams the bytes via `reply.send(outcome.stream)`.
    // It MUST NOT serialise `artifactStorageKey` in any JSON branch.
    expect(src).not.toMatch(/artifactStorageKey:\s*\w+\.artifactStorageKey/);
  });
});

describe("M3.2 — frontend panel", () => {
  const src = read("apps/web/app/(app)/cases/components/SiuPanel.tsx");

  it("renders download link with bounded testid", () => {
    expect(src).toContain('data-testid="siu-export-download-link"');
  });

  it("download href targets the bounded download endpoint", () => {
    expect(src).toContain(
      "/v1/cases/${caseId}/siu-exports/${h.id}/download",
    );
  });

  it("renders the storage-safety note", () => {
    expect(src).toContain('data-testid="siu-history-storage-note"');
    expect(src).toMatch(/Storage keys are never rendered/);
  });

  it("only `generated` or `downloaded` rows show the Download link", () => {
    expect(src).toMatch(/h\.exportStatus === "generated"/);
    expect(src).toMatch(/h\.exportStatus === "downloaded"/);
  });

  it("never claims a SIU finality determination", () => {
    assertNoForbiddenPhrases(src, "SiuPanel.tsx");
  });
});

describe("M3.2 — docs vocabulary", () => {
  for (const doc of [
    "docs/verticals/insurance-siu-saved-views.md",
    "docs/verticals/phase-m3-2-siu-governance-export-closure.md",
  ]) {
    it(`${doc} never uses forbidden vocabulary`, () => {
      assertNoForbiddenPhrases(read(doc), doc);
    });
  }
});
