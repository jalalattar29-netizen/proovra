import sharp from "sharp";
import {
  buildCaptureLocationReportViewport,
  resolveReportMapTileSource,
  type CaptureLocationReportViewport,
  type ReportMapTileRefusal,
  type ReportMapTileSource,
} from "@proovra/shared";

import { REPORT_MAP_IMAGE } from "./report-v2/page-geometry.js";

/**
 * THE PDF REPORT'S STREET MAP (2026-11-12).
 *
 * Owner decision 2026-11-12 revises AUD-025 / AUD-19 for this feature only:
 * a NEWLY generated report whose record holds a saved, authorized location
 * may carry a real street map, composed here from XYZ tiles of ONE
 * deliberately configured source (resolveReportMapTileSource in
 * @proovra/shared/tile-endpoint-policy) and embedded in the PDF as a PNG, so
 * the issued bytes never depend on the network again. Previously issued PDFs
 * are stored bytes and are never re-rendered.
 *
 * WHAT A REQUEST SENDS — and nothing else:
 *   - GET <configured template with {z}/{x}/{y}>: the zoom and tile indices of
 *     the tiles around the recorded position. For an "external" source they
 *     reveal the approximate area shown (one tile at z16 is ≈ 400 m across).
 *   - User-Agent: REPORT_MAP_USER_AGENT (a fixed string naming the
 *     application, as the OpenStreetMap tile policy requires) and Accept.
 *   - A commercial source's API key, when its configured template carries
 *     one (Geoapify: ?apiKey=): it identifies PROOVRA's account, not a record.
 *   - The worker's egress IP and TLS handshake, inherent to any request.
 * Never sent: evidence content, record / report / user / workspace ids,
 * emails, cookies, a Referer, or the coordinates themselves.
 *
 * BOUNDS: every request goes to the configured host (checked per URL), never
 * follows a redirect, has a per-tile timeout and a total deadline, at most
 * REPORT_MAP_MAX_TILES tiles and REPORT_MAP_CONCURRENCY at a time, and a
 * bounded body. Any failure → `unavailable`: the report states "Map preview
 * unavailable" beside the location cards and generation completes.
 *
 * CACHE: an in-process LRU of tile bytes honouring the source's
 * Cache-Control / Expires (7 days when it sends neither — the OpenStreetMap
 * tile policy's floor), revalidated with If-None-Match / If-Modified-Since.
 * Tiles are only ever fetched for a report being generated (no prefetch).
 *
 * LOGS carry the outcome, zoom and counts — never a coordinate, tile index,
 * URL or the provider's API key (which rides in the configured template's
 * query, e.g. Geoapify ?apiKey=, and is sent to that provider only).
 */

export const REPORT_MAP_WIDTH_PX = REPORT_MAP_IMAGE.widthPx;
export const REPORT_MAP_HEIGHT_PX = REPORT_MAP_IMAGE.heightPx;
export const REPORT_MAP_USER_AGENT = "PROOVRA-ReportMap/1.0 (evidence report renderer; +https://www.proovra.com)";
export const REPORT_MAP_MAX_TILES = 24;
export const REPORT_MAP_CONCURRENCY = 2;
const TILE_TIMEOUT_MS = 4_000;
const TOTAL_DEADLINE_MS = 12_000;
const MAX_TILE_BYTES = 1_000_000;
const MIN_TILE_BYTES = 64;
const DEFAULT_CACHE_SECONDS = 7 * 24 * 3600;
const CACHE_MAX_ENTRIES = 512;
const TILE_SIZE = 256;

export type ReportMapResult =
  | {
      status: "rendered";
      dataUrl: string;
      attribution: string;
      sourceKind: ReportMapTileSource["kind"];
      zoom: number;
      scaleBarLabel: string;
    }
  | { status: "unavailable"; reason: ReportMapTileRefusal | "INVALID_LOCATION" | "TOO_MANY_TILES" | "FETCH_FAILED" | "COMPOSE_FAILED" };

type CachedTile = { body: Buffer; expiresAt: number; etag: string | null; lastModified: string | null };
const tileCache = new Map<string, CachedTile>();

/** Test seam. */
export function resetReportMapTileCacheForTest(): void {
  tileCache.clear();
}

function cacheLifetimeMs(headers: Headers): number {
  const cc = headers.get("cache-control") ?? "";
  const maxAge = /(?:^|,)\s*(?:s-maxage|max-age)=(\d+)/i.exec(cc);
  if (maxAge?.[1]) return Number(maxAge[1]) * 1000;
  const expires = headers.get("expires");
  if (expires) {
    const t = Date.parse(expires);
    if (Number.isFinite(t)) return Math.max(0, t - Date.now());
  }
  return DEFAULT_CACHE_SECONDS * 1000;
}

