/**
 * PROOVRA V2 internal UI foundation — public entry point.
 *
 * The stylesheet is imported from `app/globals.css` alongside the other
 * experience sheets (`app-primitives.css`, `cases-experience.css`,
 * `notifications.css`). It is inert until a `.pv2-*` class is rendered or
 * `useProovraV2Surface()` opts a route in, so shipping it globally does
 * not migrate any page on its own.
 */
export * from "./primitives";
export * from "./icons";
export { useProovraV2Surface } from "./useProovraV2Surface";
