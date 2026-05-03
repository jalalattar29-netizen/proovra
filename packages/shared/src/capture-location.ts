export const CAPTURE_LOCATION_SOURCE_LABEL =
  "Browser/device-reported geolocation";

export const CAPTURE_LOCATION_STATUS_LABEL = "Location metadata included";

export const CAPTURE_LOCATION_CONTEXT_DESCRIPTION =
  "Device/browser-reported location preserved with this evidence record.";

export const CAPTURE_LOCATION_SHORT_BOUNDARY =
  "Location metadata is device-reported and permission-based.";

export const CAPTURE_LOCATION_LEGAL_BOUNDARY =
  "Location metadata is device/browser-reported and user-permission-based. It may support context, but it does not independently prove physical presence, authorship, truth, or admissibility.";

export const CAPTURE_LOCATION_MAP_ATTRIBUTION =
  "Map data © OpenStreetMap contributors";

const EARTH_RADIUS_METERS = 6_378_137;
const DEFAULT_TILE_SIZE = 256;
const DEFAULT_TILE_GRID = 3;
const DEFAULT_MAP_WIDTH = 1200;
const DEFAULT_MAP_HEIGHT = 720;
const DEFAULT_TILE_URL =
  "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const OPEN_STREET_MAP_URL = "https://www.openstreetmap.org/";

export type CaptureLocationInput = {
  lat?: string | number | null;
  lng?: string | number | null;
  accuracyMeters?: string | number | null;
};

export type CaptureLocationTile = {
  key: string;
  x: number;
  y: number;
  left: number;
  top: number;
  width: number;
  height: number;
  url: string | null;
};

export type CaptureLocationDisplayModel = {
  lat: number;
  lng: number;
  accuracyMeters: number | null;
  width: number;
  height: number;
  zoom: number;
  tileSize: number;
  coordinateLabel: string;
  latLabel: string;
  lngLabel: string;
  accuracyLabel: string;
  statusLabel: string;
  description: string;
  sourceLabel: string;
  legalBoundary: string;
  attributionLabel: string;
  locationLineLabel: string;
  geoUri: string;
  externalMapUrl: string;
  metersPerPixel: number;
  markerX: number;
  markerY: number;
  accuracyRadiusPx: number;
  scaleBarMeters: number;
  scaleBarLabel: string;
  tileGrid: number;
  tileTemplate: string;
  tiles: CaptureLocationTile[];
};

function toFiniteNumber(
  value: string | number | null | undefined
): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function trimTrailingZeros(value: string): string {
  return value.includes(".") ? value.replace(/\.?0+$/, "") : value;
}

function clampLatitude(value: number): number {
  return Math.max(-85.05112878, Math.min(85.05112878, value));
}

function normalizeLongitude(value: number): number {
  if (!Number.isFinite(value)) return 0;
  let next = value;
  while (next < -180) next += 360;
  while (next > 180) next -= 360;
  return next;
}

function escapeSvgText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function buildCoordinateLineLabel(lat: number, lng: number): string {
  return `${formatCaptureLocationCoordinate(lat)}°, ${formatCaptureLocationCoordinate(lng)}°`;
}

function chooseZoom(accuracyMeters: number | null): number {
  if (accuracyMeters === null) return 15;
  if (accuracyMeters <= 12) return 18;
  if (accuracyMeters <= 30) return 17;
  if (accuracyMeters <= 75) return 16;
  if (accuracyMeters <= 150) return 15;
  if (accuracyMeters <= 500) return 14;
  if (accuracyMeters <= 1_500) return 13;
  if (accuracyMeters <= 5_000) return 12;
  return 11;
}

function latLngToWorldPixel(lat: number, lng: number, zoom: number): {
  x: number;
  y: number;
} {
  const tileScale = DEFAULT_TILE_SIZE * 2 ** zoom;
  const normalizedLat = clampLatitude(lat);
  const normalizedLng = normalizeLongitude(lng);
  const latRad = (normalizedLat * Math.PI) / 180;

  const x = ((normalizedLng + 180) / 360) * tileScale;
  const y =
    ((1 -
      Math.log(
        Math.tan(latRad) + 1 / Math.cos(latRad)
      ) /
        Math.PI) /
      2) *
    tileScale;

  return { x, y };
}

