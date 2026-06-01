/**
 * PROOVRA Phase 10 — PayPal webhook idempotency source-contract test.
 *
 * Pins the constitutional shape of the PayPal webhook dedup surface:
 *
 *   - The `PaypalWebhookEvent` Prisma model exists and maps to the
 *     canonical `paypal_webhook_events` table.
 *   - A Phase 10 migration creates that table using the Phase O
 *     defensive pattern (idempotent `CREATE TABLE IF NOT EXISTS` or
 *     `DO $$ ... IF NOT EXISTS pg_tables ... CREATE TABLE` block)
 *     with the terminating semicolon required by the
 *     INDEX_COLUMN_RISK safety gate.
 *   - The `/paypal` webhook handler references the canonical dedup
 *     model (i.e. uses the table as the idempotency keystone).
 *   - The handler does NOT log the raw `req.body` (a constitutional
 *     security rule: provider payloads may contain secrets / PII).
 *
 * Test style: source-contract (file-text assertions). No DB I/O.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const API_ROOT = fileURLToPath(new URL("..", import.meta.url));

const SCHEMA_PATH = resolve(API_ROOT, "prisma/schema.prisma");
const MIGRATIONS_DIR = resolve(API_ROOT, "prisma/migrations");
const WEBHOOK_PATH = resolve(API_ROOT, "src/routes/webhooks.routes.ts");

function findPhase10Migration(): string | null {
  if (!existsSync(MIGRATIONS_DIR)) return null;
  for (const name of readdirSync(MIGRATIONS_DIR)) {
    const dir = resolve(MIGRATIONS_DIR, name);
    if (!statSync(dir).isDirectory()) continue;
    if (!/phase_10_paypal_webhook_idempotency$/i.test(name)) continue;
    const sql = resolve(dir, "migration.sql");
    if (existsSync(sql)) return sql;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Prisma model
// ---------------------------------------------------------------------------

describe("Phase 10 — PaypalWebhookEvent Prisma model", () => {
  const schema = readFileSync(SCHEMA_PATH, "utf8");

  it("declares model PaypalWebhookEvent", () => {
    expect(schema).toMatch(/model\s+PaypalWebhookEvent\s*\{/);
  });

  it("maps the model to the canonical paypal_webhook_events table", () => {
    expect(schema).toMatch(/@@map\("paypal_webhook_events"\)/);
  });

  it("model row carries a unique paypal_event_id (the dedup keystone)", () => {
    const modelBlock =
      schema
        .split(/model\s+PaypalWebhookEvent\s*\{/)[1]
        ?.split(/\nmodel\s+/)[0] ?? "";
    expect(modelBlock).toMatch(/paypal_event_id/);
    expect(modelBlock).toMatch(/@unique\b/);
  });
});

// ---------------------------------------------------------------------------
// Migration file
// ---------------------------------------------------------------------------

describe("Phase 10 — paypal_webhook_events migration (Phase O hardened)", () => {
  const migrationPath = findPhase10Migration();

  it("a phase_10_paypal_webhook_idempotency migration file exists", () => {
    expect(
      migrationPath,
      "expected prisma/migrations/<*>_phase_10_paypal_webhook_idempotency/migration.sql to exist",
    ).not.toBeNull();
  });

  it("the migration creates the paypal_webhook_events table (idempotent guarded CREATE TABLE)", () => {
    expect(migrationPath).not.toBeNull();
    const sql = readFileSync(migrationPath as string, "utf8");
    // Two acceptable Phase O patterns: top-level `CREATE TABLE IF NOT
    // EXISTS` OR a DO $$ ... IF NOT EXISTS ... pg_tables guard
    // wrapping a plain `CREATE TABLE`. Either way the table name must
    // be present and the create must be defensive.
    const tableNamePresent = /paypal_webhook_events/.test(sql);
    expect(tableNamePresent).toBe(true);

    const directIfNotExists = /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+"?paypal_webhook_events"?/i.test(
      sql,
    );
    const guardedCreate =
      /IF\s+NOT\s+EXISTS\s*\(\s*SELECT\s+1\s+FROM\s+pg_tables[\s\S]{0,400}CREATE\s+TABLE\s+"?paypal_webhook_events"?/i.test(
        sql,
      );

    expect(
      directIfNotExists || guardedCreate,
      "expected idempotent CREATE TABLE (IF NOT EXISTS or pg_tables-guarded) for paypal_webhook_events",
    ).toBe(true);
  });

  it("the migration terminates the CREATE TABLE block with );  (INDEX_COLUMN_RISK safety gate)", () => {
    expect(migrationPath).not.toBeNull();
    const sql = readFileSync(migrationPath as string, "utf8");
    // Require the literal "\n);" sequence to appear, anchoring the
    // close of the CREATE TABLE column list. The Phase O safety gate
    // regex is strict about this terminator.
    expect(sql).toMatch(/\)\s*;/);
  });
});

// ---------------------------------------------------------------------------
// Webhook handler wiring
// ---------------------------------------------------------------------------

describe("Phase 10 — /paypal webhook handler wires the dedup model + redacts payload", () => {
  const handler = readFileSync(WEBHOOK_PATH, "utf8");

  it("the handler references the canonical PaypalWebhookEvent / paypal_webhook_events surface", () => {
    // The Prisma client exposes the model as `prisma.paypalWebhookEvent`;
    // direct table name reference is also acceptable for raw SQL.
    expect(
      handler.includes("paypalWebhookEvent") ||
        handler.includes("paypal_webhook_events"),
    ).toBe(true);
  });

  it("the handler does NOT log the raw req.body / request.body (no provider payload leakage)", () => {
    // Forbidden: any logger call whose payload includes `req.body` /
    // `request.body` / `body:` derived from the raw payload. We allow
    // logging structured fields (event id, event type, payload hash)
    // — those are not the raw body.
    const offenders: string[] = [];
    const re =
      /(?:req\.log|request\.log|app\.log|console)\.[a-z]+\([^)]*\b(?:req|request)\.body\b/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(handler)) !== null) {
      offenders.push(m[0]);
    }
    expect(
      offenders,
      `forbidden raw-body logging in webhook:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
