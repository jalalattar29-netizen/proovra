/**
 * Phase HOME-CLOSURE — regression lock for the Sentry-noise bug
 *
 *   GET /v1/evidence?otsStatus=PENDING,UPGRADING,QUEUED
 *   → "Invalid otsStatus filter: UPGRADING" → 500 → Sentry
 *
 * Root cause was a contract drift between the Home priority href
 * (apps/web/components/home-experience/home-view-model.ts) and the
 * Evidence list filter allowlist (services/api/src/routes/evidence.routes.ts):
 * Home was sending a bucket value that the API didn't accept.
 *
 * This test parses both files at build time and asserts:
 *   1. Every value Home emits in a priority href is in the API
 *      allowlist for the same column.
 *   2. The parser raises AppError(VALIDATION_ERROR) (not a bare Error)
 *      so the global error handler returns HTTP 400 and the failure
 *      stays out of Sentry.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const EVIDENCE_ROUTES_SRC = readFileSync(
  resolve(__dirname, "..", "src", "routes", "evidence.routes.ts"),
  "utf8",
);
const HOME_VM_SRC = readFileSync(
  resolve(__dirname, "..", "..", "..", "apps", "web", "components", "home-experience", "home-view-model.ts"),
  "utf8",
);

/**
 * Extract the union of string literals between
 *   `const ${name} = [` ... `] as const`.
 */
function readAllowlist(src: string, name: string): string[] {
  const re = new RegExp(`const\\s+${name}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*as\\s+const`);
  const match = re.exec(src);
  expect(match, `allowlist ${name} not found in evidence.routes.ts`).toBeTruthy();
  return Array.from(match![1]!.matchAll(/"([A-Z_]+)"/g)).map((m) => m[1]!);
}

/**
 * Read the value of an exported string constant such as
 *   export const HOME_INTEGRITY_REVIEW_HREF = "/evidence?...";
 * Phase HOME-CTA-NORMALIZATION made the priority hrefs go through
 * shared constants, so we follow the constant instead of trying to
 * read the literal from each priority block.
 */
function readHrefConstant(src: string, name: string): string {
  const re = new RegExp(`export\\s+const\\s+${name}\\s*=\\s*"([^"]+)"`);
  const match = re.exec(src);
  expect(match, `${name} constant not found in home-view-model.ts`).toBeTruthy();
  return match![1]!;
}

