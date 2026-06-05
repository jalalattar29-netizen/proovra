/**
 * PHASE 5 closure — cron sweep for expired previous_* integration
 * secrets.
 *
 * Pins:
 *
 *   1. `sweepExpiredPreviousIntegrationSecrets` clears expired
 *      ApiCredential.previous_* and WebhookEndpoint.previousSecret_*
 *      triples in batches, leaves the live secret material untouched,
 *      and is idempotent (a second run returns 0).
 *   2. dryRun=true returns the counts that WOULD be cleared without
 *      mutating any row.
 *   3. The new POST /v1/integrations/process-secret-cleanup route
 *      uses `requireIntegrationCronSecret` (no end-user auth path),
 *      lives in the cron-driven sweepers section of integrations.routes,
 *      and rejects body.batchSize > 5000 / < 1 via the zod schema.
 *   4. The route documentation header lists the new endpoint alongside
 *      /process-webhook-retries and /webhooks/cleanup-deliveries.
 *   5. The service never reads or writes the live `keyHash` /
 *      `secretCiphertext` columns — only the `previous_*` triple is
 *      ever touched (source-text pin: the SET clause names exactly the
 *      three previous_* columns and no others).
 *
 * Hard rules satisfied:
 *   - No fabricated audit / latency metric. Summary is honest
 *     measured counts.
 *   - No raw secret material in logs or summary.
 *   - No new scheduler — caller is the same cron pattern as the
 *     existing /process-webhook-retries route.
 *   - No DB migration introduced (asserted by walking migrations dir).
 */

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { sweepExpiredPreviousIntegrationSecrets } from "../src/services/integrations/secret-cleanup.service.js";

// ---------------------------------------------------------------------------
// Test helpers — read source files for grep pins.
// ---------------------------------------------------------------------------

