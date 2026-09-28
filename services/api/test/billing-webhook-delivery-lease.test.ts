import { describe, expect, it } from "vitest";

import {
  WEBHOOK_PROCESSING_LEASE_MS,
  webhookDuplicateDisposition,
} from "../src/services/billing/webhook-delivery-lease.js";

const NOW = new Date("2026-09-28T12:00:00.000Z");

describe("billing webhook delivery lease", () => {
  it("deduplicates only a delivery that completed", () => {
    expect(
      webhookDuplicateDisposition({
        processingStatus: "PROCESSED",
        receivedAt: NOW,
        now: NOW,
      }),
    ).toBe("DEDUPLICATE");
  });

  it("returns a non-success retry signal while the first handler owns the lease", () => {
    expect(
      webhookDuplicateDisposition({
        processingStatus: "RECEIVED",
        receivedAt: new Date(NOW.getTime() - WEBHOOK_PROCESSING_LEASE_MS + 1),
        now: NOW,
      }),
    ).toBe("RETRY_LATER");
  });

  it("reclaims RECEIVED after a process can no longer own the lease", () => {
    expect(
      webhookDuplicateDisposition({
        processingStatus: "RECEIVED",
        receivedAt: new Date(NOW.getTime() - WEBHOOK_PROCESSING_LEASE_MS),
        now: NOW,
      }),
    ).toBe("RECLAIM");
  });

  it("retries an explicitly failed delivery immediately", () => {
    expect(
      webhookDuplicateDisposition({
        processingStatus: "FAILED",
        receivedAt: NOW,
        now: NOW,
      }),
    ).toBe("RECLAIM");
  });
});
