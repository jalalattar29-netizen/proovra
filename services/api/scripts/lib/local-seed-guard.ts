/**
 * ET-UPL-04 — THE refusal every seeding script runs before its first write.
 *
 * services/api/.env carries live Production credentials, and a seeder that
 * loads it (or inherits a stray DATABASE_URL) and trusts NODE_ENV alone writes
 * fabricated SIGNED evidence and custody into whatever that URL names.
 * seed-home-personas.ts did exactly that; seed-admin-fixture.ts had a name
 * check but no host check. Both now use this one guard:
 *
 *   - NODE_ENV must not be production;
 *   - DATABASE_URL must be set and parseable;
 *   - the database NAME must look local (test / fixture / local / dev) and must
 *     not look like production (prod / production / neondb);
 *   - the HOST must be loopback (localhost, 127.x, ::1, *.localhost) or a
 *     single-label compose service name (e.g. `postgres`) — never a dotted
 *     remote host.
 *
 * Seeders do not load a .env file: DATABASE_URL is passed explicitly.
 */

export function localSeedDatabaseRefusal(env: NodeJS.ProcessEnv = process.env): string | null {
  if ((env.NODE_ENV ?? "").trim().toLowerCase() === "production") return "NODE_ENV is production.";
  const dsn = (env.DATABASE_URL ?? "").trim();
  if (dsn === "") return "DATABASE_URL is not set (pass it explicitly; seeders load no .env file).";
  let url: URL;
  try {
    url = new URL(dsn);
  } catch {
    return "DATABASE_URL is not a parseable URL.";
  }
  const name = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!/(test|fixture|local|dev)/i.test(name)) {
    return `database "${name}" does not look local. Name it with test/fixture/local/dev.`;
  }
  if (/(prod|production|neondb)/i.test(name)) return `database "${name}" looks like production.`;
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const loopback =
    host === "localhost" ||
    host.endsWith(".localhost") ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) ||
    host === "::1";
  const composeService = /^[a-z0-9][a-z0-9_-]*$/.test(host);
  if (!loopback && !composeService) {
    return `host "${host}" is not loopback or a local compose service name.`;
  }
  return null;
}

export function assertLocalSeedDatabase(script: string, env: NodeJS.ProcessEnv = process.env): void {
  const refusal = localSeedDatabaseRefusal(env);
  if (refusal) {
    // eslint-disable-next-line no-console
    console.error(`${script}: REFUSED — ${refusal}`);
    process.exit(1);
  }
}
