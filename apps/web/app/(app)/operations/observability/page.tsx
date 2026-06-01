/**
 * PHASE 1A IA RESET — canonical /operations/observability surface.
 *
 * This is the canonical URL for the platform observability dashboard.
 * The legacy `/ops/observability` URL now 308-redirects here (see
 * `apps/web/next.config.js`). The actual page implementation still
 * lives under `app/(app)/ops/observability/page.tsx` to avoid churning
 * every internal import in this consolidation pass; we re-export its
 * default here so this canonical route serves the same content.
 */
export { default } from "../../ops/observability/page";
