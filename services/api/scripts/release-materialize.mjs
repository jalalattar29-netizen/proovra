/**
 * PHASE 12 — POINT 8 PART A, STEP A4: materialize a release artifact.
 *
 * WHY MATERIALIZE AT ALL
 * ---------------------------------------------------------------------------
 * Every migration check in this repository has run against the WORKING TREE,
 * where all 221 migration directories exist. What actually ships is a clean
 * checkout — `actions/checkout` then `COPY services/api/prisma` — which has
 * 204. That gap is how a tracked `DROP TABLE … CASCADE` came to ship without
 * the untracked guard whose RAISE is its only safety, and no amount of checking
 * the working tree could have found it.
 *
 * So this builds the artifact the way the pipeline does — `git archive` from a
 * commit, not a copy of the directory you happen to be sitting in — and lets
 * every downstream rehearsal run against THAT.
 *
 *   --view head       exactly what HEAD ships today
 *   --view proposed   HEAD plus the explicitly justified additions
 *   --view worktree   the dirty tree, provided only so the difference can be
 *                     measured; never a release candidate
 *
 * Usage:
 *   node scripts/release-materialize.mjs --view proposed --out <dir> [--json]
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");
const PRISMA_REL = "services/api/prisma";

/**
 * The additions this pass justifies. Every one is an untracked migration that
 * Point 6 classified and that A1 dispositioned; the reason is carried here so
 * the artifact is self-describing and a future reader does not have to guess
 * why a directory is in it.
 *
 * NOTE ON THE CONTRACT/DROP ENTRIES: they are in the ARTIFACT because a
 * destructive migration must never be separated from its guard. They are kept
 * out of a release by the WAVE selector at deploy time, not by being absent
 * from the image — absence is what caused the defect.
 */
export const PROPOSED_ADDITIONS = {
  "20270923500000_persona_profiles_removal_precondition":
    "REQUIRED_LATER_CONTRACT_MIGRATION — the guard for the tracked, unguarded 20270924000000 drop. Shipping the drop without it is the release-blocking defect.",
  "20271102000000_uuid_id_default_repair": "REQUIRED_RELEASE_MIGRATION — REPAIR, SAFE_TO_APPLY_NOW.",
  "20271103000000_case_evidence_link_canonical": "REQUIRED_RELEASE_MIGRATION — BACKFILL, self-gating on readiness.",
  "20271104000000_case_evidence_link_integrity": "REQUIRED_RELEASE_MIGRATION — BACKFILL, self-gating on readiness.",
  "20271105000000_evidence_case_id_removal": "REQUIRED_LATER_CONTRACT_MIGRATION — self-guarded CONTRACT_DROP.",
  "20271106000000_legal_hold_canonical": "REQUIRED_RELEASE_MIGRATION — EXPAND, SAFE_TO_APPLY_NOW.",
  "20271107000000_legal_hold_backfill": "REQUIRED_RELEASE_MIGRATION — BACKFILL, self-gating on readiness.",
  "20271108000000_legal_hold_legacy_removal": "REQUIRED_LATER_CONTRACT_MIGRATION — self-guarded CONTRACT_DROP.",
  "20271109000000_workspace_governance_policy_version": "REQUIRED_RELEASE_MIGRATION — BACKFILL, self-gating on readiness.",
  "20271110000000_exchange_download_authorization_semantics": "REQUIRED_RELEASE_MIGRATION — BACKFILL, self-gating on readiness.",
  "20271111000000_step_up_session_organization_binding": "REQUIRED_RELEASE_MIGRATION — EXPAND, SAFE_TO_APPLY_NOW.",
  "20271112000000_point4_write_unblock_repair":
    "REQUIRED_RELEASE_MIGRATION — REPAIR that unblocks live writes; prerequisite of 20271117000000.",
  "20271113000000_point5_report_generation_authority": "REQUIRED_RELEASE_MIGRATION — EXPAND, SAFE_TO_APPLY_NOW.",
  "20271114000000_point5_media_intelligence_kind_catalog": "REQUIRED_RELEASE_MIGRATION — REPAIR, SAFE_TO_APPLY_NOW.",
  "20271115000000_point5_atomic_sweep_claims": "REQUIRED_RELEASE_MIGRATION — BACKFILL, self-gating on readiness.",
  "20271117000000_point4_schema_authority_contract":
    "REQUIRED_LATER_CONTRACT_MIGRATION — CONTRACT_DROP; destroys through dynamic identifiers, each self-guarded by a RAISE.",
  "20271118000000_legal_hold_strict_scope_target": "REQUIRED_LATER_CONTRACT_MIGRATION — CONTRACT_DROP, self-guarded.",
  "20271119000000_search_document_embedding_after_extension":
    "REQUIRED_RELEASE_MIGRATION — EXPAND, SAFE_TO_APPLY_NOW. Creates the column and ANN index that 20260620100000 could never create, because its pgvector guard is evaluated a year before CREATE EXTENSION vector.",
};

