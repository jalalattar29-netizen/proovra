/**
 * PRO-PW-09 (owner decision J, 2026-11-21) — THE NAMED-ORIGIN POLICY, REPORT-ONLY.
 *
 * The enforced policy (middleware.ts `buildCsp`) still carries the `https:`
 * scheme source in img-src, media-src, font-src and connect-src. Narrowing it
 * blind would break production, and until now there was no way to see what
 * production actually loads: the policy had no report-uri / report-to.
 *
 * This module builds the NARROWED policy — every external origin named — and
 * the middleware sends it as `Content-Security-Policy-Report-Only` next to the
 * unchanged enforced header. The browser enforces nothing from it; it reports
 * every load the narrowed policy WOULD block to `/api/csp-report`. The
 * observation period, the promotion criteria and the promotion steps are in
 * docs/operations/csp-report-only.md. Narrowing is NOT complete while this is
 * Report-Only.
 *
 * Every origin below is taken from source or deployment configuration, not
 * guessed:
 *
 *   - API (`NEXT_PUBLIC_API_BASE`) — apiFetch, analytics (`/v1/analytics/track`
 *     goes through apiFetch), derived-asset `<img src>` bytes (NEW-081).
 *   - Evidence object store — AWS S3 eu-central-1, bucket
 *     proovra-evidence-prod-eu (services/api/src/storage.ts: region default
 *     eu-central-1; path-style when S3_ENDPOINT is set, virtual-hosted when it
 *     is not, so BOTH host forms are named). `NEXT_PUBLIC_STORAGE_ORIGIN` adds a
 *     deployment's own store (NEW-075). Presigned PUTs (multipart-uploader),
 *     preview frames (AUD-48) and media/img reads.
 *     The enforced policy's `https://*.r2.cloudflarestorage.com` is NOT carried
 *     over: production storage is S3, not R2; a report will say if anything
 *     still loads from R2.
 *   - Approved tile endpoint (`NEXT_PUBLIC_CAPTURE_LOCATION_TILE_URL`, AUD-025):
 *     the web map never uses a public provider. Geoapify is the PDF report
 *     map's provider (worker only, resolveReportMapTileSource) and is refused
 *     for the web by `resolveApprovedTileTemplate`, so it is not named here.
 *   - Sentry — the ingest origin parsed from `NEXT_PUBLIC_SENTRY_DSN`
 *     (lib/sentry.ts; consent-gated). Nothing when the DSN is unset.
 *   - Google / Apple sign-in — the origins the enforced policy already names.
 *   - Google account avatars — auth.service.ts stores the Google `picture`
 *     claim as avatarUrl, rendered by AppAccountToolbar / OverviewSection:
 *     `https://*.googleusercontent.com`.
 *   - Fonts — self-hosted by next/font/local (app/fonts.google.ts): 'self' and
 *     data: only, no font CDN.
 *   - Stripe / PayPal — top-level navigations to hosted checkout
 *     (billingMessages.ts host allowlists); CSP does not govern a top-level
 *     navigation and no Stripe/PayPal script, frame or form is embedded, so
 *     neither is named. A report would show otherwise.
 */

import { resolveApprovedTileTemplate } from "@proovra/shared/tile-endpoint-policy";

/** Where browsers send violation reports (a same-origin Next route). */
export const CSP_REPORT_PATH = "/api/csp-report";
/** The Reporting API group name used by `report-to`. */
export const CSP_REPORT_GROUP = "csp-endpoint";

/** The production evidence store, both S3 host forms (see header). */
export const AWS_S3_EVIDENCE_ORIGINS = [
  "https://proovra-evidence-prod-eu.s3.eu-central-1.amazonaws.com",
  "https://s3.eu-central-1.amazonaws.com",
] as const;

export const GOOGLE_AVATAR_ORIGIN = "https://*.googleusercontent.com";

