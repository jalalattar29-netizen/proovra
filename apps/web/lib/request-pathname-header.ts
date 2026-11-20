/**
 * PRO-PW-10 — the request header the middleware stamps with the path being
 * rendered, so the ROOT LAYOUT (which Next gives no pathname) can render the
 * same document language the client will. Set on every request the
 * middleware forwards; a value a client sends is overwritten. Its own module
 * so the middleware bundle does not pull in the i18n dictionaries.
 */
export const REQUEST_PATHNAME_HEADER = "x-proovra-pathname";
