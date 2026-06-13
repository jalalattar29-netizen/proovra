/**
 * Phase CAPTURE-HARDENING — manual / cron sweeper.
 *
 *   pnpm --filter proovra-api tsx scripts/sweep-capture-drafts.ts
 *
 * One-shot runner. Designed to be invoked from a Kubernetes CronJob /
 * a system cron / a manual operator command. Does NOT loop — exits
 * with code 0 on success, code 1 on a thrown error so the cron
 * scheduler sees the failure.
 *
 * Refuses to run in production unless `--prod-ok` is passed, the same
 * convention every other operator script in this repo uses.
 */

import "dotenv/config";

import { sweepExpiredCaptureDrafts } from "../src/jobs/capture-draft-expiry.job.js";

const argv = new Set(process.argv.slice(2));
const isProd = process.env.NODE_ENV === "production";
if (isProd && !argv.has("--prod-ok")) {
  // eslint-disable-next-line no-console
  console.error(
    "REFUSING to run capture-draft sweeper in production without --prod-ok.",
  );
  process.exit(1);
}

(async () => {
  const result = await sweepExpiredCaptureDrafts();
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
})().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("capture-draft sweeper failed:", err);
  process.exit(1);
});
