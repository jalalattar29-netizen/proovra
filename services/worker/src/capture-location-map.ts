import sharp from "sharp";
import {
  buildCaptureLocationPdfFallbackSvg,
  type CaptureLocationInput,
  resolveApprovedTileTemplate,
} from "@proovra/shared";

/**
 * AUD-025 — EVIDENCE COORDINATES NEVER LEAVE FOR A MAP BY DEFAULT.
 *
 * The mode defaulted to "static" with tile.openstreetmap.org as the template,
 * so every report and verification package with GPS evidence fetched tiles
 * whose x/y/z ARE the evidence location from a public third party, and logged
 * the tile URLs. The default is now the deterministic local renderer.
 * "static" draws tiles only from an endpoint a deployment explicitly
 * configures (CAPTURE_LOCATION_TILE_URL), and a known public provider is
 * refused even then: a configured endpoint must be the deployment's own,
 * approved tile server. A refused or missing endpoint renders locally.
 */
// The approved-endpoint policy lives in @proovra/shared (one rule for the
// report worker and the web map): resolveApprovedTileTemplate.
export { resolveApprovedTileTemplate };

export type CaptureLocationMapMode = "static" | "fallback" | "off";

/** Read per call, so the deployment's configuration is the only thing that decides. */
export function resolveCaptureLocationMapMode(env: NodeJS.ProcessEnv = process.env): {
  mode: CaptureLocationMapMode;
  tileTemplate: string | null;
} {
  const requested = env.CAPTURE_LOCATION_MAP_MODE?.trim().toLowerCase();
  if (requested === "off") return { mode: "off", tileTemplate: null };
  if (requested !== "static") return { mode: "fallback", tileTemplate: null };
  const approved = resolveApprovedTileTemplate(env.CAPTURE_LOCATION_TILE_URL);
  if (!approved.template) {
    // The reason only — never the configured URL, never a coordinate.
    console.warn("[capture-location-map] static tiles refused; rendering locally", {
      reason: approved.refused,
    });
    return { mode: "fallback", tileTemplate: null };
  }
  return { mode: "static", tileTemplate: approved.template };
}

async function renderFallbackPng(
  input: CaptureLocationInput & { width?: number; height?: number; zoom?: number }
): Promise<Buffer | null> {
  console.info("[capture-location-map] rendering locally", {
    width: input.width ?? null,
    height: input.height ?? null,
  });
  const svg = buildCaptureLocationPdfFallbackSvg({
    lat: input.lat ?? 0,
    lng: input.lng ?? 0,
    accuracyMeters: input.accuracyMeters ?? null,
    width: input.width,
    height: input.height,
    zoom: input.zoom,
  });
  if (!svg) return null;

  return sharp(Buffer.from(svg, "utf8"))
    .png({ compressionLevel: 9 })
    .toBuffer();
}

export async function renderCaptureLocationMapPreviewPng(
  input: CaptureLocationInput & {
    width?: number;
    height?: number;
    zoom?: number;
    tileGrid?: number;
  }
): Promise<Buffer | null> {
  if (
    input.lat === null ||
    input.lat === undefined ||
    input.lng === null ||
    input.lng === undefined
  ) {
    return null;
  }

  // 2026-10-20 (AUD-19) — AN ISSUED ARTIFACT NEVER FETCHES TILES. The report
  // and the verification package are immutable once issued; a map drawn from
  // a tile server (even the deployment's own) made their bytes depend on a
  // network answer at render time and sent the evidence location's tile
  // coordinates out of the worker. The worker renders the deterministic local
  // map only; "off" still omits it.
  const { mode } = resolveCaptureLocationMapMode();
  if (mode === "off") {
    return null;
  }
  return renderFallbackPng(input);
}

export async function renderCaptureLocationMapPreviewDataUrl(
  input: CaptureLocationInput & {
    width?: number;
    height?: number;
    zoom?: number;
    tileGrid?: number;
  }
): Promise<string | null> {
  const buffer = await renderCaptureLocationMapPreviewPng(input);
  return buffer ? `data:image/png;base64,${buffer.toString("base64")}` : null;
}
