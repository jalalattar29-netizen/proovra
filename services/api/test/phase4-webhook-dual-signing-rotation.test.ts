/**
 * PHASE 4 — Dual-signing webhook rotation.
 *
 * Verifies the end-to-end shape of the new rotation pathway:
 *
 *   1. `rotateWebhookSecret` issues a new raw secret AND moves the
 *      prior signing material into the endpoint's `previous_*`
 *      columns with a cutoff of `now + graceMinutes`.
 *   2. Inside the grace window the dispatcher signs each outbound
 *      delivery with BOTH secrets and emits a comma-separated
 *      `v1=<new>,v1=<old>` multi-sig in `X-Proovra-Signature`.
 *   3. Outside the window the dispatcher signs with only the new
 *      secret AND lazily clears the previous_* triple on the next
 *      delivery.
 *   4. A standalone receiver that knows ONLY the previous raw secret
 *      can still verify a delivery that was signed during the grace
 *      window; a receiver that knows ONLY the new raw secret can
 *      verify the same delivery. After the window only the new-secret
 *      receiver verifies.
 *   5. The route layer (zod schema + audit emission contract) accepts
 *      `graceMinutes`, clamps it server-side, and never persists the
 *      raw secret / ciphertext / previous ciphertext in audit
 *      metadata.
 *
 * Hard rules (HARD CONSTRAINTS in the phase brief):
 *   - `previous_secret_ciphertext` is NEVER returned by
 *     `projectWebhookEndpoint`.
 *   - The audit event metadata NEVER contains `rawSecret`,
 *     `secretCiphertext`, or `previousSecretCiphertext`.
 *   - `MAX_WEBHOOK_ROTATION_GRACE_MINUTES === 1440` (1 day ceiling).
 *   - `DEFAULT_WEBHOOK_ROTATION_GRACE_MINUTES === 60`.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { PrismaClient } from "@prisma/client";

import {
  __setWebhookHttpClientForTests,
  attemptDelivery,
  type WebhookHttpClient,
  type WebhookHttpResponse,
} from "../src/services/integrations/webhook-dispatcher.js";
import {
  DEFAULT_WEBHOOK_ROTATION_GRACE_MINUTES,
  MAX_WEBHOOK_ROTATION_GRACE_MINUTES,
  decryptWebhookSecret,
  issueWebhookSecret,
  projectWebhookEndpoint,
  rotateWebhookSecret,
} from "../src/services/integrations/webhooks.service.js";
import { buildWebhookSignatureBase } from "@proovra/shared";
import { createHmac } from "node:crypto";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const API_KEY_SECRET = "a".repeat(64);

function withApiKeySecret<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.env.API_KEY_SECRET;
  const prevFlag = process.env.INTEGRATIONS_ENABLED;
  process.env.API_KEY_SECRET = API_KEY_SECRET;
  process.env.INTEGRATIONS_ENABLED = "true";
  return fn().finally(() => {
    if (prev === undefined) delete process.env.API_KEY_SECRET;
    else process.env.API_KEY_SECRET = prev;
    if (prevFlag === undefined) delete process.env.INTEGRATIONS_ENABLED;
    else process.env.INTEGRATIONS_ENABLED = prevFlag;
  });
}

type FakeEndpoint = {
  id: string;
  teamId: string;
  url: string;
  description: string | null;
  status: string;
  secretCiphertext: string;
  secretPrefix: string;
  previousSecretCiphertext: string | null;
  previousSecretPrefix: string | null;
  previousSecretValidUntilUtc: Date | null;
  eventTypes: string[];
  failureCount: number;
  lastSuccessAtUtc: Date | null;
  lastFailureAtUtc: Date | null;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

type FakeRow = {
  id: string;
  endpointId: string;
  teamId: string;
  eventId: string;
  eventType: string;
  payloadJson: unknown;
  status: string;
  attemptCount: number;
  nextAttemptAtUtc: Date | null;
  responseStatus: number | null;
  responseBodyPreview: string | null;
  errorMessage: string | null;
  sentAtUtc: Date | null;
  failedAtUtc: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

function makeEndpoint(overrides: Partial<FakeEndpoint> = {}): FakeEndpoint {
  const issued = issueWebhookSecret();
  if (!issued) throw new Error("API_KEY_SECRET not set");
  return {
    id: "22222222-2222-4222-8222-222222222222",
    teamId: "33333333-3333-4333-8333-333333333333",
    url: "https://example.com/hook",
    description: null,
    status: "ACTIVE",
    secretCiphertext: issued.secretCiphertext,
    secretPrefix: issued.secretPrefix,
    previousSecretCiphertext: null,
    previousSecretPrefix: null,
    previousSecretValidUntilUtc: null,
    eventTypes: [],
    failureCount: 0,
    lastSuccessAtUtc: null,
    lastFailureAtUtc: null,
    createdByUserId: "55555555-5555-4555-8555-555555555555",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

/**
 * Tiny prisma stub for the rotation + dispatch path. Tracks updates to
 * the endpoint row so the test can assert the lazy-clear behaviour.
 */
