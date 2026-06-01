/**
 * PHASE 1A IA RESET — canonical /operations/media-graph surface.
 *
 * This is the canonical URL for the media graph operator view.
 * The legacy `/ops/media-graph` URL now 308-redirects here (see
 * `apps/web/next.config.js`). The actual page implementation still
 * lives under `app/(app)/ops/media-graph/page.tsx`; we re-export
 * its default here so this canonical route serves the same content.
 */
export { default } from "../../ops/media-graph/page";