function buildScaleBarMeters(metersPerPixel: number, width: number): number {
  const targetMeters = metersPerPixel * (width * 0.22);
  const steps = [
    5,
    10,
    20,
    25,
    50,
    100,
    200,
    250,
    500,
    1_000,
    2_000,
    5_000,
    10_000,
    20_000,
  ];

  for (const step of steps) {
    if (step >= targetMeters) return step;
  }

  return 20_000;
}

function formatScaleBarLabel(meters: number): string {
  if (meters >= 1_000) {
    const km = meters / 1_000;
    return km % 1 === 0 ? `${km} km` : `${trimTrailingZeros(km.toFixed(1))} km`;
  }
  return `${meters} m`;
}

function formatGridCoordinate(value: number): string {
  const abs = Math.abs(value);
  return `${trimTrailingZeros(abs.toFixed(abs >= 10 ? 2 : 3))}°`;
}

function buildTileUrl(
  tileTemplate: string,
  x: number,
  y: number,
  zoom: number
): string | null {
  const maxTileIndex = 2 ** zoom;
  if (y < 0 || y >= maxTileIndex) return null;

  const wrappedX = ((x % maxTileIndex) + maxTileIndex) % maxTileIndex;
  return tileTemplate
    .replace("{z}", String(zoom))
    .replace("{x}", String(wrappedX))
    .replace("{y}", String(y));
}

export function hasCaptureLocationMetadata(
  input: CaptureLocationInput | null | undefined
): boolean {
  return (
    toFiniteNumber(input?.lat ?? null) !== null &&
    toFiniteNumber(input?.lng ?? null) !== null
  );
}

export function formatCaptureLocationCoordinate(
  value: string | number | null | undefined
): string {
  const normalized = toFiniteNumber(value);
  if (normalized === null) return "Not recorded";
  return trimTrailingZeros(normalized.toFixed(6));
}

export function formatCaptureLocationAccuracy(
  value: string | number | null | undefined
): string {
  const normalized = toFiniteNumber(value);
  if (normalized === null || normalized < 0) return "Not recorded";

  const rounded =
    normalized >= 1_000
      ? Math.round(normalized)
      : normalized >= 100
        ? Math.round(normalized)
        : normalized >= 10
          ? Math.round(normalized)
          : Math.round(normalized * 10) / 10;

  return `± ${trimTrailingZeros(String(rounded))} meters`;
}

export function buildCaptureLocationGeoUri(
  input: CaptureLocationInput | null | undefined
): string | null {
  const lat = toFiniteNumber(input?.lat ?? null);
  const lng = toFiniteNumber(input?.lng ?? null);
  if (lat === null || lng === null) return null;

  const accuracy = toFiniteNumber(input?.accuracyMeters ?? null);
  const coordinateText = `${formatCaptureLocationCoordinate(lat)},${formatCaptureLocationCoordinate(lng)}`;
  const query =
    accuracy !== null && accuracy >= 0
      ? `;u=${encodeURIComponent(trimTrailingZeros(accuracy.toFixed(1)))}`
      : "";

  return `geo:${coordinateText}${query}`;
}

export function buildCaptureLocationExternalMapUrl(
  input: CaptureLocationInput | null | undefined,
  zoom?: number | null
): string | null {
  const lat = toFiniteNumber(input?.lat ?? null);
  const lng = toFiniteNumber(input?.lng ?? null);
  if (lat === null || lng === null) return null;

  const nextZoom = Math.max(3, Math.min(19, Math.round(zoom ?? chooseZoom(null))));
  const latText = formatCaptureLocationCoordinate(lat);
  const lngText = formatCaptureLocationCoordinate(lng);

  return `${OPEN_STREET_MAP_URL}?mlat=${encodeURIComponent(latText)}&mlon=${encodeURIComponent(
    lngText
  )}#map=${nextZoom}/${encodeURIComponent(latText)}/${encodeURIComponent(lngText)}`;
}

