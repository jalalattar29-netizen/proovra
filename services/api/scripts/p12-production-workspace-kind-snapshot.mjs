#!/usr/bin/env node
/**
 * PHASE 12 — UNK-004: Production workspace-kind convergence, READ ONLY.
 *
 * Why this exists
 * ---------------------------------------------------------------------------
 * `20271125000000_workspace_kind_authority_contract` made `teams.workspace_kind`
 * NOT NULL after a backfill that classifies from STRUCTURAL authority only. The
 * audit could assert that locally, but "does PRODUCTION actually hold zero NULLs
 * and zero contradictions?" is a question only Production can answer, and the
 * previous passes left it UNKNOWN because no collector existed to ask it.
 *
 * This is that collector. It returns BOUNDED COUNTS ONLY. It selects no
 * identifier, no name, no email and no user-authored text, so its output can be
 * pasted into an audit artifact without redaction.
 *
 * Safety contract
 * ---------------------------------------------------------------------------
 *   * It requires `P6_PRODUCTION_READONLY_DATABASE_URL` — the SAME explicitly
 *     named credential the Point-6 migration collector uses. It deliberately
 *     does NOT fall back to DATABASE_URL, DIRECT_URL or SHADOW_DATABASE_URL: a
 *     configured URL is not evidence that it is safe to read.
 *   * It issues SELECT only. No DDL, no DML, no `migrate` command.
 *   * It opens the session read-only (`default_transaction_read_only`) and runs
 *     inside a READ ONLY transaction, so the server itself refuses a write even
 *     if this file were later edited carelessly.
 *
 * Usage:
 *   Set P6_PRODUCTION_READONLY_DATABASE_URL to a standard PostgreSQL
 *   connection string for a SELECT-only role (sslmode=require), then run:
 *     node services/api/scripts/p12-production-workspace-kind-snapshot.mjs
 *
 *   The example URL is written in prose rather than as a literal
 *   scheme://user:password@host string on purpose: this repository has been
 *   rejected by push protection before, and a placeholder that is shaped like
 *   a credential is still shaped like a credential to a scanner.
 */

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const VAR = "P6_PRODUCTION_READONLY_DATABASE_URL";
const url = (process.env[VAR] ?? "").trim();

if (!url) {
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: false,
        check: "production-workspace-kind-convergence",
        error: `${VAR} is not set`,
        detail:
          "This collector deliberately does NOT fall back to DATABASE_URL, DIRECT_URL or SHADOW_DATABASE_URL. UNK-004 requires an explicitly named read-only credential so that no configured URL can be mistaken for a safe one.",
        remedy: `Create (or reuse) a SELECT-only PostgreSQL role, set ${VAR} to its connection string (sslmode=require), then run: node services/api/scripts/p12-production-workspace-kind-snapshot.mjs`,
        ProductionWorkspaceKindNull: "UNKNOWN_BLOCKED",
        ProductionWorkspaceKindContradictions: "UNKNOWN_BLOCKED",
      },
      null,
      2,
    )}\n`,
  );
  process.exit(2);
}

/**
 * Bounded counts. Every expression is an aggregate — no row is ever returned,
 * so no identity can leak through this query.
 *
 * The contradiction classes are the ones the tenancy model forbids:
 *   - a PERSONAL workspace that is not flagged personal, or vice versa;
 *   - an ORGANIZATION workspace whose Organization is a SYSTEM bootstrap
 *     container rather than a real CUSTOMER Organization;
 *   - an OWNED workspace attached to a CUSTOMER Organization (that would be an
 *     Organization workspace wearing the wrong discriminator);
 *   - any workspace with no Organization at all (the column is NOT NULL since
 *     Phase 2.7X, so a NULL here means the contract migration did not land).
 */
const SQL = `
SELECT
  COUNT(*)::bigint                                                   AS total_workspaces,
  COUNT(*) FILTER (WHERE t.workspace_kind IS NULL)::bigint           AS kind_null,
  COUNT(*) FILTER (WHERE t.workspace_kind = 'PERSONAL')::bigint      AS kind_personal,
  COUNT(*) FILTER (WHERE t.workspace_kind = 'OWNED')::bigint         AS kind_owned,
  COUNT(*) FILTER (WHERE t.workspace_kind = 'ORGANIZATION')::bigint  AS kind_organization,
  COUNT(*) FILTER (
    WHERE t.workspace_kind IS NOT NULL
      AND t.workspace_kind NOT IN ('PERSONAL','OWNED','ORGANIZATION')
  )::bigint                                                          AS kind_invalid,
  COUNT(*) FILTER (
    WHERE t.workspace_kind = 'PERSONAL' AND t.is_personal IS DISTINCT FROM TRUE
  )::bigint                                                          AS contra_personal_not_flagged,
  COUNT(*) FILTER (
    WHERE t.is_personal = TRUE AND t.workspace_kind IS DISTINCT FROM 'PERSONAL'
  )::bigint                                                          AS contra_flagged_not_personal,
  COUNT(*) FILTER (
    WHERE t.workspace_kind = 'ORGANIZATION' AND o.kind IS DISTINCT FROM 'CUSTOMER'
  )::bigint                                                          AS contra_org_kind_not_customer,
  COUNT(*) FILTER (
    WHERE t.workspace_kind = 'OWNED' AND o.kind = 'CUSTOMER'
  )::bigint                                                          AS contra_owned_under_customer_org,
  COUNT(*) FILTER (WHERE t.organization_id IS NULL)::bigint          AS contra_no_organization