function remember(url: string, entry: CachedTile): void {
  tileCache.delete(url);
  tileCache.set(url, entry);
  while (tileCache.size > CACHE_MAX_ENTRIES) {
    const oldest = tileCache.keys().next().value;
    if (oldest === undefined) break;
    tileCache.delete(oldest);
  }
}

function tileUrl(source: ReportMapTileSource, t: { z: number; x: number; y: number }): string {
  const url = source.template.replace("{z}", String(t.z)).replace("{x}", String(t.x)).replace("{y}", String(t.y));
  // Only the configured host is ever asked (a template is operator config,
  // but the check is per URL so a malformed template cannot widen it).
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase().replace(/\.$/, "") !== source.host) {
    throw new Error("REPORT_MAP_HOST_MISMATCH");
  }
  return url;
}

async function fetchTile(url: string, deadline: number): Promise<{ body: Buffer; cached: boolean }> {
  const now = Date.now();
  const hit = tileCache.get(url);
  if (hit && hit.expiresAt > now) {
    remember(url, hit);
    return { body: hit.body, cached: true };
  }
  const budget = Math.min(TILE_TIMEOUT_MS, deadline - now);
  if (budget <= 0) throw new Error("REPORT_MAP_DEADLINE");
  const headers: Record<string, string> = { "User-Agent": REPORT_MAP_USER_AGENT, Accept: "image/png,image/*;q=0.8" };
  if (hit?.etag) headers["If-None-Match"] = hit.etag;
  if (hit?.lastModified) headers["If-Modified-Since"] = hit.lastModified;
  const response = await fetch(url, {
    method: "GET",
    headers,
    redirect: "error",
    referrerPolicy: "no-referrer",
    credentials: "omit",
    signal: AbortSignal.timeout(budget),
  });
  if (response.status === 304 && hit) {
    remember(url, { ...hit, expiresAt: Date.now() + cacheLifetimeMs(response.headers) });
    return { body: hit.body, cached: true };
  }
  if (!response.ok) throw new Error(`REPORT_MAP_HTTP_${response.status}`);
  const type = response.headers.get("content-type") ?? "";
  if (!type.startsWith("image/")) throw new Error("REPORT_MAP_NOT_IMAGE");
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_TILE_BYTES) throw new Error("REPORT_MAP_TOO_LARGE");
  const body = Buffer.from(await response.arrayBuffer());
  if (body.byteLength < MIN_TILE_BYTES || body.byteLength > MAX_TILE_BYTES) throw new Error("REPORT_MAP_BAD_SIZE");
  remember(url, {
    body,
    expiresAt: Date.now() + cacheLifetimeMs(response.headers),
    etag: response.headers.get("etag"),
    lastModified: response.headers.get("last-modified"),
  });
  return { body, cached: false };
}

/**
 * A failure as a bounded code for the log. Only our own REPORT_MAP_* codes and
 * an error class name pass: a runtime message may quote the request URL, and
 * the URL carries a commercial provider's API key and the tile indices.
 */
