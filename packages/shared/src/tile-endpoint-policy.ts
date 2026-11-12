/**
 * AUD-025 — THE APPROVED TILE ENDPOINT (2026-10-17; moved here from the report
 * worker so the web map reads the same rule). Tiles are requested only from an
 * endpoint a deployment explicitly configures, and a known PUBLIC provider is
 * refused even then: the tile x/y/z ARE the evidence location, so it must be
 * the deployment's own tile server. This governs the web CSP, the automatic
 * web / native map and the verification package.
 *
 * REVISED 2026-11-12 (owner decision) FOR THE PDF REPORT'S MAP ONLY: see
 * resolveReportMapTileSource below — the report worker may use an external
 * provider when the deployment configures it and declares it "external".
 */
export const PUBLIC_TILE_PROVIDER_HOSTS = [
  "openstreetmap.org",
  "openstreetmap.fr",
  "openstreetmap.de",
  "osm.org",
  "opentopomap.org",
  "mapbox.com",
  "googleapis.com",
  "google.com",
  "gstatic.com",
  "arcgisonline.com",
  "arcgis.com",
  "cartocdn.com",
  "stadiamaps.com",
  "stamen.com",
  "thunderforest.com",
  "maptiler.com",
  "here.com",
  "hereapi.com",
  "virtualearth.net",
  "bing.com",
  "wikimedia.org",
  "esri.com",
  "tomtom.com",
  "mapquest.com",
  "geoapify.com",
];

/** The approved tile template, or null with the bounded reason it was refused. */
export function resolveApprovedTileTemplate(
  raw: string | null | undefined,
): { template: string | null; refused: "NOT_CONFIGURED" | "INVALID_URL" | "PUBLIC_PROVIDER" | null } {
  const value = raw?.trim();
  if (!value) return { template: null, refused: "NOT_CONFIGURED" };
  if (!value.includes("{z}") || !value.includes("{x}") || !value.includes("{y}")) {
    return { template: null, refused: "INVALID_URL" };
  }
  let host: string;
  try {
    const url = new URL(value.replace(/\{[xyzs]\}/g, "0"));
    if (url.protocol !== "https:" && url.protocol !== "http:") return { template: null, refused: "INVALID_URL" };
    host = url.hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return { template: null, refused: "INVALID_URL" };
  }
  const isPublic = PUBLIC_TILE_PROVIDER_HOSTS.some((h) => host === h || host.endsWith("." + h));
  return isPublic ? { template: null, refused: "PUBLIC_PROVIDER" } : { template: value, refused: null };
}


/**
 * THE PDF REPORT'S MAP SOURCE (2026-11-12) — the report worker ONLY.
 *
 * Owner decision 2026-11-12 revises AUD-025 / AUD-19 for this one feature:
 * when a newly generated report holds a saved, authorized location, the
 * worker may fetch street-map tiles from ONE deliberately configured source
 * and embed the composed image in the PDF. The verification package, the web
 * and native maps and every other worker network path keep their own rules.
 *
 * Configuration (all read per call; nothing has a default URL):
 *   CAPTURE_LOCATION_MAP_MODE        "static" turns report map imagery on.
 *   CAPTURE_LOCATION_TILE_URL        XYZ template, https, with {z} {x} {y}.
 *                                    A commercial provider's API key rides
 *                                    in its query (e.g. Geoapify ?apiKey=),
 *                                    so the template is a SECRET: it is
 *                                    never logged or put in a report.
 *   CAPTURE_LOCATION_TILE_SOURCE     "proovra" (a PROOVRA-operated tile
 *                                    server) or "external" (a third-party
 *                                    provider). A known public provider is
 *                                    accepted ONLY as "external": it then
 *                                    receives the tile z/x/y, which reveal
 *                                    the approximate area shown.
 *   CAPTURE_LOCATION_TILE_ATTRIBUTION the source's required credit, printed
 *                                    on the map. Required for "external";
 *                                    an openstreetmap.org source defaults to
 *                                    "© OpenStreetMap contributors".
 */
export type ReportMapTileSource = {
  template: string;
  host: string;
  kind: "proovra" | "external";
  attribution: string;
};

export type ReportMapTileRefusal =
  | "MAP_MODE_OFF"
  | "NOT_CONFIGURED"
  | "INVALID_URL"
  | "SOURCE_KIND_MISSING"
  | "PUBLIC_PROVIDER_NOT_DECLARED_EXTERNAL"
  | "ATTRIBUTION_MISSING";