/** Parse a "/evidence?param=A,B,C" href into `{param, values}`. */
function splitHref(href: string): { param: string; values: string[] } {
  const q = href.split("?")[1] ?? "";
  const [param, raw] = q.split("=");
  return {
    param: param ?? "",
    values: (raw ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

/**
 * Verify the priority's source block in home-view-model.ts uses the
 * shared constant (not a re-introduced literal). This locks the
 * "single source of truth" property so a future drift fails CI.
 */
function assertPriorityUsesConstant(src: string, key: string, constantName: string): void {
  const blockRe = new RegExp(`key:\\s*"${key}"[\\s\\S]{0,1500}?href:\\s*([A-Za-z_]+)`);
  const match = blockRe.exec(src);
  expect(match, `priority block for ${key} not found`).toBeTruthy();
  expect(match![1], `priority ${key} must use the ${constantName} constant`).toBe(constantName);
}

describe("Home priority hrefs must use values the Evidence filter accepts", () => {
  const allowlists = {
    tsaStatus: readAllowlist(EVIDENCE_ROUTES_SRC, "EVIDENCE_TSA_STATUSES"),
    otsStatus: readAllowlist(EVIDENCE_ROUTES_SRC, "EVIDENCE_OTS_STATUSES"),
    publicVerifyState: readAllowlist(EVIDENCE_ROUTES_SRC, "PUBLIC_VERIFY_STATES"),
    verificationStatus: readAllowlist(EVIDENCE_ROUTES_SRC, "VERIFICATION_STATUSES"),
  };

  it("EVIDENCE_OTS_STATUSES contains every value the trust-summary `pending` bucket inputs", () => {
    // trust-summary.service.ts:71 — pending bucket = PENDING|UPGRADING|QUEUED
    expect(allowlists.otsStatus).toContain("PENDING");
    expect(allowlists.otsStatus).toContain("UPGRADING");
    expect(allowlists.otsStatus).toContain("QUEUED");
  });

  it("EVIDENCE_TSA_STATUSES contains every value the trust-summary `failed` bucket inputs", () => {
    // trust-summary.service.ts:64 — failed bucket = FAILED|REJECTED|ERROR
    expect(allowlists.tsaStatus).toContain("FAILED");
    expect(allowlists.tsaStatus).toContain("REJECTED");
    expect(allowlists.tsaStatus).toContain("ERROR");
  });

  it("HOME_OTS_PENDING_HREF emits only values in EVIDENCE_OTS_STATUSES (Sentry-noise regression lock)", () => {
    const { param, values } = splitHref(readHrefConstant(HOME_VM_SRC, "HOME_OTS_PENDING_HREF"));
    expect(param).toBe("otsStatus");
    expect(values.length).toBeGreaterThan(0);
    for (const v of values) {
      expect(allowlists.otsStatus, `HOME_OTS_PENDING_HREF value ${v} must be in EVIDENCE_OTS_STATUSES`).toContain(v);
    }
    assertPriorityUsesConstant(HOME_VM_SRC, "ots_pending", "HOME_OTS_PENDING_HREF");
  });

  it("HOME_TSA_FAILURES_HREF emits only values in EVIDENCE_TSA_STATUSES", () => {
    const { param, values } = splitHref(readHrefConstant(HOME_VM_SRC, "HOME_TSA_FAILURES_HREF"));
    expect(param).toBe("tsaStatus");
    for (const v of values) {
      expect(allowlists.tsaStatus, `HOME_TSA_FAILURES_HREF value ${v} must be in EVIDENCE_TSA_STATUSES`).toContain(v);
    }
    assertPriorityUsesConstant(HOME_VM_SRC, "tsa_failures", "HOME_TSA_FAILURES_HREF");
  });

  it("HOME_PUBLISH_VERIFICATION_HREF emits only values in PUBLIC_VERIFY_STATES", () => {
    const { param, values } = splitHref(readHrefConstant(HOME_VM_SRC, "HOME_PUBLISH_VERIFICATION_HREF"));
    expect(param).toBe("publicVerifyState");
    for (const v of values) {
      expect(allowlists.publicVerifyState, `HOME_PUBLISH_VERIFICATION_HREF value ${v} must be in PUBLIC_VERIFY_STATES`).toContain(v);
    }
    assertPriorityUsesConstant(HOME_VM_SRC, "publish_verification", "HOME_PUBLISH_VERIFICATION_HREF");
  });

  it("HOME_INTEGRITY_REVIEW_HREF emits only values in VERIFICATION_STATUSES (and the priority uses the constant)", () => {
    const { param, values } = splitHref(readHrefConstant(HOME_VM_SRC, "HOME_INTEGRITY_REVIEW_HREF"));
    expect(param).toBe("verificationStatus");
    for (const v of values) {
      expect(allowlists.verificationStatus, `HOME_INTEGRITY_REVIEW_HREF value ${v} must be in VERIFICATION_STATUSES`).toContain(v);
    }
    assertPriorityUsesConstant(HOME_VM_SRC, "resolve_integrity", "HOME_INTEGRITY_REVIEW_HREF");
  });

  it("HOME_INTEGRITY_REVIEW_HREF must NEVER again use ?status=uploaded (wrong column!)", () => {
    // Original bug: integrity count came from verificationStatus IN (REVIEW_REQUIRED,FAILED)
    // but the href filtered Evidence.status. This lock prevents regression.
    const integrityHref = readHrefConstant(HOME_VM_SRC, "HOME_INTEGRITY_REVIEW_HREF");
    expect(integrityHref).not.toContain("status=uploaded");
    expect(integrityHref).not.toContain("status=UPLOADED");
  });

  it("parseEvidenceMultiEnumFilter throws AppError(VALIDATION_ERROR) — so invalid filter values return HTTP 400, not 500 (Sentry)", () => {
    // Locks the import + the throw form. Returning a bare Error here
    // means the global error handler hits captureException + 500.
    expect(EVIDENCE_ROUTES_SRC).toMatch(/import\s+\{[^}]*AppError[^}]*,[^}]*ErrorCode[^}]*\}\s+from\s+"\.\.\/errors\.js"/);
    expect(EVIDENCE_ROUTES_SRC).toMatch(
      /parseEvidenceMultiEnumFilter[\s\S]*?throw\s+new\s+AppError\(\s*ErrorCode\.VALIDATION_ERROR/,
    );
  });
});
