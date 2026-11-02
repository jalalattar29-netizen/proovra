/**
 * OPS-003 — every name in an example env file has a reader, or a stated reason.
 */
import { describe, expect, it } from "vitest";

// @ts-expect-error -- plain script, no declaration file.
import { exampleKeys, loadAllowance, unreadKeys } from "../../../scripts/ci/env-contract.mjs";

describe("env contract", () => {
  it("no example file names a variable nothing reads", () => {
    expect(unreadKeys()).toEqual([]);
  }, 60_000);

  it("the check can fail: a name no code reads is not in any example", () => {
    const keys = exampleKeys() as Map<string, string>;
    expect(keys.size).toBeGreaterThan(50);
    for (const dead of ["LOG_AGGREGATION_ENABLED", "COMMUNICATIONS_WEBHOOK_SECRET", "SSO_ENABLED", "REVIEWER_OPS_ENABLED"]) {
      expect(keys.has(dead), dead).toBe(false);
    }
  });

  it("each allowance states where the name is built", () => {
    for (const reason of Object.values(loadAllowance() as Record<string, string>)) {
      expect(reason).toMatch(/\.ts/);
    }
  });
});
