/**
 * AUD-025 — THE APPROVED TILE ENDPOINT, one policy for every map (2026-10-17;
 * moved here from the report worker so the web map reads the same rule).
 * Tiles are requested only from an endpoint a deployment explicitly
 * configures, and a known PUBLIC provider is refused even then: the tile x/y/z
 * ARE the evidence location, so it must be the deployment's own tile server.
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