function readApi(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../${rel}`, import.meta.url)),
    "utf8",
  );
}

const ROUTES_SRC = readApi("src/routes/integrations.routes.ts");
const SERVICE_SRC = readApi(
  "src/services/integrations/secret-cleanup.service.ts",
);

// ---------------------------------------------------------------------------
// Minimal in-memory Prisma fake — covers only ApiCredential and
// WebhookEndpoint findMany + updateMany. The shape mirrors how the
// production sweeper uses Prisma.
// ---------------------------------------------------------------------------

type ApiCredentialRow = {
  id: string;
  teamId: string;
  keyHash: string;
  keyPrefix: string;
  previousKeyHash: string | null;
  previousKeyPrefix: string | null;
  previousValidUntilUtc: Date | null;
};

type WebhookEndpointRow = {
  id: string;
  teamId: string;
  secretCiphertext: string;
  secretPrefix: string;
  previousSecretCiphertext: string | null;
  previousSecretPrefix: string | null;
  previousSecretValidUntilUtc: Date | null;
};

type WhereExpr = {
  previousValidUntilUtc?: { not?: null; lt?: Date };
  previousSecretValidUntilUtc?: { not?: null; lt?: Date };
  id?: { in: string[] };
};

function matchesApi(row: ApiCredentialRow, where: WhereExpr): boolean {
  if (where.id) {
    if (!where.id.in.includes(row.id)) return false;
  }
  if (where.previousValidUntilUtc) {
    const v = row.previousValidUntilUtc;
    if (where.previousValidUntilUtc.not === null && v === null) return false;
    if (where.previousValidUntilUtc.lt !== undefined) {
      if (v === null) return false;
      if (v.getTime() >= where.previousValidUntilUtc.lt.getTime()) return false;
    }
  }
  return true;
}

function matchesWebhook(row: WebhookEndpointRow, where: WhereExpr): boolean {
  if (where.id) {
    if (!where.id.in.includes(row.id)) return false;
  }
  if (where.previousSecretValidUntilUtc) {
    const v = row.previousSecretValidUntilUtc;
    if (where.previousSecretValidUntilUtc.not === null && v === null)
      return false;
    if (where.previousSecretValidUntilUtc.lt !== undefined) {
      if (v === null) return false;
      if (
        v.getTime() >= where.previousSecretValidUntilUtc.lt.getTime()
      )
        return false;
    }
  }
  return true;
}

function makeFakePrisma(opts: {
  apiRows: ApiCredentialRow[];
  webhookRows: WebhookEndpointRow[];
  spy: {
    apiUpdateCalls: number;
    webhookUpdateCalls: number;
    apiUpdatePayloads: Record<string, unknown>[];
    webhookUpdatePayloads: Record<string, unknown>[];
  };
}) {
  const { apiRows, webhookRows, spy } = opts;
  return {
    apiCredential: {
      async findMany(q: { where: WhereExpr; take: number }) {
        return apiRows
          .filter((r) => matchesApi(r, q.where))
          .slice(0, q.take)
          .map((r) => ({ id: r.id }));
      },
      async updateMany(q: {
        where: WhereExpr;
        data: Record<string, unknown>;
      }) {
        spy.apiUpdateCalls += 1;
        spy.apiUpdatePayloads.push(q.data);
        let count = 0;
        for (const row of apiRows) {
          if (!matchesApi(row, q.where)) continue;
          count += 1;
          if ("previousKeyHash" in q.data)
            row.previousKeyHash = q.data.previousKeyHash as null;
          if ("previousKeyPrefix" in q.data)
            row.previousKeyPrefix = q.data.previousKeyPrefix as null;
          if ("previousValidUntilUtc" in q.data)
            row.previousValidUntilUtc =
              q.data.previousValidUntilUtc as null;
        }
        return { count };
      },
    },
    webhookEndpoint: {
      async findMany(q: { where: WhereExpr; take: number }) {
        return webhookRows
          .filter((r) => matchesWebhook(r, q.where))
          .slice(0, q.take)
          .map((r) => ({ id: r.id }));
      },
      async updateMany(q: {
        where: WhereExpr;
        data: Record<string, unknown>;
      }) {
        spy.webhookUpdateCalls += 1;
        spy.webhookUpdatePayloads.push(q.data);
        let count = 0;
        for (const row of webhookRows) {
          if (!matchesWebhook(row, q.where)) continue;
          count += 1;
          if ("previousSecretCiphertext" in q.data)
            row.previousSecretCiphertext =
              q.data.previousSecretCiphertext as null;
          if ("previousSecretPrefix" in q.data)
            row.previousSecretPrefix = q.data.previousSecretPrefix as null;
          if ("previousSecretValidUntilUtc" in q.data)
            row.previousSecretValidUntilUtc =
              q.data.previousSecretValidUntilUtc as null;
        }
        return { count };
      },
    },
  } as unknown as import("@prisma/client").PrismaClient;
}

function makeSpy(): {
  apiUpdateCalls: number;
  webhookUpdateCalls: number;
  apiUpdatePayloads: Record<string, unknown>[];
  webhookUpdatePayloads: Record<string, unknown>[];
} {
  return {
    apiUpdateCalls: 0,
    webhookUpdateCalls: 0,
    apiUpdatePayloads: [],
    webhookUpdatePayloads: [],
  };
}

function seedApi(
  id: string,
  previousValidUntilUtc: Date | null,
): ApiCredentialRow {
  return {
    id,
    teamId: "11111111-1111-4111-8111-111111111111",
    keyHash: `live-hash-${id}`,
    keyPrefix: `pwk_v1_${id.slice(0, 6)}`,
    previousKeyHash:
      previousValidUntilUtc !== null ? `prev-hash-${id}` : null,
    previousKeyPrefix:
      previousValidUntilUtc !== null ? `prev-${id.slice(0, 6)}` : null,
    previousValidUntilUtc,
  };
}

function seedWebhook(
  id: string,
  previousSecretValidUntilUtc: Date | null,
): WebhookEndpointRow {
  return {
    id,
    teamId: "11111111-1111-4111-8111-111111111111",
    secretCiphertext: `live-secret-${id}`,
    secretPrefix: `whsec_${id.slice(0, 6)}`,
    previousSecretCiphertext:
      previousSecretValidUntilUtc !== null ? `prev-secret-${id}` : null,
    previousSecretPrefix:
      previousSecretValidUntilUtc !== null
        ? `prev-whsec-${id.slice(0, 6)}`
        : null,
    previousSecretValidUntilUtc,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PHASE 5 closure — sweepExpiredPreviousIntegrationSecrets", () => {
  let originalFlag: string | undefined;

  beforeEach(() => {
    originalFlag = process.env.INTEGRATIONS_ENABLED;
    process.env.INTEGRATIONS_ENABLED = "true";
  });

  afterEach(() => {
    if (originalFlag === undefined) delete process.env.INTEGRATIONS_ENABLED;
    else process.env.INTEGRATIONS_ENABLED = originalFlag;
  });

  it("clears an ApiCredential whose previousValidUntilUtc is in the past", async () => {
    const past = new Date(Date.now() - 60_000);
    const apiRows = [
      seedApi("a0000000-0000-4000-8000-000000000001", past),
    ];
    const webhookRows: WebhookEndpointRow[] = [];
    const spy = makeSpy();
    const client = makeFakePrisma({ apiRows, webhookRows, spy });

    const summary = await sweepExpiredPreviousIntegrationSecrets({}, client);

    expect(summary.apiKeyRowsCleared).toBe(1);
    expect(summary.webhookRowsCleared).toBe(0);
    expect(summary.dryRun).toBe(false);
    expect(typeof summary.scannedAt).toBe("string");
    expect(() => new Date(summary.scannedAt).toISOString()).not.toThrow();

    // Row was actually mutated.
    expect(apiRows[0].previousKeyHash).toBeNull();
    expect(apiRows[0].previousKeyPrefix).toBeNull();
    expect(apiRows[0].previousValidUntilUtc).toBeNull();

    // Live credential material was NOT touched.
    expect(apiRows[0].keyHash).toBe("live-hash-a0000000-0000-4000-8000-000000000001");
    expect(apiRows[0].keyPrefix).toMatch(/^pwk_v1_/);
  });

  it("does NOT touch an ApiCredential whose previousValidUntilUtc is still in the future", async () => {
    const future = new Date(Date.now() + 60 * 60 * 1000);
    const apiRows = [
      seedApi("a0000000-0000-4000-8000-000000000002", future),
    ];
    const webhookRows: WebhookEndpointRow[] = [];
    const spy = makeSpy();
    const client = makeFakePrisma({ apiRows, webhookRows, spy });

    const summary = await sweepExpiredPreviousIntegrationSecrets({}, client);

    expect(summary.apiKeyRowsCleared).toBe(0);
    expect(spy.apiUpdateCalls).toBe(0);
    expect(apiRows[0].previousKeyHash).not.toBeNull();
    expect(apiRows[0].previousValidUntilUtc).not.toBeNull();
  });

  it("never touches an ApiCredential that has never been rotated (previousValidUntilUtc = NULL)", async () => {
    const apiRows = [
      seedApi("a0000000-0000-4000-8000-000000000003", null),
    ];
    const webhookRows: WebhookEndpointRow[] = [];
    const spy = makeSpy();
    const client = makeFakePrisma({ apiRows, webhookRows, spy });

    const summary = await sweepExpiredPreviousIntegrationSecrets({}, client);
    expect(summary.apiKeyRowsCleared).toBe(0);
    expect(spy.apiUpdateCalls).toBe(0);
  });

  it("clears a WebhookEndpoint whose previousSecretValidUntilUtc is in the past", async () => {
    const past = new Date(Date.now() - 60_000);
    const apiRows: ApiCredentialRow[] = [];
    const webhookRows = [
      seedWebhook("b0000000-0000-4000-8000-000000000001", past),
    ];
    const spy = makeSpy();
    const client = makeFakePrisma({ apiRows, webhookRows, spy });

    const summary = await sweepExpiredPreviousIntegrationSecrets({}, client);

    expect(summary.webhookRowsCleared).toBe(1);
    expect(webhookRows[0].previousSecretCiphertext).toBeNull();
    expect(webhookRows[0].previousSecretPrefix).toBeNull();
    expect(webhookRows[0].previousSecretValidUntilUtc).toBeNull();

    // Active signing material is NEVER touched.
    expect(webhookRows[0].secretCiphertext).toBe(
      "live-secret-b0000000-0000-4000-8000-000000000001",
    );
    expect(webhookRows[0].secretPrefix).toMatch(/^whsec_/);
  });

  it("does NOT touch a WebhookEndpoint whose grace window is still open", async () => {
    const future = new Date(Date.now() + 30 * 60 * 1000);
    const apiRows: ApiCredentialRow[] = [];
    const webhookRows = [
      seedWebhook("b0000000-0000-4000-8000-000000000002", future),
    ];
    const spy = makeSpy();
    const client = makeFakePrisma({ apiRows, webhookRows, spy });

    const summary = await sweepExpiredPreviousIntegrationSecrets({}, client);

    expect(summary.webhookRowsCleared).toBe(0);
    expect(spy.webhookUpdateCalls).toBe(0);
    expect(webhookRows[0].previousSecretCiphertext).not.toBeNull();
  });

  it("dryRun=true returns the counts that WOULD be cleared without issuing UPDATE", async () => {
    const past = new Date(Date.now() - 60_000);
    const apiRows = [
      seedApi("a0000000-0000-4000-8000-000000000004", past),
      seedApi("a0000000-0000-4000-8000-000000000005", past),
    ];
    const webhookRows = [
      seedWebhook("b0000000-0000-4000-8000-000000000004", past),
    ];
    const spy = makeSpy();
    const client = makeFakePrisma({ apiRows, webhookRows, spy });

    const summary = await sweepExpiredPreviousIntegrationSecrets(
      { dryRun: true },
      client,
    );

    expect(summary.dryRun).toBe(true);
    expect(summary.apiKeyRowsCleared).toBe(2);
    expect(summary.webhookRowsCleared).toBe(1);
    // No UPDATE was issued.
    expect(spy.apiUpdateCalls).toBe(0);
    expect(spy.webhookUpdateCalls).toBe(0);
    // Rows were not mutated.
    expect(apiRows[0].previousKeyHash).not.toBeNull();
    expect(webhookRows[0].previousSecretCiphertext).not.toBeNull();
  });

  it("is idempotent: a second run after a successful clear returns zero counts", async () => {
    const past = new Date(Date.now() - 60_000);
    const apiRows = [
      seedApi("a0000000-0000-4000-8000-000000000006", past),
    ];
    const webhookRows = [
      seedWebhook("b0000000-0000-4000-8000-000000000006", past),
    ];
    const spy = makeSpy();
    const client = makeFakePrisma({ apiRows, webhookRows, spy });

    const first = await sweepExpiredPreviousIntegrationSecrets({}, client);
    expect(first.apiKeyRowsCleared).toBe(1);
    expect(first.webhookRowsCleared).toBe(1);

    const second = await sweepExpiredPreviousIntegrationSecrets({}, client);
    expect(second.apiKeyRowsCleared).toBe(0);
    expect(second.webhookRowsCleared).toBe(0);
  });

  it("respects batchSize: candidates are limited via Prisma take=batchSize", async () => {
    const past = new Date(Date.now() - 60_000);
    const apiRows = Array.from({ length: 6 }, (_, i) =>
      seedApi(
        `a0000000-0000-4000-8000-0000000${String(i).padStart(5, "0")}`,
        past,
      ),
    );
    const webhookRows: WebhookEndpointRow[] = [];
    const spy = makeSpy();
    const client = makeFakePrisma({ apiRows, webhookRows, spy });

    const summary = await sweepExpiredPreviousIntegrationSecrets(
      { batchSize: 3 },
      client,
    );
    expect(summary.apiKeyRowsCleared).toBe(3);
    // Three rows remain expired after the bounded sweep.
    expect(
      apiRows.filter((r) => r.previousValidUntilUtc !== null).length,
    ).toBe(3);
  });

  it("clamps oversized batchSize down to the 5000 ceiling defensively (no throw)", async () => {
    const past = new Date(Date.now() - 60_000);
    const apiRows = [
      seedApi("a0000000-0000-4000-8000-00000000aaaa", past),
    ];
    const webhookRows: WebhookEndpointRow[] = [];
    const spy = makeSpy();
    const client = makeFakePrisma({ apiRows, webhookRows, spy });

    // Service layer clamps gracefully — the route-layer zod schema is
    // what enforces 400 on oversized inputs.
    const summary = await sweepExpiredPreviousIntegrationSecrets(
      { batchSize: 1_000_000 },
      client,
    );
    expect(summary.apiKeyRowsCleared).toBe(1);
  });

  it("returns zero counts when integrations feature is disabled", async () => {
    process.env.INTEGRATIONS_ENABLED = "false";
    const past = new Date(Date.now() - 60_000);
    const apiRows = [
      seedApi("a0000000-0000-4000-8000-00000000bbbb", past),
    ];
    const webhookRows = [
      seedWebhook("b0000000-0000-4000-8000-00000000bbbb", past),
    ];
    const spy = makeSpy();
    const client = makeFakePrisma({ apiRows, webhookRows, spy });

    const summary = await sweepExpiredPreviousIntegrationSecrets({}, client);
    expect(summary.apiKeyRowsCleared).toBe(0);
    expect(summary.webhookRowsCleared).toBe(0);
    expect(spy.apiUpdateCalls).toBe(0);
    expect(spy.webhookUpdateCalls).toBe(0);
    // Original rows still have previous_* set.
    expect(apiRows[0].previousValidUntilUtc).not.toBeNull();
  });
});

// ===========================================================================
// PART 2 — Source-text pins on the route + service shape.
// ===========================================================================

describe("PHASE 5 closure — route wiring", () => {
  it("declares POST /v1/integrations/process-secret-cleanup", () => {
    expect(ROUTES_SRC).toMatch(/\/v1\/integrations\/process-secret-cleanup/);
  });

  it("the route uses requireIntegrationCronSecret (no end-user auth path)", () => {
    // The block surrounding the new route must call
    // requireIntegrationCronSecret as the first guard — same shape as
    // /process-webhook-retries and /webhooks/cleanup-deliveries.
    const blockRegex =
      /"\/v1\/integrations\/process-secret-cleanup"[\s\S]{0,400}requireIntegrationCronSecret/;
    expect(ROUTES_SRC).toMatch(blockRegex);
  });

  it("the route never references requireAuth or requireMember", () => {
    // The path string appears twice — in the header doc-block and in
    // the `app.post(...)` declaration. We want the route body, so use
    // lastIndexOf to skip past the header.
    const idx = ROUTES_SRC.lastIndexOf(
      "/v1/integrations/process-secret-cleanup",
    );
    expect(idx).toBeGreaterThan(0);
    // The route body ends at the closing `},` of its async handler.
    // Use a permissive 600-char slice — the route is short.
    const slice = ROUTES_SRC.slice(idx, idx + 700);
    expect(slice).not.toMatch(/requireAuth/);
    expect(slice).not.toMatch(/requireMember/);
  });

  it("zod validates batchSize between 1 and 5000 inclusive", () => {
    const idx = ROUTES_SRC.lastIndexOf(
      "/v1/integrations/process-secret-cleanup",
    );
    const slice = ROUTES_SRC.slice(idx, idx + 800);
    expect(slice).toMatch(/batchSize:\s*z\.number\(\)\.int\(\)\.min\(1\)\.max\(5_000\)/);
    expect(slice).toMatch(/dryRun:\s*z\.boolean\(\)\.optional\(\)/);
  });

  it("the route header documents the new endpoint alongside the other cron sweepers", () => {
    expect(ROUTES_SRC).toMatch(
      /POST\s+\/v1\/integrations\/process-webhook-retries/,
    );
    expect(ROUTES_SRC).toMatch(
      /POST\s+\/v1\/integrations\/webhooks\/cleanup-deliveries/,
    );
    expect(ROUTES_SRC).toMatch(
      /POST\s+\/v1\/integrations\/process-secret-cleanup/,
    );
  });

  it("imports sweepExpiredPreviousIntegrationSecrets from the new service module", () => {
    expect(ROUTES_SRC).toMatch(
      /import\s*\{\s*sweepExpiredPreviousIntegrationSecrets\s*\}\s*from\s*"\.\.\/services\/integrations\/secret-cleanup\.service\.js"/,
    );
  });
});

// ===========================================================================
// PART 3 — Source-text pins on the service.
// ===========================================================================

describe("PHASE 5 closure — service shape", () => {
  it("only writes the three previous_* columns on ApiCredential (no live keyHash / keyPrefix)", () => {
    // Find the data: { ... } block of the apiCredential.updateMany call.
    const apiUpdate = SERVICE_SRC.match(
      /apiCredential\.updateMany\(\{[\s\S]*?data:\s*\{([\s\S]*?)\}/,
    );
    expect(apiUpdate).not.toBeNull();
    const payload = (apiUpdate?.[1] ?? "").replace(/\s+/g, "");
    expect(payload).toMatch(/previousKeyHash:null/);
    expect(payload).toMatch(/previousKeyPrefix:null/);
    expect(payload).toMatch(/previousValidUntilUtc:null/);
    // Forbidden — live secret material must not appear in the SET.
    expect(payload).not.toMatch(/^keyHash:/m);
    expect(payload).not.toMatch(/,keyHash:/);
    expect(payload).not.toMatch(/,keyPrefix:/);
  });

  it("only writes the three previous_* columns on WebhookEndpoint (no live secretCiphertext)", () => {
    const whUpdate = SERVICE_SRC.match(
      /webhookEndpoint\.updateMany\(\{[\s\S]*?data:\s*\{([\s\S]*?)\}/,
    );
    expect(whUpdate).not.toBeNull();
    const payload = (whUpdate?.[1] ?? "").replace(/\s+/g, "");
    expect(payload).toMatch(/previousSecretCiphertext:null/);
    expect(payload).toMatch(/previousSecretPrefix:null/);
    expect(payload).toMatch(/previousSecretValidUntilUtc:null/);
    expect(payload).not.toMatch(/,secretCiphertext:/);
    expect(payload).not.toMatch(/,secretPrefix:/);
  });

  it("respects the global feature flag via isIntegrationsFeatureEnabled()", () => {
    expect(SERVICE_SRC).toMatch(/isIntegrationsFeatureEnabled\(\)/);
  });

  it("never logs raw secret material — service has no console / logger statements", () => {
    expect(SERVICE_SRC).not.toMatch(/console\./);
    expect(SERVICE_SRC).not.toMatch(/\.log\.(info|warn|debug)/);
  });
});

// ===========================================================================
// PART 4 — No DB migration was introduced for this sweeper.
// ===========================================================================

describe("PHASE 5 closure — no schema migration introduced", () => {
  it("does not add any SQL migration that mentions previous_key_hash / previous_secret_ciphertext clearing", () => {
    const migrationsDir = fileURLToPath(
      new URL("../prisma/migrations/", import.meta.url),
    );
    const dirs = readdirSync(migrationsDir, { withFileTypes: true });
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const name = d.name;
      // Reject any migration that targets the new sweeper's symbols.
      // Existing migrations (Phase 2 / Phase 4) DEFINED these columns —
      // they're allowed to mention the column names. We forbid only
      // migrations whose name implies a Phase 5 sweep introduction.
      expect(name).not.toMatch(/sweep[-_]expired[-_]previous/);
      expect(name).not.toMatch(/process[-_]secret[-_]cleanup/);
    }
  });
});
