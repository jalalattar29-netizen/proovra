/**
 * FREE per-record output authority — Evidence Detail's output flags come from
 * the RECORD's eligibility, and fail closed (UNRESOLVED) when it cannot be
 * resolved. They never fall back to the plan, whose FREE row includes reports.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import * as sharedBilling from "@proovra/shared-billing";
import { getPlanCapabilities } from "@proovra/shared-billing";
import { describe, expect, it } from "vitest";

import * as eligibility from "../src/services/billing/evidence-output-eligibility.service.js";
import { recordOutputFlags } from "../src/services/billing/evidence-output-eligibility.service.js";
import * as planCatalog from "../src/services/plan-catalog.service.js";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("recordOutputFlags", () => {
  it("an UNRESOLVED record offers no per-record output — even on a plan that includes them", () => {
    const free = getPlanCapabilities("FREE");
    expect(free.reportsIncluded).toBe(true); // the plan row would have granted it
    expect(recordOutputFlags(null, free)).toEqual({
      recordOutputEligibility: "UNRESOLVED",
      reportsIncluded: false,
      verificationPackageIncluded: false,
      publicVerifyIncluded: true,
    });
  });

  it("a resolved record is served exactly its own answer", () => {
    const free = getPlanCapabilities("FREE");
    expect(
      recordOutputFlags(
        { reportsIncluded: false, verificationPackageIncluded: false, publicVerifyIncluded: true },
        free,
      ),
    ).toEqual({
      recordOutputEligibility: "RESOLVED",
      reportsIncluded: false,
      verificationPackageIncluded: false,
      publicVerifyIncluded: true,
    });
    expect(
      recordOutputFlags(
        { reportsIncluded: true, verificationPackageIncluded: true, publicVerifyIncluded: true },
        free,
      ).reportsIncluded,
    ).toBe(true);
  });

  it("Evidence Detail composes its flags through recordOutputFlags, with no plan fallback", () => {
    const route = read("../src/routes/evidence.routes.ts");
    expect(route).toContain("...recordOutputFlags(recordEligibility, caps)");
    expect(route).not.toMatch(/recordEligibility\?\.reportsIncluded\s*\?\?/);
    expect(route).not.toMatch(/recordEligibility\?\.verificationPackageIncluded\s*\?\?/);
  });
});

describe("no plan-only helper can answer a per-record question", () => {
  it("the plan-only predicates are gone from every export surface", () => {
    expect("canPlanGenerateReports" in sharedBilling).toBe(false);
    expect("canPlanGenerateVerificationPackage" in sharedBilling).toBe(false);
    expect("canPlanGenerateReports" in planCatalog).toBe(false);
    expect("canPlanGenerateVerificationPackage" in planCatalog).toBe(false);
    expect("planIncludesReports" in eligibility).toBe(false);
  });
});
