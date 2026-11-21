# Web CSP: the named-origin policy in Report-Only

Owner: Web platform. Finding: PRO-PW-09 (owner decision J, 2026-11-21).
Status: **observation stage. Narrowing is NOT complete.** The enforced policy
still allows any `https:` origin for img, media, font and connect.

## What production sends

Every response secured by `apps/web/middleware.ts` in a production build carries
two policies.

| Header | Source | Effect |
|---|---|---|
| `Content-Security-Policy` | `buildCsp()` in `apps/web/middleware.ts` | **Enforced**. This is the policy that was enforced before; it is not changed. Scripts are limited to `'self'`, the per-request nonce and Google/Apple sign-in. It also sets `frame-ancestors 'none'` and `object-src 'none'`. The `https:` scheme sources in img/media/font/connect remain. |
| `Content-Security-Policy-Report-Only` | `buildReportOnlyCsp()` in `apps/web/lib/security/csp-report-only.ts` | **Observed only**. It is the narrowed policy, with every external origin named and no bare scheme source. It uses the same nonce as the enforced policy. It sends reports through `report-uri /api/csp-report` and `report-to csp-endpoint`. |
| `Reporting-Endpoints` | same module | `csp-endpoint="/api/csp-report"` |

The middleware failure path (any exception inside the middleware) sends
`FAIL_SAFE_CSP`. That policy is `default-src 'self'`, `script-src 'self'`, inline
styles, data/blob images and data fonts, with no `https:` in any directive. No
directive in it is wider than the enforced policy. The runbook boundary's early
answers (malformed or unknown slug rewritten to not-found, the 401/403 denial
page, the alias rewrite) now carry both policies. They used to leave with no
CSP at all.

## The named origins and where each comes from

| Origin | Directives | Source of truth |
|---|---|---|
| `NEXT_PUBLIC_API_BASE` origin | img, media, connect | apiFetch (including analytics `/v1/analytics/track`) and derived-asset `<img>` bytes (NEW-081) |
| `https://proovra-evidence-prod-eu.s3.eu-central-1.amazonaws.com`, `https://s3.eu-central-1.amazonaws.com` | img, media, connect | Evidence storage is AWS S3 eu-central-1, bucket `proovra-evidence-prod-eu`. `services/api/src/storage.ts` presigns path-style when `S3_ENDPOINT` is set and virtual-hosted when it is not, so both host forms are named. |
| `NEXT_PUBLIC_STORAGE_ORIGIN` | img, media, connect, frame | A deployment's own store (NEW-075, AUD-48 preview frames) |
| approved tile origin (`NEXT_PUBLIC_CAPTURE_LOCATION_TILE_URL`) | img | AUD-025: the web map never uses a public provider. Geoapify is only used by the worker's PDF report map and is refused for the web, so it is not named. |
| Sentry ingest origin parsed from `NEXT_PUBLIC_SENTRY_DSN` | connect | `apps/web/lib/sentry.ts`. It is consent-gated. Nothing is added when the DSN is unset. |
| `https://accounts.google.com`, `https://appleid.apple.com`, `https://appleid.cdn-apple.com` | script, style-elem, connect, frame, form-action | Google/Apple sign-in. These are the same origins as the enforced policy. |
| `https://*.googleusercontent.com` | img | Google `picture` claim stored as `avatarUrl` (`auth.service.ts`), rendered in the account toolbar and settings |
| fonts: `'self' data:` only | font | Self-hosted by `next/font/local` (`app/fonts.google.ts`) |

Some dependencies are deliberately not named:
- **Stripe and PayPal.** Checkout is a top-level navigation to hosted pages, which CSP does not govern. No payment-provider script, frame or form is embedded.
- **Cloudflare R2.** `https://*.r2.cloudflarestorage.com` is still in the enforced policy, but production storage is S3. A report will show if anything still loads from R2.
- **`wss:`.** No WebSocket or EventSource client exists in `apps/web`.

`frame-src` gets no hard-coded S3 hosts, because the enforced `frame-src` has no
`https:`. As a result the Report-Only policy is never wider than the enforced
policy in any directive, and promoting it can only narrow. A test pins this:
`apps/web/__tests__/ws-shell-csp-report-only.test.ts`.

