#!/usr/bin/env node
/**
 * Phase 2.7X — Local-audit env preparation helper.
 *
 * Reads the credentials from the running `proovra_postgres` docker
 * container and writes `services/api/.env.audit-local` (a SIBLING
 * file, never the active `.env`). The operator either:
 *
 *   (a) inspects the generated sibling file and copies it to
 *       `services/api/.env` themselves, OR
 *   (b) passes `--swap --yes-i-know` to let this script back up
 *       the existing `.env` and replace it.
 *
 * Default mode is the safe (a) — no env mutation. The swap mode
 * requires BOTH `--swap` AND `--yes-i-know` so it cannot fire
 * from a shell typo.
 *
 * Why this script exists:
 *   Phase 2.7A and Phase 2.7X both hit the same gate — the active
 *   `DATABASE_URL` points at Neon, so the Phase 2.5C/D/E/F guards
 *   correctly refuse to apply the Organization migration. The
 *   structural fix is the Phase 2.5F `.env.audit-local.example`
 *   template, but the operator still has to copy + customise it
 *   with the actual local docker postgres credentials. This script
 *   automates the customise step (reading container env) while
 *   keeping the FINAL .env decision in operator hands.
 *
 * Hard rules:
 *   - The script NEVER applies a migration. It only writes env
 *     files.
 *   - The script NEVER mutates the active `.env` without
 *     `--swap --yes-i-know` BOTH set.
 *   - The script NEVER prints the password to stdout.
 *   - The script NEVER touches Neon credentials.
 *   - The script fails closed when the docker container isn't
 *     running.
 *
 * Exit codes:
 *   0  sibling file written successfully (default mode)
 *   2  docker container `proovra_postgres` is not running
 *   3  docker exec read failed
 *   4  swap requested but `--yes-i-know` missing
 *   5  swap completed
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  copyFileSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const API_ROOT = resolve(__dirname, "..");
const REPO_ROOT = resolve(API_ROOT, "..", "..");

const args = process.argv.slice(2);
const swapMode = args.includes("--swap");
const yesIKnow = args.includes("--yes-i-know");

// ---------------------------------------------------------------------------
// Step 1 — Confirm the docker postgres container is running.
// ---------------------------------------------------------------------------
const dockerPs = spawnSync(
  "docker",
  ["ps", "--filter", "name=proovra_postgres", "--format", "{{.Names}}"],
  { encoding: "utf8" },
);
const containerRunning = (dockerPs.stdout ?? "").trim() === "proovra_postgres";

if (!containerRunning) {
  process.stderr.write(
    "\n[prepare-local-env] REFUSED: docker container `proovra_postgres`\n" +
      "  is not running. Start it with the project's docker-compose:\n" +
      "    docker compose -f infra/docker/docker-compose.full.yml up -d postgres\n\n",
  );
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Step 2 — Read POSTGRES_USER + POSTGRES_DB + POSTGRES_PASSWORD from
// the container's env. We do NOT echo the password to stdout.
// ---------------------------------------------------------------------------
const dockerEnv = spawnSync("docker", ["exec", "proovra_postgres", "env"], {
  encoding: "utf8",
});
if (dockerEnv.status !== 0) {
  process.stderr.write(
    "\n[prepare-local-env] REFUSED: docker exec failed.\n" +
      `  stderr: ${dockerEnv.stderr ?? ""}\n\n`,
  );
  process.exit(3);
}

const containerEnvText = dockerEnv.stdout ?? "";
function readVar(name) {
  const m = containerEnvText.match(new RegExp(`^${name}=(.*)$`, "m"));
  return m ? m[1] : null;
}
const PG_USER = readVar("POSTGRES_USER") ?? "audit";
const PG_DB = readVar("POSTGRES_DB") ?? "proovra_audit";
const PG_PASSWORD = readVar("POSTGRES_PASSWORD") ?? "";

if (!PG_PASSWORD) {
  process.stderr.write(
    "\n[prepare-local-env] WARNING: POSTGRES_PASSWORD not present in container env.\n" +
      "  The docker compose may have started without setting it; the generated\n" +
      "  .env.audit-local will have an empty password and will need to be\n" +
      "  edited manually before use.\n\n",
  );
}

// ---------------------------------------------------------------------------
// Step 3 — Compose the local-audit env file body. We read the
// committed `.env.audit-local.example` as the template and only
// rewrite the lines we want to override (DATABASE_URL, DIRECT_URL,
// optionally SHADOW_DATABASE_URL).
// ---------------------------------------------------------------------------
const examplePath = resolve(REPO_ROOT, ".env.audit-local.example");
if (!existsSync(examplePath)) {
  process.stderr.write(
    "\n[prepare-local-env] REFUSED: .env.audit-local.example missing at repo root.\n" +
      "  This template ships with Phase 2.5F. Restore it from git history if removed.\n\n",
  );
  process.exit(3);
}
const exampleText = readFileSync(examplePath, "utf8");

const localUrl = `postgresql://${PG_USER}:${PG_PASSWORD}@localhost:5432/${PG_DB}`;

const shadowDbName = `${PG_DB}_shadow`;
const shadowUrl = `postgresql://${PG_USER}:${PG_PASSWORD}@localhost:5432/${shadowDbName}`;

const rewritten = exampleText
  .split(/\r?\n/)
  .map((line) => {
    if (line.startsWith("DATABASE_URL=")) {
      return `DATABASE_URL=${localUrl}`;
    }
    if (line.startsWith("DIRECT_URL=")) {
      return `DIRECT_URL=${localUrl}`;
    }
    if (line.startsWith("SHADOW_DATABASE_URL=")) {
      // Phase 2.7X — rewrite shadow URL with the SAME container creds
      // so `prisma migrate dev` can drop+recreate the shadow DB. The
      // audit user has `rolcreatedb` so this works.
      return `SHADOW_DATABASE_URL=${shadowUrl}`;
    }
    return line;
  })
  .join("\n");

const targetPath = resolve(API_ROOT, ".env.audit-local");
writeFileSync(targetPath, rewritten, "utf8");

process.stderr.write("\n");
process.stderr.write("───────────────────────────────────────────────────────────────\n");
process.stderr.write("  PROOVRA prepare-local-env (Phase 2.7X)\n");
process.stderr.write("───────────────────────────────────────────────────────────────\n");
process.stderr.write(`  wrote        : services/api/.env.audit-local\n`);
process.stderr.write(`  database     : ${PG_DB}\n`);
process.stderr.write(`  user         : ${PG_USER}\n`);
process.stderr.write(`  password     : ${PG_PASSWORD ? "(from container)" : "(empty — manual edit required)"}\n`);
process.stderr.write(`  host         : localhost (LOCAL classification)\n`);
process.stderr.write("───────────────────────────────────────────────────────────────\n\n");

if (!swapMode) {
  process.stderr.write(
    "Next steps (operator chooses):\n" +
      "\n" +
      "  Option A — inspect first, swap manually:\n" +
      "    cat services/api/.env.audit-local        # review\n" +
      "    cp services/api/.env services/api/.env.production-backup-$(date +%s)\n" +
      "    cp services/api/.env.audit-local services/api/.env\n" +
      "    pnpm --filter proovra-api db:preflight   # expect classification=LOCAL\n" +
      "\n" +
      "  Option B — let this script do the swap (BOTH flags required):\n" +
      "    pnpm --filter proovra-api db:use-audit-local --swap --yes-i-know\n" +
      "\n",
  );
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Swap mode
// ---------------------------------------------------------------------------
if (!yesIKnow) {
  process.stderr.write(
    "[prepare-local-env] REFUSED: --swap requires --yes-i-know as a second flag.\n" +
      "  This double-acknowledgement prevents accidental swaps. If you really\n" +
      "  want to replace services/api/.env with the audit-local config, run:\n" +
      "    pnpm --filter proovra-api db:use-audit-local --swap --yes-i-know\n\n",
  );
  process.exit(4);
}

const activeEnvPath = resolve(API_ROOT, ".env");
if (existsSync(activeEnvPath)) {
  const backupPath = `${activeEnvPath}.production-backup-${Date.now()}`;
  copyFileSync(activeEnvPath, backupPath);
  process.stderr.write(`[prepare-local-env] backed up existing .env to ${backupPath}\n`);
}
copyFileSync(targetPath, activeEnvPath);
process.stderr.write(
  "[prepare-local-env] swapped: services/api/.env now points at the local audit DB.\n" +
    "  Verify with: pnpm --filter proovra-api db:preflight\n" +
    "  Restore via: cp services/api/.env.production-backup-* services/api/.env\n\n",
);
process.exit(5);
