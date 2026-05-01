export const CAPTURE_LOCATION_SOURCE_LABEL =
  "Browser/device-reported geolocation";

export const CAPTURE_LOCATION_STATUS_LABEL = "Location metadata included";

export const CAPTURE_LOCATION_CONTEXT_DESCRIPTION =
  "This evidence record contains signed capture-location metadata preserved within the integrity state.";

export const CAPTURE_LOCATION_SHORT_BOUNDARY =
  "Location metadata is device-reported and permission-based.";

export const CAPTURE_LOCATION_LEGAL_BOUNDARY =
  "Location metadata is device/browser-reported and user-permission-based. It may support context, but it does not independently prove physical presence, authorship, truth, or admissibility.";

export type CaptureLocationInput = {
  lat?: string | number | null;
  lng?: string | number | null;
  accuracyMeters?: string | number | null;
};

function toFiniteNumber(value: string | number | null | undefined): number | null {
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

function escapeSvgText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
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
    normalized >= 1000
      ? Math.round(normalized)
      : normalized >= 100
        ? Math.round(normalized)
        : normalized >= 10
          ? Math.round(normalized)
          : Math.round(normalized * 10) / 10;

  return `± ${trimTrailingZeros(String(rounded))} meters`;
}

export function buildCaptureLocationMapSvg(params: {
  lat: string | number;
  lng: string | number;
  accuracyMeters?: string | number | null;
  width?: number;
  height?: number;
}): string {
  const lat = toFiniteNumber(params.lat) ?? 0;
  const lng = toFiniteNumber(params.lng) ?? 0;
  const accuracy = toFiniteNumber(params.accuracyMeters ?? null);
  const width = Math.max(320, Math.round(params.width ?? 1200));
  const height = Math.max(220, Math.round(params.height ?? 720));

  const padX = Math.round(width * 0.1);
  const padY = Math.round(height * 0.12);
  const plotWidth = width - padX * 2;
  const plotHeight = height - padY * 2;
  const markerX = padX + ((lng + 180) / 360) * plotWidth;
  const markerY = padY + ((90 - (lat + 90)) / 180) * plotHeight;
  const accuracyRadius =
    accuracy === null ? 34 : Math.max(18, Math.min(88, 18 + accuracy * 0.35));
  const gridOpacity = 0.13;
  const contourOffset = ((Math.abs(lat) + Math.abs(lng)) % 12) + 1;
  const coordinateLabel = `${formatCaptureLocationCoordinate(lat)}°, ${formatCaptureLocationCoordinate(lng)}°`;
  const accuracyLabel = formatCaptureLocationAccuracy(accuracy);

  const verticalLines = Array.from({ length: 6 }, (_, index) => {
    const x = padX + (plotWidth / 5) * index;
    return `<line x1="${x}" y1="${padY}" x2="${x}" y2="${height - padY}" stroke="rgba(214,220,223,${gridOpacity})" stroke-width="1" />`;
  }).join("");

  const horizontalLines = Array.from({ length: 5 }, (_, index) => {
    const y = padY + (plotHeight / 4) * index;
    return `<line x1="${padX}" y1="${y}" x2="${width - padX}" y2="${y}" stroke="rgba(214,220,223,${gridOpacity})" stroke-width="1" />`;
  }).join("");

  const contourPaths = Array.from({ length: 4 }, (_, index) => {
    const startY = padY + plotHeight * (0.12 + index * 0.19);
    const wave = 22 + contourOffset * 1.5 + index * 7;
    return `<path d="M ${padX - 18} ${startY}
      C ${padX + plotWidth * 0.18} ${startY - wave},
        ${padX + plotWidth * 0.36} ${startY + wave * 0.6},
        ${padX + plotWidth * 0.52} ${startY - wave * 0.5}
      S ${padX + plotWidth * 0.78} ${startY + wave * 0.7},
        ${width - padX + 18} ${startY - wave * 0.25}"
      fill="none"
      stroke="rgba(151,160,166,0.16)"
      stroke-width="${1.5 + index * 0.2}" />`;
  }).join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" fill="none">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#11181c"/>
      <stop offset="58%" stop-color="#293136"/>
      <stop offset="100%" stop-color="#394249"/>
    </linearGradient>
    <linearGradient id="panel" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="rgba(255,255,255,0.16)"/>
      <stop offset="100%" stop-color="rgba(255,255,255,0.05)"/>
    </linearGradient>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="18" stdDeviation="24" flood-color="rgba(5,10,12,0.34)"/>
    </filter>
  </defs>

  <rect width="${width}" height="${height}" rx="28" fill="url(#bg)"/>
  <rect x="14" y="14" width="${width - 28}" height="${height - 28}" rx="22" fill="url(#panel)" stroke="rgba(210,216,220,0.18)"/>
  <rect x="${padX}" y="${padY}" width="${plotWidth}" height="${plotHeight}" rx="18" fill="rgba(10,16,19,0.28)" stroke="rgba(214,220,223,0.11)"/>
  ${verticalLines}
  ${horizontalLines}
  ${contourPaths}

  <circle cx="${markerX}" cy="${markerY}" r="${accuracyRadius}" fill="rgba(98,176,171,0.12)" stroke="rgba(98,176,171,0.28)" stroke-width="2"/>
  <circle cx="${markerX}" cy="${markerY}" r="10" fill="#69c7bd" stroke="#dce6e3" stroke-width="3" filter="url(#shadow)"/>
  <path d="M ${markerX} ${markerY + 15} l -7 16 h 14 z" fill="#69c7bd" stroke="#dce6e3" stroke-width="2" />
  <line x1="${markerX - 28}" y1="${markerY}" x2="${markerX + 28}" y2="${markerY}" stroke="rgba(220,226,230,0.6)" stroke-width="1.4"/>
  <line x1="${markerX}" y1="${markerY - 28}" x2="${markerX}" y2="${markerY + 28}" stroke="rgba(220,226,230,0.6)" stroke-width="1.4"/>

  <text x="${padX}" y="${height - 32}" fill="rgba(232,237,239,0.92)" font-size="28" font-weight="700" font-family="Inter, Helvetica Neue, Arial, sans-serif">${escapeSvgText(coordinateLabel)}</text>
  <text x="${width - padX}" y="${height - 32}" text-anchor="end" fill="rgba(206,213,216,0.82)" font-size="22" font-weight="600" font-family="Inter, Helvetica Neue, Arial, sans-serif">${escapeSvgText(accuracyLabel)}</text>
  <text x="${padX}" y="44" fill="rgba(226,232,235,0.78)" font-size="18" font-weight="700" letter-spacing="2.4" font-family="Inter, Helvetica Neue, Arial, sans-serif">CAPTURE LOCATION</text>
  <text x="${width - padX}" y="44" text-anchor="end" fill="rgba(188,196,200,0.72)" font-size="16" font-weight="600" font-family="Inter, Helvetica Neue, Arial, sans-serif">${escapeSvgText(CAPTURE_LOCATION_SOURCE_LABEL)}</text>
</svg>`;
}

export function buildCaptureLocationMapDataUrl(params: {
  lat: string | number;
  lng: string | number;
  accuracyMeters?: string | number | null;
  width?: number;
  height?: number;
}): string {
  const svg = buildCaptureLocationMapSvg(params);
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}
