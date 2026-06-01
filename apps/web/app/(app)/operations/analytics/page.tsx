/**
 * PHASE 1A IA RESET — canonical /operations/analytics surface.
 *
 * This is the canonical URL for the platform analytics dashboard.
 * The legacy `/ops/analytics` URL now 308-redirects here (see
 * `apps/web/next.config.js`). The actual page implementation still
 * lives under `app/(app)/ops/analytics/page.tsx`; we re-export
 * its default here so this canonical route serves the same content.
 */
export { default } from "../../ops/analytics/page";
