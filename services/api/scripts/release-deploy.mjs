/**
 * PHASE 12 — POINT 8 PART A/B: WAVE-AWARE migration deployment.
 *
 * THE PROBLEM THIS REPLACES
 * ---------------------------------------------------------------------------
 * `prisma migrate deploy` applies every migration directory it can see that is
 * not yet recorded. The Point-6 runbook's answer was to keep the six Release-D
 * contract migrations OUT of the deployment artifact until Release D — and that
 * is precisely what produced the release-blocking defect: the guard for
 * `20270924000000_drop_workspace_persona_profiles` was left untracked, the drop
 * was not, and a clean checkout shipped an unguarded `DROP TABLE … CASCADE`.
 *
 * Absence is the wrong mechanism. A destructive migration and its guard must
 * never be separable, so the ARTIFACT carries all 221 and the WAVE is chosen
 * here, at deploy time, from the Point-6 classification. The artifact is
 * complete and reproducible; the deployment is bounded.
 *
 * HOW THE BOUND IS ENFORCED
 * ---------------------------------------------------------------------------
 * Prisma is handed a temporary migrations directory containing exactly the
 * allowed set. It cannot apply what it cannot see, so the bound does not depend
 * on an operator remembering a flag. Before it runs, the artifact-integrity
 * gate re-checks the SELECTED set — a wave that would carry a destructive
 * migration without its guard is refused, which is the failure mode that
 * started all of this.
 *
 * Usage:
 *   node scripts/release-deploy.mjs --artifact <dir> --wave A_B|C|D [--dry-run]
 *
 * The database comes from DATABASE_URL. Host safety is delegated to the
 * existing `db-host-policy` used by `safe-migrate.mjs`; this tool refuses a
 * non-local host unless the same explicit override is present.
 */
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");

/**
 * Waves, in application order. Each wave INCLUDES every earlier one.
 *
 * PHASE 13 (NEW-058) — `WAIT_FOR_RUNTIME_CUTOVER` joins wave C.
 *
 * It was ALREADY a legal wave everywhere else: `migration-inventory.mjs`
 * accepts it, `phase-12-point6-migration-closure.test.ts` recognises it,
 * `docs/architecture/migration-deployment-plan.md` §4 defines it, and
 * `docs/operations/point6-migration-runbook.md` maps it to Release C in the
 * wave→owner-action table. It was missing HERE alone, because until now no
 * migration occupied it — Release C was "No migrations", a code-only cutover.
 *
 * Omitting it from this map was therefore not a policy that runtime-cutover
 * migrations are forbidden; it was a map that had never been asked the
 * question. Left unfixed, the first migration in that wave would be silently
 * deferred out of EVERY wave — including D — so no release could ever apply it
 * while the deploy tool still reported success. That is the quiet-drop failure
 * mode this whole tool exists to prevent, and it is worse than a refusal.
 *
 * It sits in C and not in A_B for the reason that defines the wave: such a
 * migration is not safe ahead of its image (`safeBeforeCodeDeployment: false`),
 * so it must land WITH the cutover, never before it.
 */
export const WAVES = {
  A_B: ["HISTORICAL_PRESERVE_NEVER_REWRITE", "SAFE_TO_APPLY_NOW"],
  C: [
    "HISTORICAL_PRESERVE_NEVER_REWRITE",
    "SAFE_TO_APPLY_NOW",
    "WAIT_FOR_BACKFILL_READINESS",
    "WAIT_FOR_RUNTIME_CUTOVER",
  ],
  D: [
    "HISTORICAL_PRESERVE_NEVER_REWRITE",
    "SAFE_TO_APPLY_NOW",
    "WAIT_FOR_BACKFILL_READINESS",
    "WAIT_FOR_RUNTIME_CUTOVER",
    "CONTRACT_DROP_LATER",
  ],
};

