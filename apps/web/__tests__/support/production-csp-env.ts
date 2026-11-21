/**
 * PRO-PW-09 — a production build's CSP inputs for middleware tests. Imported
 * BEFORE the middleware (its inputs are read at module load). `node --test`
 * runs each file in its own process, so this never leaks into another file.
 */
import "./split-host-env";

(process.env as Record<string, string>).NODE_ENV = "production";
process.env.NEXT_PUBLIC_API_BASE = "https://api.proovra.test";
process.env.NEXT_PUBLIC_SENTRY_DSN = "https://publickey@o4507.ingest.de.sentry.io/4508";
process.env.NEXT_PUBLIC_CAPTURE_LOCATION_TILE_URL = "https://tiles.proovra.test/{z}/{x}/{y}.png";

export const TEST_SENTRY_ORIGIN = "https://o4507.ingest.de.sentry.io";
export const TEST_TILE_ORIGIN = "https://tiles.proovra.test";
export const TEST_API_ORIGIN = "https://api.proovra.test";