/** Nothing is excluded. Recorded explicitly so conservation is provable. */
export const PROPOSED_EXCLUSIONS = {};

function git(...args) {
  return execFileSync("git", args, { cwd: REPO, encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
}

/** Extract `services/api/prisma` from a commit exactly as the pipeline would. */
function materializeHead(out) {
  mkdirSync(out, { recursive: true });
  const tar = join(out, "_head.tar");
  // `-c core.autocrlf=false` — NOT cosmetic.
  //
  // This machine has `core.autocrlf=true` and the repository had no
  // `.gitattributes`, so `git archive` rewrote every migration's LF to CRLF:
  // 21 CR bytes injected into a file whose canonical blob has none. Prisma
  // records `_prisma_migrations.checksum` over the RAW BYTES of the file it
  // applied, so a CRLF artifact and the LF artifact CI produces on Linux carry
  // different checksums for the same commit — and deploying one against a
  // database migrated from the other fails with "migration was modified after
  // it was applied".
  //
  // Pinning it here makes the materialization reproduce the canonical blob
  // byte-for-byte on any machine. `.gitattributes` fixes the same class for
  // ordinary checkouts.
  execFileSync("git", ["-c", "core.autocrlf=false", "archive", "--format=tar", "-o", tar, "HEAD", PRISMA_REL], {
    cwd: REPO,
    maxBuffer: 512 * 1024 * 1024,
  });
  // GNU tar reads a leading `C:` as a remote host spec ("Cannot connect to C"),
  // so the archive is named relatively from inside the output directory rather
  // than passed as an absolute Windows path.
  execFileSync("tar", ["-xf", "_head.tar"], { cwd: out });
  rmSync(tar, { force: true });
}

export function materialize({ view, out }) {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  if (view === "worktree") {
    cpSync(resolve(REPO, PRISMA_REL), join(out, PRISMA_REL), { recursive: true });
  } else {
    materializeHead(out);
    if (view === "proposed") {
      for (const name of Object.keys(PROPOSED_ADDITIONS)) {
        const src = resolve(REPO, PRISMA_REL, "migrations", name);
        if (!existsSync(src)) throw new Error(`proposed addition missing from worktree: ${name}`);
        cpSync(src, join(out, PRISMA_REL, "migrations", name), { recursive: true });
      }
      for (const name of Object.keys(PROPOSED_EXCLUSIONS)) {
        rmSync(join(out, PRISMA_REL, "migrations", name), { recursive: true, force: true });
      }
    }
  }

  const migRoot = join(out, PRISMA_REL, "migrations");
  const migrations = existsSync(migRoot)
    ? readdirSync(migRoot)
        .filter((d) => statSync(join(migRoot, d)).isDirectory() && existsSync(join(migRoot, d, "migration.sql")))
        .sort()
    : [];

  // Raw-byte checksums — the basis `_prisma_migrations.checksum` uses, so the
  // artifact's identity is comparable with what a database records.
  const checksums = Object.fromEntries(
    migrations.map((n) => [n, createHash("sha256").update(readFileSync(join(migRoot, n, "migration.sql"))).digest("hex")]),
  );

  const manifest = {
    view,
    gitCommit: git("rev-parse", "HEAD").trim(),
    migrationCount: migrations.length,
    migrations,
    checksums,
    artifactDigest: createHash("sha256")
      .update(migrations.map((n) => `${n}:${checksums[n]}`).join("\n"))
      .digest("hex"),
  };
  writeFileSync(join(out, "release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const argv = process.argv.slice(2);
  const arg = (n, d) => {
    const i = argv.indexOf(n);
    return i >= 0 ? argv[i + 1] : d;
  };
  const m = materialize({ view: arg("--view", "proposed"), out: resolve(arg("--out", "")) });
  if (argv.includes("--json")) console.log(JSON.stringify(m, null, 2));
  else console.log(`${m.view}: ${m.migrationCount} migrations, artifactDigest ${m.artifactDigest.slice(0, 16)}…`);
}
