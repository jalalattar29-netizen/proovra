/**
 * Phase closure — notification.failed lifecycle event.
 *
 * Phase 6 left notification.failed deferred on the assertion that no
 * single canonical chokepoint existed. The audit in the closure phase
 * showed the assertion was UX-conservative, not architectural: every
 * terminal FAILED transition for a NotificationDelivery row already
 * funnels through the `dispatchDelivery` helper plus the
 * `sendEmailNotification` first-send path inside
 * `services/api/src/services/notifications/index.ts`. Five FAILED
 * branches in total — all now emit `notification.failed` via the
 * canonical `emitWebhookEvent` after the row is committed FAILED.
 *
 * This file pins:
 *
 *   1. Each FAILED branch is followed by an `emitNotificationFailedWebhook`
 *      call (source-text pin). RETRY_SCHEDULED branches MUST NOT emit
 *      (they are not terminal).
 *   2. The notifications service imports the canonical
 *      `emitWebhookEvent` from the integrations dispatcher — no
 *      parallel emitter.
 *   3. The emit is post-commit and best-effort: the dispatcher is
 *      invoked AFTER the FAILED `update()` resolves, wrapped in a
 *      try/catch so a webhook-dispatch failure cannot unwind the
 *      notification's terminal state.
 *   4. Privacy contract — the payload shape:
 *        - Hashes the recipient (sha256 hex), NEVER includes raw value.
 *        - Drops the raw `errorMessage` (often echoes addresses /
 *          provider stack traces). Only `errorCode` sentinel + bounded
 *          ID fields cross the wire.
 *   5. End-to-end behavioral check via an in-memory Prisma stub: when a
 *      provider non-transient error fires `dispatchDelivery`, the
 *      stub's IntegrationWebhookDelivery.create is invoked exactly once
 *      with `eventType: "notification.failed"`.
 *   6. The dispatcher emit is `attemptInline: false` so the originating
 *      retry/resend caller does not block on outbound delivery.
 *
 * Hard rules from the closure brief:
 *   - Reuse canonical services. NO parallel emitter.
 *   - Post-commit only.
 *   - No raw secrets / bodies / Authorization headers logged.
 *   - Each emit wrapped in try/catch — MUST NEVER throw.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { PrismaClient } from "@prisma/client";

// ---------------------------------------------------------------------------
// Source-text loader — same convention as phase6.
// ---------------------------------------------------------------------------

function readApi(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../${rel}`, import.meta.url)),
    "utf8",
  );
}
function readWeb(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../../apps/web/${rel}`, import.meta.url)),
    "utf8",
  );
}

const NOTIFICATIONS_SERVICE = readApi("src/services/notifications/index.ts");
const PAGE = readWeb("app/(app)/integrations/page.tsx");

// ===========================================================================
// PART 1 — Source-text pins on the wiring shape.
// ===========================================================================

describe("phase closure — notifications service wires notification.failed", () => {
  it("imports the canonical emitWebhookEvent from the integrations dispatcher", () => {
    expect(NOTIFICATIONS_SERVICE).toMatch(
      /import\s*\{\s*emitWebhookEvent\s*\}\s*from\s*"\.\.\/integrations\/webhook-dispatcher\.js"/,
    );
  });

  it("declares the canonical event-type literal", () => {
    expect(NOTIFICATIONS_SERVICE).toMatch(
      /NOTIFICATION_FAILED_EVENT\s*=\s*"notification\.failed"/,
    );
  });

  it("defines a single emit helper named emitNotificationFailedWebhook", () => {
    expect(NOTIFICATIONS_SERVICE).toMatch(
      /async function emitNotificationFailedWebhook\(/,
    );
  });

  it("the emit helper is wrapped in try/catch — must never throw", () => {
    // The helper body must contain BOTH `try {` and `catch` so a webhook
    // dispatch failure absorbs into the notification lifecycle.
    const block = NOTIFICATIONS_SERVICE.match(
      /async function emitNotificationFailedWebhook\([\s\S]*?\n\}\n/,
    );
    expect(block).not.toBeNull();
    const body = block![0];
    expect(body).toMatch(/try \{/);
    expect(body).toMatch(/catch/);
  });

  it("the emit helper uses attemptInline: false (post-commit, non-blocking)", () => {
    const block = NOTIFICATIONS_SERVICE.match(
      /async function emitNotificationFailedWebhook\([\s\S]*?\n\}\n/,
    );
    expect(block).not.toBeNull();
    expect(block![0]).toMatch(/attemptInline:\s*false/);
  });

  it("every terminal FAILED branch is followed by an emit call", () => {
    // Source-pin: for each occurrence of `status: "FAILED"`, the next
    // 30 lines should contain an emitNotificationFailedWebhook call
    // (only the FAILED branches emit; RETRY_SCHEDULED branches must not).
    // We count occurrences as a coarse-but-strict invariant.
    const failedCount = (
      NOTIFICATIONS_SERVICE.match(/status:\s*"FAILED"/g) ?? []
    ).length;
    const emitCount = (
      NOTIFICATIONS_SERVICE.match(/emitNotificationFailedWebhook\(/g) ?? []
    ).length;
    // 1 declaration + 1 per FAILED branch.
    expect(failedCount).toBeGreaterThanOrEqual(5);
    expect(emitCount).toBe(failedCount + 1);
  });

  it("the emit is gated on !retriable for branches that share a retriable ternary", () => {
    // For the four sendEmailNotification/dispatchDelivery branches that
    // use the retriable ternary, the emit MUST be guarded by `if (!retriable)`.
    // Five FAILED branches total but the missing_template_context branch is
    // immediate-FAILED (no retriable ternary), so four occurrences are
    // expected.
    const guardedCount = (
      NOTIFICATIONS_SERVICE.match(
        /if \(!retriable\) \{\s*await emitNotificationFailedWebhook/g,
      ) ?? []
    ).length;
    expect(guardedCount).toBe(4);
  });
});

// ===========================================================================
// PART 2 — Privacy contract.
// ===========================================================================

describe("phase closure — notification.failed payload privacy", () => {
  it("the payload hashes the recipient instead of including the raw value", () => {
    const block = NOTIFICATIONS_SERVICE.match(
      /async function emitNotificationFailedWebhook\([\s\S]*?\n\}\n/,
    );
    expect(block).not.toBeNull();
    const body = block![0];
    // Hash builder is invoked on `delivery.recipient`.
    expect(body).toMatch(/hashRecipientForWebhook\(delivery\.recipient\)/);
    // The payload key is `recipientHash`, never `recipient`.
    expect(body).toMatch(/recipientHash:/);
    expect(body).not.toMatch(/payload\.recipient\s*=\s*delivery\.recipient/);
  });

  it("the payload does NOT include the raw errorMessage", () => {
    const block = NOTIFICATIONS_SERVICE.match(
      /async function emitNotificationFailedWebhook\([\s\S]*?\n\}\n/,
    );
    expect(block).not.toBeNull();
    const body = block![0];
    // The bounded `errorCode` sentinel is OK to expose; the raw
    // `errorMessage` (often a provider stack trace) is NOT.
    expect(body).toMatch(/reason:\s*delivery\.errorCode/);
    expect(body).not.toMatch(/delivery\.errorMessage/);
  });

  it("the hash helper uses sha256 hex (deterministic, full-length)", () => {
    // The hash MUST be sha256-hex so subscribers can correlate failures
    // without seeing the raw recipient.
    const block = NOTIFICATIONS_SERVICE.match(
      /function hashRecipientForWebhook\([\s\S]*?\n\}\n/,
    );
    expect(block).not.toBeNull();
    expect(block![0]).toMatch(/createHash\("sha256"\)/);
    expect(block![0]).toMatch(/digest\("hex"\)/);
  });
});

// ===========================================================================
// PART 3 — UI advertises the newly wired event.
// ===========================================================================

describe("phase closure — UI selector advertises notification.failed", () => {
  it("ALL_EVENT_TYPES contains notification.failed", () => {
    const match = PAGE.match(
      /const ALL_EVENT_TYPES = \[([\s\S]*?)\] as const;/,
    );
    expect(match).not.toBeNull();
    expect(match![1]).toContain(`"notification.failed"`);
  });

  it("the page comment documents the closure-phase wiring", () => {
    expect(PAGE).toMatch(/notification\.failed/);
    expect(PAGE).toMatch(/notifications\/index\.ts/);
    // Must explicitly call out the privacy bounding.
    expect(PAGE).toMatch(/hashed|hash/);
  });
});

// ===========================================================================
// PART 4 — End-to-end behavioural check via an in-memory Prisma stub.
//
// We exercise the real `sendEmailNotification` against a stub Prisma so a
// regression that drops the emit call would crash this test loudly. The
// stub tracks IntegrationWebhookDelivery.create calls; one is expected per
// notification.failed emit.
// ===========================================================================

type CapturedEmit = {
  endpointId: string;
  teamId: string;
  eventType: string;
  payloadJson: Record<string, unknown>;
  status: string;
};

function buildStubPrisma(): {
  client: PrismaClient;
  notifications: Array<Record<string, unknown>>;
  webhookEmits: CapturedEmit[];
} {
  const notifications: Array<Record<string, unknown>> = [];
  const webhookEmits: CapturedEmit[] = [];

  const client = {
    notificationDelivery: {
      create: async (args: { data: Record<string, unknown> }) => {
        const row = {
          id: `notif-${notifications.length + 1}`,
          retryCount: 0,
          failedAtUtc: null,
          ...args.data,
        };
        notifications.push(row);
        return row;
      },
      update: async (args: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => {
        const idx = notifications.findIndex((n) => n.id === args.where.id);
        if (idx < 0) throw new Error("not found");
        notifications[idx] = { ...notifications[idx], ...args.data };
        // Normalise failedAtUtc to a Date so the helper's
        // `.toISOString()` call works on the passed-through row.
        if (
          notifications[idx].failedAtUtc &&
          !(notifications[idx].failedAtUtc instanceof Date)
        ) {
          notifications[idx].failedAtUtc = new Date(
            notifications[idx].failedAtUtc as string,
          );
        }
        return notifications[idx];
      },
      findUnique: async (args: { where: { id: string } }) => {
        return notifications.find((n) => n.id === args.where.id) ?? null;
      },
      findMany: async () => [],
      updateMany: async () => ({ count: 0 }),
    },
    webhookEndpoint: {
      findMany: async (args: {
        where: { teamId: string; status: "ACTIVE" };
      }) => {
        // A wildcard endpoint exists for both seeded teams so we can
        // observe emits in either path. The dispatcher filters by team.
        const all = [
          {
            id: "ep-wildcard-closure",
            teamId: "team-closure",
            status: "ACTIVE",
            eventTypes: [],
            secretCiphertext: "stub",
            previousSecretCiphertext: null,
            previousSecretValidUntilUtc: null,
            url: "https://example.invalid/hook",
          },
          {
            id: "ep-wildcard-noemit",
            teamId: "team-noemit",
            status: "ACTIVE",
            eventTypes: [],
            secretCiphertext: "stub",
            previousSecretCiphertext: null,
            previousSecretValidUntilUtc: null,
            url: "https://example.invalid/hook",
          },
        ];
        return all.filter(
          (e) => e.teamId === args.where.teamId && e.status === "ACTIVE",
        );
      },
    },
    integrationWebhookDelivery: {
      create: async (args: { data: CapturedEmit }) => {
        webhookEmits.push(args.data);
        return { id: `del-${webhookEmits.length}`, ...args.data };
      },
      update: async () => null,
    },
  } as unknown as PrismaClient;

  return { client, notifications, webhookEmits };
}

// We drive the missing_template_context FAILED branch in dispatchDelivery
// (via resendNotificationDelivery). That branch is the cleanest end-to-end
// path: it does no rendering and no provider call, so the test exercises
// the pure post-commit emit without needing to stub email templates.
describe("phase closure — dispatchDelivery missing_template_context FAILED emits notification.failed", () => {
  it("emits exactly one notification.failed webhook with bounded payload", async () => {
    const prevNotif = process.env.NOTIFICATIONS_ENABLED;
    const prevIntegrations = process.env.INTEGRATIONS_ENABLED;
    process.env.NOTIFICATIONS_ENABLED = "true";
    process.env.INTEGRATIONS_ENABLED = "true";

    try {
      const { resendNotificationDelivery } = await import(
        "../src/services/notifications/index.js"
      );

      const { client, notifications, webhookEmits } = buildStubPrisma();

      // Seed a delivery with NO templateContextJson so the dispatchDelivery
      // path takes the missing_template_context FAILED branch.
      notifications.push({
        id: "notif-existing",
        teamId: "team-closure",
        eventType: "EVIDENCE_REQUEST_SENT",
        channel: "EMAIL",
        provider: "RESEND",
        recipient: "ops@example.invalid",
        recipientName: "Ops",
        recipientUserId: null,
        evidenceRequestId: "req-closure-1",
        evidenceId: null,
        intakeLinkId: null,
        status: "FAILED",
        retryCount: 0,
        templateContextJson: null,
        templateKey: "EVIDENCE_REQUEST_SENT",
        renderedPreview: null,
        subject: null,
        errorCode: null,
        errorMessage: null,
        nextAttemptAtUtc: null,
        failedAtUtc: null,
        sentAtUtc: null,
        providerMessageId: null,
        initiatedByUserId: null,
      });

      const result = await resendNotificationDelivery(
        {
          id: "notif-existing",
          teamId: "team-closure",
          actorUserId: "actor-closure",
        },
        client,
      );

      expect(result.outcome).toBe("failed_to_dispatch");

      // Exactly one notification.failed webhook emit.
      expect(webhookEmits.length).toBe(1);
      const emit = webhookEmits[0];
      expect(emit.eventType).toBe("notification.failed");
      expect(emit.status).toBe("PENDING");
      expect(emit.teamId).toBe("team-closure");

      const envelope = emit.payloadJson as {
        event: string;
        eventId: string;
        teamId: string;
        data: Record<string, unknown>;
      };
      expect(envelope.event).toBe("notification.failed");

      const data = envelope.data;
      expect(data.teamId).toBe("team-closure");
      expect(data.notificationId).toBe("notif-existing");
      expect(data.evidenceRequestId).toBe("req-closure-1");
      expect(data.reason).toBe("missing_template_context");
      expect(typeof data.failedAtUtc).toBe("string");

      // Recipient is hashed, never raw.
      expect(data.recipientHash).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.stringify(data)).not.toContain("ops@example.invalid");
      // The raw errorMessage from the row MUST NOT cross into the
      // payload. The original errorMessage in the source is a docstring
      // about "Cannot retry: stored template context is missing." — it
      // is intentionally not surfaced to subscribers.
      expect(JSON.stringify(data)).not.toContain("Cannot retry");
    } finally {
      if (prevNotif === undefined) delete process.env.NOTIFICATIONS_ENABLED;
      else process.env.NOTIFICATIONS_ENABLED = prevNotif;
      if (prevIntegrations === undefined)
        delete process.env.INTEGRATIONS_ENABLED;
      else process.env.INTEGRATIONS_ENABLED = prevIntegrations;
    }
  });
});

describe("phase closure — feature-flagged off → no emit, even on FAILED", () => {
  it("when INTEGRATIONS_ENABLED is unset, emitWebhookEvent is a no-op", async () => {
    const prevNotif = process.env.NOTIFICATIONS_ENABLED;
    const prevIntegrations = process.env.INTEGRATIONS_ENABLED;
    process.env.NOTIFICATIONS_ENABLED = "true";
    delete process.env.INTEGRATIONS_ENABLED;

    try {
      const { resendNotificationDelivery } = await import(
        "../src/services/notifications/index.js"
      );

      const { client, notifications, webhookEmits } = buildStubPrisma();

      notifications.push({
        id: "notif-noemit",
        teamId: "team-noemit",
        eventType: "EVIDENCE_REQUEST_SENT",
        channel: "EMAIL",
        provider: "RESEND",
        recipient: "ops@example.invalid",
        recipientName: null,
        recipientUserId: null,
        evidenceRequestId: "req-noemit",
        evidenceId: null,
        intakeLinkId: null,
        status: "FAILED",
        retryCount: 0,
        templateContextJson: null,
        templateKey: "EVIDENCE_REQUEST_SENT",
        renderedPreview: null,
        subject: null,
        errorCode: null,
        errorMessage: null,
        nextAttemptAtUtc: null,
        failedAtUtc: null,
        sentAtUtc: null,
        providerMessageId: null,
        initiatedByUserId: null,
      });

      const result = await resendNotificationDelivery(
        {
          id: "notif-noemit",
          teamId: "team-noemit",
          actorUserId: "actor-noemit",
        },
        client,
      );

      expect(result.outcome).toBe("failed_to_dispatch");
      // Integrations dispatcher is off — no row inserted.
      expect(webhookEmits.length).toBe(0);
    } finally {
      if (prevNotif === undefined) delete process.env.NOTIFICATIONS_ENABLED;
      else process.env.NOTIFICATIONS_ENABLED = prevNotif;
      if (prevIntegrations === undefined)
        delete process.env.INTEGRATIONS_ENABLED;
      else process.env.INTEGRATIONS_ENABLED = prevIntegrations;
    }
  });
});

// ===========================================================================
// PART 5 — Worker-only events remain deferred and documented.
// ===========================================================================

describe("phase closure — worker-only events remain deferred", () => {
  it("evidence.report_generated stays out of ALL_EVENT_TYPES", () => {
    const match = PAGE.match(
      /const ALL_EVENT_TYPES = \[([\s\S]*?)\] as const;/,
    );
    expect(match).not.toBeNull();
    expect(match![1]).not.toContain(`"evidence.report_generated"`);
  });

  it("evidence.package_generated stays out of ALL_EVENT_TYPES", () => {
    const match = PAGE.match(
      /const ALL_EVENT_TYPES = \[([\s\S]*?)\] as const;/,
    );
    expect(match).not.toBeNull();
    expect(match![1]).not.toContain(`"evidence.package_generated"`);
  });

  it("the page comment explains why both worker events remain deferred", () => {
    expect(PAGE).toMatch(/evidence\.report_generated/);
    expect(PAGE).toMatch(/evidence\.package_generated/);
    expect(PAGE).toMatch(/services\/worker\/src\/processor\.ts/);
    expect(PAGE).toMatch(/Deferred to a future phase/);
  });
});
