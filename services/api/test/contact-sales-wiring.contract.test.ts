/**
 * Phase LC1-LC4 — Contact Sales lead-capture wiring contract.
 *
 * Source-level locks proving the previously-missing /v1/contact-sales
 * pipeline is in place. The previous audit found that submissions to
 * the marketing /api/contact-sales proxy 404'd against the upstream
 * because the route, service, and Prisma model were all missing —
 * every submission was a lead-loss.
 *
 * These tests are file-text contracts (no running DB / Resend) so
 * they can stay green in CI without infra. The end-to-end run
 * happens in dev with `pnpm dev` + the new admin page.
 *
 * Pinned:
 *
 *   1. ContactSalesRequest model + status/priority enums in schema.
 *   2. Migration uses Phase O-Final guarded indexes + IF NOT EXISTS.
 *   3. contact-sales.service.ts persists FIRST, emails best-effort,
 *      logs `tag:"contact_sales_email_skipped"` when Resend isn't
 *      configured, and surfaces auto-reply failure as a separate
 *      warning tag.
 *   4. contact-sales.routes.ts registers POST /v1/contact-sales and
 *      returns 201.
 *   5. server.ts registers contactSalesRoutes + adminContactSalesRoutes.
 *   6. email.service.ts exposes sendContactSalesNotification +
 *      sendContactSalesAutoReply on the EmailService type and both
 *      not-configured stubs + real Resend implementations.
 *   7. admin-contact-sales.routes.ts gates list/detail/patch behind
 *      requirePlatformAdmin.
 */

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const API_ROOT = resolve(__dirname, "..");

function read(rel: string): string {
  return readFileSync(resolve(API_ROOT, rel), "utf8");
}

describe("Contact Sales — Prisma schema + migration", () => {
  const schema = read("prisma/schema.prisma");

  it("declares ContactSalesRequest model bound to contact_sales_requests", () => {
    expect(schema).toMatch(/model ContactSalesRequest \{/);
    expect(schema).toMatch(/@@map\("contact_sales_requests"\)/);
  });

  it("includes every field operators triage from", () => {
    expect(schema).toMatch(/discussion_topic/);
    expect(schema).toMatch(/current_challenge/);
    expect(schema).toMatch(/deployment_timeline/);
    expect(schema).toMatch(/estimated_users/);
    expect(schema).toMatch(/additional_details/);
    expect(schema).toMatch(/email_sent_at/);
    expect(schema).toMatch(/webhook_sent_at/);
  });

  it("declares ContactSalesStatus + ContactSalesPriority enums", () => {
    expect(schema).toMatch(/enum ContactSalesStatus \{[^}]*NEW[^}]*REVIEWED/s);
    expect(schema).toMatch(/enum ContactSalesPriority \{[^}]*LOW[^}]*NORMAL[^}]*HIGH/s);
  });

  it("has a migration file using Phase O-Final guarded indexes", () => {
    const migDir = resolve(
      API_ROOT,
      "prisma/migrations/20270827000000_contact_sales_lead_capture"
    );
    expect(existsSync(migDir)).toBe(true);

    const sql = readFileSync(
      resolve(migDir, "migration.sql"),
      "utf8"
    );
    // additive only — no destructive operations (the literal word
    // "DROP" appears in the migration's safety header comment, so
    // match the SQL action forms instead).
    expect(sql).not.toMatch(/\bDROP\s+(TABLE|COLUMN|INDEX|TYPE|CONSTRAINT)\b/i);
    expect(sql).not.toMatch(/\bRENAME\s+(TABLE|COLUMN|TO)\b/i);
    expect(sql).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(sql).not.toMatch(/\bTRUNCATE\b/i);

    // CREATE TABLE IF NOT EXISTS for idempotency
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS "contact_sales_requests"/);

    // enum types via DO + existence checks
    expect(sql).toMatch(/CREATE TYPE "ContactSalesStatus"/);
    expect(sql).toMatch(/CREATE TYPE "ContactSalesPriority"/);

    // index creation wrapped in DO + information_schema.columns guard
    expect(sql).toMatch(/information_schema\.columns/);
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS "contact_sales_requests_status_created_at_idx"/);
  });
});