FROM teams t
LEFT JOIN organizations o ON o.id = t.organization_id
`;

async function main() {
  let Client;
  try {
    ({ Client } = require("pg"));
  } catch {
    process.stdout.write(
      `${JSON.stringify({ ok: false, error: "the 'pg' package is not resolvable from services/api" }, null, 2)}\n`,
    );
    process.exit(3);
  }

  const client = new Client({
    connectionString: url,
    application_name: "p12-unk004-readonly-collector",
    statement_timeout: 30_000,
  });

  await client.connect();
  try {
    // Belt and braces: make the SERVER refuse a write on this session.
    await client.query("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY");
    await client.query("BEGIN READ ONLY");
    const { rows } = await client.query(SQL);
    await client.query("COMMIT");

    const r = rows[0] ?? {};
    const n = (k) => Number(r[k] ?? 0);

    const contradictions =
      n("contra_personal_not_flagged") +
      n("contra_flagged_not_personal") +
      n("contra_org_kind_not_customer") +
      n("contra_owned_under_customer_org") +
      n("contra_no_organization");

    const out = {
      ok: n("kind_null") === 0 && n("kind_invalid") === 0 && contradictions === 0,
      check: "production-workspace-kind-convergence",
      readOnly: true,
      totalWorkspaces: n("total_workspaces"),
      byKind: {
        PERSONAL: n("kind_personal"),
        OWNED: n("kind_owned"),
        ORGANIZATION: n("kind_organization"),
      },
      ProductionWorkspaceKindNull: n("kind_null"),
      ProductionWorkspaceKindInvalid: n("kind_invalid"),
      ProductionWorkspaceKindContradictions: contradictions,
      contradictionBreakdown: {
        personalKindNotFlaggedPersonal: n("contra_personal_not_flagged"),
        flaggedPersonalNotPersonalKind: n("contra_flagged_not_personal"),
        organizationKindUnderNonCustomerOrg: n("contra_org_kind_not_customer"),
        ownedKindUnderCustomerOrg: n("contra_owned_under_customer_org"),
        workspaceWithNoOrganization: n("contra_no_organization"),
      },
    };
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    process.exit(out.ok ? 0 : 1);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  // Never echo the connection string or any driver payload that could carry it.
  process.stdout.write(
    `${JSON.stringify({ ok: false, error: "collector failed", name: err?.name ?? "Error" }, null, 2)}\n`,
  );
  process.exit(4);
});