export function buildCaptureLocationDisplayModel(params: {
  lat: string | number;
  lng: string | number;
  accuracyMeters?: string | number | null;
  width?: number;
  height?: number;
  zoom?: number;
  tileTemplate?: string | null;
  tileGrid?: number;
}): CaptureLocationDisplayModel | null {
  const lat = toFiniteNumber(params.lat);
  const lng = toFiniteNumber(params.lng);
  if (lat === null || lng === null) return null;

  const normalizedLat = clampLatitude(lat);
  const normalizedLng = normalizeLongitude(lng);
  const accuracy = toFiniteNumber(params.accuracyMeters ?? null);
  const width = Math.max(320, Math.round(params.width ?? DEFAULT_MAP_WIDTH));
  const height = Math.max(220, Math.round(params.height ?? DEFAULT_MAP_HEIGHT));
  const zoom = Math.max(3, Math.min(19, Math.round(params.zoom ?? chooseZoom(accuracy))));
  const tileGrid = Math.max(3, Math.min(5, Math.round(params.tileGrid ?? DEFAULT_TILE_GRID)));
  const tileTemplate =
    typeof params.tileTemplate === "string" && params.tileTemplate.trim()
      ? params.tileTemplate.trim()
      : DEFAULT_TILE_URL;

  const metersPerPixel =
    (Math.cos((normalizedLat * Math.PI) / 180) *
      2 *
      Math.PI *
      EARTH_RADIUS_METERS) /
    (DEFAULT_TILE_SIZE * 2 ** zoom);

  const worldPixel = latLngToWorldPixel(normalizedLat, normalizedLng, zoom);
  const gridHalf = Math.floor(tileGrid / 2);
  const startTileX = Math.floor(worldPixel.x / DEFAULT_TILE_SIZE) - gridHalf;
  const startTileY = Math.floor(worldPixel.y / DEFAULT_TILE_SIZE) - gridHalf;
  const startPixelX = startTileX * DEFAULT_TILE_SIZE;
  const startPixelY = startTileY * DEFAULT_TILE_SIZE;
  const mosaicSize = tileGrid * DEFAULT_TILE_SIZE;

  const targetAspect = width / height;
  const cropWidth =
    targetAspect >= 1 ? mosaicSize : Math.max(DEFAULT_TILE_SIZE, mosaicSize * targetAspect);
  const cropHeight =
    targetAspect >= 1 ? Math.max(DEFAULT_TILE_SIZE, mosaicSize / targetAspect) : mosaicSize;
  const cropLeft = (mosaicSize - cropWidth) / 2;
  const cropTop = (mosaicSize - cropHeight) / 2;
  const scale = width / cropWidth;

  const markerBaseX = worldPixel.x - startPixelX;
  const markerBaseY = worldPixel.y - startPixelY;
  const markerX = (markerBaseX - cropLeft) * scale;
  const markerY = (markerBaseY - cropTop) * scale;
  const clampedMarkerX = Math.max(0, Math.min(width, markerX));
const clampedMarkerY = Math.max(0, Math.min(height, markerY));
  const accuracyRadiusPx =
    accuracy === null || accuracy < 0
      ? Math.max(22, Math.min(46, width * 0.032))
      : Math.max(18, Math.min(width * 0.16, (accuracy / metersPerPixel) * scale));

  const tiles: CaptureLocationTile[] = [];
  for (let row = 0; row < tileGrid; row += 1) {
    for (let col = 0; col < tileGrid; col += 1) {
      const tileX = startTileX + col;
      const tileY = startTileY + row;
      tiles.push({
        key: `${zoom}:${tileX}:${tileY}`,
        x: tileX,
        y: tileY,
        left: (col * DEFAULT_TILE_SIZE - cropLeft) * scale,
        top: (row * DEFAULT_TILE_SIZE - cropTop) * scale,
        width: DEFAULT_TILE_SIZE * scale,
        height: DEFAULT_TILE_SIZE * scale,
        url: buildTileUrl(tileTemplate, tileX, tileY, zoom),
      });
    }
  }

  const scaleBarMeters = buildScaleBarMeters(metersPerPixel, width);

  return {
    lat: normalizedLat,
    lng: normalizedLng,
    accuracyMeters: accuracy,
    width,
    height,
    zoom,
    tileSize: DEFAULT_TILE_SIZE,
    coordinateLabel: buildCoordinateLineLabel(normalizedLat, normalizedLng),
    latLabel: formatCaptureLocationCoordinate(normalizedLat),
    lngLabel: formatCaptureLocationCoordinate(normalizedLng),
    accuracyLabel: formatCaptureLocationAccuracy(accuracy),
    statusLabel: CAPTURE_LOCATION_STATUS_LABEL,
    description: CAPTURE_LOCATION_CONTEXT_DESCRIPTION,
    sourceLabel: CAPTURE_LOCATION_SOURCE_LABEL,
    legalBoundary: CAPTURE_LOCATION_LEGAL_BOUNDARY,
    attributionLabel: CAPTURE_LOCATION_MAP_ATTRIBUTION,
    locationLineLabel: buildCoordinateLineLabel(normalizedLat, normalizedLng),
    geoUri: buildCaptureLocationGeoUri({
      lat: normalizedLat,
      lng: normalizedLng,
      accuracyMeters: accuracy,
    })!,
    externalMapUrl: buildCaptureLocationExternalMapUrl(
      {
        lat: normalizedLat,
        lng: normalizedLng,
        accuracyMeters: accuracy,
      },
      zoom
    )!,
    metersPerPixel,
markerX: clampedMarkerX,
markerY: clampedMarkerY,
    accuracyRadiusPx,
    scaleBarMeters,
    scaleBarLabel: formatScaleBarLabel(scaleBarMeters),
    tileGrid,
    tileTemplate,
    tiles,
  };
}

