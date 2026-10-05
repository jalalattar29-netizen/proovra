/**
 * EVIDENCE-OUTPUT INCIDENT (2026-10-05) — what a SIGNED, unreported record in
 * a Personal Space told its owner, pinned to the truth.
 *
 *   * "Public verification not configured" came from `Boolean(ANCHOR_PROVIDER)`
 *     — an unrelated external-anchor setting — not from anything about Public
 *     Verify, a share link or the record.
 *   * The library's protected/needs-review counters used "any lock column
 *     non-null", disagreeing with the record's own classification.
 *   * TSA_ENABLED had two readers with different rules.
 *   * The "not included" copy spoke of the RECORD's plan; eligibility is the
 *     workspace's current plan.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  isTsaEnabled,
  tsaTrustConfigurationIssues,
} from "../src/services/timestamp/validate-tsa-token.js";

const ROOT = resolve(__dirname, "..", "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const ROUTES = read("services/api/src/routes/evidence.routes.ts");

function fn(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  expect(start, `${name} not found`).toBeGreaterThan(-1);
  const next = src.indexOf("\nfunction ", start + 10);
  const nextAsync = src.indexOf("\nasync function ", start + 10);
  const ends = [next, nextAsync].filter((i) => i > 0);
  return src.slice(start, ends.length ? Math.min(...ends) : undefined);
}

describe("public verification — a fact about the record, not about ANCHOR_PROVIDER", () => {
  const builder = code(fn(ROUTES, "buildPublicVerificationSummaryBase"));

  it("availability no longer reads the external-anchor provider", () => {
    expect(builder).not.toMatch(/params\.anchor\.configured/);
    expect(builder).toMatch(/const configured = true;/);
    expect(builder).toMatch(/This record is private\. Publish it, or create a share link/);
    expect(builder).not.toMatch(/no published verification record is configured/);
  });

  it("the review alert for an unpublished record is informational and never says 'not configured'", () => {
    const routeCode = code(ROUTES);
    expect(routeCode).not.toMatch(/label: "Public verification not configured"/);
    expect(routeCode).toMatch(
      /case "NOT_CONFIGURED":\s*case "CONFIGURED_NOT_PUBLISHED":\s*operationalAlerts\.push\(\{\s*severity: "info" as const,\s*label: "Not published for public verification"/,
    );
  });

  it("the web labels both unpublished states the same truthful way", () => {
    const lib = read("apps/web/app/(app)/evidence/[id]/_tabs/_lib.tsx");
    expect(lib).toMatch(/case "NOT_CONFIGURED":\s*case "CONFIGURED_NOT_PUBLISHED":\s*return \{\s*label: "Not published"/);
    expect(code(lib)).not.toMatch(/publishable verification surface configured/);
  });
});

describe("storage protection — the library counters use the ONE classification", () => {
  const routeCode = code(ROUTES);

  it("protected = retention in force or a legal hold ON; needs-review is its NULL-safe complement", () => {
    expect(routeCode).toMatch(
      /STORAGE_PROTECTED_PREDICATE[\s\S]{0,400}storageObjectLockMode: \{ in: \["COMPLIANCE", "GOVERNANCE"\] \}[\s\S]{0,120}storageObjectLockRetainUntilUtc: \{ gt: storageNow \}[\s\S]{0,120}storageObjectLockLegalHoldStatus: "ON"/,
    );
    const review = routeCode.slice(routeCode.indexOf("STORAGE_NEEDS_REVIEW_PREDICATE"), routeCode.indexOf("MULTIPART_PREDICATE"));
    for (const clause of [
      "{ storageObjectLockMode: null }",
      '{ storageObjectLockMode: { notIn: ["COMPLIANCE", "GOVERNANCE"] } }',
      "{ storageObjectLockRetainUntilUtc: null }",
      "{ storageObjectLockRetainUntilUtc: { lte: storageNow } }",
      "{ storageObjectLockLegalHoldStatus: null }",
      '{ storageObjectLockLegalHoldStatus: { not: "ON" } }',
    ]) {
      expect(review).toContain(clause);
    }
  });

  it("every summary builder carries the classification, and a failed read is UNCONFIRMED", () => {
    const summary = code(fn(ROUTES, "getStorageProtectionSummary"));
    expect(summary.match(/protection: classifyStorageProtection\(/g)?.length).toBe(2);
    expect(summary).toMatch(/readFailed: true,\s*protection: "UNCONFIRMED"/);
    expect(code(fn(ROUTES, "getStorageProtectionSummaryFromSnapshot"))).toMatch(/protection: classifyStorageProtection\(/);
    expect(code(fn(ROUTES, "mapStorageStatusLabel"))).not.toMatch(/storage\.verified/);
  });

  it("no web surface reads `verified` as protection", () => {
    for (const p of ["apps/web/app/(app)/evidence/page.tsx", "apps/web/app/(app)/evidence/[id]/_tabs/EvidenceIntegrityTab.tsx"]) {
      expect(code(read(p)), p).not.toMatch(/storage\?\.verified/);
    }
  });
});

describe("TSA_ENABLED — one reader", () => {
  it("true and 1, trimmed and case-insensitive, enable; anything else does not", () => {
    for (const v of ["true", "TRUE", " true ", "1"]) expect(isTsaEnabled({ TSA_ENABLED: v }), v).toBe(true);
    for (const v of [undefined, "", "false", "0", "yes"]) expect(isTsaEnabled({ TSA_ENABLED: v }), String(v)).toBe(false);
  });

  it("readiness and the timestamp service agree: an enabled TSA with no trust anchor is reported, a disabled one is not", async () => {
    expect(await tsaTrustConfigurationIssues({ TSA_ENABLED: "1" })).toContain("tsa_trust_bundle_path_not_set");
    expect(await tsaTrustConfigurationIssues({ TSA_ENABLED: " true " })).toContain("tsa_trust_bundle_path_not_set");
    expect(await tsaTrustConfigurationIssues({ TSA_ENABLED: "false" })).toEqual([]);
    const service = code(read("services/api/src/services/timestamp.service.ts"));
    expect(service).toMatch(/function enabled\(\): boolean \{\s*return isTsaEnabled\(process\.env\);/);
    expect(service).not.toMatch(/TSA_ENABLED/);
  });
});

describe("'not included' copy names the WORKSPACE's current plan, identically everywhere", () => {
  it("download reason (web + mobile) and generation outcome (API + web + mobile)", () => {
    const reason = "reports are not included in this workspace's current plan";
    expect(read("apps/web/app/(app)/evidence/[id]/_tabs/_lib.tsx")).toContain(reason);
    expect(read("apps/mobile/src/product/evidence-record.ts")).toContain(reason);
    const outcome =
      "Reports and verification packages are not issued for this evidence record: they are not included in this workspace's current plan. The original evidence remains finalized and verifiable.";
    for (const p of [
      "services/api/src/routes/evidence.routes.ts",
      "apps/web/lib/evidence/generation-outcome.ts",
      "apps/mobile/src/product/evidence-detail.ts",
    ]) {
      expect(read(p), p).toContain(outcome);
      expect(read(p), p).not.toMatch(/under its current plan/);
    }
  });
});

describe("TSA trust — the validating service can actually read a bundle", () => {
  it("proovra-api mounts the bundle directory read-only and points TSA_TRUST_BUNDLE_PATH into it", () => {
    const compose = read("infra/docker/docker-compose.prod.yml");
    const api = compose.slice(compose.indexOf("\n  proovra-api:\n"), compose.indexOf("\n  proovra-worker:\n"));
    expect(api).toMatch(/\n {6}TSA_TRUST_BUNDLE_PATH: \/run\/proovra\/tsa\/trust-bundle\.pem\n/);
    expect(api).toMatch(/\n {4}volumes:\n {6}- \/opt\/proovra\/app\/secrets\/tsa:\/run\/proovra\/tsa:ro\n/);
    // No certificate or key material is committed: the compose file names a
    // host path only.
    expect(compose).not.toMatch(/BEGIN CERTIFICATE|BEGIN .*PRIVATE KEY/);
  });
});
