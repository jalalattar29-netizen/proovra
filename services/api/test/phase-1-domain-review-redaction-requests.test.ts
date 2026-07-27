/**
 * PHASE 1 AUTHORIZATION CLOSURE (2026-07-21) — CRITICAL domains:
 * evidence-review (review-operations), redaction (redaction-rbac), and
 * evidence-requests. Behavioral negative-conformance for the permissions
 * these surfaces authorize with, plus source-contracts that each routes
 * through the canonical primitive (or is status-aware, for the redaction
 * role resolver which uses its own bounded role model).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { assertNegativeAuthorizationConformance } from "./helpers/authorization-conformance.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const reviewSrc = readFileSync(join(SRC, "routes", "review-operations.routes.ts"), "utf8");
const requestsSrc = readFileSync(join(SRC, "routes", "evidence-requests.routes.ts"), "utf8");
const redactionSrc = readFileSync(
  join(SRC, "services", "redaction", "redaction-rbac.service.ts"),
  "utf8",
);

describe("evidence-review — evidence_request.review is authorization-closed", () => {
  assertNegativeAuthorizationConformance("evidence_request.review");
});
describe("evidence-requests — evidence.read is authorization-closed", () => {
  assertNegativeAuthorizationConformance("evidence.read");
});

describe("review-operations — source composes the canonical primitive", () => {
  it("both reviewer + admin gates route through authorizeOrFail (anti-enum)", () => {
    expect(reviewSrc).toContain("authorizeOrFail");
    expect(reviewSrc).toMatch(/antiEnumeration:\s*true/);
    expect(reviewSrc).not.toMatch(/const perm = requirePermission\(/);
  });
  it("admin gate preserves the stricter OWNER/ADMIN restriction", () => {
    expect(reviewSrc).toMatch(/membership\.role !== "OWNER" && membership\.role !== "ADMIN"/);
  });
});

describe("evidence-requests — source composes the canonical primitive", () => {
  it("requireMember routes through authorizeOrFail (anti-enum)", () => {
    expect(requestsSrc).toContain("authorizeOrFail");
    expect(requestsSrc).toMatch(/antiEnumeration:\s*true/);
    expect(requestsSrc).not.toMatch(/message:\s*"Not a member of the workspace"/);
  });

  // PHASE 1 capability precision (B): mutations are NOT gated by evidence.read.
  // The exact operation→capability assignment (each string must appear as a
  // requireMember(...) 4th arg at its call site).
  it("mutations use operation-specific evidence_request.* capabilities", () => {
    const cap = (permission: string) =>
      requestsSrc.match(
        new RegExp(
          `requireMember\\(req, reply, [^,]+,\\s*"${permission.replace(/\./g, "\\.")}"\\)`,
          "g",
        ),
      ) ?? [];
    // create/send/patch/request-more/retry → create (>= 5 sites)
    expect(cap("evidence_request.create").length).toBeGreaterThanOrEqual(5);
    // cancel / close / assign → their own capability
    expect(cap("evidence_request.cancel").length).toBeGreaterThanOrEqual(1);
    expect(cap("evidence_request.close").length).toBeGreaterThanOrEqual(1);
    expect(cap("evidence_request.assign").length).toBeGreaterThanOrEqual(1);
    // review-response / needs-more-info / waive → review (>= 3 sites)
    expect(cap("evidence_request.review").length).toBeGreaterThanOrEqual(3);
    // reads → evidence.read (list / get-one / delivery / events / queue)
    expect(cap("evidence.read").length).toBeGreaterThanOrEqual(4);
  });
});

describe("redaction-rbac — role resolver is status-aware (fail-closed)", () => {
  it("resolves NO redaction role for a non-ACTIVE membership", () => {
    expect(redactionSrc).toContain("teamMemberStatusGrantsAccess");
    expect(redactionSrc).toMatch(/select:\s*\{\s*role:\s*true,\s*status:\s*true\s*\}/);
    expect(redactionSrc).toMatch(/!teamMemberStatusGrantsAccess\(member\.status\)/);
  });
});
