/**
 * F-27d (Free-user audit, 2026-11-13) — Free allowance wording states the
 * RESOLVED allowance, never a hard-coded "3 records".
 *
 * The server refusal is built from the cap the decision was made on (the
 * catalog's FREE value, or a downgrade grandfather frozen above it); the
 * code-keyed client copy, which cannot know that cap, carries no number.
 */
import { describe, expect, it } from "vitest";
import { PLAN_CAPABILITIES } from "@proovra/shared-billing";
import { userFacingErrorFor } from "@proovra/shared";

import { freeLimitReachedMessage } from "../src/services/billing-enforcement.service.js";

describe("F-27d — FREE_LIMIT_REACHED wording follows the resolved allowance", () => {
  it("states the catalog's FREE allowance when that is the cap", () => {
    const published = PLAN_CAPABILITIES.FREE.maxEvidenceRecords!;
    const msg = freeLimitReachedMessage(published, 0);
    expect(msg).toContain(`the record limit included in the Free plan: ${published} records.`);
    // The phrases the integration gate pins as product copy stay.
    expect(msg).toMatch(/record limit/);
    expect(msg).toMatch(/Deleting a record does not restore a slot/);
  });

  it("states a configured / frozen allowance that differs from today's catalog value", () => {
    const msg = freeLimitReachedMessage(7, 0);
    expect(msg).toContain("Free plan: 7 records.");
    expect(msg).not.toMatch(/\b3 records\b/);
    expect(freeLimitReachedMessage(1, 0)).toContain("Free plan: 1 record.");
  });

  it("keeps the unfinished-upload clause and says nothing numeric when no cap is known", () => {
    const msg = freeLimitReachedMessage(null, 1);
    expect(msg).toMatch(/record limit included in the Free plan\. /);
    expect(msg).toMatch(/One of them is an upload that was never finished/);
  });

  it("the code-keyed client copy carries no allowance number", () => {
    const copy = userFacingErrorFor("FREE_LIMIT_REACHED");
    expect(copy?.message).toBeTruthy();
    expect(copy!.message).not.toMatch(/\d+\s+(evidence\s+)?records?/i);
    expect(copy!.message).toMatch(/Deleting a record does not restore a slot/);
  });
});
