/**
 * PRO-PW-09 (owner decision J) — the CSP violation report intake.
 *
 * A report is attacker-writable input that arrives unauthenticated, so this
 * endpoint is deliberately narrow:
 *
 *   - POST only, and only the two CSP report media types
 *     (`application/csp-report`, `application/reports+json`) → else 415.
 *   - At most CSP_REPORT_MAX_BYTES of body, by header AND by bytes read → 413.
 *   - Rate-limited per client IP and globally → 429.
 *   - Only a fixed set of fields is kept, each sanitized: URLs lose userinfo,
 *     query and fragment; capability paths (Verify, share, intake, invites,
 *     portal, reset …) and token-shaped segments are redacted; every string is
 *     truncated. `original-policy` (it carries the nonce), `script-sample`,
 *     `referrer` and the user agent are never kept.
 *   - Nothing is stored: one structured log line per accepted violation.
 */

export const CSP_REPORT_MAX_BYTES = 8 * 1024;
export const CSP_REPORT_MAX_PER_BATCH = 10;
export const CSP_REPORT_FIELD_MAX = 200;
export const CSP_REPORT_IP_LIMIT = 30; // per window, per client IP
export const CSP_REPORT_GLOBAL_LIMIT = 600; // per window, whole process
export const CSP_REPORT_WINDOW_MS = 60_000;

export const CSP_REPORT_CONTENT_TYPES = ["application/csp-report", "application/reports+json"] as const;

const KNOWN_DIRECTIVES = new Set([
  "default-src",
  "script-src",
  "script-src-elem",
  "script-src-attr",
  "style-src",
  "style-src-elem",
  "style-src-attr",
  "img-src",
  "media-src",
  "font-src",
  "connect-src",
  "frame-src",
  "child-src",
  "worker-src",
  "manifest-src",
  "object-src",
  "base-uri",
  "form-action",
  "frame-ancestors",
]);

/** Keyword values a browser reports instead of a URL. */
const BLOCKED_KEYWORDS = new Set(["inline", "eval", "wasm-eval", "trusted-types-policy", "trusted-types-sink", "self", "data", "blob"]);

/** Paths whose segments after the prefix are capabilities (middleware.ts PRO-PW-06). */
const CAPABILITY_PREFIXES = [
  "/verify/",
  "/share/",
  "/intake/",
  "/invite/",
  "/portal/",
  "/org-invites/",
  "/collaboration-teams/invites/",
  "/auth/",
];
const CAPABILITY_EXACT = new Set(["/portal", "/reset-password"]);

const TOKENISH_SEGMENT = /^(?=.*[0-9])[A-Za-z0-9_\-.~%=+]{16,}$|^[A-Za-z0-9_\-.~%=+]{32,}$/;
const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function truncate(value: string, max = CSP_REPORT_FIELD_MAX): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function redactPath(pathname: string): string {
  if (CAPABILITY_EXACT.has(pathname.replace(/\/+$/, ""))) return pathname.replace(/\/+$/, "");
  for (const prefix of CAPABILITY_PREFIXES) {
    if (pathname.startsWith(prefix)) return `${prefix}:redacted`;
  }
  return pathname
    .split("/")
    .map((seg) => (seg && (UUID_SEGMENT.test(seg) || TOKENISH_SEGMENT.test(seg)) ? ":redacted" : seg))
    .join("/");
}

/**
 * A reported URL reduced to what diagnosis needs: scheme, host, port and a
 * redacted path. No userinfo, query or fragment ever survives.
 */
export function sanitizeReportUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value) return null;
  const keyword = value.replace(/^'|'$/g, "").toLowerCase();
  if (BLOCKED_KEYWORDS.has(keyword)) return keyword;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol === "data:" || url.protocol === "blob:") return url.protocol.slice(0, -1);
  if (url.protocol !== "https:" && url.protocol !== "http:" && url.protocol !== "wss:" && url.protocol !== "ws:") {
    return truncate(url.protocol);
  }
  return truncate(`${url.protocol}//${url.host}${redactPath(url.pathname)}`);
}

function sanitizeDirective(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  return KNOWN_DIRECTIVES.has(name) ? name : null;
}

function sanitizeInt(raw: unknown): number | null {
  const n = typeof raw === "string" ? Number(raw) : raw;
  return typeof n === "number" && Number.isInteger(n) && n >= 0 && n < 10_000_000 ? n : null;
}

function sanitizeDisposition(raw: unknown): "enforce" | "report" | null {
  return raw === "enforce" || raw === "report" ? raw : null;
}

export type SafeCspViolation = {
  documentUrl: string | null;
  blockedUrl: string | null;
  effectiveDirective: string | null;
  sourceFile: string | null;
  lineNumber: number | null;
  columnNumber: number | null;
  disposition: "enforce" | "report" | null;
  statusCode: number | null;
};

