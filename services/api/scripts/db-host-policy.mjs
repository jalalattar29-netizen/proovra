/**
 * Phase 2.5D — Shared DB host classification policy.
 *
 * Single source of truth for "is this DATABASE_URL safe to mutate?".
 * Used by:
 *   - `scripts/safe-migrate.mjs` (Phase 2.5C wrapper) — wraps the
 *     `prisma migrate` CLI invocation with a host check + dual-
 *     override requirement.
 *   - `prisma.config.ts` (Phase 2.5D in-process hook) — runs the
 *     same check when the prisma client is initialised, so direct
 *     `pnpm exec prisma migrate ...` invocations cannot bypass the
 *     wrapper.
 *
 * Both consumers MUST go through this module so the policy is
 * truly centralised. A future PR that loosens classification only
 * has to touch one file, and CI re-asserts the policy on every
 * push.
 *
 * Exports:
 *   - SAFE_HOSTS           : Set<string>
 *   - REMOTE_PATTERNS      : RegExp[]
 *   - classifyHost(host)   : "local" | "remote" | "unknown"
 *   - parseDatabaseHost(url): { host, port, database, protocol }
 *   - shouldAllowMigration({ classification, allowRemoteFlag, envOverride })
 *
 * Hard rules:
 *   - This module is .mjs (no TypeScript compile step) so it can
 *     be `import`-ed from both `safe-migrate.mjs` and the prisma
 *     config without depending on the build pipeline.
 *   - The classifier is conservative: anything not explicitly
 *     local is treated as needing dual-override. Unknown hosts
 *     fall in the same bucket as known-remote.
 */

/**
 * Host names that are considered SAFE to mutate without explicit
 * operator confirmation. Anything not in this list is non-local.
 *
 * Intentionally narrow:
 *   - `localhost`, `127.0.0.1`, `::1` — the developer's machine.
 *   - `host.docker.internal` — Docker Desktop bridge to host.
 *   - `postgres` — bare service name inside docker compose.
 *   - `proovra_postgres` — explicit container hostname.
 */
export const SAFE_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "host.docker.internal",
  "postgres",
  "proovra_postgres",
]);

/**
 * Patterns that mark a host as definitively remote / production-like.
 * Defense in depth on top of SAFE_HOSTS — a string that happens to
 * also match a SAFE_HOSTS entry would still be classified `remote`
 * if it matches one of these patterns.
 */
export const REMOTE_PATTERNS = [
  /\.neon\.tech$/i,
  /\.amazonaws\.com$/i,
  /\.azure\.com$/i,
  /\.googleusercontent\.com$/i,
  /\.cloudsql\./i,
  /\.pooler\./i,
  /-pooler\./i,
];

/**
 * @param {string} host
 * @returns {"local" | "remote" | "unknown"}
 */
export function classifyHost(host) {
  if (!host || host.length === 0) return "unknown";
  if (REMOTE_PATTERNS.some((re) => re.test(host))) return "remote";
  if (SAFE_HOSTS.has(host)) return "local";
  return "unknown";
}

/**
 * @param {string} url
 * @returns {{ host: string, port: string, database: string, protocol: string }}
 */
export function parseDatabaseHost(url) {
  try {
    const parsed = new URL(url);
    return {
      host: parsed.hostname || "",
      port: parsed.port || "",
      database: (parsed.pathname || "").replace(/^\//, ""),
      protocol: parsed.protocol || "",
    };
  } catch {
    return { host: "", port: "", database: "", protocol: "" };
  }
}

/**
 * Policy: should a migration be allowed to proceed?
 *
 * @param {object} args
 * @param {"local" | "remote" | "unknown"} args.classification
 * @param {boolean} args.allowRemoteFlag  — `--allow-remote` was passed
 * @param {boolean} args.envOverride      — `MIGRATE_ALLOW_REMOTE=1` is set
 * @returns {{ allow: boolean, reason: string }}
 */
export function shouldAllowMigration({
  classification,
  allowRemoteFlag,
  envOverride,
}) {
  if (classification === "local") {
    return { allow: true, reason: "local_host" };
  }
  // Non-local hosts require BOTH overrides. Either alone is not
  // enough — see Phase 2.5C reasoning.
  if (allowRemoteFlag && envOverride) {
    return { allow: true, reason: "explicit_dual_override" };
  }
  if (allowRemoteFlag && !envOverride) {
    return {
      allow: false,
      reason: "missing_env_MIGRATE_ALLOW_REMOTE",
    };
  }
  if (!allowRemoteFlag && envOverride) {
    return {
      allow: false,
      reason: "missing_flag_--allow-remote",
    };
  }
  return {
    allow: false,
    reason: `non_local_host_${classification}`,
  };
}
