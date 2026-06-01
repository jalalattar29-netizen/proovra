/**
 * PHASE 1A IA RESET — canonical /operations/runbooks surface.
 *
 * This is the canonical URL for the operator runbook catalog.
 * The legacy `/ops/runbooks` URL now 308-redirects here (see
 * `apps/web/next.config.js`). The actual page implementation still
 * lives under `app/(app)/ops/runbooks/page.tsx`; we re-export its
 * default here so this canonical route serves the same content.
 */
export { default } from "../../ops/runbooks/page";
