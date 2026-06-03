import { defineConfig } from "prisma/config";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
// Phase 2.5D — in-process safety hook. Closes the residual bypass
// risk left over from Phase 2.5C, where the safe-migrate.mjs wrapper
// only protected the `pnpm prisma:migrate` script. A developer who
// ran `pnpm exec prisma migrate deploy` directly (or had a shell
// alias) could still target a remote DB. Now the SAME host
// classification policy is enforced HERE — before Prisma's CLI
// produces any side effect — so direct invocations also refuse
// non-local hosts by default.
//
// `db-host-policy.mjs` is .mjs (no compile step) and lives next to
// `safe-migrate.mjs`. Importing it from a .ts file works because
// the prisma CLI runs `tsx` over this file, which resolves .mjs
// imports natively.
// Phase 2.5D — policy logic inlined to avoid a TS resolver collision
// with `.mjs` imports under `"moduleResolution": "Bundler"`. The
// canonical implementation lives in
// `scripts/db-host-policy.mjs` (consumed by `safe-migrate.mjs`); this
// in-process hook duplicates the small surface to keep the file self-
// contained. A test in `e2e/phase2-5d-migration-safety.spec.ts`
// asserts that both code paths refuse the same remote URL identically.
const SAFE_HOSTS = new Set([
    "localhost",
    "127.0.0.1",
    "::1",
    "host.docker.internal",
    "postgres",
    "proovra_postgres",
]);
const REMOTE_PATTERNS = [
    /\.neon\.tech$/i,
    /\.amazonaws\.com$/i,
    /\.azure\.com$/i,
    /\.googleusercontent\.com$/i,
    /\.cloudsql\./i,
    /\.pooler\./i,
    /-pooler\./i,
];
function classifyHost(host) {
    if (!host || host.length === 0)
        return "unknown";
    if (REMOTE_PATTERNS.some((re) => re.test(host)))
        return "remote";
    if (SAFE_HOSTS.has(host))
        return "local";
    return "unknown";
}
function parseDatabaseHost(url) {
    try {
        const parsed = new URL(url);
        return { host: parsed.hostname || "" };
    }
    catch {
        return { host: "" };
    }
}
function shouldAllowMigration(args) {
    if (args.classification === "local") {
        return { allow: true, reason: "local_host" };
    }
    if (args.allowRemoteFlag && args.envOverride) {
        return { allow: true, reason: "explicit_dual_override" };
    }
    if (args.allowRemoteFlag) {
        return { allow: false, reason: "missing_env_MIGRATE_ALLOW_REMOTE" };
    }
    if (args.envOverride) {
        return { allow: false, reason: "missing_flag_--allow-remote" };
    }
    return { allow: false, reason: `non_local_host_${args.classification}` };
}
function loadEnvFile(path) {
    if (!existsSync(path))
        return;
    const content = readFileSync(path, "utf8");
    for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#"))
            continue;
        const idx = line.indexOf("=");
        if (idx <= 0)
            continue;
        const key = line.slice(0, idx).trim();
        let value = line.slice(idx + 1).trim();
        if (!key)
            continue;
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        if (process.env[key] === undefined) {
            process.env[key] = value;
        }
    }
}
const cwdEnv = resolve(process.cwd(), ".env");
const serviceEnv = resolve(process.cwd(), "services/api/.env");
loadEnvFile(cwdEnv);
if (serviceEnv !== cwdEnv) {
    loadEnvFile(serviceEnv);
}
const databaseUrl = process.env.DATABASE_URL?.trim();
const shadowUrl = process.env.SHADOW_DATABASE_URL?.trim();
if (!databaseUrl) {
    throw new Error("DATABASE_URL is not set. Prisma config could not find it in process.env, .env, or services/api/.env");
}
// =============================================================================
// Phase 2.5D — In-process migration-target safety hook.
//
// Runs the SAME classification policy as scripts/safe-migrate.mjs so
// the wrapper is not the only enforcement layer. Direct
// `pnpm exec prisma migrate <...>` invocations now hit this check
// before any DB operation. Read-only commands (`prisma generate`,
// `prisma format`, etc.) are NOT blocked because they never mutate
// the DB; we only refuse when the invocation is clearly a migration.
//
// The "is this a migration?" check is conservative: we look for
// `migrate` anywhere in `process.argv`. If a future Prisma command
// adds a migration-capable verb we don't know about, the conservative
// reading is "block it"; the operator can use the documented
// `--allow-remote` + `MIGRATE_ALLOW_REMOTE=1` override.
//
// PRISMA_BYPASS_SAFETY=1 is an explicit operator escape hatch for
// the rare case where the hook itself is the problem (e.g. prisma's
// own internals run a probe against the URL during `prisma generate`
// in some future version). Setting it makes the hook log a warning
// but proceed. Both the hook AND the documented escape hatch path
// are tested in the Phase 2.5D e2e spec.
// =============================================================================
const argv = process.argv.join(" ").toLowerCase();
const looksLikeMigration = argv.includes(" migrate ") ||
    argv.endsWith(" migrate") ||
    argv.includes(" db push") ||
    argv.includes(" db pull") ||
    argv.includes(" db execute") ||
    argv.includes(" db seed");
const bypassEnv = process.env.PRISMA_BYPASS_SAFETY === "1";
if (looksLikeMigration && !bypassEnv) {
    const { host } = parseDatabaseHost(databaseUrl);
    const classification = classifyHost(host);
    const allowRemoteFlag = process.argv.includes("--allow-remote") ||
        // The wrapper strips --allow-remote before invoking prisma. If the
        // wrapper called us, the env override below carries the signal.
        process.env.SAFE_MIGRATE_WRAPPER_OK === "1";
    const envOverride = process.env.MIGRATE_ALLOW_REMOTE === "1";
    const decision = shouldAllowMigration({
        classification,
        allowRemoteFlag,
        envOverride,
    });
    if (!decision.allow) {
        process.stderr.write("\n" +
            "═══════════════════════════════════════════════════════════════\n" +
            "  PROOVRA in-process migration safety hook (Phase 2.5D)\n" +
            "═══════════════════════════════════════════════════════════════\n" +
            `  host          : ${host || "(empty)"}\n` +
            `  classification: ${classification.toUpperCase()}\n` +
            `  reason        : ${decision.reason}\n` +
            "═══════════════════════════════════════════════════════════════\n" +
            "\n" +
            "  [prisma.config] REFUSED: direct prisma migration commands are\n" +
            "  blocked against non-local DATABASE_URL targets.\n" +
            "\n" +
            "  Use the supported entrypoint:\n" +
            "    pnpm --filter proovra-api prisma:migrate\n" +
            "\n" +
            "  For an intentional remote migration, pass BOTH:\n" +
            "    --allow-remote    (CLI flag)\n" +
            "    MIGRATE_ALLOW_REMOTE=1  (env var)\n" +
            "\n" +
            "  Emergency escape hatch (use only after confirming the host\n" +
            "  is correct):  PRISMA_BYPASS_SAFETY=1\n" +
            "\n" +
            "  See docs/operations/MIGRATION_DISCIPLINE.md.\n\n");
        process.exit(8);
    }
}
else if (looksLikeMigration && bypassEnv) {
    process.stderr.write("\n[prisma.config] WARNING: PRISMA_BYPASS_SAFETY=1 — in-process " +
        "safety hook bypassed. Proceeding without host classification.\n\n");
}
export default defineConfig({
    schema: "prisma/schema.prisma",
    migrations: {
        path: "prisma/migrations",
    },
    datasource: {
        url: databaseUrl,
        shadowDatabaseUrl: shadowUrl || undefined,
    },
});
