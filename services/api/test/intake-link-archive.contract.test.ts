/**
 * Intake Links Operations Console — archive endpoint source-contract.
 *
 * Pins the contract for the new POST /v1/workflow/intake-links/:id/
 * archive | /unarchive endpoints plus the supporting service-layer
 * + schema changes.
 *
 * Critical invariants (matches the Operations Console design brief):
 *   1. Archive is ORTHOGONAL to revoke. The service must write only
 *      archivedAtUtc/archivedByUserId — never touch link.status. A
 *      revoked link can be archived; an active link can be archived.
 *   2. Both endpoints require admin role (same as revoke) and are
 *      audited via appendPlatformAuditLog.
 *   3. List endpoint accepts ?archiveScope=active|archived|all and
 *      defaults to "active" so prior callers see no change.
 *   4. Operations Console projection includes link.archivedAtUtc so
 *      the UI can render the Archived tab and chip.
 *   5. There is NO DELETE endpoint — the design brief explicitly
 *      omits hard delete because revoke + archive achieves the
 *      operator's goal without destroying the audit trail.
 */

import { strict as assert } from "node:assert";
import { readFileSync, existsSync } from "node:fs";
import { describe, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), "..", "..", "..");
const ROUTES = resolve(
  REPO_ROOT,
  "services/api/src/routes/workflow-intake-links.routes.ts",
);
const SERVICE = resolve(
  REPO_ROOT,
  "services/api/src/services/workflow-intake-link.service.ts",
);
const LIFECYCLE = resolve(
  REPO_ROOT,
  "services/api/src/services/intake-link-lifecycle.service.ts",
);
const SCHEMA = resolve(REPO_ROOT, "services/api/prisma/schema.prisma");
const MIGRATION = resolve(
  REPO_ROOT,
  "services/api/prisma/migrations/20270824000000_intake_link_archive/migration.sql",
);

function read(p: string): string {
  return readFileSync(p, "utf8");
}

describe("Pin 1 — schema + migration", () => {
  it("WorkflowIntakeLink declares archivedAtUtc + archivedByUserId", () => {
    const src = read(SCHEMA);
    assert.match(
      src,
      /archivedAtUtc\s+DateTime\?\s+@map\("archived_at_utc"\)\s+@db\.Timestamptz\(6\)/,
    );
    assert.match(
      src,
      /archivedByUserId\s+String\?\s+@map\("archived_by_user_id"\)\s+@db\.Uuid/,
    );
  });

  it("WorkflowIntakeLink indexes (teamId, archivedAtUtc) so the Active default-view query is cheap", () => {
    const src = read(SCHEMA);
    assert.match(src, /@@index\(\[teamId, archivedAtUtc\]\)/);
  });

  it("Migration adds both columns idempotently and creates the index with the Phase O-Final guard", () => {
    assert.ok(existsSync(MIGRATION), "archive migration file missing");
    const src = read(MIGRATION);
    assert.match(
      src,
      /ADD COLUMN IF NOT EXISTS "archived_at_utc"\s+TIMESTAMPTZ\(6\)/,
    );
    assert.match(
      src,
      /ADD COLUMN IF NOT EXISTS "archived_by_user_id" UUID/,
    );
    // Index wrapped in information_schema.columns existence check —
    // Phase O-Final pattern, see test/phase-o-migration-safety-gate.
    assert.match(src, /DO \$\$/);
    assert.match(src, /information_schema\.columns/);
    assert.match(
      src,
      /CREATE INDEX IF NOT EXISTS "workflow_intake_links_team_archived_idx"/,
    );
  });
});