function buildCenteredMapMarker(params: {
  centerX: number;
  centerY: number;
  markerFill: string;
  markerStroke: string;
  crosshairStroke: string;
  crosshairExtent?: number;
  markerRadius?: number;
  tailHeight?: number;
  tailHalfWidth?: number;
  shadowId?: string;
}): string {
  const crosshairExtent = params.crosshairExtent ?? 26;
  const markerRadius = params.markerRadius ?? 10.5;
  const tailHeight = params.tailHeight ?? 14;
  const tailHalfWidth = params.tailHalfWidth ?? 7;
  const shadow = params.shadowId
    ? ` filter="url(#${escapeSvgText(params.shadowId)})"`
    : "";

  return `
  <line x1="${params.centerX - crosshairExtent}" y1="${params.centerY}" x2="${
    params.centerX + crosshairExtent
  }" y2="${params.centerY}" stroke="${params.crosshairStroke}" stroke-width="1.2"/>
  <line x1="${params.centerX}" y1="${params.centerY - crosshairExtent}" x2="${
    params.centerX
  }" y2="${params.centerY + crosshairExtent}" stroke="${params.crosshairStroke}" stroke-width="1.2"/>
  <circle cx="${params.centerX}" cy="${params.centerY}" r="${markerRadius}"
    fill="${params.markerFill}" stroke="${params.markerStroke}" stroke-width="3.4"${shadow}/>
  <path d="M ${params.centerX} ${params.centerY + markerRadius + 5} l -${tailHalfWidth} ${tailHeight} h ${
    tailHalfWidth * 2
  } z"
    fill="${params.markerFill}" stroke="${params.markerStroke}" stroke-width="1.6"/>
`;
}

function buildSurveyCurvePath(
  width: number,
  height: number,
  seed: number,
  amplitude: number,
  offsetRatio: number
): string {
  const offset = ((seed % 97) / 97) * height * 0.22;
  const y = height * offsetRatio + offset * 0.12;
  const p1 = width * (0.18 + ((seed % 11) * 0.011));
  const p2 = width * (0.42 + ((seed % 7) * 0.013));
  const p3 = width * (0.74 + ((seed % 5) * 0.01));

  return `M ${-40} ${y.toFixed(1)}
    C ${p1.toFixed(1)} ${(y - amplitude).toFixed(1)},
      ${p2.toFixed(1)} ${(y + amplitude * 0.68).toFixed(1)},
      ${p3.toFixed(1)} ${(y - amplitude * 0.52).toFixed(1)}
    S ${(width + 20).toFixed(1)} ${(y + amplitude * 0.36).toFixed(1)},
      ${(width + 40).toFixed(1)} ${(y - amplitude * 0.1).toFixed(1)}`;
}

