/**
 * PHASE 12 CORRECTIVE PASS §2 — THE GATE THAT KEEPS ONE INVITATION AUTHORITY.
 *
 * The runtime suite proves the duplicate lifecycle columns are gone from a
 * migrated database and that the surviving reader takes its facts from the
 * grant. Neither of those stops the duplicate from being reintroduced: a
 * future schema edit could add `grantState` back to the sidecar, and a future
 * handler could read it, and both would look perfectly reasonable in review.
 *
 * This is the structural half. It reads the schema and the sources and fails
 * if the shape that produced the finding reappears.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const API = path.resolve(HERE, "..");
const read = (rel: string): string => readFileSync(path.join(API, rel), "utf8");

const SCHEMA = read("prisma/schema.prisma");

/** The five columns that duplicated the grant's lifecycle. */
const DUPLICATE_LIFECYCLE_FIELDS = [
  "grantState",
  "rawToken",
  "tokenHash",
  "expiresAtUtc",
  "revokedAtUtc",
] as const;

function modelBody(name: string): string {
  const start = SCHEMA.indexOf(`\nmodel ${name} `);
  if (start < 0) throw new Error(`model ${name} not found in schema`);
  const end = SCHEMA.indexOf("\n}", start);
  return SCHEMA.slice(start, end + 2);
}

describe("§2 — the invitation lifecycle has exactly one authority", () => {
  it("the sidecar model declares no copy of the grant's lifecycle", () => {
    const body = modelBody("ExternalReviewerRoleAssignment");
    const reintroduced = DUPLICATE_LIFECYCLE_FIELDS.filter((f) =>
      new RegExp(`^\\s*${f}\\s`, "m").test(body),
    );
    expect(
      reintroduced,
      `ExternalReviewerRoleAssignment must not re-declare the grant's lifecycle: ${reintroduced.join(", ")}`,
    ).toEqual([]);
    // Positive control: the fields it DOES own are present, so this is not
    // passing because the model was renamed out from under the check.
    expect(body).toMatch(/^\s*role\s/m);
    expect(body).toMatch(/^\s*watermarkPolicy\s/m);
  });

  it("the grant model still declares every lifecycle field it owns", () => {
    const body = modelBody("ExternalReviewGrant");
    for (const f of ["tokenHash", "tokenVersion", "state", "expiresAtUtc", "revokedAtUtc", "acceptedAtUtc"]) {
      expect(body, `ExternalReviewGrant must own ${f}`).toMatch(
        new RegExp(`^\\s*${f}\\s`, "m"),
      );
    }
  });

  it("no source reads a lifecycle fact off an externalReviewerRoleAssignment select", () => {
    // A `select` block on the sidecar that names one of the dropped fields is
    // the exact shape the CSV export had. The fields no longer exist, so this
    // would not compile — but the check is cheap and states the rule where
    // someone would break it.
    const files = [
      "src/routes/organizations-reports.routes.ts",
      "src/routes/external-portal.routes.ts",
      "src/services/external-review/portal-invitation.service.ts",
      "src/services/external-review/portal-projection.service.ts",
      "src/services/external-review/portal-session.service.ts",
    ];
    const offenders: string[] = [];
    for (const f of files) {
      const src = read(f);
      for (const m of src.matchAll(
        /externalReviewerRoleAssignment\.\w+\(\{[\s\S]{0,1200}?\n\s*\}\)/g,
      )) {
        for (const field of DUPLICATE_LIFECYCLE_FIELDS) {
          if (new RegExp(`\\b${field}\\b\\s*:`).test(m[0])) {
            offenders.push(`${f}: ${field}`);
          }
        }
      }
    }
    expect(
      offenders,
      `the invitation lifecycle comes from ExternalReviewGrant only:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("the delivery intent is keyed on content and resend, not on attempt", () => {
    const body = modelBody("ExternalReviewInvitationDelivery");
    expect(body).toMatch(/@@unique\(\[teamId, grantId, contentVersion, resendSeq\]/);
    expect(body).toMatch(/@@unique\(\[intentKey\]/);
    // The invariant that forced a history rewrite must not come back.
    expect(
      body,
      "keying the intent on `attempt` is what forced historical renumbering",
    ).not.toMatch(/@@unique\(\[teamId, grantId, attempt\]/);
  });

  it("the provider idempotency key is minted from the durable intent", () => {
    const src = read("src/services/external-review/portal-invitation-email.service.ts");
    expect(src).toMatch(/mintEmailIdempotencyKey\(\s*\n?\s*"external_review_invitation",\s*\n?\s*delivery\.intentKey/);
    // The surrogate-id shape is what made a retry unrecognisable.
    expect(src).not.toMatch(/mintEmailIdempotencyKey\([\s\S]{0,80}delivery\.id/);
  });

  it("rotation advances the content generation in the same statement as the hash", () => {
    const src = read("src/services/external-review/external-review-grant.service.ts");
    // The file contains three UPDATEs against this table (transition, access
    // counter, rotation). Anchor on the one that writes the hash, rather than
    // on the first one the regex happens to reach.
    const update =
      /UPDATE "external_review_grants"\s*\n\s*SET "token_hash"[\s\S]*?RETURNING/.exec(
        src,
      );
    expect(update, "the guarded rotation UPDATE must exist").toBeTruthy();
    expect(
      update![0],
      "a rotation that does not advance the generation collapses onto the superseded message's key",
    ).toMatch(/"token_version" = "token_version" \+ 1/);
  });

  it("the contract migration guards every destructive statement, before it", () => {
    const sql = read(
      "prisma/migrations/20271122000000_external_review_invitation_authority_contract/migration.sql",
    );
    const firstDrop = Math.min(
      ...["DROP COLUMN", "DROP CONSTRAINT", "DROP INDEX"]
        .map((k) => sql.indexOf(k))
        .filter((i) => i >= 0),
    );
    const lastGuard = sql.lastIndexOf("RAISE EXCEPTION");
    expect(firstDrop, "the migration must contain a destructive statement").toBeGreaterThan(0);
    expect(
      lastGuard,
      "every readiness check must precede the first destructive statement",
    ).toBeLessThan(firstDrop);
    // Each dropped column is named by a readiness check.
    for (const col of ["grant_state", "raw_token", "token_hash", "expires_at_utc", "revoked_at_utc"]) {
      expect(sql.slice(0, firstDrop), `${col} must be covered by a guard`).toContain(col);
    }
  });

  it("the backfill does not renumber a business-visible counter", () => {
    const sql = read(
      "prisma/migrations/20271121000000_external_review_invitation_authority_backfill/migration.sql",
    );
    // The replaced migration's defining statement.
    expect(
      sql,
      "`attempt` is what operator consoles have been showing; renumbering it rewrites history",
    ).not.toMatch(/SET\s+"attempt"\s*=/);
    expect(sql).not.toMatch(/DELETE\s+FROM/i);
  });
});
