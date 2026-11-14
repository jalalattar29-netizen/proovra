import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  WEBHOOK_PROCESSING_LEASE_MS,
  webhookDuplicateDisposition,
  webhookLeaseFence,
} from "../src/services/billing/webhook-delivery-lease.js";

const NOW = new Date("2026-09-28T12:00:00.000Z");

const WEBHOOK_ROUTES = readFileSync(
  new URL("../src/routes/webhooks.routes.ts", import.meta.url),
  "utf8",
);

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

  // AUDIT F-06 — a handler stalled past the lease must not overwrite the
  // outcome of the redelivery that reclaimed its row.
  describe("final status write is fenced by the claimed lease", () => {
    type Row = {
      processingStatus: string;
      receivedAt: Date;
      errorReason: string | null;
    };
    // updateMany semantics over one row, applying the where as Postgres does.
    function updateMany(
      row: Row,
      where: { processingStatus: string; receivedAt: Date },
      data: Partial<Row>,
    ): number {
      if (
        row.processingStatus !== where.processingStatus ||
        row.receivedAt.getTime() !== where.receivedAt.getTime()
      ) {
        return 0;
      }
      Object.assign(row, data);
      return 1;
    }

    it("a stale handler's FAILED cannot replace the reclaimer's PROCESSED", () => {
      const firstClaim = new Date(
        NOW.getTime() - WEBHOOK_PROCESSING_LEASE_MS - 1,
      );
      const row: Row = {
        processingStatus: "RECEIVED",
        receivedAt: firstClaim,
        errorReason: null,
      };
      // The redelivery reclaims the expired lease and completes.
      row.receivedAt = NOW;
      expect(
        updateMany(row, webhookLeaseFence(NOW), {
          processingStatus: "PROCESSED",
        }),
      ).toBe(1);
      // The first handler wakes up and tries to write its own outcome.
      expect(
        updateMany(row, webhookLeaseFence(firstClaim), {
          processingStatus: "FAILED",
          errorReason: "Error",
        }),
      ).toBe(0);
      expect(row).toEqual({
        processingStatus: "PROCESSED",
        receivedAt: NOW,
        errorReason: null,
      });
    });

    it("fences on RECEIVED and the claimed receivedAt", () => {
      expect(webhookLeaseFence(NOW)).toEqual({
        processingStatus: "RECEIVED",
        receivedAt: NOW,
      });
    });

    const handlers = [
      {
        provider: "Stripe",
        start: 'app.post("/stripe"',
        end: 'app.post("/paypal"',
        key: "stripeEventId: event.id",
      },
      {
        provider: "PayPal",
        start: 'app.post("/paypal"',
        end: null,
        key: "paypalEventId",
      },
    ] as const;

    for (const { provider, start, end, key } of handlers) {
      it(`${provider} writes PROCESSED and FAILED only under its own lease`, () => {
        const from = WEBHOOK_ROUTES.indexOf(start);
        expect(from).toBeGreaterThan(-1);
        const to = end ? WEBHOOK_ROUTES.indexOf(end, from + 1) : -1;
        const handler = WEBHOOK_ROUTES.slice(from, to === -1 ? undefined : to);
        // The claim token is written on create and replaced on reclaim.
        expect(handler).toMatch(
          /processingStatus: "RECEIVED",\s*receivedAt: claimedAt,/,
        );
        expect(handler).toMatch(/claimedAt = reclaimedAt;/);
        // Both final writes (PROCESSED, FAILED) are fenced; none is unfenced.
        const fenced = handler
          .split(".updateMany({")
          .slice(1)
          .filter((tail) =>
            tail
              .trimStart()
              .startsWith(`where: { ${key}, ...webhookLeaseFence(claimedAt) },`),
          );
        expect(fenced.length).toBe(2);
        expect(handler).not.toMatch(/WebhookEvent\s*\.update\(/);
      });
    }
  });
});
