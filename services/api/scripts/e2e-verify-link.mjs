/**
 * Give an e2e record a public verification link, and nothing else.
 *
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * ET-PKG-07: a record is private by default and a public link is an opaque
 * share token, never the record's id. The product route that creates a link
 * (POST /v1/evidence/:id/verify-links) publishes the record when it is the
 * first one, and publishing requires a step-up challenge — an MFA proof the
 * browser suite's throwaway accounts do not hold.
 *
 * The e2e database is a disposable container the job owns, so the record is
 * published and the link minted here, exactly as the verification-share
 * authority stores one: the SHA-256 of a 256-bit random token. Deliberately
 * NOT a product route: the API must not grow a "publish without step-up"
 * surface for a test's convenience.
 *
 * Prints the token on stdout. `/verify/<token>` and `/public/verify/<token>`
 * then open the record.
 *
 * REFUSES A NON-LOOPBACK DATABASE — it writes to `evidence` and
 * `verification_share_tokens`, and will only do so against a local address.
 */
import { createHash, randomBytes } from "node:crypto";

import pg from "pg";

function arg(name) {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}

const evidenceId = arg("evidence");
const projection = arg("projection") ?? "STANDARD";
if (!evidenceId || !/^[0-9a-f-]{36}$/i.test(evidenceId)) {
  console.error("e2e-verify-link: --evidence=<uuid> is required");
  process.exit(2);
}
if (!["STANDARD", "BASIC"].includes(projection)) {
  console.error(`e2e-verify-link: --projection must be STANDARD or BASIC (got ${projection})`);
  process.exit(2);
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("e2e-verify-link: DATABASE_URL is not set");
  process.exit(2);
}
const host = (() => {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
})();
if (!["localhost", "127.0.0.1", "::1", "postgres"].includes(host)) {
  console.error(
    `e2e-verify-link: REFUSED — DATABASE_URL host "${host}" is not a local ` +
      "address. This script writes to evidence and verification_share_tokens " +
      "and will only do so against a disposable local database.",
  );
  process.exit(3);
}

const token = `pvs_${randomBytes(32).toString("base64url")}`;
const tokenHash = createHash("sha256").update(token, "utf8").digest("hex");

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await client.query("BEGIN");
  const found = await client.query(
    `UPDATE evidence SET public_verify_state = 'PUBLISHED' WHERE id = $1::uuid RETURNING team_id`,
    [evidenceId],
  );
  if (found.rowCount !== 1) {
    throw new Error(`no evidence row ${evidenceId}`);
  }
  await client.query(
    `INSERT INTO verification_share_tokens (evidence_id, team_id, token_hash, purpose, projection, audience)
     VALUES ($1::uuid, $2, $3, 'OWNER_SHARE', $4, 'e2e recipient')`,
    [evidenceId, found.rows[0].team_id, tokenHash, projection],
  );
  await client.query("COMMIT");
  process.stdout.write(token);
} catch (err) {
  await client.query("ROLLBACK").catch(() => undefined);
  console.error(`e2e-verify-link: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  await client.end();
}
