#!/usr/bin/env node
/**
 * RUNTIME SCHEMA GATE — does the database this process is configured for have
 * every object THIS image's code requires (scripts/runtime-schema-requirements.mjs)?
 *
 *   node scripts/runtime-schema-gate.mjs          (from services/api, inside the image)
 *
 * The deploy script runs it FROM THE NEW IMAGE, against the Production database,
 * BEFORE any container is recreated: an image whose models name a column the
 * database does not have answers its first read with P2022 (the Release-B invite
 * outage), so that image must never start serving.
 *
 * `db:preflight` cannot do this for Production — it skips its runtime check for
 * every non-local host. This gate exists for exactly that case, and is READ ONLY:
 * catalog SELECTs inside a `BEGIN READ ONLY` transaction, rolled back. It reads
 * DATABASE_URL from the environment only (no env file), and prints the result —
 * never the URL, the host or any credential.
 *
 * Exit: 0 = every required object present; 12 = missing/indeterminate or the
 * catalog could not be read (fail closed).
 */
import {
  RUNTIME_SCHEMA_REQUIREMENTS,
  checkRuntimeSchemaRequirements,
  describeRuntimeSchemaFailure,
} from "./runtime-schema-requirements.mjs";

const databaseUrl = (process.env.DATABASE_URL ?? "").trim();
if (!databaseUrl) {
  console.error("runtime-schema-gate: DATABASE_URL is not set — refusing (fail closed).");
  process.exit(12);
}

let pool = null;
let client = null;
let code = 12;
try {
  const { Pool } = await import("pg");
  pool = new Pool({ connectionString: databaseUrl, max: 1 });
  client = await pool.connect();
  await client.query("BEGIN READ ONLY");
  const result = await checkRuntimeSchemaRequirements(async (sql) => (await client.query(sql)).rowCount > 0);
  await client.query("ROLLBACK");
  if (result.ok) {
    console.log(`runtime-schema-gate: PASS — all ${RUNTIME_SCHEMA_REQUIREMENTS.length} required objects present.`);
    code = 0;
  } else {
    console.error(`runtime-schema-gate: FAIL\n${describeRuntimeSchemaFailure(result)}`);
  }
} catch {
  // Never forward a driver message: it can carry the host or user name.
  console.error("runtime-schema-gate: FAIL — could not read the database catalog; the required objects are treated as absent.");
} finally {
  client?.release();
  await pool?.end().catch(() => {});
}
process.exit(code);
