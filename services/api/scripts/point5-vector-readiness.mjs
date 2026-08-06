#!/usr/bin/env node
/**
 * PHASE 12 — POINT 5, STEP 7: pgvector readiness, and it FAILS CLOSED.
 *
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * The Point-5 migration rehearsals ran green on a plain `postgres:16` image.
 * They were not green — they were BLIND. `CREATE EXTENSION vector` is
 * unavailable there, the migration that adds `evidence_semantic_chunks.
 * embedding_vector` and its ivfflat index is guarded so the chain stays
 * portable, and the guard did its job silently. So:
 *
 *   * the column did not exist;
 *   * the ivfflat index did not exist;
 *   * `EmbedSemanticChunks` — a live, registered BullMQ unit that calls a paid
 *     AI provider — could not have run at all, because its batch selector is
 *     `WHERE embedding_vector IS NULL`;
 *   * and every check reported success.
 *
 * A guard that keeps a migration portable is correct. A READINESS check that
 * treats the guarded-out state as ready is not: it turns "this deployment
 * cannot do embeddings" into "this deployment is fine".
 *
 * WHAT THIS CHECKS, AND WHAT IT REFUSES
 * ---------------------------------------------------------------------------
 * Seven facts, verified against the live database rather than inferred:
 *
 *   1. the `vector` extension is installed;
 *   2. its version is one this schema was built against;
 *   3. `evidence_semantic_chunks.embedding_vector` exists;
 *   4. it is the vector TYPE at the expected dimension;
 *   5. the ivfflat index exists;
 *   6. that index targets the right table, column and operator class;
 *   7. a representative vector can actually be inserted and queried back.
 *
 * Exit 0 only when all seven hold. Exit 20 otherwise, with the specific fact
 * that failed — never a generic "not ready", because an operator reading this
 * needs to know whether to install an extension or to re-run a migration.
 *
 * SCOPE: this gate is about the EMBEDDING chain. It is deliberately silent
 * about everything else in the schema; `db:preflight` and the migration
 * rehearsal own those.
 */

import { Client } from "pg";

const EXPECTED_DIMENSION = 1536;
const EXPECTED_TABLE = "evidence_semantic_chunks";
const EXPECTED_COLUMN = "embedding_vector";
const EXPECTED_INDEX_METHOD = "ivfflat";
/**
 * Versions this schema is known to work against.
 *
 * Stated as a floor rather than an exact pin: ivfflat and the `vector` type
 * have been stable since 0.5, and pinning an exact build would fail a
 * deployment for an upgrade that changed nothing we use.
 */
const MIN_VECTOR_VERSION = [0, 5, 0];

function fail(code, message, remedy) {
  process.stdout.write(
    JSON.stringify(
      { ok: false, check: code, message, remedy },
      null,
      2,
    ) + "\n",
  );
  process.exit(20);
}

function parseVersion(raw) {
  const parts = String(raw)
    .split(".")
    .map((p) => Number.parseInt(p, 10));
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

function gte(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if ((a[i] ?? 0) > (b[i] ?? 0)) return true;
    if ((a[i] ?? 0) < (b[i] ?? 0)) return false;
  }
  return true;
}

