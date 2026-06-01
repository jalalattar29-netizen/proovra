/**
 * PHASE 1A IA RESET — canonical /operations/quotas surface.
 *
 * This is the canonical URL for the platform quotas operator view.
 * The legacy `/dashboard/quotas` URL now 308-redirects here (see
 * `apps/web/next.config.js`). The actual page implementation still
 * lives under `app/(app)/dashboard/quotas/page.tsx`; we re-export
 * its default here so this canonical route serves the same content.
 */
export { default } from "../../dashboard/quotas/page";
