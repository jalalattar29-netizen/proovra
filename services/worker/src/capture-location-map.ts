import sharp from "sharp";
import {
  buildCaptureLocationDisplayModel,
  buildCaptureLocationMapSvg,
  type CaptureLocationDisplayModel,
  type CaptureLocationInput,
} from "@proovra/shared";

const DEFAULT_TILE_REQUEST_TIMEOUT_MS = 2_500;
const DEFAULT_MAP_MODE = (
  process.env.CAPTURE_LOCATION_MAP_MODE?.trim().toLowerCase() || "static"
) as "static" | "fallback" | "off";

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

async function fetchTileBuffer(url: string): Promise<Buffer> {
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

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } finally {
    clearTimeout(timeout);
  }
}

async function renderFallbackPng(
  input: CaptureLocationInput & { width?: number; height?: number; zoom?: number }
): Promise<Buffer | null> {
  const svg = buildCaptureLocationMapSvg({
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
  input: CaptureLocationInput & { width?: number; height?: number; zoom?: number }
): Promise<Buffer | null> {
  const model = buildCaptureLocationDisplayModel({
    lat: input.lat ?? 0,
    lng: input.lng ?? 0,
    accuracyMeters: input.accuracyMeters ?? null,
    width: input.width,
    height: input.height,
    zoom: input.zoom,
    tileTemplate: process.env.CAPTURE_LOCATION_TILE_URL?.trim() || undefined,
  });

  if (!model) return null;

  const tileBuffers = await Promise.all(
    model.tiles.map(async (tile) => {
      if (!tile.url) return null;
      const buffer = await fetchTileBuffer(tile.url);
      return {
        left: Math.round(tile.left),
        top: Math.round(tile.top),
        width: Math.max(1, Math.round(tile.width)),
        height: Math.max(1, Math.round(tile.height)),
        buffer,
      };
    })
  );

  const validTiles = tileBuffers.filter(
    (tile): tile is NonNullable<typeof tile> => tile !== null
  );

  if (validTiles.length === 0) {
    return null;
  }

  const base = sharp({
    create: {
      width: model.width,
      height: model.height,
      channels: 4,
      background: { r: 22, g: 31, b: 35, alpha: 1 },
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

return base
  .composite(composedTiles)
  .grayscale()
  .modulate({ brightness: 1.08, saturation: 0 })
  .linear(1.12, -8)
  .sharpen({ sigma: 0.8 })
  .composite([{ input: overlayBuffer, left: 0, top: 0 }])
  .png({ compressionLevel: 9 })
  .toBuffer();
}

export async function renderCaptureLocationMapPreviewPng(
  input: CaptureLocationInput & { width?: number; height?: number; zoom?: number }
): Promise<Buffer | null> {
  if (
    input.lat === null ||
    input.lat === undefined ||
    input.lng === null ||
    input.lng === undefined
  ) {
    return null;
  }

  if (DEFAULT_MAP_MODE === "off") {
    return null;
  }

  if (DEFAULT_MAP_MODE === "fallback") {
    return renderFallbackPng(input);
  }

  try {
    return (await renderStaticTilePreview(input)) ?? (await renderFallbackPng(input));
  } catch (error) {
    console.warn(
      "[capture-location-map] Falling back to deterministic preview:",
      error
    );
    return renderFallbackPng(input);
  }
}

export async function renderCaptureLocationMapPreviewDataUrl(
  input: CaptureLocationInput & { width?: number; height?: number; zoom?: number }
): Promise<string | null> {
  const buffer = await renderCaptureLocationMapPreviewPng(input);
  return buffer ? `data:image/png;base64,${buffer.toString("base64")}` : null;
}
