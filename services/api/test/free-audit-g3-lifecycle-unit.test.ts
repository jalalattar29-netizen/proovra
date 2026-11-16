/**
 * FREE-USER AUDIT 0ea0 — GROUP API-G3-LIFECYCLE, the pure pieces: the A1-06
 * terms-gate classification of the essential cancel / close / read-marker /
 * bulk trash-and-export paths. Substantive writes stay gated.
 *
 *   R1-F-08   — cancelling or closing an evidence request (it revokes the
 *               request's intake links) is open, like the direct link revoke.
 *   B2B-F-13  — the inbox read / unread / mark-all-read markers are BACKGROUND,
 *               like the mention read marker; archive and snooze stay gated.
 *   B5A-F-12  — bulk TRASH and EXPORT_METADATA_CSV are open (single trash
 *               already was); every other bulk action stays gated.
 */
import { describe, expect, it } from "vitest";

import { legalAcceptanceRequiredFor } from "../src/middleware/legal-acceptance-gate.js";

describe("A1-06 essential-path exemptions (free-audit 0ea0 G3)", () => {
  it("R1-F-08: evidence-request cancel and close are not refused for stale terms; create and send still are", () => {
    expect(legalAcceptanceRequiredFor("POST", "/v1/evidence-requests/:id/cancel")).toBe(false);
    expect(legalAcceptanceRequiredFor("POST", "/v1/evidence-requests/:id/close")).toBe(false);
    expect(legalAcceptanceRequiredFor("POST", "/v1/evidence-requests")).toBe(true);
    expect(legalAcceptanceRequiredFor("POST", "/v1/evidence-requests/:id/send")).toBe(true);
  });

  it("B2B-F-13: inbox read markers are exempt; archive, snooze and remind stay gated", () => {
    expect(legalAcceptanceRequiredFor("POST", "/v1/me/inbox/items/:itemKey/read")).toBe(false);
    expect(legalAcceptanceRequiredFor("POST", "/v1/me/inbox/items/:itemKey/unread")).toBe(false);
    expect(legalAcceptanceRequiredFor("POST", "/v1/me/inbox/mark-all-read")).toBe(false);
    expect(legalAcceptanceRequiredFor("POST", "/v1/me/inbox/items/:itemKey/archive")).toBe(true);
    expect(legalAcceptanceRequiredFor("POST", "/v1/me/inbox/items/:itemKey/snooze")).toBe(true);
    expect(legalAcceptanceRequiredFor("POST", "/v1/me/inbox/items/:itemKey/remind")).toBe(true);
  });

  it("B5A-F-12: bulk TRASH and EXPORT_METADATA_CSV pass; any other bulk action, or no body, is gated", () => {
    const bulk = "/v1/evidence/bulk";
    expect(legalAcceptanceRequiredFor("POST", bulk, { action: "TRASH", evidenceIds: ["x"] })).toBe(false);
    expect(legalAcceptanceRequiredFor("POST", bulk, { action: "EXPORT_METADATA_CSV", evidenceIds: ["x"] })).toBe(false);
    expect(legalAcceptanceRequiredFor("POST", bulk, { action: "ADD_TO_CASE", evidenceIds: ["x"] })).toBe(true);
    expect(legalAcceptanceRequiredFor("POST", bulk, { action: "ARCHIVE", evidenceIds: ["x"] })).toBe(true);
    expect(legalAcceptanceRequiredFor("POST", bulk, null)).toBe(true);
    expect(legalAcceptanceRequiredFor("POST", bulk)).toBe(true);
    // The body never widens an unrelated route.
    expect(legalAcceptanceRequiredFor("POST", "/v1/evidence", { action: "TRASH" })).toBe(true);
  });
});
