/**
 * Make a freshly-registered e2e account usable, and nothing else.
 *
 * WHY THIS EXISTS AT ALL
 * ---------------------------------------------------------------------------
 * `POST /v1/auth/email/login` refuses an account whose email is unverified
 * (403 EMAIL_NOT_VERIFIED), and it is right to. The only route that clears
 * that flag is `POST /v1/auth/email/verify`, which needs the token from the
 * verification email — and the e2e stack has notifications disabled
 * (registration answers `verificationSent: false`) while the token is stored
 * only as a SHA-256 hash. There is nothing to replay, so there is no route
 * the browser suite can call.
 *
 * The e2e database is a disposable container the job owns, so the flag is set
 * here instead. Deliberately NOT a product route: the API must not grow a
 * "verify without the token" surface for a test's convenience.
 *
 * WHY IT LIVES UNDER services/api
 * ---------------------------------------------------------------------------
 * `pg` is a dependency of this package, not of the repository root, and ESM
 * resolves from the file's own location. A helper under `e2e/` cannot import
 * it without either a root dependency or a path trick; this file can just say
 * `import pg from "pg"`.
 *
 * REFUSES A NON-LOOPBACK DATABASE
 * ---------------------------------------------------------------------------
 * It writes to `users` and `entitlements`. The one address it will accept is
 * a local one, so a stray DATABASE_URL cannot point it at anything real.
 */
import pg from "pg";

function arg(name) {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}

const email = arg("email");
const plan = arg("plan");
if (!email) {
  console.error("e2e-account: --email=<address> is required");
  process.exit(2);
}
if (plan && !["FREE", "PRO", "TEAM"].includes(plan)) {
  console.error(`e2e-account: --plan must be FREE, PRO or TEAM (got ${plan})`);
  process.exit(2);
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("e2e-account: DATABASE_URL is not set");
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
    `e2e-account: REFUSED — DATABASE_URL host "${host}" is not a local ` +
      "address. This script writes to users and entitlements and will only " +
      "do so against a disposable local database.",
  );
  process.exit(3);
}

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  const verified = await client.query(
    'UPDATE "users" SET "email_verified_at" = now() WHERE "email" = $1',
    [email],
  );
  if (!verified.rowCount) {
    console.error(`e2e-account: no user with email ${email}`);
    process.exit(4);
  }
  if (plan && plan !== "FREE") {
    // Registration already creates a FREE entitlement, so this updates the
    // row rather than inserting a second one that ordering would decide
    // between.
    const planned = await client.query(
      'UPDATE "entitlements" SET "plan" = $2 WHERE "user_id" = ' +
        '(SELECT "id" FROM "users" WHERE "email" = $1)',
      [email, plan],
    );
    if (!planned.rowCount) {
      console.error(`e2e-account: no entitlement row for ${email}`);
      process.exit(5);
    }
  }
  console.log(`e2e-account: ${email} verified${plan ? ` on ${plan}` : ""}`);
} finally {
  await client.end();
}