## The report endpoint: `POST /api/csp-report`

`apps/web/app/api/csp-report/route.ts` is a thin wrapper around
`apps/web/lib/security/csp-report.ts`. Its limits:

- **Content types.** Only `application/csp-report` and `application/reports+json` are accepted. Any other type gets 415.
- **Size.** A body is capped at 8 KiB. Both the declared `content-length` and the bytes actually read are checked; over the cap gets 413.
- **Rate.** Each client IP may send 30 requests per minute, and the whole instance 600 per minute; over either limit gets 429. The client IP is taken from the edge-written header (`getClientIp`, the same as the lead forms). The limiter is in memory, per instance.
- **Batch size.** At most 10 violations are processed per batch.
- **What is kept.** Only these fields: `documentUrl`, `blockedUrl`, `effectiveDirective` (checked against an allowlist), `sourceFile`, `lineNumber`, `columnNumber`, `disposition`, `statusCode`.
- **URL sanitizing.** URLs lose userinfo, query and fragment. Capability paths are reduced to `<prefix>/:redacted`: `/verify/`, `/share/`, `/intake/`, `/invite/`, `/portal/`, `/org-invites/`, `/collaboration-teams/invites/` and `/auth/`. Path segments shaped like a UUID or a token become `:redacted`. Every string is truncated to 200 characters.
- **What is dropped.** `original-policy` (it carries the nonce), `script-sample`/`sample`, `referrer` and the user agent are never kept.
- **Storage.** Nothing is stored. Each accepted violation produces one log line, `{"event":"csp_report",...}`, in the web runtime logs (Vercel function logs). The answer is 204.

## Observation period

The period starts when a web build containing this change is deployed to
production. Record that date and commit here when it happens. It lasts **at
least 14 days**, and must also cover all of the following:

1. At least one production web release after the start date.
2. A real session of each flow below, run by the operator on production with
   their own account (no test data in tenant records):
   - Google sign-in and Apple sign-in;
   - capture upload, including multipart part PUTs to storage;
   - evidence preview (image, video, PDF frame);
   - the recorded-location map;
   - the account avatar;
   - Sentry capture with analytics consent granted;
   - Stripe and PayPal checkout redirect and return;
   - a public Verify page.

Daily, read the log lines with `event = csp_report`. Group them by
`effectiveDirective` and the origin of `blockedUrl`. Classify each group as one
of:
- **first-party need**: name the origin and add it to `buildReportOnlyCsp`;
- **browser extension or injected noise**: for example `chrome-extension`, or a
  blocked URL that no source file references;
- **unexpected third party**: investigate as a possible injection.

## Enforcement criteria (all must hold)

1. The observation period above is complete.
2. In the last 7 consecutive days, no report has come from a first-party flow.
   Every remaining report is classified as extension or injection noise.
3. Every origin added during observation has a source reference in the module
   header.
4. The Sentry DSN, storage origin and tile URL used in production were present
   at build time. The policy is built from `NEXT_PUBLIC_*` values that are
   inlined at build.

## How to promote

1. In `buildCsp()` (`apps/web/middleware.ts`), replace the `https:` scheme
   source and the R2 wildcard **one directive at a time**, in this order: font,
   media, img, connect. Take the origin list from the Report-Only policy, so
   the two builders share one origin list.
2. Add `report-uri /api/csp-report` and `report-to csp-endpoint` to the enforced
   policy, so violations are still visible after enforcement.
3. Keep the Report-Only header for the next narrowing stage: `style-src
   'unsafe-inline'`, which is not addressed here.
4. Deploy each directive change separately. Watch the reports for 48 hours
   before the next one.
5. Run `node apps/web/scripts/run-tests.mjs ws-shell-csp`. The test that keeps
   the Report-Only policy no wider than the enforced policy must still pass.
6. Only after step 1 is complete for all four directives may PRO-PW-09 be
   proposed as closed.

**To roll back**, revert the directive change. The Report-Only header and the
report endpoint have no effect on what the browser loads.
