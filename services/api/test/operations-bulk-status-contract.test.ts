/**
 * OPS-011 — the bulk-action item status vocabulary is ONE contract.
 *
 * The web counted "SUCCEEDED" items while the runner wrote COMPLETED, so every
 * successful sweep read as a failure. Both clients now read
 * `BULK_ACTION_ITEM_STATUSES` / `bulkActionItemSucceeded` from
 * `@proovra/shared`; this pins that list to the database enum the runner
 * writes, so the two cannot drift apart again.
 */
import * as prismaPkg from "@prisma/client";
import { BULK_ACTION_ITEM_STATUSES, bulkActionItemSucceeded } from "@proovra/shared";
import { describe, expect, it } from "vitest";

describe("OPS-011 — bulk item status contract", () => {
  it("the shared list is exactly the database enum", () => {
    expect([...BULK_ACTION_ITEM_STATUSES].sort()).toEqual(
      Object.values(prismaPkg.BulkOperationalActionItemStatus).sort(),
    );
  });

  it("only COMPLETED counts as applied", () => {
    expect(bulkActionItemSucceeded(prismaPkg.BulkOperationalActionItemStatus.COMPLETED)).toBe(true);
    for (const s of ["PENDING", "FAILED", "SKIPPED", "SUCCEEDED", null, undefined]) {
      expect(bulkActionItemSucceeded(s as string | null | undefined)).toBe(false);
    }
  });
});