export function buildCaptureLocationStaticMapFallbackSvg(params: {
  lat: string | number;
  lng: string | number;
  accuracyMeters?: string | number | null;
  width?: number;
  height?: number;
  zoom?: number;
}): string {
  const model = buildCaptureLocationDisplayModel(params);
  if (!model) {
    return "";
  }

  const {
    width,
    height,
    accuracyRadiusPx,
    locationLineLabel,
    accuracyLabel,
    sourceLabel,
    attributionLabel,
    scaleBarMeters,
    scaleBarLabel,
    lat,
    lng,
  } = model;

  const framePaddingX = Math.round(width * 0.075);
  const framePaddingY = Math.round(height * 0.12);
  const plotWidth = width - framePaddingX * 2;
  const plotHeight = height - framePaddingY * 2;
  const gridLatStep = 0.004 * (18 / model.zoom);
  const gridLngStep = 0.006 * (18 / model.zoom);
  const scaleBarWidth = Math.min(
    width * 0.24,
    (scaleBarMeters / model.metersPerPixel) * 0.72
  );
  const seed = Math.round((Math.abs(lat) + Math.abs(lng)) * 10_000);
  const centerX = Math.round(width / 2);
  const centerY = Math.round(height / 2);

  const verticalLines = Array.from({ length: 6 }, (_, index) => {
    const x = framePaddingX + (plotWidth / 5) * index;
    return `<line x1="${x}" y1="${framePaddingY}" x2="${x}" y2="${
      height - framePaddingY
    }" stroke="rgba(215,223,226,0.13)" stroke-width="1" />`;
  }).join("");

  const horizontalLines = Array.from({ length: 5 }, (_, index) => {
    const y = framePaddingY + (plotHeight / 4) * index;
    return `<line x1="${framePaddingX}" y1="${y}" x2="${
      width - framePaddingX
    }" y2="${y}" stroke="rgba(215,223,226,0.11)" stroke-width="1" />`;
  }).join("");

  const roadPaths = [
    buildSurveyCurvePath(width, height, seed + 7, 28, 0.23),
    buildSurveyCurvePath(width, height, seed + 19, 22, 0.47),
    buildSurveyCurvePath(width, height, seed + 37, 30, 0.7),
  ]
    .map(
      (d, index) =>
        `<path d="${d}" fill="none" stroke="${
          index === 1 ? "rgba(153,167,171,0.30)" : "rgba(194,202,205,0.20)"
        }" stroke-width="${index === 1 ? 4.4 : 2.1}" stroke-linecap="round" />`
    )
    .join("");

  const terrainPaths = Array.from({ length: 5 }, (_, index) =>
    `<path d="${buildSurveyCurvePath(
      width,
      height,
      seed + 53 + index * 11,
      14 + index * 4,
      0.16 + index * 0.16
    )}" fill="none" stroke="rgba(106,126,132,0.14)" stroke-width="${
      1.15 + index * 0.12
    }" />`
  ).join("");

  const latTicks = Array.from({ length: 3 }, (_, index) => {
    const value = lat + (1 - index) * gridLatStep;
    const y = framePaddingY + (plotHeight / 2) * index;
    return `<text x="${framePaddingX - 18}" y="${y + 4}" text-anchor="end" fill="rgba(220,228,231,0.72)" font-size="13" font-weight="600" font-family="Inter, Helvetica Neue, Arial, sans-serif">${escapeSvgText(
      formatGridCoordinate(value)
    )}</text>`;
  }).join("");

  const lngTicks = Array.from({ length: 3 }, (_, index) => {
    const value = lng + (index - 1) * gridLngStep;
    const x = framePaddingX + (plotWidth / 2) * index;
    return `<text x="${x}" y="${height - framePaddingY + 24}" text-anchor="middle" fill="rgba(220,228,231,0.72)" font-size="13" font-weight="600" font-family="Inter, Helvetica Neue, Arial, sans-serif">${escapeSvgText(
      formatGridCoordinate(value)
    )}</text>`;
  }).join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" fill="none">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0f171b"/>
      <stop offset="48%" stop-color="#263036"/>
      <stop offset="100%" stop-color="#3b454c"/>
    </linearGradient>
    <linearGradient id="glass" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="rgba(255,255,255,0.16)"/>
      <stop offset="100%" stop-color="rgba(255,255,255,0.04)"/>
    </linearGradient>
    <radialGradient id="glow" cx="50%" cy="50%" r="52%">
      <stop offset="0%" stop-color="rgba(106,199,188,0.18)"/>
      <stop offset="100%" stop-color="rgba(106,199,188,0)"/>
    </radialGradient>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="12" stdDeviation="18" flood-color="rgba(4,8,10,0.32)"/>
    </filter>
  </defs>

  <rect width="${width}" height="${height}" rx="28" fill="url(#bg)"/>
  <rect x="14" y="14" width="${width - 28}" height="${height - 28}" rx="22" fill="url(#glass)" stroke="rgba(210,216,220,0.18)"/>
  <rect x="${framePaddingX}" y="${framePaddingY}" width="${plotWidth}" height="${plotHeight}" rx="22" fill="rgba(10,16,19,0.34)" stroke="rgba(214,220,223,0.12)"/>

  ${verticalLines}
  ${horizontalLines}
  ${terrainPaths}
  ${roadPaths}
  ${latTicks}
  ${lngTicks}

  <circle cx="${centerX}" cy="${centerY}" r="${accuracyRadiusPx}" fill="rgba(98,176,171,0.14)" stroke="rgba(98,176,171,0.34)" stroke-width="2.2"/>
  <circle cx="${centerX}" cy="${centerY}" r="${Math.max(24, accuracyRadiusPx * 0.66)}" fill="url(#glow)"/>
  ${buildCenteredMapMarker({
    centerX,
    centerY,
    markerFill: "#0b2e27",
    markerStroke: "#ffffff",
    crosshairStroke: "rgba(227,233,236,0.56)",
    crosshairExtent: 30,
    markerRadius: 10,
    tailHeight: 15,
    tailHalfWidth: 7,
    shadowId: "shadow",
  })}

  <rect x="${framePaddingX + 18}" y="${height - 92}" width="${Math.round(scaleBarWidth)}" height="5" rx="2.5" fill="rgba(231,236,238,0.78)"/>
  <line x1="${framePaddingX + 18}" y1="${height - 98}" x2="${framePaddingX + 18}" y2="${height - 80}" stroke="rgba(231,236,238,0.88)" stroke-width="1.2"/>
  <line x1="${framePaddingX + 18 + Math.round(scaleBarWidth)}" y1="${height - 98}" x2="${framePaddingX + 18 + Math.round(scaleBarWidth)}" y2="${height - 80}" stroke="rgba(231,236,238,0.88)" stroke-width="1.2"/>
  <text x="${framePaddingX + 18}" y="${height - 104}" fill="rgba(224,231,234,0.8)" font-size="12.5" font-weight="700" letter-spacing="0.04em" font-family="Inter, Helvetica Neue, Arial, sans-serif">${escapeSvgText(
    scaleBarLabel
  )}</text>

  <text x="${width - framePaddingX}" y="44" text-anchor="end" fill="rgba(192,200,204,0.74)" font-size="15.5" font-weight="700" font-family="Inter, Helvetica Neue, Arial, sans-serif">N</text>
  <path d="M ${width - framePaddingX - 5} 67 l 5 -12 l 5 12 z" fill="rgba(220,228,231,0.76)"/>
  <line x1="${width - framePaddingX}" y1="68" x2="${width - framePaddingX}" y2="93" stroke="rgba(220,228,231,0.7)" stroke-width="1.3"/>

  <text x="${framePaddingX}" y="46" fill="rgba(226,232,235,0.8)" font-size="18" font-weight="800" letter-spacing="2.2" font-family="Inter, Helvetica Neue, Arial, sans-serif">CAPTURE CONTEXT</text>
  <text x="${framePaddingX}" y="72" fill="rgba(232,237,239,0.92)" font-size="27" font-weight="700" font-family="Inter, Helvetica Neue, Arial, sans-serif">${escapeSvgText(
    locationLineLabel
  )}</text>
  <text x="${framePaddingX}" y="${height - 38}" fill="rgba(206,213,216,0.84)" font-size="20" font-weight="600" font-family="Inter, Helvetica Neue, Arial, sans-serif">${escapeSvgText(
    accuracyLabel
  )}</text>
  <text x="${width - framePaddingX}" y="${height - 38}" text-anchor="end" fill="rgba(206,213,216,0.78)" font-size="15.5" font-weight="600" font-family="Inter, Helvetica Neue, Arial, sans-serif">${escapeSvgText(
    sourceLabel
  )}</text>
  <text x="${width - framePaddingX}" y="${height - 18}" text-anchor="end" fill="rgba(186,194,198,0.66)" font-size="12" font-weight="600" font-family="Inter, Helvetica Neue, Arial, sans-serif">${escapeSvgText(
    attributionLabel
  )}</text>
  <text x="${framePaddingX}" y="${height - 18}" fill="rgba(186,194,198,0.64)" font-size="12.2" font-weight="700" letter-spacing="0.08em" font-family="Inter, Helvetica Neue, Arial, sans-serif">PROOVRA</text>
</svg>`;
}

export function buildCaptureLocationMapSvg(params: {
  lat: string | number;
  lng: string | number;
  accuracyMeters?: string | number | null;
  width?: number;
  height?: number;
  zoom?: number;
}): string {
  return buildCaptureLocationStaticMapFallbackSvg(params);
}

export function buildCaptureLocationPdfFallbackSvg(params: {
  lat: string | number;
  lng: string | number;
  accuracyMeters?: string | number | null;
  width?: number;
  height?: number;
  zoom?: number;
}): string {
  const model = buildCaptureLocationDisplayModel(params);
  if (!model) {
    return "";
  }

  const {
    width,
    height,
    accuracyRadiusPx,
    latLabel,
    lngLabel,
    accuracyLabel,
    sourceLabel,
    attributionLabel,
    scaleBarMeters,
    scaleBarLabel,
    lat,
    lng,
  } = model;

  const framePaddingX = Math.round(width * 0.06);
  const framePaddingY = Math.round(height * 0.11);
  const plotWidth = width - framePaddingX * 2;
  const plotHeight = height - framePaddingY * 2;
  const gridLatStep = 0.0032 * (18 / model.zoom);
  const gridLngStep = 0.0046 * (18 / model.zoom);
  const scaleBarWidth = Math.min(
    width * 0.19,
    (scaleBarMeters / model.metersPerPixel) * 0.68
  );
  const seed = Math.round((Math.abs(lat) + Math.abs(lng)) * 10_000);
  const centerX = Math.round(width / 2);
  const centerY = Math.round(height / 2);

  const verticalLines = Array.from({ length: 6 }, (_, index) => {
    const x = framePaddingX + (plotWidth / 5) * index;
    return `<line x1="${x}" y1="${framePaddingY}" x2="${x}" y2="${
      height - framePaddingY
    }" stroke="rgba(90,110,105,0.20)" stroke-width="1.1" />`;
  }).join("");

  const horizontalLines = Array.from({ length: 4 }, (_, index) => {
    const y = framePaddingY + (plotHeight / 3) * index;
    return `<line x1="${framePaddingX}" y1="${y}" x2="${
      width - framePaddingX
    }" y2="${y}" stroke="rgba(90,110,105,0.18)" stroke-width="1.1" />`;
  }).join("");

  const roadPaths = [
    buildSurveyCurvePath(width, height, seed + 7, 20, 0.28),
    buildSurveyCurvePath(width, height, seed + 17, 18, 0.5),
    buildSurveyCurvePath(width, height, seed + 31, 22, 0.7),
    buildSurveyCurvePath(width, height, seed + 41, 15, 0.38),
    buildSurveyCurvePath(width, height, seed + 59, 17, 0.62),
  ]
    .map(
      (d, index) =>
        `<path d="${d}" fill="none" stroke="${
          index === 1
            ? "rgba(80,95,92,0.35)"
            : index >= 3
              ? "rgba(124,138,135,0.30)"
              : "rgba(146,158,155,0.28)"
        }" stroke-width="${
          index === 1 ? 4.8 : index >= 3 ? 1.8 : 2.5
        }" stroke-linecap="round" />`
    )
    .join("");

  const terrainPaths = Array.from({ length: 6 }, (_, index) =>
    `<path d="${buildSurveyCurvePath(
      width,
      height,
      seed + 47 + index * 9,
      11 + index * 3,
      0.18 + index * 0.18
    )}" fill="none" stroke="rgba(136,154,149,0.18)" stroke-width="${
      1.15 + index * 0.16
    }" />`
  ).join("");

  const parcelLines = Array.from({ length: 8 }, (_, index) => {
    const x1 = framePaddingX + (plotWidth / 7) * (index % 7);
    const y1 = framePaddingY + (plotHeight / 8) * index;
    const x2 = x1 + plotWidth * 0.18;
    const y2 = y1 + plotHeight * 0.12;
    return `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(
      1
    )}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(
      1
    )}" stroke="rgba(120,138,133,0.12)" stroke-width="0.9" />`;
  }).join("");

  const latTicks = Array.from({ length: 3 }, (_, index) => {
    const value = lat + (1 - index) * gridLatStep;
    const y = framePaddingY + (plotHeight / 2) * index;
    return `<text x="${framePaddingX - 14}" y="${y + 4}" text-anchor="end" fill="rgba(82,102,100,0.64)" font-size="12" font-weight="700" font-family="Helvetica Neue, Arial, sans-serif">${escapeSvgText(
      formatGridCoordinate(value)
    )}</text>`;
  }).join("");

  const lngTicks = Array.from({ length: 3 }, (_, index) => {
    const value = lng + (index - 1) * gridLngStep;
    const x = framePaddingX + (plotWidth / 2) * index;
    return `<text x="${x}" y="${height - framePaddingY + 18}" text-anchor="middle" fill="rgba(82,102,100,0.64)" font-size="12" font-weight="700" font-family="Helvetica Neue, Arial, sans-serif">${escapeSvgText(
      formatGridCoordinate(value)
    )}</text>`;
  }).join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" fill="none">
  <defs>
    <linearGradient id="paperBg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#f4f6f3"/>
      <stop offset="100%" stop-color="#eef2ef"/>
    </linearGradient>
    <filter id="pinShadow" x="-30%" y="-30%" width="160%" height="160%">
      <feDropShadow dx="0" dy="5" stdDeviation="5" flood-color="rgba(33,57,54,0.18)"/>
    </filter>
  </defs>

  <rect width="${width}" height="${height}" rx="20" fill="url(#paperBg)"/>
  <rect x="10" y="10" width="${width - 20}" height="${height - 20}" rx="16" fill="rgba(255,255,255,0.74)" stroke="rgba(111,130,127,0.20)"/>
  <rect x="${framePaddingX}" y="${framePaddingY}" width="${plotWidth}" height="${plotHeight}" rx="16" fill="rgba(250,252,250,0.92)" stroke="rgba(117,136,134,0.22)"/>

  ${verticalLines}
  ${horizontalLines}
  ${terrainPaths}
  ${parcelLines}
  ${roadPaths}
  ${latTicks}
  ${lngTicks}

  <circle cx="${centerX}" cy="${centerY}" r="${accuracyRadiusPx}" fill="rgba(140,194,182,0.20)" stroke="rgba(88,136,126,0.36)" stroke-width="2.2"/>
  ${buildCenteredMapMarker({
    centerX,
    centerY,
    markerFill: "#1f5f57",
    markerStroke: "#f7faf8",
    crosshairStroke: "rgba(28,69,63,0.36)",
    crosshairExtent: 26,
    markerRadius: 10.5,
    tailHeight: 14,
    tailHalfWidth: 7,
    shadowId: "pinShadow",
  })}

  <rect x="${framePaddingX + 14}" y="${height - 45}" width="${Math.round(scaleBarWidth)}" height="4" rx="2" fill="rgba(28,69,63,0.74)"/>
  <line x1="${framePaddingX + 14}" y1="${height - 49}" x2="${framePaddingX + 14}" y2="${height - 37}" stroke="rgba(28,69,63,0.74)" stroke-width="1"/>
  <line x1="${framePaddingX + 14 + Math.round(scaleBarWidth)}" y1="${height - 49}" x2="${framePaddingX + 14 + Math.round(scaleBarWidth)}" y2="${height - 37}" stroke="rgba(28,69,63,0.74)" stroke-width="1"/>
  <text x="${framePaddingX + 14}" y="${height - 54}" fill="rgba(38,68,64,0.76)" font-size="11.5" font-weight="800" font-family="Helvetica Neue, Arial, sans-serif">${escapeSvgText(
    scaleBarLabel
  )}</text>

  <text x="${framePaddingX}" y="27" fill="rgba(36,68,64,0.92)" font-size="15.5" font-weight="800" letter-spacing="0.06em" font-family="Helvetica Neue, Arial, sans-serif">CAPTURE CONTEXT</text>
  <text x="${framePaddingX}" y="46" fill="rgba(72,88,87,0.86)" font-size="12.5" font-weight="700" font-family="Helvetica Neue, Arial, sans-serif">${escapeSvgText(
    `Lat ${latLabel}° • Lng ${lngLabel}°`
  )}</text>
  <text x="${framePaddingX}" y="${height - 20}" fill="rgba(74,90,88,0.78)" font-size="11.8" font-weight="700" font-family="Helvetica Neue, Arial, sans-serif">${escapeSvgText(
    `${accuracyLabel} • ${sourceLabel}`
  )}</text>
  <text x="${width - framePaddingX}" y="${height - 20}" text-anchor="end" fill="rgba(106,118,116,0.72)" font-size="10.6" font-weight="700" font-family="Helvetica Neue, Arial, sans-serif">${escapeSvgText(
    attributionLabel
  )}</text>
</svg>`;
}

export function buildCaptureLocationMapDataUrl(params: {
  lat: string | number;
  lng: string | number;
  accuracyMeters?: string | number | null;
  width?: number;
  height?: number;
  zoom?: number;
}): string {
  const svg = buildCaptureLocationMapSvg(params);
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}
