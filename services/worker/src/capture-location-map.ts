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
  const labelPadding = Math.max(20, Math.round(model.width * 0.038));
  const footerHeight = Math.max(94, Math.round(model.height * 0.17));
  const markerOuterRadius = Math.max(24, model.accuracyRadiusPx * 0.64);
  const scaleBarWidth = Math.min(
    model.width * 0.22,
    (model.scaleBarMeters / model.metersPerPixel) * 0.76
  );

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${model.width}" height="${model.height}" viewBox="0 0 ${model.width} ${model.height}" fill="none">
  <defs>
    <linearGradient id="topFade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="rgba(8,14,16,0.44)"/>
      <stop offset="100%" stop-color="rgba(8,14,16,0)"/>
    </linearGradient>
    <linearGradient id="footer" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="rgba(9,16,18,0.02)"/>
      <stop offset="100%" stop-color="rgba(9,16,18,0.76)"/>
    </linearGradient>
    <filter id="shadow" x="-30%" y="-30%" width="160%" height="160%">
      <feDropShadow dx="0" dy="10" stdDeviation="14" flood-color="rgba(4,8,10,0.35)"/>
    </filter>
  </defs>

  <rect width="${model.width}" height="${model.height}" rx="28" fill="transparent"/>
  <rect width="${model.width}" height="${Math.round(model.height * 0.26)}" rx="28" fill="url(#topFade)"/>
  <rect y="${model.height - footerHeight}" width="${model.width}" height="${footerHeight}" fill="url(#footer)"/>
  <rect x="1" y="1" width="${model.width - 2}" height="${model.height - 2}" rx="27" stroke="rgba(213,221,224,0.22)"/>

  <circle cx="${model.markerX}" cy="${model.markerY}" r="${model.accuracyRadiusPx}" fill="rgba(98,176,171,0.18)" stroke="rgba(98,176,171,0.44)" stroke-width="2.4"/>
  <circle cx="${model.markerX}" cy="${model.markerY}" r="${markerOuterRadius}" fill="rgba(98,176,171,0.08)"/>
  <line x1="${model.markerX - 26}" y1="${model.markerY}" x2="${model.markerX + 26}" y2="${model.markerY}" stroke="rgba(236,241,243,0.72)" stroke-width="1.2"/>
  <line x1="${model.markerX}" y1="${model.markerY - 26}" x2="${model.markerX}" y2="${model.markerY + 26}" stroke="rgba(236,241,243,0.72)" stroke-width="1.2"/>
  <circle cx="${model.markerX}" cy="${model.markerY}" r="10" fill="#69c7bd" stroke="#dce6e3" stroke-width="3" filter="url(#shadow)"/>
  <path d="M ${model.markerX} ${model.markerY + 15} l -7 16 h 14 z" fill="#69c7bd" stroke="#dce6e3" stroke-width="2" />

  <text x="${labelPadding}" y="42" fill="rgba(241,246,247,0.92)" font-size="18" font-weight="800" letter-spacing="2.4" font-family="Inter, Helvetica Neue, Arial, sans-serif">CAPTURE CONTEXT</text>
  <text x="${labelPadding}" y="68" fill="rgba(241,246,247,0.94)" font-size="27" font-weight="700" font-family="Inter, Helvetica Neue, Arial, sans-serif">${model.locationLineLabel}</text>
  <text x="${model.width - labelPadding}" y="42" text-anchor="end" fill="rgba(232,237,239,0.82)" font-size="15.5" font-weight="700" font-family="Inter, Helvetica Neue, Arial, sans-serif">${model.sourceLabel}</text>

  <rect x="${labelPadding}" y="${model.height - 56}" width="${Math.round(scaleBarWidth)}" height="5" rx="2.5" fill="rgba(240,244,246,0.92)"/>
  <line x1="${labelPadding}" y1="${model.height - 62}" x2="${labelPadding}" y2="${model.height - 44}" stroke="rgba(240,244,246,0.92)" stroke-width="1.1"/>
  <line x1="${labelPadding + Math.round(scaleBarWidth)}" y1="${model.height - 62}" x2="${labelPadding + Math.round(scaleBarWidth)}" y2="${model.height - 44}" stroke="rgba(240,244,246,0.92)" stroke-width="1.1"/>
  <text x="${labelPadding}" y="${model.height - 68}" fill="rgba(236,241,243,0.82)" font-size="12.5" font-weight="700" font-family="Inter, Helvetica Neue, Arial, sans-serif">${model.scaleBarLabel}</text>

  <text x="${labelPadding}" y="${model.height - 22}" fill="rgba(236,241,243,0.88)" font-size="20" font-weight="600" font-family="Inter, Helvetica Neue, Arial, sans-serif">${model.accuracyLabel}</text>
  <text x="${model.width - labelPadding}" y="${model.height - 20}" text-anchor="end" fill="rgba(200,209,212,0.78)" font-size="12" font-weight="600" font-family="Inter, Helvetica Neue, Arial, sans-serif">${model.attributionLabel}</text>
  <text x="${model.width - labelPadding}" y="${model.height - 42}" text-anchor="end" fill="rgba(232,237,239,0.86)" font-size="15.5" font-weight="700" font-family="Inter, Helvetica Neue, Arial, sans-serif">PROOVRA</text>
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
    .modulate({ brightness: 0.76, saturation: 0.18 })
    .gamma(1.08)
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