function fromLegacy(body: Record<string, unknown>): SafeCspViolation {
  return {
    documentUrl: sanitizeReportUrl(body["document-uri"]),
    blockedUrl: sanitizeReportUrl(body["blocked-uri"]),
    effectiveDirective: sanitizeDirective(body["effective-directive"] ?? body["violated-directive"]),
    sourceFile: sanitizeReportUrl(body["source-file"]),
    lineNumber: sanitizeInt(body["line-number"]),
    columnNumber: sanitizeInt(body["column-number"]),
    disposition: sanitizeDisposition(body.disposition),
    statusCode: sanitizeInt(body["status-code"]),
  };
}

function fromReportingApi(body: Record<string, unknown>): SafeCspViolation {
  return {
    documentUrl: sanitizeReportUrl(body.documentURL),
    blockedUrl: sanitizeReportUrl(body.blockedURL),
    effectiveDirective: sanitizeDirective(body.effectiveDirective),
    sourceFile: sanitizeReportUrl(body.sourceFile),
    lineNumber: sanitizeInt(body.lineNumber),
    columnNumber: sanitizeInt(body.columnNumber),
    disposition: sanitizeDisposition(body.disposition),
    statusCode: sanitizeInt(body.statusCode),
  };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Parse an accepted body into safe violations (empty when nothing usable). */
export function parseCspReportBody(contentType: string, text: string): SafeCspViolation[] {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return [];
  }
  if (contentType === "application/csp-report") {
    const inner = isObject(json) ? json["csp-report"] : null;
    return isObject(inner) ? [fromLegacy(inner)] : [];
  }
  if (!Array.isArray(json)) return [];
  const out: SafeCspViolation[] = [];
  for (const entry of json.slice(0, CSP_REPORT_MAX_PER_BATCH)) {
    if (!isObject(entry) || entry.type !== "csp-violation" || !isObject(entry.body)) continue;
    out.push(fromReportingApi(entry.body));
  }
  return out;
}

/** The media type alone, lower-cased, or null when it is not a CSP report type. */
export function acceptedCspContentType(header: string | null): (typeof CSP_REPORT_CONTENT_TYPES)[number] | null {
  const media = (header ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  return (CSP_REPORT_CONTENT_TYPES as readonly string[]).includes(media)
    ? (media as (typeof CSP_REPORT_CONTENT_TYPES)[number])
    : null;
}

type Bucket = { count: number; resetAt: number };

/** A fixed-window limiter: per key, plus one global bucket. */
export function createCspReportLimiter(opts?: { perKey?: number; global?: number; windowMs?: number; now?: () => number }) {
  const perKey = opts?.perKey ?? CSP_REPORT_IP_LIMIT;
  const globalMax = opts?.global ?? CSP_REPORT_GLOBAL_LIMIT;
  const windowMs = opts?.windowMs ?? CSP_REPORT_WINDOW_MS;
  const now = opts?.now ?? Date.now;
  const buckets = new Map<string, Bucket>();
  let globalBucket: Bucket = { count: 0, resetAt: 0 };

  const hit = (b: Bucket, t: number): Bucket => (t >= b.resetAt ? { count: 1, resetAt: t + windowMs } : { count: b.count + 1, resetAt: b.resetAt });

  return function allow(key: string): boolean {
    const t = now();
    globalBucket = hit(globalBucket, t);
    if (globalBucket.count > globalMax) return false;
    const next = hit(buckets.get(key) ?? { count: 0, resetAt: 0 }, t);
    buckets.set(key, next);
    if (buckets.size > 10_000) {
      for (const [k, b] of buckets) if (t >= b.resetAt) buckets.delete(k);
    }
    return next.count <= perKey;
  };
}

async function readCapped(req: Request, max: number): Promise<string | null> {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    buf.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(buf);
}

export type CspReportDeps = {
  allow: (key: string) => boolean;
  clientKey: (req: Request) => string;
  log: (line: string) => void;
};

const empty = (status: number) => new Response(null, { status, headers: { "cache-control": "no-store" } });

/** The whole intake; the Next route is a thin wrapper around this. */
export async function handleCspReport(req: Request, deps: CspReportDeps): Promise<Response> {
  if (req.method !== "POST") return empty(405);
  const contentType = acceptedCspContentType(req.headers.get("content-type"));
  if (!contentType) return empty(415);
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > CSP_REPORT_MAX_BYTES) return empty(413);
  if (!deps.allow(deps.clientKey(req))) return empty(429);
  const text = await readCapped(req, CSP_REPORT_MAX_BYTES);
  if (text === null) return empty(413);
  for (const violation of parseCspReportBody(contentType, text)) {
    deps.log(JSON.stringify({ event: "csp_report", ...violation }));
  }
  return empty(204);
}
