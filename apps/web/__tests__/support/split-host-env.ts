/**
 * Split-host deployment for middleware tests (PRO-A1-02). Imported BEFORE the
 * middleware, whose host bases are read at module load. `node --test` runs
 * each test file in its own process, so this never leaks into another file.
 */
process.env.NEXT_PUBLIC_APP_BASE = "https://app.proovra.test";
process.env.NEXT_PUBLIC_WEB_BASE = "https://www.proovra.test";

export const SPLIT_HOSTS = { app: "app.proovra.test", web: "www.proovra.test" } as const;
