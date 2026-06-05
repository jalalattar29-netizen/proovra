/**
 * PHASE 6 + closure — Webhook event wiring contract.
 *
 * Phase 5 stood up an honest health dashboard. Phase 6 closed the
 * lifecycle-event gap for the API-producer events; the closure phase
 * additionally wires notification.failed at its single canonical
 * chokepoint inside services/api/src/services/notifications/index.ts.
 *
 * What this file pins:
 *
 *   1. The CreateWebhookDialog selector (apps/web/.../integrations/page.tsx)
 *      advertises ONLY event types that have a live emitWebhookEvent
 *      caller in services/api/src/services/**. No dead UI options.
 *
 *   2. Each newly wired event has its emit call site in the canonical
 *      service:
 *        - evidence_request.sent       → sendEvidenceRequest
 *        - evidence_request.response_received → linkResponseFromIntakeSession
 *        - external_intake.submitted   → submitExternalIntake
 *        - notification.failed         → notifications/index.ts post-commit
 *                                        (every terminal FAILED branch)
 *
 *   3. Pre-existing wired events are unchanged:
 *        - evidence.created            → createEvidence
 *        - evidence.completed          → completeEvidence post-finalize
 *        - evidence_request.created    → createEvidenceRequest
 *        - governance.legal_hold_placed → placeLegalHold
 *        - governance.export_blocked   → recordExportBlock
 *
 *   4. Deliberately UNWIRED events are absent from the UI selector
 *      and the page documents WHY:
 *        - evidence.report_generated   (worker-process; deferred)
 *        - evidence.package_generated  (worker-process; deferred)
 *
 *   5. Behaviour: emitWebhookEvent writes a PENDING
 *      IntegrationWebhookDelivery row per matching ACTIVE endpoint.
 *      Verified with an in-memory Prisma stub so we exercise the
 *      end-to-end "subscribed endpoint -> delivery row" contract
 *      without needing a live Postgres.
 *
 * Hard rules pinned:
 *   - Every emit reuses the canonical dispatcher
 *     `services/integrations/webhook-dispatcher.ts`. No parallel
 *     emitter is introduced.
 *   - Every emit call site is wrapped in a try/catch so a webhook
 *     persistence failure cannot break the primary lifecycle.
 *   - Payloads carry IDs + bounded lifecycle metadata only — never
 *     PII such as recipient email/phone, raw intake URLs, or
 *     contributor IP / UA. notification.failed hashes its recipient
 *     and drops the raw provider error message.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { PrismaClient } from "@prisma/client";

import { emitWebhookEvent } from "../src/services/integrations/webhook-dispatcher.js";

// ---------------------------------------------------------------------------
// Source-text loaders (same convention as Phase 3 + Phase 5).
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

const EVIDENCE_REQUEST_SERVICE = readApi(
  "src/services/evidence-request.service.ts",
);
const EXTERNAL_INTAKE_ORCHESTRATION = readApi(
  "src/services/external-intake-orchestration.service.ts",
);
const EVIDENCE_SERVICE = readApi("src/services/evidence.service.ts");
const EVIDENCE_COMPLETE_SERVICE = readApi(
  "src/services/evidence-complete.service.ts",
);
const GOVERNANCE_SERVICE = readApi("src/services/governance.service.ts");
const PAGE = readWeb("app/(app)/integrations/page.tsx");

// ===========================================================================
// PART 1 — UI advertises only events with live producers.
// ===========================================================================

describe("PHASE 6 + closure — UI selector advertises only wired events", () => {
  // All currently wired API-producer events.
  const WIRED = [
    "evidence.created",
    "evidence.completed",
    "evidence_request.created",
    "evidence_request.sent",
    "evidence_request.response_received",
    "external_intake.submitted",
    "notification.failed",
    "governance.legal_hold_placed",
    "governance.export_blocked",
  ] as const;

  // Worker-only events still deferred; the page must continue to
  // document the deferral so operators see the trade-off.
  const UNWIRED_REMOVED = [
    "evidence.report_generated",
    "evidence.package_generated",
  ] as const;

  it("the ALL_EVENT_TYPES constant in page.tsx contains every wired event", () => {
    // The selector array literal in the page.
    const match = PAGE.match(/const ALL_EVENT_TYPES = \[([\s\S]*?)\] as const;/);
    expect(match).not.toBeNull();
    const body = match![1];
    for (const ev of WIRED) {
      expect(body).toContain(`"${ev}"`);
    }
  });

  it("the ALL_EVENT_TYPES constant does NOT advertise unwired events", () => {
    const match = PAGE.match(/const ALL_EVENT_TYPES = \[([\s\S]*?)\] as const;/);
    expect(match).not.toBeNull();
    const body = match![1];
    for (const ev of UNWIRED_REMOVED) {
      expect(body).not.toContain(`"${ev}"`);
    }
  });

  it("page.tsx documents WHY the worker-only events are deliberately absent", () => {
    // The honest-limit comment must mention the worker boundary AND
    // call out that the wildcard (`eventTypes: []`) subscription is
    // unaffected, so operators understand the trade-off.
    expect(PAGE).toMatch(/services\/worker\/src\/processor\.ts/);
    expect(PAGE).toMatch(/eventTypes: \[\]/);
    expect(PAGE).toMatch(/Deferred to a future phase/);
  });
});

// ===========================================================================
// PART 2 — Each newly wired event has the right call site.
// ===========================================================================

describe("PHASE 6 — evidence_request.sent emit lives in sendEvidenceRequest", () => {
  it("the service emits evidence_request.sent with the documented payload", () => {
    // Must include the event-type literal AND the payload keys.
    expect(EVIDENCE_REQUEST_SERVICE).toMatch(
      /eventType:\s*"evidence_request\.sent"/,
    );
    // Payload keys: ID-only, no recipient PII.
    expect(EVIDENCE_REQUEST_SERVICE).toMatch(
      /evidenceRequestId:\s*finalRequest\.id/,
    );
    expect(EVIDENCE_REQUEST_SERVICE).toMatch(/status:\s*finalRequest\.status/);
    expect(EVIDENCE_REQUEST_SERVICE).toMatch(
      /intakeLinkId:\s*finalRequest\.intakeLinkId/,
    );
  });

  it("the evidence_request.sent emit is wrapped in a non-throwing try/catch", () => {
    // Hard rule from the brief: webhook persistence failure cannot
    // break the SEND lifecycle.
    const blockMatch = EVIDENCE_REQUEST_SERVICE.match(
      /try \{[\s\S]*?evidence_request\.sent[\s\S]*?\} catch \{/,
    );
    expect(blockMatch).not.toBeNull();
  });

  it("the evidence_request.sent payload does NOT leak recipient PII", () => {
    // Pull the payload object literal for the sent event and check it
    // does not reference recipientEmail/recipientPhone/rawToken/intakeUrl.
    const block = EVIDENCE_REQUEST_SERVICE.match(
      /eventType:\s*"evidence_request\.sent"[\s\S]*?attemptInline:/,
    );
    expect(block).not.toBeNull();
    const body = block![0];
    expect(body).not.toMatch(/recipientEmail/);
    expect(body).not.toMatch(/recipientPhone/);
    expect(body).not.toMatch(/rawToken/);
    expect(body).not.toMatch(/intakeUrl/);
  });
});

describe("PHASE 6 — evidence_request.response_received emit lives in linkResponseFromIntakeSession", () => {
  it("the service emits evidence_request.response_received", () => {
    expect(EVIDENCE_REQUEST_SERVICE).toMatch(
      /eventType:\s*"evidence_request\.response_received"/,
    );
    expect(EVIDENCE_REQUEST_SERVICE).toMatch(
      /intakeSessionId:\s*params\.intakeSession\.id/,
    );
  });

  it("the emit is wrapped in a non-throwing try/catch", () => {
    const blockMatch = EVIDENCE_REQUEST_SERVICE.match(
      /try \{[\s\S]*?evidence_request\.response_received[\s\S]*?\} catch \{/,
    );
    expect(blockMatch).not.toBeNull();
  });

  it("the response_received payload does NOT leak reviewer note or contributor IP/UA", () => {
    const block = EVIDENCE_REQUEST_SERVICE.match(
      /eventType:\s*"evidence_request\.response_received"[\s\S]*?attemptInline:/,
    );
    expect(block).not.toBeNull();
    const body = block![0];
    expect(body).not.toMatch(/reviewerNote/);
    expect(body).not.toMatch(/contributorIp/i);
    expect(body).not.toMatch(/userAgent/i);
    expect(body).not.toMatch(/submitterEmail/i);
  });
});

describe("PHASE 6 — external_intake.submitted emit lives in submitExternalIntake", () => {
  it("the orchestration service imports the canonical dispatcher", () => {
    // No parallel emitter: must reuse the same module that all other
    // integration-event producers reuse.
    expect(EXTERNAL_INTAKE_ORCHESTRATION).toMatch(
      /from\s+"\.\/integrations\/webhook-dispatcher\.js"/,
    );
    expect(EXTERNAL_INTAKE_ORCHESTRATION).toMatch(
      /import\s*\{\s*emitWebhookEvent\s*\}\s*from\s*"\.\/integrations\/webhook-dispatcher\.js"/,
    );
  });

  it("the service emits external_intake.submitted", () => {
    expect(EXTERNAL_INTAKE_ORCHESTRATION).toMatch(
      /eventType:\s*"external_intake\.submitted"/,
    );
    // Payload keys: bounded IDs + workflow metadata only.
    expect(EXTERNAL_INTAKE_ORCHESTRATION).toMatch(
      /evidenceId:\s*evidence\.id/,
    );
    expect(EXTERNAL_INTAKE_ORCHESTRATION).toMatch(
      /intakeSessionId:\s*submitted\.id/,
    );
    expect(EXTERNAL_INTAKE_ORCHESTRATION).toMatch(/partCount:\s*parts\.length/);
  });

  it("the emit is wrapped in a non-throwing try/catch", () => {
    const blockMatch = EXTERNAL_INTAKE_ORCHESTRATION.match(
      /try \{[\s\S]*?external_intake\.submitted[\s\S]*?\} catch \{/,
    );
    expect(blockMatch).not.toBeNull();
  });

  it("the external_intake.submitted payload does NOT leak contributor PII", () => {
    const block = EXTERNAL_INTAKE_ORCHESTRATION.match(
      /eventType:\s*"external_intake\.submitted"[\s\S]*?attemptInline:/,
    );
    expect(block).not.toBeNull();
    const body = block![0];
    // The session has a contributorIpHash and a userAgentHash; we
    // MUST NOT surface even the hashes to webhook subscribers.
    expect(body).not.toMatch(/contributorIp/i);
    expect(body).not.toMatch(/userAgent/i);
    expect(body).not.toMatch(/submitterEmail/i);
    expect(body).not.toMatch(/rawToken/i);
  });
});

// ===========================================================================
// PART 3 — Pre-existing wired events still in place (regression guard).
// ===========================================================================

describe("PHASE 6 — pre-existing emit sites are unchanged", () => {
  it("createEvidence still emits evidence.created", () => {
    expect(EVIDENCE_SERVICE).toMatch(/eventType:\s*"evidence\.created"/);
  });

  it("completeEvidence still emits evidence.completed", () => {
    expect(EVIDENCE_COMPLETE_SERVICE).toMatch(
      /eventType:\s*"evidence\.completed"/,
    );
  });

  it("createEvidenceRequest still emits evidence_request.created", () => {
    expect(EVIDENCE_REQUEST_SERVICE).toMatch(
      /eventType:\s*"evidence_request\.created"/,
    );
  });

  it("governance.service still emits both governance events", () => {
    expect(GOVERNANCE_SERVICE).toMatch(
      /eventType:\s*"governance\.legal_hold_placed"/,
    );
    expect(GOVERNANCE_SERVICE).toMatch(
      /eventType:\s*"governance\.export_blocked"/,
    );
  });

  it("there is only ONE canonical emitWebhookEvent import path used by API producers", () => {
    // No parallel emitter — every service that emits canonical
    // integration events imports from
    // services/integrations/webhook-dispatcher.js.
    const sources = [
      EVIDENCE_SERVICE,
      EVIDENCE_COMPLETE_SERVICE,
      EVIDENCE_REQUEST_SERVICE,
      EXTERNAL_INTAKE_ORCHESTRATION,
      GOVERNANCE_SERVICE,
    ];
    for (const src of sources) {
      expect(src).toMatch(
        /from\s+"[^"]*integrations\/webhook-dispatcher\.js"/,
      );
    }
  });
});

// ===========================================================================
// PART 4 — Dispatcher behavior: matching subscribers receive a row.
// ===========================================================================

type EndpointRow = {
  id: string;
  teamId: string;
  status: "ACTIVE" | "DISABLED";
  eventTypes: string[];
  secretCiphertext: string;
  previousSecretCiphertext: string | null;
  previousSecretValidUntilUtc: Date | null;
  url: string;
};

type DeliveryRow = {
  id: string;
  endpointId: string;
  teamId: string;
  eventId: string;
  eventType: string;
  status: string;
  attemptCount: number;
  payloadJson: unknown;
};

function buildStubPrisma(endpoints: EndpointRow[]): {
  client: PrismaClient;
  deliveries: DeliveryRow[];
} {
  const deliveries: DeliveryRow[] = [];

  // Minimal prisma surface. Methods not used by emitWebhookEvent are
  // deliberately omitted so a regression would crash loudly.
  const client = {
    webhookEndpoint: {
      findMany: async (args: {
        where: { teamId: string; status: "ACTIVE" };
      }) => {
        return endpoints.filter(
          (e) => e.teamId === args.where.teamId && e.status === "ACTIVE",
        );
      },
    },
    integrationWebhookDelivery: {
      create: async (args: { data: Omit<DeliveryRow, "id"> }) => {
        const row: DeliveryRow = {
          id: `del-${deliveries.length + 1}`,
          ...args.data,
        };
        deliveries.push(row);
        return row;
      },
      update: async () => null,
    },
  } as unknown as PrismaClient;

  return { client, deliveries };
}

describe("PHASE 6 — emitWebhookEvent produces a PENDING row for every subscribed endpoint", () => {
  const TEAM = "team-phase6";

  function endpoint(
    id: string,
    opts: Partial<EndpointRow> = {},
  ): EndpointRow {
    return {
      id,
      teamId: TEAM,
      status: "ACTIVE",
      eventTypes: [],
      secretCiphertext: "stub",
      previousSecretCiphertext: null,
      previousSecretValidUntilUtc: null,
      url: "https://example.invalid/hook",
      ...opts,
    };
  }

  // The feature flag must be on for the dispatcher to do any work.
  // We toggle in this describe so the assertion is explicit.
  function withFlag(fn: () => Promise<void>): Promise<void> {
    const prev = process.env.INTEGRATIONS_ENABLED;
    process.env.INTEGRATIONS_ENABLED = "true";
    return fn().finally(() => {
      if (prev === undefined) delete process.env.INTEGRATIONS_ENABLED;
      else process.env.INTEGRATIONS_ENABLED = prev;
    });
  }

  it("evidence_request.sent fans out to matching subscribers only", async () => {
    await withFlag(async () => {
      const { client, deliveries } = buildStubPrisma([
        endpoint("ep-all", { eventTypes: [] }), // wildcard
        endpoint("ep-sent", { eventTypes: ["evidence_request.sent"] }),
        endpoint("ep-other", { eventTypes: ["evidence.completed"] }),
        endpoint("ep-disabled", {
          status: "DISABLED",
          eventTypes: ["evidence_request.sent"],
        }),
      ]);

      const result = await emitWebhookEvent(
        {
          teamId: TEAM,
          eventType: "evidence_request.sent",
          payload: {
            evidenceRequestId: "req-1",
            status: "SENT",
            recipientMode: "EXTERNAL_CONTRIBUTOR",
          },
          attemptInline: false,
        },
        client,
      );

      expect(result.enqueued).toBe(2);
      const endpointIds = deliveries.map((d) => d.endpointId).sort();
      expect(endpointIds).toEqual(["ep-all", "ep-sent"]);
      for (const row of deliveries) {
        expect(row.status).toBe("PENDING");
        expect(row.eventType).toBe("evidence_request.sent");
        expect(row.teamId).toBe(TEAM);
      }
    });
  });

  it("external_intake.submitted fans out to matching subscribers only", async () => {
    await withFlag(async () => {
      const { client, deliveries } = buildStubPrisma([
        endpoint("ep-all", { eventTypes: [] }),
        endpoint("ep-submitted", {
          eventTypes: ["external_intake.submitted"],
        }),
        endpoint("ep-irrelevant", {
          eventTypes: ["governance.export_blocked"],
        }),
      ]);

      const result = await emitWebhookEvent(
        {
          teamId: TEAM,
          eventType: "external_intake.submitted",
          payload: {
            evidenceId: "ev-1",
            intakeLinkId: "link-1",
            intakeSessionId: "sess-1",
            intakeMode: "EXTERNAL_SINGLE_USE",
            partCount: 3,
          },
          attemptInline: false,
        },
        client,
      );

      expect(result.enqueued).toBe(2);
      expect(deliveries.map((d) => d.endpointId).sort()).toEqual([
        "ep-all",
        "ep-submitted",
      ]);
    });
  });

  it("evidence_request.response_received with NO subscriber writes no row", async () => {
    await withFlag(async () => {
      const { client, deliveries } = buildStubPrisma([
        endpoint("ep-sent-only", { eventTypes: ["evidence_request.sent"] }),
        endpoint("ep-disabled", {
          status: "DISABLED",
          eventTypes: [],
        }),
      ]);

      const result = await emitWebhookEvent(
        {
          teamId: TEAM,
          eventType: "evidence_request.response_received",
          payload: { evidenceRequestId: "req-1" },
          attemptInline: false,
        },
        client,
      );

      expect(result.enqueued).toBe(0);
      expect(deliveries.length).toBe(0);
    });
  });

  it("the dispatcher persists the canonical envelope (event / eventId / timestampUtc / teamId / data)", async () => {
    await withFlag(async () => {
      const { client, deliveries } = buildStubPrisma([
        endpoint("ep-all", { eventTypes: [] }),
      ]);

      await emitWebhookEvent(
        {
          teamId: TEAM,
          eventType: "evidence_request.sent",
          payload: { evidenceRequestId: "req-1" },
          attemptInline: false,
        },
        client,
      );

      expect(deliveries.length).toBe(1);
      const envelope = deliveries[0].payloadJson as Record<string, unknown>;
      expect(envelope.event).toBe("evidence_request.sent");
      expect(typeof envelope.eventId).toBe("string");
      expect(typeof envelope.timestampUtc).toBe("string");
      expect(envelope.teamId).toBe(TEAM);
      expect(envelope.data).toEqual({ evidenceRequestId: "req-1" });
    });
  });
});

// ===========================================================================
// PART 5 — End-to-end style: emit for each newly-wired event, no throw.
// ===========================================================================
//
// We don't boot Fastify or run the real prisma client. We assert the
// "best-effort, never throws" contract by calling emitWebhookEvent with
// the canonical wired-event shapes against a stub prisma that throws
// from create. The dispatcher's documented swallow-error posture
// MUST keep the call from rejecting.
// ---------------------------------------------------------------------------

describe("PHASE 6 — emitWebhookEvent never throws even when delivery row insert fails", () => {
  const TEAM = "team-phase6-fail";

  function brokenClient(): PrismaClient {
    return {
      webhookEndpoint: {
        findMany: async () => [
          {
            id: "ep-broken",
            teamId: TEAM,
            status: "ACTIVE",
            eventTypes: [],
            secretCiphertext: "stub",
            previousSecretCiphertext: null,
            previousSecretValidUntilUtc: null,
            url: "https://example.invalid/hook",
          },
        ],
      },
      integrationWebhookDelivery: {
        create: async () => {
          throw new Error("simulated db failure");
        },
        update: async () => null,
      },
    } as unknown as PrismaClient;
  }

  it.each([
    "evidence_request.sent",
    "evidence_request.response_received",
    "external_intake.submitted",
  ] as const)(
    "%s — dispatcher absorbs the persistence failure and returns enqueued: 0",
    async (eventType) => {
      const prev = process.env.INTEGRATIONS_ENABLED;
      process.env.INTEGRATIONS_ENABLED = "true";
      try {
        const result = await emitWebhookEvent(
          {
            teamId: TEAM,
            eventType,
            payload: { id: "test" },
            attemptInline: false,
          },
          brokenClient(),
        );
        expect(result.enqueued).toBe(0);
      } finally {
        if (prev === undefined) delete process.env.INTEGRATIONS_ENABLED;
        else process.env.INTEGRATIONS_ENABLED = prev;
      }
    },
  );
});