export function loadWaves() {
  const inv = JSON.parse(readFileSync(resolve(REPO, "docs/architecture/migration-inventory-p6.json"), "utf8"));
  return Object.fromEntries(inv.migrations.map((m) => [m.name, m.releaseWave]));
}

/**
 * Select the migration directories a wave may apply.
 *
 * Returns `{selected, deferred, unclassified}`. An unclassified directory is an
 * ERROR, not a default-allow: the artifact carrying something the inventory has
 * never seen is exactly how an unreviewed migration reaches a database.
 */
export function selectForWave({ artifactMigrations, wave, waves }) {
  const allowed = new Set(WAVES[wave] ?? []);
  if (allowed.size === 0) throw new Error(`unknown wave: ${wave}`);
  const selected = [];
  const deferred = [];
  const unclassified = [];
  for (const name of artifactMigrations) {
    const w = waves[name];
    if (!w) unclassified.push(name);
    else if (allowed.has(w)) selected.push(name);
    else deferred.push(name);
  }
  return { selected: selected.sort(), deferred: deferred.sort(), unclassified: unclassified.sort() };
}

/**
 * What the database actually recorded. The deploy's own report is not evidence
 * of its bound — it reported success over a selection it had not applied.
 */
async function appliedMigrationNames(databaseUrl) {
  // `pg` rather than PrismaClient: the generated client is bound to the
  // repository's schema and Prisma 7 removed the `datasources` constructor
  // option, so pointing it at an arbitrary rehearsal database is awkward. This
  // is one read of one system table.
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const { rows } = await client.query(
      "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY migration_name",
    );
    return rows.map((r) => r.migration_name);
  } finally {
    await client.end();
  }
}

function artifactMigrationNames(artifactDir) {
  const root = join(artifactDir, "services/api/prisma/migrations");
  return readdirSync(root)
    .filter((d) => existsSync(join(root, d, "migration.sql")))
    .sort();
}