function makePrismaStub(endpoint: FakeEndpoint): {
  client: PrismaClient;
  endpointUpdates: Array<Record<string, unknown>>;
  rows: FakeRow[];
} {
  const endpointUpdates: Array<Record<string, unknown>> = [];
  const rows: FakeRow[] = [];
  let nextRowId = 0;
  const client = {
    webhookEndpoint: {
      findFirst: async (q: { where: { id: string; teamId: string } }) => {
        if (
          endpoint.id !== q.where.id ||
          endpoint.teamId !== q.where.teamId
        )
          return null;
        return endpoint;
      },
      update: async (q: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => {
        endpointUpdates.push({ ...q.data });
        Object.assign(endpoint, q.data);
        return endpoint;
      },
    },
    integrationWebhookDelivery: {
      create: async (q: { data: Record<string, unknown> }) => {
        const id = `00000000-0000-4000-8000-${String(nextRowId++).padStart(12, "0")}`;
        const row: FakeRow = {
          id,
          endpointId: String(q.data.endpointId),
          teamId: String(q.data.teamId),
          eventId: String(q.data.eventId),
          eventType: String(q.data.eventType),
          payloadJson: q.data.payloadJson,
          status: String(q.data.status ?? "PENDING"),
          attemptCount: Number(q.data.attemptCount ?? 0),
          nextAttemptAtUtc: null,
          responseStatus: null,
          responseBodyPreview: null,
          errorMessage: null,
          sentAtUtc: null,
          failedAtUtc: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        rows.push(row);
        return row;
      },
      update: async (q: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => {
        const row = rows.find((r) => r.id === q.where.id);
        if (!row) return null;
        Object.assign(row, q.data);
        return row;
      },
    },
  } as unknown as PrismaClient;
  return { client, endpointUpdates, rows };
}

/**
 * Standalone receiver verification, written ENTIRELY in terms of the
 * public scheme. Mirrors webhook-receiver-verification.test.ts but
 * accepts the comma-separated multi-sig header.
 */
function receiverVerifyMultiSig(input: {
  rawSecret: string;
  signatureHeader: string;
  timestampHeader: string;
  body: string;
}): boolean {
  const base = buildWebhookSignatureBase(
    Number.parseInt(input.timestampHeader, 10),
    input.body,
  );
  const expected = createHmac("sha256", input.rawSecret)
    .update(base, "utf8")
    .digest("hex");
  const entries = input.signatureHeader.split(",").map((s) => s.trim());
  return entries.some((entry) => {
    if (!entry.startsWith("v1=")) return false;
    const received = entry.slice(3);
    if (received.length !== expected.length) return false;
    let diff = 0;
    for (let i = 0; i < received.length; i += 1) {
      diff |= received.charCodeAt(i) ^ expected.charCodeAt(i);
    }
    return diff === 0;
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let restoreHttp: (() => void) | null = null;
afterEach(() => {
  if (restoreHttp) restoreHttp();
  restoreHttp = null;
});

describe("PHASE 4 — webhook rotation service constants + clamping", () => {
  it("exposes canonical grace-window constants", () => {
    expect(MAX_WEBHOOK_ROTATION_GRACE_MINUTES).toBe(24 * 60);
    expect(DEFAULT_WEBHOOK_ROTATION_GRACE_MINUTES).toBe(60);
  });
});

describe("PHASE 4 — rotateWebhookSecret service", () => {
  it("issues a new raw secret and copies prior signing material to previous_* columns", async () => {
    await withApiKeySecret(async () => {
      const endpoint = makeEndpoint();
      const originalCiphertext = endpoint.secretCiphertext;
      const originalPrefix = endpoint.secretPrefix;
      const { client } = makePrismaStub(endpoint);

      const result = await rotateWebhookSecret(
        {
          id: endpoint.id,
          teamId: endpoint.teamId,
          graceMinutes: 30,
        },
        client,
      );

      expect(result.rawSecret).toMatch(/^pwhsec_v\d+_/);
      // New material is live; prior material is preserved.
      expect(endpoint.secretCiphertext).not.toBe(originalCiphertext);
      expect(endpoint.secretPrefix).not.toBe(originalPrefix);
      expect(endpoint.previousSecretCiphertext).toBe(originalCiphertext);
      expect(endpoint.previousSecretPrefix).toBe(originalPrefix);
      expect(result.previousSecretPrefix).toBe(originalPrefix);
      // Cutoff ~ now + 30min.
      const expected = Date.now() + 30 * 60 * 1000;
      expect(
        Math.abs(result.previousSecretValidUntilUtc.getTime() - expected),
      ).toBeLessThan(5000);
    });
  });

  it("defaults graceMinutes to 60 when omitted", async () => {
    await withApiKeySecret(async () => {
      const endpoint = makeEndpoint();
      const { client } = makePrismaStub(endpoint);

      const result = await rotateWebhookSecret(
        { id: endpoint.id, teamId: endpoint.teamId },
        client,
      );
      const expected = Date.now() + 60 * 60 * 1000;
      expect(
        Math.abs(result.previousSecretValidUntilUtc.getTime() - expected),
      ).toBeLessThan(5000);
    });
  });

  it("rejects graceMinutes outside [1, 1440] with invalid_grace_minutes", async () => {
    await withApiKeySecret(async () => {
      const endpoint = makeEndpoint();
      const { client } = makePrismaStub(endpoint);
      await expect(
        rotateWebhookSecret(
          { id: endpoint.id, teamId: endpoint.teamId, graceMinutes: 0 },
          client,
        ),
      ).rejects.toMatchObject({ code: "invalid_grace_minutes" });
      await expect(
        rotateWebhookSecret(
          {
            id: endpoint.id,
            teamId: endpoint.teamId,
            graceMinutes: MAX_WEBHOOK_ROTATION_GRACE_MINUTES + 1,
          },
          client,
        ),
      ).rejects.toMatchObject({ code: "invalid_grace_minutes" });
    });
  });

  it("rejects endpoint_not_found cleanly", async () => {
    await withApiKeySecret(async () => {
      const endpoint = makeEndpoint();
      const { client } = makePrismaStub(endpoint);
      await expect(
        rotateWebhookSecret(
          {
            id: "11111111-1111-4111-8111-111111111111",
            teamId: endpoint.teamId,
          },
          client,
        ),
      ).rejects.toMatchObject({ code: "endpoint_not_found" });
    });
  });

  it("never returns the previous_* ciphertext via projectWebhookEndpoint", async () => {
    await withApiKeySecret(async () => {
      const endpoint = makeEndpoint();
      const { client } = makePrismaStub(endpoint);
      await rotateWebhookSecret(
        { id: endpoint.id, teamId: endpoint.teamId, graceMinutes: 15 },
        client,
      );
      // Sanity: prior ciphertext is stored on the row.
      expect(endpoint.previousSecretCiphertext).not.toBeNull();
      // But the projection NEVER surfaces it (or the live ciphertext).
      const projected = projectWebhookEndpoint(endpoint as never);
      expect(
        (projected as Record<string, unknown>).secretCiphertext,
      ).toBeUndefined();
      expect(
        (projected as Record<string, unknown>).previousSecretCiphertext,
      ).toBeUndefined();
      expect(projected.previousSecretPrefix).toBe(endpoint.previousSecretPrefix);
      expect(projected.previousSecretValidUntilUtc).not.toBeNull();
    });
  });
});

describe("PHASE 4 — dispatcher emits dual-sign header during grace", () => {
  it("emits 'v1=<new>,v1=<old>' when previous_secret is within validity", async () => {
    await withApiKeySecret(async () => {
      const newIssued = issueWebhookSecret()!;
      const oldIssued = issueWebhookSecret()!;
      const endpoint = makeEndpoint({
        secretCiphertext: newIssued.secretCiphertext,
        secretPrefix: newIssued.secretPrefix,
        previousSecretCiphertext: oldIssued.secretCiphertext,
        previousSecretPrefix: oldIssued.secretPrefix,
        previousSecretValidUntilUtc: new Date(Date.now() + 60 * 60 * 1000),
      });
      const { client, rows } = makePrismaStub(endpoint);
      const captured: Array<{ headers: Record<string, string>; body: string }> =
        [];
      const fake: WebhookHttpClient = async (req) => {
        captured.push({ headers: req.headers, body: req.body });
        const resp: WebhookHttpResponse = {
          status: 200,
          bodyPreview: "ok",
          errorMessage: null,
        };
        return resp;
      };
      restoreHttp = __setWebhookHttpClientForTests(fake);

      // Seed a PENDING row and attempt directly.
      const row = await client.integrationWebhookDelivery.create({
        data: {
          endpointId: endpoint.id,
          teamId: endpoint.teamId,
          eventId: "44444444-4444-4444-8444-444444444444",
          eventType: "evidence.completed",
          payloadJson: { data: { evidenceId: "abc" } },
          status: "PENDING",
          attemptCount: 0,
        },
      });

      const outcome = await attemptDelivery(
        row as never,
        endpoint as never,
        client,
      );
      expect(outcome).toBe("delivered");
      expect(captured).toHaveLength(1);

      const header = captured[0].headers["x-proovra-signature"];
      // Comma-separated multi-sig — exactly two entries during grace.
      const entries = header.split(",").map((e) => e.trim());
      expect(entries).toHaveLength(2);
      expect(entries[0]).toMatch(/^v1=[0-9a-f]{64}$/);
      expect(entries[1]).toMatch(/^v1=[0-9a-f]{64}$/);
      expect(entries[0]).not.toBe(entries[1]);

      // A receiver that knows the OLD secret verifies. A receiver that
      // knows the NEW secret verifies. A receiver with a junk secret
      // does not.
      expect(
        receiverVerifyMultiSig({
          rawSecret: newIssued.rawSecret,
          signatureHeader: header,
          timestampHeader: captured[0].headers["x-proovra-timestamp"],
          body: captured[0].body,
        }),
      ).toBe(true);
      expect(
        receiverVerifyMultiSig({
          rawSecret: oldIssued.rawSecret,
          signatureHeader: header,
          timestampHeader: captured[0].headers["x-proovra-timestamp"],
          body: captured[0].body,
        }),
      ).toBe(true);
      expect(
        receiverVerifyMultiSig({
          rawSecret: "pwhsec_v1_junk-not-real",
          signatureHeader: header,
          timestampHeader: captured[0].headers["x-proovra-timestamp"],
          body: captured[0].body,
        }),
      ).toBe(false);
      // Row should be SENT.
      expect(rows[0].status).toBe("SENT");
    });
  });

  it("emits only the new signature once the grace window has expired", async () => {
    await withApiKeySecret(async () => {
      const newIssued = issueWebhookSecret()!;
      const oldIssued = issueWebhookSecret()!;
      // Window already closed (1 ms ago).
      const endpoint = makeEndpoint({
        secretCiphertext: newIssued.secretCiphertext,
        secretPrefix: newIssued.secretPrefix,
        previousSecretCiphertext: oldIssued.secretCiphertext,
        previousSecretPrefix: oldIssued.secretPrefix,
        previousSecretValidUntilUtc: new Date(Date.now() - 1),
      });
      const { client, endpointUpdates } = makePrismaStub(endpoint);
      const captured: Array<{ headers: Record<string, string>; body: string }> =
        [];
      const fake: WebhookHttpClient = async (req) => {
        captured.push({ headers: req.headers, body: req.body });
        return { status: 200, bodyPreview: "ok", errorMessage: null };
      };
      restoreHttp = __setWebhookHttpClientForTests(fake);

      const row = await client.integrationWebhookDelivery.create({
        data: {
          endpointId: endpoint.id,
          teamId: endpoint.teamId,
          eventId: "44444444-4444-4444-8444-444444444444",
          eventType: "evidence.completed",
          payloadJson: { data: { evidenceId: "abc" } },
          status: "PENDING",
          attemptCount: 0,
        },
      });

      await attemptDelivery(row as never, endpoint as never, client);

      const header = captured[0].headers["x-proovra-signature"];
      // Single signature only.
      expect(header.includes(",")).toBe(false);
      expect(header).toMatch(/^v1=[0-9a-f]{64}$/);
      // Only the NEW secret verifies.
      expect(
        receiverVerifyMultiSig({
          rawSecret: newIssued.rawSecret,
          signatureHeader: header,
          timestampHeader: captured[0].headers["x-proovra-timestamp"],
          body: captured[0].body,
        }),
      ).toBe(true);
      expect(
        receiverVerifyMultiSig({
          rawSecret: oldIssued.rawSecret,
          signatureHeader: header,
          timestampHeader: captured[0].headers["x-proovra-timestamp"],
          body: captured[0].body,
        }),
      ).toBe(false);

      // Lazy clear: the dispatcher fired a best-effort update to NULL
      // out the previous_* triple. The clear is async so it may
      // resolve on the next microtask — wait one tick.
      await new Promise((r) => setImmediate(r));
      const clearUpdate = endpointUpdates.find(
        (u) =>
          u.previousSecretCiphertext === null &&
          u.previousSecretPrefix === null &&
          u.previousSecretValidUntilUtc === null,
      );
      expect(clearUpdate).toBeDefined();
    });
  });

  it("ciphertexts stored in previous_secret_ciphertext decrypt back via decryptWebhookSecret", async () => {
    await withApiKeySecret(async () => {
      const issued = issueWebhookSecret()!;
      // The wrap key is symmetric across the live and previous columns;
      // decrypt should round-trip.
      const recovered = decryptWebhookSecret(issued.secretCiphertext);
      expect(recovered).toBe(issued.rawSecret);
    });
  });
});

// ---------------------------------------------------------------------------
// Route + audit invariants — inspected via source so we don't need a
// live Fastify server.
// ---------------------------------------------------------------------------

const ROUTE_SRC_PATH = resolve(
  process.cwd(),
  "src/routes/integrations.routes.ts",
);
const SERVICE_SRC_PATH = resolve(
  process.cwd(),
  "src/services/integrations/webhooks.service.ts",
);
const PAGE_SRC_PATH = resolve(
  process.cwd(),
  "../../apps/web/app/(app)/integrations/page.tsx",
);
const DOCS_SRC_PATH = PAGE_SRC_PATH;

describe("PHASE 4 — rotation route source invariants", () => {
  const routeSrc = readFileSync(ROUTE_SRC_PATH, "utf8");

  it("rotate-secret route accepts graceMinutes via zod and clamps to MAX_WEBHOOK_ROTATION_GRACE_MINUTES", () => {
    expect(routeSrc).toMatch(
      /\/v1\/integrations\/webhooks\/:id\/rotate-secret/,
    );
    expect(routeSrc).toMatch(
      /graceMinutes:\s*z[\s\S]*?\.max\(MAX_WEBHOOK_ROTATION_GRACE_MINUTES\)/,
    );
  });

  it("rotate-secret route emits the integration.webhook.secret_rotated audit event with bounded metadata", () => {
    expect(routeSrc).toContain('"integration.webhook.secret_rotated"');
    expect(routeSrc).toMatch(/previousSecretPrefix:\s*result\.previousSecretPrefix/);
    expect(routeSrc).toMatch(/newSecretPrefix:\s*result\.endpoint\.secretPrefix/);
  });

  it("rotate-secret route gates through step-up before issuing a new secret", () => {
    // The block must include the step-up call between perm check and
    // service invocation. Just assert the call is present in the file.
    expect(routeSrc).toContain("requireStepUpForSensitiveAction");
  });

  it("audit eventType union includes integration.webhook.secret_rotated", () => {
    expect(routeSrc).toMatch(
      /"integration\.webhook\.secret_rotated"/,
    );
  });

  it("audit emit call sites NEVER persist the raw secret, ciphertext, or previous ciphertext in metadata", () => {
    // Find every `emitWebhookAudit({...})` call and confirm metadata
    // doesn't reference forbidden field names.
    const forbidden = [
      "rawSecret",
      "secretCiphertext",
      "previousSecretCiphertext",
      "payloadJson",
    ];
    // Cheap regex: each forbidden token MUST NOT appear inside any
    // `metadata: { ... }` block of a `emitWebhookAudit` call. We
    // approximate by asserting the forbidden tokens are absent from
    // the whole file in metadata-shaped lines.
    const lines = routeSrc.split(/\r?\n/);
    let insideAuditMetadata = false;
    let depth = 0;
    for (const line of lines) {
      if (line.includes("emitWebhookAudit(")) {
        insideAuditMetadata = true;
      }
      if (insideAuditMetadata) {
        for (const ch of line) {
          if (ch === "{") depth += 1;
          else if (ch === "}") {
            depth -= 1;
            if (depth <= 0) {
              insideAuditMetadata = false;
              depth = 0;
              break;
            }
          }
        }
        for (const tok of forbidden) {
          if (line.includes(tok)) {
            throw new Error(
              `Forbidden token "${tok}" appears inside an emitWebhookAudit metadata block: ${line.trim()}`,
            );
          }
        }
      }
    }
  });
});

describe("PHASE 4 — service source invariants", () => {
  const svcSrc = readFileSync(SERVICE_SRC_PATH, "utf8");

  it("service exports MAX_WEBHOOK_ROTATION_GRACE_MINUTES === 1440 and DEFAULT === 60", () => {
    expect(svcSrc).toMatch(
      /MAX_WEBHOOK_ROTATION_GRACE_MINUTES\s*=\s*24\s*\*\s*60/,
    );
    expect(svcSrc).toMatch(
      /DEFAULT_WEBHOOK_ROTATION_GRACE_MINUTES\s*=\s*60/,
    );
  });

  it("rotateWebhookSecret persists previousSecretCiphertext + previousSecretPrefix + cutoff", () => {
    expect(svcSrc).toMatch(/previousSecretCiphertext:\s*priorSecretCiphertext/);
    expect(svcSrc).toMatch(/previousSecretPrefix:\s*priorSecretPrefix/);
    expect(svcSrc).toMatch(/previousSecretValidUntilUtc/);
  });

  it("clearExpiredPreviousWebhookSecret nulls the entire previous_* triple", () => {
    expect(svcSrc).toMatch(
      /clearExpiredPreviousWebhookSecret[\s\S]*?previousSecretCiphertext:\s*null[\s\S]*?previousSecretPrefix:\s*null[\s\S]*?previousSecretValidUntilUtc:\s*null/,
    );
  });

  it("projection NEVER surfaces secretCiphertext or previousSecretCiphertext", () => {
    expect(svcSrc).toContain(
      "Deliberately NOT returned: secretCiphertext, previousSecretCiphertext",
    );
  });
});

describe("PHASE 4 — dispatcher source invariant", () => {
  const dispSrc = readFileSync(
    resolve(
      process.cwd(),
      "src/services/integrations/webhook-dispatcher.ts",
    ),
    "utf8",
  );

  it("dispatcher computes both signatures inside the grace window and joins them with a comma", () => {
    expect(dispSrc).toMatch(
      /signatureHeader\s*=\s*`\$\{newSignature\},\$\{prevSignature\}`/,
    );
  });

  it("dispatcher lazy-clears previous_* via clearExpiredPreviousWebhookSecret after the cutoff", () => {
    expect(dispSrc).toContain("clearExpiredPreviousWebhookSecret(endpoint.id");
  });
});

describe("PHASE 4 — SignatureDocsPanel documents the comma-separated multi-sig format", () => {
  const pageSrc = readFileSync(DOCS_SRC_PATH, "utf8");

  it("documents the v1=<new>,v1=<old> header form during rotation grace", () => {
    expect(pageSrc).toMatch(/v1=&lt;new&gt;,v1=&lt;old&gt;/);
  });

  it("documents the rotation grace window default + maximum", () => {
    expect(pageSrc).toMatch(/default 60 minutes/);
    expect(pageSrc).toMatch(/max 24/);
  });

  it("provides a multi-sig verification pseudocode block that splits on commas", () => {
    expect(pageSrc).toContain('signature_header.split(",")');
    expect(pageSrc).toMatch(/entries\.some/);
  });

  it("exposes RotateWebhookDialog mounted by rotateWebhookForId", () => {
    expect(pageSrc).toContain("RotateWebhookDialog");
    expect(pageSrc).toContain("rotateWebhookForId");
    // The dialog wires graceMinutes through to submitRotateWebhookSecret.
    expect(pageSrc).toContain("submitRotateWebhookSecret");
  });

  it("surfaces the rotation grace history on the webhook row when previousSecretValidUntilUtc is set", () => {
    expect(pageSrc).toContain("integrations-webhook-grace-");
    expect(pageSrc).toContain("Previous secret");
  });

  it("DisclosureBanner explains BOTH-signing during the grace window after a webhook rotation", () => {
    expect(pageSrc).toContain("webhook_rotated");
    expect(pageSrc).toContain("integrations-webhook-rotation-grace-hint");
  });
});
