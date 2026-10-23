/**
 * The outputs card's "Trusted timestamp" — one canonical wording per state,
 * never a bare "Not available" (2026-10-23).
 *
 * Not requested, pending, stamped but not validated, validated, failed and
 * service-unavailable are different facts; the facts that could not be read
 * at all are a seventh. Validation is claimed only when it happened.
 */

import { describe, it, expect } from "vitest";

import { tsaLabel } from "../../components/evidence-outputs/ArtifactTruthHeader";

const t = (status: string | null, over: Record<string, unknown> = {}) =>
  ({ status, validated: false, validatedAtUtc: null, failureCode: null, genTimeUtc: null, ...over }) as never;

describe("tsaLabel — the canonical timestamp presentation", () => {
  const cases: Array<[string, unknown, string]> = [
    ["facts could not be read", null, "Status could not be read"],
    ["never requested (no status)", t(null), "Not requested"],
    ["never requested", t("NOT_REQUESTED"), "Not requested"],
    ["pending", t("PENDING"), "Pending"],
    ["stamped, not validated", t("RECORDED_NOT_VALIDATED"), "Token recorded, not validated"],
    ["stamped without a validation time", t("STAMPED"), "Token recorded, not validated"],
    ["validated", t("STAMPED", { validated: true, validatedAtUtc: "2026-10-06T10:00:00Z" }), "Validated"],
    ["failed at the provider", t("FAILED", { failureCode: "tsa_provider_timeout" }), "Failed — no token obtained"],
    ["failed, cause unknown", t("FAILED"), "Not validated"],
    ["service unavailable", t("UNAVAILABLE"), "Timestamp service unavailable"],
  ];
  for (const [name, input, label] of cases) {
    it(`${name} → "${label}"`, () => {
      expect(tsaLabel(input as never).label).toBe(label);
    });
  }

  it("no state but a real validation is ever labelled validated or shown in the success tone", () => {
    for (const [, input] of cases) {
      const f = tsaLabel(input as never);
      if (f.label === "Validated") continue;
      expect(f.tone).not.toBe("ok");
      expect(f.status).not.toBe("VERIFIED");
    }
  });

  it("the bare 'Not available' is gone", () => {
    for (const [, input] of cases) expect(tsaLabel(input as never).label).not.toBe("Not available");
  });
});
