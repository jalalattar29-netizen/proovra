/**
 * Phase C #17 — tests for the new forensic-semantics behavior.
 *
 * These tests are intentionally pure-function focused so they can run
 * without a database / S3 fixture. Database-backed behavior (e.g. that
 * EVIDENCE_LOCKED is not appended on no-op retention; that public verify
 * rejects pre-finalized records; that the reaper marks expired drafts) is
 * exercised end-to-end in the deployed integration suite.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  PROOVRA_FORBIDDEN_SURFACE_PATTERNS,
  PROOVRA_MULTIPART_REVIEWER_EXPLANATION,
} from "@proovra/shared-evidence-presentation";
import { sanitizePageContextPath } from "../src/services/ai/ai-chat.service.js";
import {
  buildDefaultCaptureDraftExpiry,
  CAPTURE_DRAFT_EXPIRY_DAYS,
  CAPTURE_DRAFT_EXPIRY_MS,
  sanitizeCaptureSessionItem,
} from "../src/services/capture-draft-governance.js";

function readRepoFile(...segments: string[]): string {
  return readFileSync(resolve("D:/digital-witness", ...segments), "utf8");
}

describe("ai-chat sanitizePageContextPath (Phase C #3)", () => {
  it("returns null for empty/missing input", () => {
    expect(sanitizePageContextPath(null)).toBeNull();
    expect(sanitizePageContextPath(undefined)).toBeNull();
    expect(sanitizePageContextPath("")).toBeNull();
    expect(sanitizePageContextPath("   ")).toBeNull();
  });

  it("rejects suspiciously long input", () => {
    const longPath = "/a/" + "x".repeat(300);
    expect(sanitizePageContextPath(longPath)).toBeNull();
  });

  it("redacts UUID segments to :id", () => {
    expect(
      sanitizePageContextPath(
        "/evidence/123e4567-e89b-12d3-a456-426614174000"
      )
    ).toBe("/evidence/:id");
  });

  it("redacts long hex tokens to :token", () => {
    expect(
      sanitizePageContextPath("/invite/abcdef1234567890abcdef1234567890")
    ).toBe("/invite/:token");
  });

  it("redacts other long dynamic segments to :dynamic", () => {
    expect(
      sanitizePageContextPath("/case/Long-Case-Name-That-Looks-Sensitive")
    ).toBe("/case/:dynamic");
  });

  it("preserves short, structural segments", () => {
    expect(sanitizePageContextPath("/evidence/list")).toBe("/evidence/list");
    expect(sanitizePageContextPath("/capture")).toBe("/capture");
  });
});

describe("public verify semantics (Governance Item 1)", () => {
  it("keeps meaningful verification separate from public-view analytics in API + UI", () => {
    const routeSource = readRepoFile(
      "services",
      "api",
      "src",
      "routes",
      "evidence.routes.ts"
    );
    const verifyPageSource = readRepoFile(
      "apps",
      "web",
      "app",
      "verify",
      "[token]",
      "page.tsx"
    );

    expect(routeSource).toContain("lastVerifiedAtUtc: evidence.lastVerifiedAtUtc");
    expect(routeSource).toContain("currentPublicVerifyViewAtUtc: verifiedAt");
    expect(routeSource).toContain("lastPublicVerifyViewAtUtc: verifiedAt");
    expect(routeSource).toContain('custodyEventSampled: false');
    expect(routeSource).toContain('code: "EVIDENCE_NOT_FINALIZED"');

    expect(verifyPageSource).toContain('label: "Last meaningful verification"');
    expect(verifyPageSource).toContain('label: "Last public verify page view"');
    expect(verifyPageSource).toContain('label: "Current public verify page view"');
    expect(verifyPageSource).not.toContain('label: "Last Verified At"');
  });
});

describe("capture draft governance (Governance Item 2)", () => {
  it("sanitizes draft filenames and strips raw relative paths before persistence", () => {
    const sanitized = sanitizeCaptureSessionItem(
      {
        fileName: "../../Patients/John Doe/MRI.pdf",
        relativePath: "Clients/ACME/case-123/photos/scene.jpg",
        role: "primary",
      },
      0
    );

    expect(sanitized.fileName).toBe("MRI.pdf");
    expect(sanitized.relativePath).toBe("scene.jpg");
  });

  it("exposes an explicit, changeable metadata-retention window", () => {
    const now = Date.UTC(2026, 0, 1, 0, 0, 0);
    const expiry = buildDefaultCaptureDraftExpiry(now);

    expect(CAPTURE_DRAFT_EXPIRY_DAYS).toBe(7);
    expect(CAPTURE_DRAFT_EXPIRY_MS).toBe(7 * 24 * 60 * 60 * 1000);
    expect(expiry.getTime()).toBe(now + CAPTURE_DRAFT_EXPIRY_MS);
  });

  it("shows the compact metadata-only privacy note on the capture page", () => {
    const capturePageSource = readRepoFile(
      "apps",
      "web",
      "app",
      "(app)",
      "capture",
      "page.tsx"
    );

    expect(capturePageSource).toContain(
      "Drafts save metadata only. File contents are not stored until"
    );
    expect(capturePageSource).toContain(
      "finalization, and draft metadata expires automatically."
    );
  });
});

describe("claims governance surfaces (Governance Item 3)", () => {
  it("keeps verify and evidence-detail copy inside the claims matrix boundary", () => {
    const surfaces = [
      readRepoFile("apps", "web", "app", "verify", "[token]", "page.tsx"),
      readRepoFile(
        "apps",
        "web",
        "app",
        "(app)",
        "evidence",
        "[id]",
        "page.tsx"
      ),
    ];

    for (const surface of surfaces) {
      for (const pattern of PROOVRA_FORBIDDEN_SURFACE_PATTERNS) {
        expect(surface).not.toMatch(pattern);
      }
    }
  });

  it("keeps AI policy/prompt language advisory and anti-overclaim", () => {
    const aiPolicy = readRepoFile(
      "services",
      "api",
      "src",
      "services",
      "ai",
      "ai-policy.ts"
    );
    const openAiPrompt = readRepoFile(
      "services",
      "api",
      "src",
      "services",
      "ai",
      "openai-provider.ts"
    );

    expect(aiPolicy).toContain(
      "AI assistance is advisory and does not determine factual truth, authorship, or legal admissibility."
    );
    expect(openAiPrompt).toContain(
      "Do not claim that evidence is authentic, true, authored by a specific person, admissible, accepted by a court, accepted by an insurer, or accepted by police."
    );
    expect(openAiPrompt).toContain(
      "Do not claim that PROOVRA proves factual truth, proves authorship, or guarantees legal admissibility."
    );
  });
});

describe("multipart reviewer wording (Governance Item 4)", () => {
  it("uses the shared multipart explanation on the verify and evidence-detail surfaces", () => {
    const verifyPageSource = readRepoFile(
      "apps",
      "web",
      "app",
      "verify",
      "[token]",
      "page.tsx"
    );
    const evidenceDetailSource = readRepoFile(
      "apps",
      "web",
      "app",
      "(app)",
      "evidence",
      "[id]",
      "page.tsx"
    );

    expect(verifyPageSource).toContain("PROOVRA_MULTIPART_REVIEWER_EXPLANATION");
    expect(evidenceDetailSource).toContain(
      "PROOVRA_MULTIPART_REVIEWER_EXPLANATION"
    );
  });
});
