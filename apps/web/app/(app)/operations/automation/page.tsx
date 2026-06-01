/**
 * PHASE 1A IA RESET — canonical /operations/automation surface.
 *
 * This is the canonical URL for the automation operator view.
 * The legacy `/ops/automation` URL now 308-redirects here (see
 * `apps/web/next.config.js`). The actual page implementation still
 * lives under `app/(app)/ops/automation/page.tsx`; we re-export
 * its default here so this canonical route serves the same content.
 */
export { default } from "../../ops/automation/page";
