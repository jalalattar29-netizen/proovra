/**
 * PHASE 12 — POINT 7: browser-run setup.
 *
 * Mints ONE run id for the whole browser matrix, and exports the CURRENT
 * required legal-policy versions the account fixture needs — read from the API
 * source of truth rather than restated here, so a policy bump cannot leave the
 * fixture silently seeding a stale acceptance and every route answering 428
 * before the behaviour under test is reached.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { REQUIRED_LEGAL_VERSIONS } from "../../services/api/src/legal/legal-versioning";

const TMP = resolve(process.cwd(), ".p7tmp");

export default async function globalSetup(): Promise<void> {
  if (!existsSync(TMP)) mkdirSync(TMP, { recursive: true });
  // A fresh run starts with no inherited credit. Carrying the previous run's
  // file forward is exactly the stale-artifact failure the closure gate must
  // catch, so the runner never creates it.
  rmSync(resolve(TMP, "browser-proven.jsonl"), { force: true });

  process.env.POINT7_RUN_ID = process.env.POINT7_RUN_ID ?? randomUUID();
  writeFileSync(resolve(TMP, "run-id.txt"), process.env.POINT7_RUN_ID, "utf8");
  writeFileSync(
    resolve(TMP, "required-legal-versions.json"),
    JSON.stringify(REQUIRED_LEGAL_VERSIONS),
    "utf8",
  );
}
