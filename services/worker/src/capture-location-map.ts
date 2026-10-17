import sharp from "sharp";
import {
  buildCaptureLocationDisplayModel,
  buildCaptureLocationPdfFallbackSvg,
  type CaptureLocationDisplayModel,
  type CaptureLocationInput,
  resolveApprovedTileTemplate,
} from "@proovra/shared";

const DEFAULT_TILE_REQUEST_TIMEOUT_MS = 2_500;

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

function buildOverlaySvg(model: CaptureLocationDisplayModel): string {
  const pad = Math.max(22, Math.round(model.width * 0.026));
  const scaleBarWidth = Math.min(
    model.width * 0.18,
    (model.scaleBarMeters / model.metersPerPixel) * 0.72
  );

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${model.width}" height="${model.height}" viewBox="0 0 ${model.width} ${model.height}" fill="none">
  <defs>
    <filter id="pinShadow" x="-40%" y="-40%" width="180%" height="180%">
      <feDropShadow dx="0" dy="8" stdDeviation="8" flood-color="rgba(0,0,0,0.24)"/>
    </filter>
  </defs>

  <rect x="1" y="1" width="${model.width - 2}" height="${model.height - 2}" rx="24"
    fill="transparent" stroke="rgba(12,28,25,0.24)" stroke-width="2"/>

  <circle cx="${model.markerX}" cy="${model.markerY}" r="${model.accuracyRadiusPx}"
    fill="rgba(11,46,39,0.10)" stroke="rgba(11,46,39,0.32)" stroke-width="3"/>

  <line x1="${model.markerX - 34}" y1="${model.markerY}" x2="${model.markerX + 34}" y2="${model.markerY}"
    stroke="rgba(11,46,39,0.58)" stroke-width="2"/>
  <line x1="${model.markerX}" y1="${model.markerY - 34}" x2="${model.markerX}" y2="${model.markerY + 34}"
    stroke="rgba(11,46,39,0.58)" stroke-width="2"/>

  <circle cx="${model.markerX}" cy="${model.markerY}" r="13"
    fill="#0b2e27" stroke="#ffffff" stroke-width="4" filter="url(#pinShadow)"/>

  <path d="M ${model.markerX} ${model.markerY + 17} l -8 18 h 16 z"
    fill="#0b2e27" stroke="#ffffff" stroke-width="2"/>

  <rect x="${pad}" y="${model.height - 42}" width="${Math.round(scaleBarWidth)}" height="5" rx="2.5"
    fill="rgba(11,46,39,0.78)"/>
  <text x="${pad}" y="${model.height - 52}" fill="rgba(11,46,39,0.84)"
    font-size="13" font-weight="800" font-family="Helvetica Neue, Arial, sans-serif">${model.scaleBarLabel}</text>

  <text x="${model.width - pad}" y="${model.height - 24}" text-anchor="end"
    fill="rgba(11,46,39,0.58)" font-size="12" font-weight="700"
    font-family="Helvetica Neue, Arial, sans-serif">${model.attributionLabel}</text>
</svg>`;
}

async function fetchTileBuffer(
  url: string
): Promise<{ buffer: Buffer; contentType: string | null; byteLength: number }> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    DEFAULT_TILE_REQUEST_TIMEOUT_MS
  );

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "PROOVRA/1.0 forensic-capture-context",
      },
    });

    if (!response.ok) {
      throw new Error(`Tile request failed with ${response.status}`);
    }

    const contentType = response.headers.get("content-type");
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    if (buffer.byteLength < 512) {
      throw new Error(`Tile body too small (${buffer.byteLength} bytes)`);
    }

    if (contentType && !contentType.startsWith("image/")) {
      throw new Error(`Unexpected tile content-type: ${contentType}`);
    }

    return {
      buffer,
      contentType,
      byteLength: buffer.byteLength,
    };
  } finally {
    clearTimeout(timeout);
  }
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

async function renderStaticTilePreview(
  input: CaptureLocationInput & {
    width?: number;
    height?: number;
    zoom?: number;
    tileGrid?: number;
  },
  tileTemplate: string,
): Promise<Buffer | null> {
  const model = buildCaptureLocationDisplayModel({
    lat: input.lat ?? 0,
    lng: input.lng ?? 0,
    accuracyMeters: input.accuracyMeters ?? null,
    width: input.width,
    height: input.height,
    zoom: input.zoom,
    tileTemplate,
    tileGrid: input.tileGrid,
  });

  if (!model) return null;

  const visibleTiles = model.tiles.filter(
    (tile) =>
      tile.url &&
      tile.left < model.width &&
      tile.top < model.height &&
      tile.left + tile.width > 0 &&
      tile.top + tile.height > 0
  );

  // Counts only: a tile URL encodes the evidence location (AUD-025).
  console.info("[capture-location-map] renderStaticTilePreview start", {
    width: model.width,
    height: model.height,
    tileCount: model.tiles.length,
    visibleTileCount: visibleTiles.length,
  });

  const tileBuffers = await Promise.all(
    visibleTiles.map(async (tile) => {
      if (!tile.url) return null;
      try {
        const tileResult = await fetchTileBuffer(tile.url);
        return {
          left: Math.round(tile.left),
          top: Math.round(tile.top),
          width: Math.max(1, Math.round(tile.width)),
          height: Math.max(1, Math.round(tile.height)),
          buffer: tileResult.buffer,
          contentType: tileResult.contentType,
          byteLength: tileResult.byteLength,
        };
      } catch (error) {
        console.warn("[capture-location-map] tile fetch failed", {
          error: error instanceof Error ? error.message.slice(0, 120) : "unknown",
        });
        return null;
      }
    })
  );

  const validTiles = tileBuffers.filter(
    (tile): tile is NonNullable<typeof tile> => tile !== null
  );

  console.info("[capture-location-map] tile fetch result", {
    requestedVisibleTiles: visibleTiles.length,
    validTiles: validTiles.length,
  });

  const minimumUsefulTiles = Math.max(
    4,
    Math.ceil(visibleTiles.length * 0.75)
  );

  if (validTiles.length < minimumUsefulTiles) {
    console.warn("[capture-location-map] insufficient valid tiles, falling back", {
      requestedTiles: model.tiles.length,
      requestedVisibleTiles: visibleTiles.length,
      validTiles: validTiles.length,
      minimumUsefulTiles,
    });
    return null;
  }

  const base = sharp({
    create: {
      width: model.width,
      height: model.height,
      channels: 4,
      background: { r: 238, g: 241, b: 240, alpha: 1 },
    },
  });

  const composedTiles = await Promise.all(
    validTiles.map(async (tile) => ({
      input: await sharp(tile.buffer)
        .resize(tile.width, tile.height, { fit: "fill" })
        .png()
        .toBuffer(),
      left: tile.left,
      top: tile.top,
    }))
  );

  const overlayBuffer = await sharp(
    Buffer.from(buildOverlaySvg(model), "utf8")
  )
    .png()
    .toBuffer();

  console.info("[capture-location-map] using tile mode", {
    validTiles: validTiles.length,
    requestedVisibleTiles: visibleTiles.length,
  });

  const mapBackground = await base
    .composite(composedTiles)
    .grayscale()
    .modulate({ brightness: 1.08, saturation: 0 })
    .linear(1.08, -4)
    .sharpen({ sigma: 0.7 })
    .png({ compressionLevel: 9 })
    .toBuffer();

  return sharp(mapBackground)
    .composite([{ input: overlayBuffer, left: 0, top: 0 }])
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

  const { mode, tileTemplate } = resolveCaptureLocationMapMode();
  if (mode === "off") {
    return null;
  }

  if (mode === "fallback" || !tileTemplate) {
    return renderFallbackPng(input);
  }

  try {
    const tilePreview = await renderStaticTilePreview(input, tileTemplate);
    return tilePreview ?? (await renderFallbackPng(input));
  } catch (error) {
    console.warn("[capture-location-map] Falling back to deterministic preview", {
      error: error instanceof Error ? error.message.slice(0, 120) : "unknown",
    });
    return renderFallbackPng(input);
  }
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