describe("Contact Sales — service.ts persistence-first guarantee", () => {
  const svc = read("src/services/contact-sales.service.ts");

  it("validates with zod and throws AppError on invalid input", () => {
    expect(svc).toMatch(/createContactSalesSchema/);
    expect(svc).toMatch(/AppError\(\s*ErrorCode\.VALIDATION_ERROR/);
  });

  it("creates the DB row BEFORE attempting email/webhook", () => {
    const createIdx = svc.indexOf("prisma.contactSalesRequest.create");
    const emailIdx = svc.indexOf("sendContactSalesNotification");
    expect(createIdx).toBeGreaterThan(-1);
    expect(emailIdx).toBeGreaterThan(-1);
    expect(createIdx).toBeLessThan(emailIdx);
  });

  it("falls back through CONTACT_SALES → DEMO_REQUEST → SUPPORT_EMAIL", () => {
    expect(svc).toMatch(/CONTACT_SALES_NOTIFICATION_EMAIL/);
    expect(svc).toMatch(/DEMO_REQUEST_NOTIFICATION_EMAIL/);
    expect(svc).toMatch(/SUPPORT_EMAIL/);
    expect(svc).toMatch(/support@proovra\.com/);
  });

  it("logs operational warnings without exposing field values", () => {
    expect(svc).toMatch(/contact_sales_email_skipped/);
    expect(svc).toMatch(/contact_sales_email_failed/);
    expect(svc).toMatch(/contact_sales_auto_reply_failed/);
    // requestId is OK; full payload values must NOT be logged.
    expect(svc).not.toMatch(
      /console\.warn[\s\S]{0,200}currentChallenge:\s*created/
    );
  });

  it("never throws after a row was successfully created (email fail-soft)", () => {
    // email + auto-reply are wrapped in try/catch; the function still
    // returns ok:true with the new record id.
    expect(svc).toMatch(/try \{[\s\S]+sendContactSalesNotification[\s\S]+\} catch/);
    expect(svc).toMatch(/return \{\s*ok: true,\s*message: "Contact-sales inquiry received\."/);
  });

  it("only stamps emailSentAt after a successful send (not before)", () => {
    expect(svc).toMatch(/emailSentAt = new Date\(\);/);
    // The assignment must be inside the success branch, not before.
    expect(svc).toMatch(
      /await emailService\.sendContactSalesNotification\([\s\S]+?\);\s*emailSentAt = new Date\(\);/
    );
  });
});

describe("Contact Sales — route + server registration", () => {
  it("contact-sales.routes registers POST /v1/contact-sales and returns 201", () => {
    const r = read("src/routes/contact-sales.routes.ts");
    expect(r).toMatch(/app\.post\("\/v1\/contact-sales"/);
    expect(r).toMatch(/reply\.code\(201\)/);
  });

  it("server.ts imports and registers contactSalesRoutes + adminContactSalesRoutes", () => {
    const s = read("src/server.ts");
    expect(s).toMatch(/import \{ contactSalesRoutes \} from/);
    expect(s).toMatch(/import \{ adminContactSalesRoutes \} from/);
    expect(s).toMatch(/await app\.register\(contactSalesRoutes\);/);
    expect(s).toMatch(/await app\.register\(adminContactSalesRoutes\);/);
  });

  it("admin routes are gated by requirePlatformAdmin", () => {
    const a = read("src/routes/admin-contact-sales.routes.ts");
    expect(a).toMatch(/preHandler: requirePlatformAdmin/);
    // list / detail / patch all gated
    const gates = (a.match(/preHandler: requirePlatformAdmin/g) ?? []).length;
    expect(gates).toBeGreaterThanOrEqual(3);
  });
});

describe("Contact Sales — email service surface", () => {
  const e = read("src/services/email.service.ts");

  it("declares both new methods on the EmailService type", () => {
    expect(e).toMatch(/sendContactSalesNotification: \(params: \{/);
    expect(e).toMatch(/sendContactSalesAutoReply: \(params: \{/);
  });

  it("not-configured stub throws with a clear message for both methods", () => {
    expect(e).toMatch(
      /async sendContactSalesNotification\(\) \{\s*throw new Error\("Email service not configured: RESEND_API_KEY missing"\);/
    );
    expect(e).toMatch(
      /async sendContactSalesAutoReply\(\) \{\s*throw new Error\("Email service not configured: RESEND_API_KEY missing"\);/
    );
  });

  it("configured singleton implements both methods via the canonical transport", () => {
    expect(e).toMatch(/async sendContactSalesNotification\(params\) \{/);
    expect(e).toMatch(/async sendContactSalesAutoReply\(params\) \{/);
    // PHASE 12 POINT 5 — every template method now hands off to ONE transport.
    // The check is unchanged in spirit and stronger in fact: it used to count
    // direct `resend.emails.send(` calls, which is exactly the duplicate
    // transport engine that has been removed. There must be no SDK send left
    // in this file at all.
    expect(e).not.toMatch(/resend\.emails\.send\(/);
    const matches = e.match(/transportSend\(\{/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(8); // existing + 2 new
  });
});