describe("Pin 2 — service layer is orthogonal to revoke", () => {
  it("archiveWorkflowIntakeLink writes ONLY archivedAtUtc + archivedByUserId (NEVER status)", () => {
    const src = read(SERVICE);
    const fnIdx = src.indexOf("export async function archiveWorkflowIntakeLink");
    assert.ok(fnIdx > 0, "archive service fn missing");
    // Find the function's closing brace. The literal "\n}\n" misses
    // on CRLF-checked-out files (Windows working copies), where the
    // pattern is "\r\n}\r\n". Use a regex anchored after fnIdx that
    // accepts either line ending so the test works on every OS the
    // repo is cloned onto.
    const endMatch = src.slice(fnIdx).search(/\r?\n\}\r?\n/);
    const end = endMatch === -1 ? -1 : fnIdx + endMatch + 2;
    const body = src.slice(fnIdx, end);
    assert.match(body, /archivedAtUtc: new Date\(\)/);
    assert.match(body, /archivedByUserId: input\.actorUserId/);
    // Critical — must not mutate link.status. Archive ≠ revoke.
    assert.ok(
      !/data:\s*\{[\s\S]*?status\s*:/.test(body),
      "archive must NOT change link.status — revoke is the separate destructive action",
    );
  });

  it("unarchiveWorkflowIntakeLink nulls both archive columns and leaves status alone", () => {
    const src = read(SERVICE);
    const fnIdx = src.indexOf("export async function unarchiveWorkflowIntakeLink");
    assert.ok(fnIdx > 0, "unarchive service fn missing");
    // Find the function's closing brace. The literal "\n}\n" misses
    // on CRLF-checked-out files (Windows working copies), where the
    // pattern is "\r\n}\r\n". Use a regex anchored after fnIdx that
    // accepts either line ending so the test works on every OS the
    // repo is cloned onto.
    const endMatch = src.slice(fnIdx).search(/\r?\n\}\r?\n/);
    const end = endMatch === -1 ? -1 : fnIdx + endMatch + 2;
    const body = src.slice(fnIdx, end);
    assert.match(body, /archivedAtUtc: null/);
    assert.match(body, /archivedByUserId: null/);
    assert.ok(
      !/data:\s*\{[\s\S]*?status\s*:/.test(body),
      "unarchive must NOT change link.status",
    );
  });

  it("both archive/unarchive are idempotent (early-return when state already matches)", () => {
    const src = read(SERVICE);
    const archiveIdx = src.indexOf("archiveWorkflowIntakeLink");
    const unarchiveIdx = src.indexOf("unarchiveWorkflowIntakeLink");
    // Each fn has an early-return guard against the existing
    // archivedAtUtc column being already in the target state.
    assert.match(
      src.slice(archiveIdx, archiveIdx + 600),
      /if \(existing\.archivedAtUtc\) return existing/,
    );
    assert.match(
      src.slice(unarchiveIdx, unarchiveIdx + 600),
      /if \(!existing\.archivedAtUtc\) return existing/,
    );
  });
});

describe("Pin 3 — routes require admin + audit + correct shape", () => {
  it("POST /:id/archive and /unarchive are registered with requireAuth", () => {
    const src = read(ROUTES);
    assert.match(src, /"\/v1\/workflow\/intake-links\/:id\/archive"/);
    assert.match(src, /"\/v1\/workflow\/intake-links\/:id\/unarchive"/);
    // Both must sit behind requireAuth + an admin-role check via
    // requireAdmin(). Source-level pin so a future refactor can't
    // accidentally drop the gate.
    const archiveBlock = src.slice(
      src.indexOf("\"/v1/workflow/intake-links/:id/archive\""),
    );
    assert.match(archiveBlock, /preHandler: requireAuth/);
    assert.match(archiveBlock, /requireAdmin\(req, reply, existing\.teamId\)/);
    const unarchiveBlock = src.slice(
      src.indexOf("\"/v1/workflow/intake-links/:id/unarchive\""),
    );
    assert.match(unarchiveBlock, /preHandler: requireAuth/);
    assert.match(unarchiveBlock, /requireAdmin\(req, reply, existing\.teamId\)/);
  });

  it("both endpoints emit a platform audit log row", () => {
    const src = read(ROUTES);
    assert.match(src, /action: "intake\.link\.archived"/);
    assert.match(src, /action: "intake\.link\.unarchived"/);
  });

  it("ListQuery accepts archiveScope and defaults to 'active' in service-layer", () => {
    const routes = read(ROUTES);
    assert.match(
      routes,
      /archiveScope: z\.enum\(\["active", "archived", "all"\]\)\.optional\(\)/,
    );
    const service = read(SERVICE);
    assert.match(
      service,
      /const archiveScope = input\.archiveScope \?\? "active"/,
    );
  });
});

describe("Pin 4 — projection exposes archivedAtUtc", () => {
  it("IntakeLinkListItem.link declares archivedAtUtc: string | null", () => {
    const src = read(LIFECYCLE);
    // The type literal lives inside the IntakeLinkListItem union; the
    // canonical pin is that the projection assigns archivedAtUtc.
    assert.match(src, /archivedAtUtc: string \| null;/);
    assert.match(
      src,
      /archivedAtUtc: link\.archivedAtUtc\?\.toISOString\(\) \?\? null/,
    );
  });

  it("projectWorkflowIntakeLink also surfaces archivedAtUtc (so the create-response shape carries it)", () => {
    const src = read(SERVICE);
    const fnIdx = src.indexOf("export function projectWorkflowIntakeLink");
    assert.ok(fnIdx > 0);
    const body = src.slice(fnIdx, fnIdx + 2000);
    assert.match(body, /archivedAtUtc: link\.archivedAtUtc\?\.toISOString\(\) \?\? null/);
  });
});

describe("Pin 5 — no general DELETE endpoint", () => {
  it("the routes file does NOT register a generic DELETE /v1/workflow/intake-links/:id", () => {
    const src = read(ROUTES);
    // The Operations Console design brief explicitly omits hard
    // delete. Revoke closes access, archive declutters; together
    // they cover the operator workflow without destroying the
    // audit trail. Pin: nothing in the routes file may bind a
    // `delete` verb to the intake-links resource.
    assert.ok(
      !/app\.delete\(\s*['"]\/v1\/workflow\/intake-links/.test(src),
      "no DELETE endpoint allowed — revoke + archive cover the workflow",
    );
  });
});
