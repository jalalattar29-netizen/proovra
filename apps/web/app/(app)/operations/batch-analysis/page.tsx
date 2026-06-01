/**
 * PHASE 1A IA RESET — canonical /operations/batch-analysis surface.
 *
 * This is the canonical URL for the batch-analysis operator dashboard.
 * The legacy `/dashboard/batch-analysis` URL now 308-redirects here
 * (see `apps/web/next.config.js`). The actual page implementation
 * still lives under `app/(app)/dashboard/batch-analysis/page.tsx`;
 * we re-export its default here so this canonical route serves the
 * same content.
 */
export { default } from "../../dashboard/batch-analysis/page";
