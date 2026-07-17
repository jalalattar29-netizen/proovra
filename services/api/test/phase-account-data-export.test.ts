/**
 * Personal account data export contracts (lifecycle Phase 4, 2026-07-17).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(resolve(HERE, rel), "utf8");
const SERVICE = read("../src/services/identity/account-data-export.service.ts");
const ROUTES = read("../src/routes/account-data-export.routes.ts");
const SCHEDULER = read("../src/services/notifications/digest-scheduler.ts");
const MIGRATION = read(
  "../prisma/migrations/20270919000000_account_data_export_requests/migration.sql",
);

describe("export data boundary", () => {
  it("package gathers ONLY the caller's own account data (every query userId-keyed)", () => {
    // Every findMany/findUnique in the builder is keyed by userId.
    const whereClauses = SERVICE.match(/where:\s*\{[^}]*\}/g) ?? [];
    const builderStart = SERVICE.indexOf("buildAccountExportPackage");
    const builderEnd = SERVICE.indexOf("export async function processAccountDataExports");
    const builder = SERVICE.slice(builderStart, builderEnd);
    for (const w of builder.match(/where:\s*\{[^}]*\}/g) ?? []) {
      expect(w, `unscoped query in export builder: ${w}`).toMatch(/userId/);
    }
    expect(whereClauses.length).toBeGreaterThan(0);
  });

  it("never exports secrets: no passwordHash / secret / recovery / providerSubjectId selected", () => {
    expect(SERVICE).not.toMatch(/passwordHash/);
    expect(SERVICE).not.toMatch(/secretCiphertext|secretIv|secretAuthTag/);
    expect(SERVICE).not.toMatch(/recoveryCode/i);
    expect(SERVICE).not.toMatch(/providerSubjectId:\s*true/);
    // No evidence/org/webhook material.
    expect(SERVICE).not.toMatch(/prisma\.evidence\b/);
    // code path, not prose: no webhook table is queried by the builder
    expect(SERVICE).not.toMatch(/prisma.webhookEndpoint/);
  });

  it("package carries schema version + sha256 checksum + scope statement", () => {
    expect(SERVICE).toMatch(/EXPORT_SCHEMA_VERSION/);
    expect(SERVICE).toMatch(/createHash\("sha256"\)/);
    expect(SERVICE).toMatch(/Personal account data only/);
  });
});

describe("async processing + retention", () => {
  it("generation is claimed atomically (REQUESTED→PROCESSING guarded updateMany)", () => {
    expect(SERVICE).toMatch(/where:\s*\{\s*id:\s*req\.id,\s*status:\s*"REQUESTED"\s*\}/);
    expect(SERVICE).toMatch(/if \(claimed\.count === 0\) continue;/);
  });

  it("expired packages are securely deleted (payload nulled, audit row kept)", () => {
    expect(SERVICE).toMatch(/status:\s*"EXPIRED",\s*packageJson:\s*null,\s*packageSha256:\s*null/);
    expect(SERVICE).not.toMatch(/accountDataExportRequest\.deleteMany/);
  });

  it("processing piggybacks the existing digest cron (no parallel job system)", () => {
    expect(SCHEDULER).toMatch(/processAccountDataExports\(now\)/);
  });

  it("ready + failed outcomes emit identity.* audit events", () => {
    expect(SERVICE).toMatch(/identity\.data_export_ready/);
    expect(SERVICE).toMatch(/identity\.data_export_failed/);
  });
});

describe("routes: step-up + universality + user binding", () => {
  it("request and download are both step-up gated with dedicated actions", () => {
    expect(ROUTES).toMatch(/"data_export_request"/);
    expect(ROUTES).toMatch(/"data_export_download"/);
  });

  it("one active request per user (409 export_request_active)", () => {
    expect(ROUTES).toMatch(/export_request_active/);
    expect(ROUTES).toMatch(/\["REQUESTED", "PROCESSING", "READY"\]/);
  });

  it("download is strictly user-bound and READY-only; no public/signed URL exists", () => {
    expect(ROUTES).toMatch(/where:\s*\{\s*id:\s*params\.id,\s*userId\s*\}/);
    expect(ROUTES).toMatch(/export_not_ready/);
    // code path, not prose: no URL-signing helper exists in the route
    expect(ROUTES).not.toMatch(/presign\(|createSignedUrl|getSignedUrl/);
  });

  it("never plan-gated: no plan/entitlement reads in the export routes", () => {
    // code path, not prose: no plan/entitlement query gates these routes
    expect(ROUTES).not.toMatch(/getPlanCapabilities\(|prisma\.entitlement/);
  });

  it("downloads are counted + audited", () => {
    expect(ROUTES).toMatch(/downloadCount:\s*\{\s*increment:\s*1\s*\}/);
    expect(ROUTES).toMatch(/identity\.data_export_downloaded/);
    expect(ROUTES).toMatch(/identity\.data_export_requested/);
  });
});

describe("migration", () => {
  it("is additive-only", () => {
    expect(MIGRATION).toMatch(/CREATE TABLE IF NOT EXISTS "account_data_export_requests"/);
    expect(MIGRATION).not.toMatch(/DROP |TRUNCATE|DELETE FROM|RENAME/i);
  });
});