function failureCode(error: unknown): string {
  if (error instanceof Error && /^REPORT_MAP_[A-Z0-9_]+$/.test(error.message)) return error.message;
  if (error instanceof Error && /^[A-Za-z]{1,40}$/.test(error.name)) return error.name;
  return "unknown";
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Marker, geographic accuracy circle and scale bar, in image pixels. */
export function buildReportMapOverlaySvg(v: CaptureLocationReportViewport): string {
  const r = v.accuracyRadiusPx;
  const barX = 14;
  const barY = v.height - 16;
  const barW = Math.round(v.scaleBarPx);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${v.width}" height="${v.height}" viewBox="0 0 ${v.width} ${v.height}">
  ${
    r !== null
      ? `<circle cx="${v.markerX}" cy="${v.markerY}" r="${r.toFixed(2)}" fill="rgba(31,95,87,0.16)" stroke="rgba(15,62,56,0.85)" stroke-width="2"/>`
      : ""
  }
  <circle cx="${v.markerX}" cy="${v.markerY}" r="6.5" fill="#0f3e38" stroke="#ffffff" stroke-width="2.5"/>
  <rect x="${barX - 6}" y="${barY - 17}" width="${barW + 12}" height="25" rx="3" fill="rgba(255,255,255,0.86)"/>
  <rect x="${barX}" y="${barY}" width="${barW}" height="3" fill="#1d2b29"/>
  <rect x="${barX}" y="${barY - 5}" width="1.5" height="8" fill="#1d2b29"/>
  <rect x="${barX + barW - 1.5}" y="${barY - 5}" width="1.5" height="8" fill="#1d2b29"/>
  <text x="${barX}" y="${barY - 6}" font-family="Helvetica, Arial, sans-serif" font-size="11" font-weight="700" fill="#1d2b29">${escapeXml(v.scaleBarLabel)}</text>
</svg>`;
}

/**
 * The street map for a report, or why there is none. `input` must be the
 * saved, authorized location — the caller only asks when the report prints it.
 */
export async function renderCaptureLocationReportMap(
  input: { lat: string | number; lng: string | number; accuracyMeters: string | number | null | undefined },
  env: NodeJS.ProcessEnv = process.env,
): Promise<ReportMapResult> {
  const started = Date.now();
  const resolved = resolveReportMapTileSource(env);
  if (!resolved.source) {
    if (resolved.refused !== "MAP_MODE_OFF" && resolved.refused !== "NOT_CONFIGURED") {
      console.warn("[report-map] source refused; no map in this report", { reason: resolved.refused });
    }
    return { status: "unavailable", reason: resolved.refused };
  }
  const source = resolved.source;
  const viewport = buildCaptureLocationReportViewport({
    lat: input.lat,
    lng: input.lng,
    accuracyMeters: input.accuracyMeters ?? null,
    width: REPORT_MAP_WIDTH_PX,
    height: REPORT_MAP_HEIGHT_PX,
  });
  if (!viewport) return { status: "unavailable", reason: "INVALID_LOCATION" };
  if (viewport.tiles.length === 0 || viewport.tiles.length > REPORT_MAP_MAX_TILES) {
    return { status: "unavailable", reason: "TOO_MANY_TILES" };
  }

  const deadline = started + TOTAL_DEADLINE_MS;
  let fetched: Array<{ body: Buffer; cached: boolean }>;
  try {
    fetched = await mapWithConcurrency(viewport.tiles, REPORT_MAP_CONCURRENCY, (t) => fetchTile(tileUrl(source, t), deadline));
  } catch (error) {
    console.warn("[report-map] tile retrieval failed; no map in this report", {
      sourceKind: source.kind,
      zoom: viewport.zoom,
      tiles: viewport.tiles.length,
      error: failureCode(error),
      ms: Date.now() - started,
    });
    return { status: "unavailable", reason: "FETCH_FAILED" };
  }

  try {
    // A mosaic of whole tiles, then the exact viewport cut from it: tiles may
    // start left of / above the image, and sharp composites at offsets ≥ 0.
    const minLeft = Math.min(...viewport.tiles.map((t) => t.left));
    const minTop = Math.min(...viewport.tiles.map((t) => t.top));
    const mosaicW = Math.max(...viewport.tiles.map((t) => t.left)) - minLeft + TILE_SIZE;
    const mosaicH = Math.max(...viewport.tiles.map((t) => t.top)) - minTop + TILE_SIZE;
    const layers = await Promise.all(
      viewport.tiles.map(async (t, i) => ({
        input: await sharp(fetched[i]!.body).resize(TILE_SIZE, TILE_SIZE, { fit: "fill" }).png().toBuffer(),
        left: Math.round(t.left - minLeft),
        top: Math.round(t.top - minTop),
      })),
    );
    const mosaic = await sharp({
      create: { width: Math.round(mosaicW), height: Math.round(mosaicH), channels: 4, background: { r: 242, g: 239, b: 233, alpha: 1 } },
    })
      .composite(layers)
      .png()
      .toBuffer();
    const png = await sharp(mosaic)
      .extract({
        left: Math.round(-minLeft),
        top: Math.round(-minTop),
        width: viewport.width,
        height: viewport.height,
      })
      .composite([{ input: Buffer.from(buildReportMapOverlaySvg(viewport), "utf8"), left: 0, top: 0 }])
      .png({ compressionLevel: 9 })
      .toBuffer();
    console.info("[report-map] rendered", {
      sourceKind: source.kind,
      zoom: viewport.zoom,
      tiles: viewport.tiles.length,
      cached: fetched.filter((f) => f.cached).length,
      bytes: png.byteLength,
      ms: Date.now() - started,
    });
    return {
      status: "rendered",
      dataUrl: `data:image/png;base64,${png.toString("base64")}`,
      attribution: source.attribution,
      sourceKind: source.kind,
      zoom: viewport.zoom,
      scaleBarLabel: viewport.scaleBarLabel,
    };
  } catch (error) {
    console.warn("[report-map] compose failed; no map in this report", {
      error: failureCode(error),
    });
    return { status: "unavailable", reason: "COMPOSE_FAILED" };
  }
}