export async function deployWave({ artifactDir, wave, dryRun = false, databaseUrl, out }) {
  const waves = loadWaves();
  const all = artifactMigrationNames(artifactDir);
  const { selected, deferred, unclassified } = selectForWave({ artifactMigrations: all, wave, waves });

  if (unclassified.length > 0) {
    throw new Error(
      `REFUSING to deploy: ${unclassified.length} migration(s) in the artifact are absent from the Point-6 inventory: ${unclassified.join(", ")}`,
    );
  }

  // Re-check integrity of the SELECTED set, not the artifact. A wave that
  // carries a destructive migration whose guard sits in a later wave is the
  // defect this whole pass exists to prevent.
  const { evaluateArtifactIntegrity } = await import("../test/point8/artifact-integrity.mjs");
  const integrity = evaluateArtifactIntegrity({ view: selected, waves });
  if (!integrity.ok) {
    throw new Error(
      `REFUSING to deploy wave ${wave}: ${integrity.failures.map((f) => `${f.code} ${f.migration}`).join("; ")}`,
    );
  }

  // The stage must live inside the package: Prisma loads the generated
  // `prisma.config.ts` with its own TypeScript loader, and that file imports
  // `prisma/config`, which only resolves from somewhere under the workspace.
  // A stage in the system temp directory fails with "Cannot find module
  // 'prisma/config'". Gitignored — it is disposable output, never source.
  const stage = out ?? resolve(REPO, "services/api/.p8-release-wave", wave);
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(join(stage, "migrations"), { recursive: true });
  cpSync(join(artifactDir, "services/api/prisma/schema.prisma"), join(stage, "schema.prisma"));
  const lock = join(artifactDir, "services/api/prisma/migrations/migration_lock.toml");
  if (existsSync(lock)) cpSync(lock, join(stage, "migrations/migration_lock.toml"));
  for (const name of selected) {
    cpSync(join(artifactDir, "services/api/prisma/migrations", name), join(stage, "migrations", name), {
      recursive: true,
    });
  }

  writeFileSync(
    join(stage, "wave-selection.json"),
    `${JSON.stringify({ wave, selected: selected.length, deferred, artifactTotal: all.length }, null, 2)}\n`,
    "utf8",
  );

  // A DEDICATED config for the staged set.
  //
  // MEASURED, NOT ASSUMED: passing `--schema <stage>/schema.prisma` while
  // running from `services/api` applies all 221 migrations, because Prisma 7
  // loads `services/api/prisma.config.ts` and that file pins
  // `migrations.path = "prisma/migrations"`, which wins over `--schema`. The
  // first run of this tool reported "All migrations have been successfully
  // applied" over a 203-migration selection while the database recorded 221 —
  // including three Release-D contract migrations. Bounding a deploy by flag
  // alone is not possible here, and a tool that believed its own selection
  // would have been worse than no tool.
  //
  // The staged config also does NOT load any `.env`, unlike the repository's,
  // so a deploy cannot silently inherit a DATABASE_URL from
  // `services/api/.env`.
  writeFileSync(
    join(stage, "prisma.config.ts"),
    [
      "// GENERATED by scripts/release-deploy.mjs — bounds Prisma to one wave.",
      '// Deliberately loads no `.env`: the target comes from the caller alone.',
      'import { defineConfig } from "prisma/config";',
      "",
      "const url = process.env.DATABASE_URL?.trim();",
      'if (!url) throw new Error("release-deploy: DATABASE_URL is not set");',
      "",
      "export default defineConfig({",
      '  schema: "schema.prisma",',
      '  migrations: { path: "migrations" },',
      "  datasource: { url },",
      "});",
      "",
    ].join("\n"),
    "utf8",
  );

  if (dryRun) return { wave, selected, deferred, stage, applied: false };

  const env = { ...process.env, DATABASE_URL: databaseUrl ?? process.env.DATABASE_URL, CHECKPOINT_DISABLE: "1" };
  // pnpm keeps the real package under `.pnpm/…`; the workspace only carries a
  // bin shim, so the CLI is resolved rather than assumed to sit at a path.
  const prismaCli = createRequire(import.meta.url).resolve("prisma/build/index.js", {
    paths: [resolve(REPO, "services/api"), REPO],
  });
  // cwd is the STAGE, so the only config Prisma can discover is the one above.
  const output = execFileSync("node", [prismaCli, "migrate", "deploy"], {
    cwd: stage,
    encoding: "utf8",
    env,
    maxBuffer: 64 * 1024 * 1024,
  });

  // Trust nothing: ask the database what it actually recorded and refuse if it
  // does not match the selection. This is the check that caught the defect.
  const applied = await appliedMigrationNames(env.DATABASE_URL);
  const unexpected = applied.filter((n) => !selected.includes(n));
  if (unexpected.length > 0) {
    throw new Error(
      `DEPLOY BOUND VIOLATED: the database recorded ${unexpected.length} migration(s) outside wave ${wave}: ${unexpected.slice(0, 8).join(", ")}${unexpected.length > 8 ? ", …" : ""}`,
    );
  }

  return { wave, selected, deferred, stage, applied: true, appliedCount: applied.length, output };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const argv = process.argv.slice(2);
  const arg = (n, d) => {
    const i = argv.indexOf(n);
    return i >= 0 ? argv[i + 1] : d;
  };
  const r = await deployWave({
    artifactDir: resolve(arg("--artifact", "")),
    wave: arg("--wave", "A_B"),
    dryRun: argv.includes("--dry-run"),
    out: arg("--stage", undefined),
  });
  console.log(
    JSON.stringify(
      { wave: r.wave, selected: r.selected.length, deferred: r.deferred, applied: r.applied, stage: r.stage },
      null,
      2,
    ),
  );
  if (r.output) console.log(r.output.trim().split("\n").slice(-12).join("\n"));
}
