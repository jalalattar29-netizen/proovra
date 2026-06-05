/**
 * PHASE 2 — Integrations api-key routes contract test.
 *
 * Pins the wire shape and security/audit posture of the four PHASE 2 routes
 * by reading the source file. Avoids a full Fastify spin-up while still
 * catching unintentional regressions (e.g. an admin removing the audit
 * emission, dropping step-up, leaking the secret in metadata).
 *
 *   POST   /v1/integrations/api-keys/:id/rotate
 *   PATCH  /v1/integrations/api-keys/:id          (expiry management)
 *   POST   /v1/integrations/api-keys/:id/revoke   (now emits audit)
 *   POST   /v1/integrations/api-keys              (now emits audit)
 *
 * Also pins the audit metadata invariants — the keyHash / previousKeyHash /
 * raw key MUST NEVER appear in the TeamActivity metadata payload.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readApi(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../${rel}`, import.meta.url)),
    "utf8",
  );
}

const ROUTES = readApi("src/routes/integrations.routes.ts");
const SERVICE = readApi("src/services/integrations/api-keys.service.ts");
const SCHEMA = readApi("prisma/schema.prisma");
const PAGE = readFileSync(
  fileURLToPath(
    new URL(
      "../../../apps/web/app/(app)/integrations/page.tsx",
      import.meta.url,
    ),
  ),
  "utf8",
);

describe("PHASE 2 — schema migration carries the dual-active columns", () => {
  it("adds previousKeyHash, previousKeyPrefix, previousValidUntilUtc as nullable fields", () => {
    expect(SCHEMA).toMatch(/previousKeyHash\s+String\?/);
    expect(SCHEMA).toMatch(/previousKeyPrefix\s+String\?/);
    expect(SCHEMA).toMatch(/previousValidUntilUtc\s+DateTime\?/);
  });

  it("indexes previousValidUntilUtc to support cron-driven cleanup", () => {
    expect(SCHEMA).toMatch(/@@index\(\[previousValidUntilUtc\]\)/);
  });
});

describe("PHASE 2 — service rotation contract", () => {
  it("exports MAX_ROTATION_GRACE_MINUTES bounded to 24h", () => {
    expect(SERVICE).toMatch(/MAX_ROTATION_GRACE_MINUTES\s*=\s*24\s*\*\s*60/);
  });

  it("rotateApiCredential writes previous_* atomically with the new keyHash", () => {
    // The update payload must contain BOTH the new keyHash AND the previous_*
    // triple in the SAME `data:` block so no consumer can observe a
    // half-rotated row.
    const rotateMatch = SERVICE.match(
      /rotateApiCredential[\s\S]+?client\.apiCredential\.update\(\{[\s\S]+?data:\s*\{([\s\S]+?)\}\,\s*\}\)/,
    );
    expect(rotateMatch).not.toBeNull();
    const data = rotateMatch![1];
    expect(data).toMatch(/keyHash:\s*issued\.keyHash/);
    expect(data).toMatch(/keyPrefix:\s*issued\.keyPrefix/);
    expect(data).toMatch(/previousKeyHash:\s*existing\.keyHash/);
    expect(data).toMatch(/previousKeyPrefix:\s*existing\.keyPrefix/);
    expect(data).toMatch(/previousValidUntilUtc/);
    expect(data).toMatch(/rotationRequired:\s*false/);
  });

  it("revokeApiCredential clears previous_* so old key cannot replay through grace", () => {
    const revokeMatch = SERVICE.match(
      /revokeApiCredential[\s\S]+?return\s+client\.apiCredential\.update\(\{[\s\S]+?data:\s*\{([\s\S]+?)\}\,\s*\}\)/,
    );
    expect(revokeMatch).not.toBeNull();
    const data = revokeMatch![1];
    expect(data).toMatch(/status:\s*"REVOKED"/);
    expect(data).toMatch(/previousKeyHash:\s*null/);
    expect(data).toMatch(/previousKeyPrefix:\s*null/);
    expect(data).toMatch(/previousValidUntilUtc:\s*null/);
  });

  it("verify path looks up by previousKeyHash and enforces the grace cutoff", () => {
    expect(SERVICE).toMatch(/previousKeyHash:\s*hash/);
    expect(SERVICE).toMatch(/previousValidUntilUtc[\s\S]{0,60}getTime\(\)/);
    // Stale previous_* are lazily cleared on rejection.
    expect(SERVICE).toMatch(
      /previousKeyHash:\s*null[\s\S]{0,200}previousValidUntilUtc:\s*null/,
    );
  });

  it("matchedPrevious flips rotationRequired=true on the response credential", () => {
    expect(SERVICE).toMatch(
      /rotationRequired:\s*matchedPrevious\s*\?\s*true\s*:\s*row\.rotationRequired/,
    );
  });

  it("projection surfaces previousKeyPrefix + previousValidUntilUtc, never the hash", () => {
    expect(SERVICE).toMatch(/previousKeyPrefix:\s*c\.previousKeyPrefix\s*\?\?\s*null/);
    expect(SERVICE).toMatch(/previousValidUntilUtc:\s*c\.previousValidUntilUtc/);
    // Hard rule: keyHash and previousKeyHash MUST NOT appear in the
    // returned projection object literal. Search the projectApiCredential
    // body specifically.
    const projMatch = SERVICE.match(
      /export function projectApiCredential[\s\S]+?return\s*\{([\s\S]+?)\}\;\s*\}/,
    );
    expect(projMatch).not.toBeNull();
    const body = projMatch![1];
    expect(body).not.toMatch(/keyHash:/);
    expect(body).not.toMatch(/previousKeyHash:/);
  });
});

describe("PHASE 2 — rotate route", () => {
  it("declares the POST /v1/integrations/api-keys/:id/rotate route", () => {
    expect(ROUTES).toMatch(
      /app\.post\(\s*"\/v1\/integrations\/api-keys\/:id\/rotate"/,
    );
  });

  it("requires requireAuth + workspace membership + manage permission", () => {
    const rotMatch = ROUTES.match(
      /app\.post\(\s*"\/v1\/integrations\/api-keys\/:id\/rotate"[\s\S]+?(?=app\.(?:post|patch|get|put|delete)\(|\Z)/,
    );
    expect(rotMatch).not.toBeNull();
    const body = rotMatch![0];
    expect(body).toMatch(/preHandler:\s*requireAuth/);
    expect(body).toMatch(/requireMember\(/);
    expect(body).toMatch(/requirePermission\([^,]+,\s*"integration\.api_key\.manage"\)/);
  });

  it("requires step-up for the rotation flow (same posture as create/revoke)", () => {
    const rotMatch = ROUTES.match(
      /app\.post\(\s*"\/v1\/integrations\/api-keys\/:id\/rotate"[\s\S]+?(?=app\.(?:post|patch|get|put|delete)\(|\Z)/,
    );
    expect(rotMatch).not.toBeNull();
    expect(rotMatch![0]).toMatch(/requireStepUpForSensitiveAction\(/);
  });

  it("validates graceMinutes is bounded by MAX_ROTATION_GRACE_MINUTES", () => {
    const rotMatch = ROUTES.match(
      /app\.post\(\s*"\/v1\/integrations\/api-keys\/:id\/rotate"[\s\S]+?(?=app\.(?:post|patch|get|put|delete)\(|\Z)/,
    );
    expect(rotMatch![0]).toMatch(
      /graceMinutes:\s*z[\s\S]{0,200}\.max\(MAX_ROTATION_GRACE_MINUTES\)/,
    );
  });

  it("emits an integration.api_key.rotated audit event", () => {
    const rotMatch = ROUTES.match(
      /app\.post\(\s*"\/v1\/integrations\/api-keys\/:id\/rotate"[\s\S]+?(?=app\.(?:post|patch|get|put|delete)\(|\Z)/,
    );
    expect(rotMatch![0]).toMatch(
      /emitApiKeyAudit\(\{[\s\S]+?eventType:\s*"integration\.api_key\.rotated"/,
    );
  });

  it("surfaces the new raw key + previous prefix + grace cutoff in the response", () => {
    const rotMatch = ROUTES.match(
      /app\.post\(\s*"\/v1\/integrations\/api-keys\/:id\/rotate"[\s\S]+?(?=app\.(?:post|patch|get|put|delete)\(|\Z)/,
    );
    const body = rotMatch![0];
    expect(body).toMatch(/rawKey:\s*result\.rawKey/);
    expect(body).toMatch(/previousKeyPrefix:\s*result\.previousKeyPrefix/);
    expect(body).toMatch(
      /previousValidUntilUtc:\s*result\.previousValidUntilUtc\.toISOString\(\)/,
    );
  });
});

describe("PHASE 2 — expiry PATCH route", () => {
  it("declares the PATCH /v1/integrations/api-keys/:id route", () => {
    expect(ROUTES).toMatch(/app\.patch\(\s*"\/v1\/integrations\/api-keys\/:id"/);
  });

  it("emits an integration.api_key.expiry_changed audit event", () => {
    const patchMatch = ROUTES.match(
      /app\.patch\(\s*"\/v1\/integrations\/api-keys\/:id"[\s\S]+?(?=app\.(?:post|patch|get|put|delete)\(|\Z)/,
    );
    expect(patchMatch).not.toBeNull();
    expect(patchMatch![0]).toMatch(
      /emitApiKeyAudit\(\{[\s\S]+?eventType:\s*"integration\.api_key\.expiry_changed"/,
    );
  });
});

describe("PHASE 2 — create + revoke now emit audit events", () => {
  it("POST /v1/integrations/api-keys emits integration.api_key.created", () => {
    expect(ROUTES).toMatch(
      /eventType:\s*"integration\.api_key\.created"[\s\S]{0,400}keyPrefix:/,
    );
  });

  it("POST /v1/integrations/api-keys/:id/revoke emits integration.api_key.revoked with persisted reason", () => {
    expect(ROUTES).toMatch(
      /eventType:\s*"integration\.api_key\.revoked"[\s\S]{0,400}reason:\s*revoked\.revokedReason/,
    );
  });
});

describe("PHASE 2 — audit metadata never carries the raw key or hash", () => {
  it("emitApiKeyAudit call sites only persist operator-visible prefixes / counts", () => {
    // Hard rule: NO call site to emitApiKeyAudit may pass `rawKey` or
    // `keyHash` (or the previousKeyHash) in the metadata payload.
    // The keyPrefix and previousKeyPrefix are intentionally allowed.
    const callSites = [...ROUTES.matchAll(/emitApiKeyAudit\(\{[\s\S]+?\}\)/g)];
    expect(callSites.length).toBeGreaterThanOrEqual(4);
    for (const m of callSites) {
      const body = m[0];
      expect(body).not.toMatch(/\brawKey\b/);
      expect(body).not.toMatch(/keyHash/);
    }
  });
});

describe("PHASE 2 — page.tsx surfaces canonical list columns + modals", () => {
  it("renders the ApiKeysTable component", () => {
    expect(PAGE).toMatch(/<ApiKeysTable[\s\S]+?rows=\{apiKeys\}/);
    expect(PAGE).toMatch(/function ApiKeysTable\(/);
  });

  it("declares the RevokeApiKeyDialog and surfaces a reason textarea", () => {
    expect(PAGE).toMatch(/function RevokeApiKeyDialog\(/);
    expect(PAGE).toMatch(/integrations-api-key-revoke-reason/);
  });

  it("declares the RotateApiKeyDialog with grace presets", () => {
    expect(PAGE).toMatch(/function RotateApiKeyDialog\(/);
    expect(PAGE).toMatch(/integrations-api-key-rotate-confirm/);
    expect(PAGE).toMatch(/ROTATION_GRACE_PRESETS/);
  });

  it("declares the ApiKeyExpiryDialog with set + clear actions", () => {
    expect(PAGE).toMatch(/function ApiKeyExpiryDialog\(/);
    expect(PAGE).toMatch(/integrations-api-key-expiry-clear/);
    expect(PAGE).toMatch(/integrations-api-key-expiry-save/);
  });

  it("declares the ApiKeyUsageDialog and consumes /v1/integrations/api-keys/:id/usage", () => {
    expect(PAGE).toMatch(/function ApiKeyUsageDialog\(/);
    expect(PAGE).toMatch(/\/v1\/integrations\/api-keys\/\$\{id\}\/usage/);
  });

  it("rotation success surfaces the new raw key via the disclosure banner exactly once", () => {
    expect(PAGE).toMatch(
      /kind:\s*"api_key_rotated"[\s\S]{0,200}rawKey:\s*res\.rawKey/,
    );
    expect(PAGE).toMatch(/integrations-rotation-grace-hint/);
  });

  it("never renders raw JSON for the usage / rotation / revoke flow", () => {
    // Hard rule: no JSON.stringify in the new components. The styled
    // panels render the structured fields directly.
    const newComponents = [
      "ApiKeysTable",
      "RevokeApiKeyDialog",
      "RotateApiKeyDialog",
      "ApiKeyExpiryDialog",
      "ApiKeyUsageDialog",
    ];
    for (const name of newComponents) {
      const startIdx = PAGE.indexOf(`function ${name}(`);
      expect(startIdx).toBeGreaterThan(-1);
      const slice = PAGE.slice(startIdx, startIdx + 3000);
      expect(slice).not.toMatch(/JSON\.stringify/);
      expect(slice).not.toMatch(/<pre>/);
    }
  });

  it("surfaces rotation-required indicator + expiry status + IP allowlist count on rows", () => {
    const startIdx = PAGE.indexOf("function ApiKeysTable(");
    const slice = PAGE.slice(startIdx, startIdx + 5000);
    expect(slice).toMatch(/rotationRequired/);
    expect(slice).toMatch(/no expiry|expires/);
    expect(slice).toMatch(/IP allowlist/);
    expect(slice).toMatch(/createdAt/);
    expect(slice).toMatch(/lastUsedAtUtc|last used|never used/);
    expect(slice).toMatch(/Revoked reason/);
  });
});
