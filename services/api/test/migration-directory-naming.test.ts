/**
 * AUD-50 (2026-10-20) — every migration directory is timestamp-ordered.
 *
 * Prisma applies migrations in directory-name order. `email_password_auth`
 * carries no timestamp, so it sorts AFTER every dated migration and its place
 * in the history is accidental (three early directories carry only a date). It is already applied under that name in
 * every database (`_prisma_migrations.migration_name`), so renaming it would
 * make Prisma treat it as new — it is grandfathered, by exact name, and no new
 * directory may repeat the pattern.
 */
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const DIR = fileURLToPath(new URL("../prisma/migrations", import.meta.url));
// Applied under these exact names everywhere; never renamed, never extended.
const GRANDFATHERED = new Set([
  "email_password_auth",
  "20260407_add_legal_acceptance_and_cookie_consent",
  "20260418_report_snapshot_fields",
  "20260430_add_tsa_input_digest_fields",
]);
// Pairs that share a timestamp (order decided by the suffix); applied, frozen.
const GRANDFATHERED_SHARED_STAMPS = new Set(["20260201120000", "20270829000000", "20270920000000"]);

describe("AUD-50 migration directory naming", () => {
  const dirs = readdirSync(DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);

  it("every migration directory except the grandfathered one starts with a 14-digit timestamp", () => {
    const offenders = dirs.filter((n) => !/^\d{14}_[a-z0-9_]+$/.test(n) && !GRANDFATHERED.has(n));
    expect(offenders).toEqual([]);
  });

  it("the grandfathered exception still exists (an allowlist entry for nothing is a dead exemption)", () => {
    for (const n of GRANDFATHERED) expect(dirs).toContain(n);
  });

  it("no two migrations share a timestamp (order would be decided by the suffix)", () => {
    const stamps = dirs.filter((n) => /^\d{14}_/.test(n)).map((n) => n.slice(0, 14));
    const dupes = stamps.filter((s, i) => stamps.indexOf(s) !== i && !GRANDFATHERED_SHARED_STAMPS.has(s));
    expect(dupes).toEqual([]);
  });
});