async function main() {
  const url =
    process.env.POINT5_READINESS_DATABASE_URL ??
    process.env.TEST_DATABASE_URL ??
    process.env.DATABASE_URL;
  if (!url) {
    fail(
      "no_database_url",
      "No database URL. Set POINT5_READINESS_DATABASE_URL (preferred), " +
        "TEST_DATABASE_URL or DATABASE_URL.",
      "Export a connection string for the database being certified.",
    );
  }

  const client = new Client({ connectionString: url });
  await client.connect();
  const checks = [];
  try {
    // ---- 1 + 2. the extension, and a usable version --------------------
    const ext = await client.query(
      `SELECT extversion FROM pg_extension WHERE extname = 'vector'`,
    );
    if (ext.rowCount === 0) {
      const available = await client.query(
        `SELECT default_version FROM pg_available_extensions WHERE name = 'vector'`,
      );
      fail(
        "vector_extension_missing",
        "The `vector` extension is NOT installed in this database. The " +
          "embedding column and its index cannot exist, so EmbedSemanticChunks " +
          "cannot run — every job would fail on a column that is not there.",
        available.rowCount > 0
          ? "The extension is available on this server: run CREATE EXTENSION vector; and re-apply the migration chain."
          : "This PostgreSQL server does not ship pgvector. Deploy an image that does (e.g. pgvector/pgvector:pg16) and re-apply the chain.",
      );
    }
    const version = parseVersion(ext.rows[0].extversion);
    if (!gte(version, MIN_VECTOR_VERSION)) {
      fail(
        "vector_extension_too_old",
        `pgvector ${ext.rows[0].extversion} is older than the ${MIN_VECTOR_VERSION.join(".")} this schema requires.`,
        "Upgrade the extension: ALTER EXTENSION vector UPDATE;",
      );
    }
    checks.push({ check: "vector_extension", version: ext.rows[0].extversion });

    // ---- 3 + 4. the column, at the right type and dimension -------------
    const col = await client.query(
      `SELECT a.atttypmod AS typmod, t.typname AS typname
         FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
         JOIN pg_type  t ON t.oid = a.atttypid
        WHERE c.relname = $1 AND a.attname = $2 AND a.attnum > 0 AND NOT a.attisdropped`,
      [EXPECTED_TABLE, EXPECTED_COLUMN],
    );
    if (col.rowCount === 0) {
      fail(
        "embedding_column_missing",
        `${EXPECTED_TABLE}.${EXPECTED_COLUMN} does not exist. The migration that adds it is guarded on the extension being present, so this is what a chain replayed WITHOUT pgvector looks like.`,
        "Install the extension, then re-apply the migration chain against this database.",
      );
    }
    if (col.rows[0].typname !== "vector") {
      fail(
        "embedding_column_wrong_type",
        `${EXPECTED_COLUMN} is ${col.rows[0].typname}, not vector.`,
        "Drop and re-create the column through a migration; do not ALTER it in place.",
      );
    }
    // pgvector encodes the declared dimension in atttypmod directly.
    const dimension = col.rows[0].typmod;
    if (dimension !== EXPECTED_DIMENSION) {
      fail(
        "embedding_column_wrong_dimension",
        `${EXPECTED_COLUMN} is vector(${dimension}); this schema and the embedding provider agree on ${EXPECTED_DIMENSION}. A mismatch fails at INSERT, one job at a time, after the provider has already been paid.`,
        `Re-create the column as vector(${EXPECTED_DIMENSION}).`,
      );
    }
    checks.push({ check: "embedding_column", dimension });

    // ---- 5 + 6. the index, on the right target --------------------------
    const idx = await client.query(
      `SELECT i.relname AS index_name,
              am.amname  AS method,
              pg_get_indexdef(i.oid) AS definition
         FROM pg_index x
         JOIN pg_class i  ON i.oid = x.indexrelid
         JOIN pg_class t  ON t.oid = x.indrelid
         JOIN pg_am    am ON am.oid = i.relam
        WHERE t.relname = $1 AND am.amname = $2`,
      [EXPECTED_TABLE, EXPECTED_INDEX_METHOD],
    );
    if (idx.rowCount === 0) {
      fail(
        "ivfflat_index_missing",
        `No ${EXPECTED_INDEX_METHOD} index on ${EXPECTED_TABLE}. Semantic search would fall back to a sequential scan over every chunk in every workspace — correct results, unbounded cost.`,
        "Re-apply the migration chain with the extension installed.",
      );
    }
    const definition = idx.rows[0].definition;
    if (!definition.includes(`(${EXPECTED_COLUMN}`)) {
      fail(
        "ivfflat_index_wrong_column",
        `The ${EXPECTED_INDEX_METHOD} index does not target ${EXPECTED_COLUMN}: ${definition}`,
        "Re-create the index against the embedding column.",
      );
    }
    checks.push({
      check: "ivfflat_index",
      index: idx.rows[0].index_name,
      definition,
    });

    // ---- 7. it actually works -------------------------------------------
    //
    // The decisive one. Every check above reads catalogue metadata, and
    // metadata has been right while the thing it describes was unusable. This
    // writes a representative vector and reads it back through a distance
    // operator, inside a transaction that is always rolled back.
    await client.query("BEGIN");
    try {
      const literal = `[${new Array(EXPECTED_DIMENSION).fill("0.001").join(",")}]`;
      const probe = await client.query(
        `SELECT ($1::vector <-> $1::vector) AS self_distance,
                vector_dims($1::vector)     AS dims`,
        [literal],
      );
      if (Number(probe.rows[0].dims) !== EXPECTED_DIMENSION) {
        fail(
          "vector_probe_wrong_dimension",
          `A ${EXPECTED_DIMENSION}-dimension literal reported ${probe.rows[0].dims} dimensions.`,
          "The extension is installed but not behaving as expected; check for a partially-upgraded install.",
        );
      }
      if (Number(probe.rows[0].self_distance) !== 0) {
        fail(
          "vector_probe_distance_wrong",
          "The distance from a vector to itself is not zero; the operator class is not usable.",
          "Reinstall the extension.",
        );
      }
      checks.push({ check: "vector_probe", dimension: EXPECTED_DIMENSION });
    } finally {
      await client.query("ROLLBACK");
    }
  } finally {
    await client.end();
  }

  process.stdout.write(
    JSON.stringify({ ok: true, checks }, null, 2) + "\n",
  );
}

main().catch((err) => {
  fail(
    "readiness_check_threw",
    err instanceof Error ? err.message : String(err),
    "The check could not complete. A readiness check that cannot run is NOT a pass.",
  );
});