function originOf(raw: string | undefined | null): string | null {
  const value = (raw ?? "").trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** The Sentry ingest origin of a DSN (`https://key@o1.ingest.sentry.io/2` → `https://o1.ingest.sentry.io`). */
export function sentryIngestOrigin(dsn: string | undefined | null): string | null {
  return originOf(dsn);
}

export function tileOrigin(template: string | undefined | null): string | null {
  const t = resolveApprovedTileTemplate(template).template;
  if (!t) return null;
  return originOf(t.replace(/{[xyzs]}/g, "0"));
}

export type ReportOnlyInputs = {
  apiBase: string;
  storageOrigin?: string | null;
  tileTemplate?: string | null;
  sentryDsn?: string | null;
};

/**
 * Each variable is referenced literally (`process.env.NEXT_PUBLIC_…`) so Next
 * inlines it at build time in the middleware bundle, exactly as middleware.ts
 * reads its own inputs. The API base is passed in by the middleware (its own
 * `API_BASE`), so the two policies can never name different API origins and
 * the API origin keeps one derivation (AUDIT-003).
 */
export function readReportOnlyInputs(apiBase: string): ReportOnlyInputs {
  return {
    apiBase,
    storageOrigin: process.env.NEXT_PUBLIC_STORAGE_ORIGIN,
    tileTemplate: process.env.NEXT_PUBLIC_CAPTURE_LOCATION_TILE_URL,
    sentryDsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  };
}

const GOOGLE_ACCOUNTS = "https://accounts.google.com";
const APPLE_ID = "https://appleid.apple.com";
const APPLE_CDN = "https://appleid.cdn-apple.com";

function list(...sources: Array<string | null | undefined | readonly string[]>): string {
  const out: string[] = [];
  for (const s of sources) {
    const items = Array.isArray(s) ? s : [s];
    for (const item of items as Array<string | null | undefined>) {
      if (item && !out.includes(item)) out.push(item);
    }
  }
  return out.join(" ");
}

/**
 * The named-origin policy. No directive carries a bare scheme source
 * (`https:`, `http:`, `wss:`); `data:` and `blob:` stay only where the
 * enforced policy has them for same-document content.
 */
export function buildReportOnlyCsp(nonce: string, inputs: ReportOnlyInputs): string {
  const api = originOf(inputs.apiBase);
  const storage = [...AWS_S3_EVIDENCE_ORIGINS, originOf(inputs.storageOrigin)].filter(
    (v): v is string => Boolean(v),
  );
  const tile = tileOrigin(inputs.tileTemplate);
  const sentry = sentryIngestOrigin(inputs.sentryDsn);

  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    `script-src ${list("'self'", `'nonce-${nonce}'`, GOOGLE_ACCOUNTS, APPLE_CDN)}`,
    `style-src ${list("'self'", `'nonce-${nonce}'`, "'unsafe-inline'")}`,
    "style-src-attr 'unsafe-inline'",
    `style-src-elem ${list("'self'", "'unsafe-inline'", GOOGLE_ACCOUNTS, APPLE_CDN)}`,
    `img-src ${list("'self'", "data:", "blob:", api, storage, tile, GOOGLE_AVATAR_ORIGIN)}`,
    `media-src ${list("'self'", "blob:", api, storage)}`,
    "font-src 'self' data:",
    `connect-src ${list("'self'", api, storage, sentry, GOOGLE_ACCOUNTS, APPLE_ID, APPLE_CDN)}`,
    // frame-src has no `https:` in the enforced policy; the hard-coded S3 hosts
    // are NOT added here, so this policy is never wider than the enforced one
    // and promoting it can never relax framing. The deployment's declared
    // store (NEXT_PUBLIC_STORAGE_ORIGIN) is named, exactly as enforced.
    `frame-src ${list("'self'", GOOGLE_ACCOUNTS, APPLE_ID, originOf(inputs.storageOrigin))}`,
    `form-action ${list("'self'", APPLE_ID)}`,
    `report-uri ${CSP_REPORT_PATH}`,
    `report-to ${CSP_REPORT_GROUP}`,
  ].join("; ");
}

/** `Reporting-Endpoints` header value for the `report-to` group. */
export const REPORTING_ENDPOINTS_HEADER = `${CSP_REPORT_GROUP}="${CSP_REPORT_PATH}"`;