export const OPENSTREETMAP_TILE_ATTRIBUTION = "© OpenStreetMap contributors";

export function resolveReportMapTileSource(env: {
  CAPTURE_LOCATION_MAP_MODE?: string;
  CAPTURE_LOCATION_TILE_URL?: string;
  CAPTURE_LOCATION_TILE_SOURCE?: string;
  CAPTURE_LOCATION_TILE_ATTRIBUTION?: string;
}): { source: ReportMapTileSource; refused: null } | { source: null; refused: ReportMapTileRefusal } {
  if (env.CAPTURE_LOCATION_MAP_MODE?.trim().toLowerCase() !== "static") return { source: null, refused: "MAP_MODE_OFF" };
  const value = env.CAPTURE_LOCATION_TILE_URL?.trim();
  if (!value) return { source: null, refused: "NOT_CONFIGURED" };
  if (!value.includes("{z}") || !value.includes("{x}") || !value.includes("{y}")) return { source: null, refused: "INVALID_URL" };
  let host: string;
  try {
    const url = new URL(value.replace(/\{[xyz]\}/g, "0"));
    // Report imagery travels over TLS only; credentials in the URL are refused.
    if (url.protocol !== "https:" || url.username || url.password) return { source: null, refused: "INVALID_URL" };
    host = url.hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return { source: null, refused: "INVALID_URL" };
  }
  const kind = env.CAPTURE_LOCATION_TILE_SOURCE?.trim().toLowerCase();
  if (kind !== "proovra" && kind !== "external") return { source: null, refused: "SOURCE_KIND_MISSING" };
  const isPublic = PUBLIC_TILE_PROVIDER_HOSTS.some((h) => host === h || host.endsWith("." + h));
  if (isPublic && kind !== "external") return { source: null, refused: "PUBLIC_PROVIDER_NOT_DECLARED_EXTERNAL" };
  const isOsm = host === "openstreetmap.org" || host.endsWith(".openstreetmap.org");
  const attribution =
    env.CAPTURE_LOCATION_TILE_ATTRIBUTION?.trim() || (isOsm ? OPENSTREETMAP_TILE_ATTRIBUTION : "");
  if (!attribution && kind === "external") return { source: null, refused: "ATTRIBUTION_MISSING" };
  return {
    source: { template: value, host, kind, attribution: attribution || OPENSTREETMAP_TILE_ATTRIBUTION },
    refused: null,
  };
}

/**
 * THE INTERACTIVE MAP'S TILE SOURCE — browser and native app ONLY
 * (2026-10-18). ONE policy, three cases:
 *
 *   - SERVER (report worker, PDF, package): `resolveApprovedTileTemplate`
 *     above — every public provider refused (AUD-025). Unchanged.
 *   - A privately hosted, approved tile endpoint (NEXT_PUBLIC_ / EXPO_PUBLIC_
 *     CAPTURE_LOCATION_TILE_URL, which this same policy accepts) → the map
 *     may load AUTOMATICALLY: the location never leaves the deployment.
 *   - Otherwise → the public OpenStreetMap tiles the map used until
 *     ebea6a075, but ONLY AFTER THE VIEWER EXPLICITLY ASKS for them: the tile
 *     z/x/y reveal the approximate location and the provider sees the viewer's
 *     IP address, so nothing is requested before that choice.
 *
 * A location the API withholds never reaches the map layer at all — this
 * policy only decides HOW a disclosed location may be drawn.
 */
export const PUBLIC_INTERACTIVE_TILE_TEMPLATE = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";

export type InteractiveMapTileSource =
  | { mode: "automatic"; template: string }
  | { mode: "consent"; template: string; provider: "OpenStreetMap" };

export function resolveInteractiveMapTileSource(configured: string | null | undefined): InteractiveMapTileSource {
  const approved = resolveApprovedTileTemplate(configured).template;
  return approved
    ? { mode: "automatic", template: approved }
    : { mode: "consent", template: PUBLIC_INTERACTIVE_TILE_TEMPLATE, provider: "OpenStreetMap" };
}

/** What the viewer is told before the first public tile request. */
export const PUBLIC_MAP_CONSENT_NOTICE =
  "Loading the map sends the approximate viewed location and your IP address to OpenStreetMap.";
