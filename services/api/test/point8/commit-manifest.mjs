/**
 * PHASE 12 — POINT 8 PART A, STEP A5: the commit manifest.
 *
 * `P8_STAGING_GIT_COMMIT_APPROVED` is absent, so nothing is staged and git
 * history is not touched. What is produced instead is the EXACT set a reviewer
 * would stage, derived from git rather than typed out.
 *
 * The care here is not ceremony. This working tree carries over a thousand
 * uncommitted files of unrelated work, and `git add -A` would sweep all of it
 * into a release commit. So the manifest is an ALLOWLIST of paths this pass
 * owns, and every path git reports is either in it or explicitly listed as
 * "not ours" — a file that is neither is an error, because that is how
 * somebody else's work ends up in a release.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { PROPOSED_ADDITIONS } from "../../scripts/release-materialize.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../../..");
const git = (...a) => execFileSync("git", a, { cwd: REPO, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });

/** Paths this pass created or edited. Anything else is somebody else's work. */
const OWNED = [
  ".gitattributes",
  ".gitignore",
  ".github/workflows/deploy-staging.yml",
  ".github/workflows/schema-reproducibility.yml",
  "docs/architecture/migration-deployment-plan.md",
  "docs/architecture/migration-inventory-p6.curation.json",
  "docs/architecture/migration-inventory-p6.json",
  "docs/architecture/program-ledger.md",
  "services/api/scripts/migration-inventory.mjs",
  "services/api/scripts/release-materialize.mjs",
  "services/api/scripts/release-materialize.d.mts",
  "services/api/scripts/release-deploy.mjs",
  "services/api/scripts/release-deploy.d.mts",
  "services/api/scripts/staging-deploy-guard.mjs",
  "services/api/scripts/staging-deploy-guard.d.mts",
  "services/api/scripts/staging-preflight-cli.mjs",
  "services/api/scripts/staging-preflight-cli.d.mts",
  "services/api/scripts/staging-deploy-cli.mjs",
];

/** Prefixes this pass owns wholesale. */
const OWNED_PREFIXES = [
  "docs/architecture/point8-",
  "services/api/test/point8/",
  "services/api/test/phase-12-point8-",
  "services/api/prisma/migrations/20271119000000_search_document_embedding_after_extension/",
];

/**
 * The seventeen untracked migrations that must be ADDED. This is the fix: the
 * guard for the tracked, unguarded persona drop is among them, and a release
 * artifact without it ships the destruction alone.
 */
const MIGRATION_ADDITIONS = Object.keys(PROPOSED_ADDITIONS).map(
  (n) => `services/api/prisma/migrations/${n}/`,
);

function owns(path) {
  return (
    OWNED.includes(path) ||
    OWNED_PREFIXES.some((p) => path.startsWith(p)) ||
    // git reports an untracked DIRECTORY as a single trailing-slash entry, so
    // the migration additions have to be matched by prefix. Matching only the
    // `migration.sql` form silently dropped all seventeen of them from the
    // manifest — the exact files this whole pass exists to add.
    MIGRATION_ADDITIONS.some((m) => path === m || path.startsWith(m))
  );
}

export function buildCommitManifest() {
  const status = git("status", "--porcelain")
    .split("\n")
    .filter(Boolean)
    .map((l) => ({ code: l.slice(0, 2), path: l.slice(3).replace(/^"|"$/g, "") }));

  const ours = status.filter((s) => owns(s.path));
  const theirs = status.filter((s) => !owns(s.path));

  const add = ours.filter((s) => s.code.trim() === "??").map((s) => s.path).sort();
  const modify = ours.filter((s) => s.code.trim() !== "??" && !s.code.includes("D")).map((s) => s.path).sort();
  const del = ours.filter((s) => s.code.includes("D")).map((s) => s.path).sort();

  // Untracked DIRECTORIES are reported by git as a single trailing-slash entry;
  // expand them so the manifest names files, not folders.
  const expand = (paths) =>
    paths
      .flatMap((p) =>
        p.endsWith("/")
          ? git("ls-files", "-o", "--exclude-standard", p).split("\n").filter(Boolean)
          : [p],
      )
      .sort();

  const addFiles = expand(add);

  const checksums = Object.fromEntries(
    [...addFiles, ...modify]
      .filter((p) => existsSync(resolve(REPO, p)) && p.endsWith("migration.sql"))
      .map((p) => [
        p,
        createHash("sha256").update(readFileSync(resolve(REPO, p))).digest("hex"),
      ]),
  );

  return {
    approvalLatch: "P8_STAGING_GIT_COMMIT_APPROVED",
    approvalPresent: process.env.P8_STAGING_GIT_COMMIT_APPROVED === "true",
    baseCommit: git("rev-parse", "HEAD").trim(),
    // NEVER `main`. `deploy-images.yml` builds and pushes :latest on push to it.
    proposedBranch: "release-candidate/p8-artifact-integrity",
    filesToAdd: addFiles,
    filesToModify: modify,
    filesToDelete: del,
    migrationChecksums: checksums,
    unrelatedWorkingTreeEntries: theirs.length,
    unrelatedSample: theirs.slice(0, 5).map((s) => s.path),
    rationale: {
      migrations:
        "Seventeen untracked migrations are added so a clean checkout carries the guard for the tracked, unguarded DROP TABLE ... CASCADE. One new migration repairs the pgvector ordering defect.",
      lineEndings:
        ".gitattributes pins *.sql to LF. git archive on a core.autocrlf=true machine injected CR bytes into migration files whose canonical blobs have none, and _prisma_migrations.checksum is over raw bytes.",
      deployment:
        "deploy-staging.yml is manual-only, bound to the staging environment, and applies migrations through the wave selector rather than a bare prisma migrate deploy.",
      ci: "schema-reproducibility.yml moves to pgvector/pgvector:pg16; on postgres:16-alpine every extension-conditional check was vacuous.",
    },
    gatesProvingSafety: [
      "services/api/test/phase-12-point8-release-artifact.test.ts (15) — fails on HEAD_ARTIFACT, passes on PROPOSED",
      "services/api/test/phase-12-point8-staging-deploy-guard.test.ts (18) — eight staging refusals",
      "services/api/test/phase-12-point6-migration-closure.test.ts (19) — inventory/runbook conservation",
      "services/api/test/phase-12-point4-raw-schema-ownership.test.ts",
      "services/api/test/phase-12-point8-manifest-gate.test.ts (19), phase-12-point8-staging-preflight.test.ts (17)",
    ],
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  console.log(JSON.stringify(buildCommitManifest(), null, 2));
}
