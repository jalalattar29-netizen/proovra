# PDF report street map — map imagery source

Status: implemented 2026-11-12 (owner decision revising AUD-025 / AUD-19 for
this one feature). Off until configured.

## What it does

A **newly generated** PDF report whose record holds a **saved, authorized**
location shows a real street map in the Capture Location panel: the map on the
left, the location cards on the right, the recorded position as a marker at the
exact centre, and the recorded accuracy as a geographically scaled circle. The
zoom is the closest street-level zoom at which the full circle fits with
padding. The composed image (880 × 332 px PNG) is embedded in the PDF, so the
issued file needs no network when it is reopened. Previously issued PDFs are
stored bytes and are never re-rendered.

Code: `services/worker/src/report-map-imagery.ts` (fetch, cache, compositing),
`packages/shared/src/capture-location.ts` → `buildCaptureLocationReportViewport`
(framing math), `packages/shared/src/tile-endpoint-policy.ts` →
`resolveReportMapTileSource` (the source rule).

## When a request happens and what it sends

- **When:** only while a report is being generated, only when that report
  prints a saved, authorized location (valid coordinates, location disclosed
  to that report's audience). No-location, withheld-location and
  invalid-location reports make no request. Nothing is prefetched.
- **To:** only the host in `CAPTURE_LOCATION_TILE_URL` (checked for every URL;
  redirects are refused; https only).
- **What:** `GET` of the configured template with `{z}/{x}/{y}` filled in —
  at most 24 tiles per report (typically 10–15), 2 at a time, 4 s per tile,
  12 s per report. Headers: a fixed `User-Agent`
  (`PROOVRA-ReportMap/1.0 (evidence report renderer; +https://www.proovra.com)`)
  and `Accept`. Revalidation adds `If-None-Match` / `If-Modified-Since`.
  A commercial source's URL also carries PROOVRA's own API key (Geoapify:
  `?apiKey=`), which identifies PROOVRA's account, not a record or user.
- **Never sent:** evidence content, record / report / user / workspace ids,
  emails, account data, cookies, a Referer, or the coordinates as numbers.
- **What it reveals:** tile indices at the chosen zoom identify the
  approximate area shown (one tile ≈ 400 m across at z16 in central Europe),
  plus the worker's egress IP. With an **external** source, that provider
  learns that a PROOVRA worker rendered a map of that area at that time.

## Cache

In-process LRU (512 tiles), honouring the source's `Cache-Control` / `Expires`
and defaulting to 7 days when neither is sent (the OpenStreetMap tile policy's
floor); expired tiles are revalidated. The cache never outlives the worker
process.

## Failure

Not configured, refused configuration, timeout, HTTP error, non-image body or
any compose error → the panel prints **"Map preview unavailable"** beside the
unchanged location cards, and the report completes. Logs record the outcome,
zoom and counts only — never coordinates, tile indices or URLs.

## Configuration (worker)

| Setting | Value | Purpose |
|---|---|---|
| `CAPTURE_LOCATION_MAP_MODE` | `static` | turns report map imagery on (anything else = off) |
| `CAPTURE_LOCATION_TILE_URL` | https XYZ template with `{z}` `{x}` `{y}` | the one source |
| `CAPTURE_LOCATION_TILE_SOURCE` | `proovra` or `external` | declares whether the source is PROOVRA-operated; a known public provider is accepted only as `external` |
| `CAPTURE_LOCATION_TILE_ATTRIBUTION` | the source's credit | printed on the map; required for `external` (openstreetmap.org defaults to `© OpenStreetMap contributors`) |

Production: the worker reads `/opt/proovra/app/.env` (`env_file` in
`infra/docker/docker-compose.prod.yml`); add the four keys there. Local full
stack: `infra/docker/docker-compose.full.yml` passes them through.

## Source selection and terms (checked 2026-11-12)

**Production source (owner decision 2026-11-12): Geoapify raster tiles**, a
commercial XYZ provider. Its tiles are the same 256 px `{z}/{x}/{y}` tiles, so
the one renderer serves it unchanged:

```
CAPTURE_LOCATION_MAP_MODE=static
CAPTURE_LOCATION_TILE_URL=https://maps.geoapify.com/v1/tile/osm-bright/{z}/{x}/{y}.png?apiKey=<PROOVRA key>
CAPTURE_LOCATION_TILE_SOURCE=external
CAPTURE_LOCATION_TILE_ATTRIBUTION=Powered by Geoapify · © OpenMapTiles · © OpenStreetMap contributors
```

Why Geoapify (geoapify.com/map-tiles; terms version 5 of 2 February 2024):

- Its tile page states an open tile policy: generated map tiles may be cached,
  stored and redistributed, and tile-based products may be generated, stored,
  reused and resold within its rate limits. Embedding composed tiles in an
  issued PDF is storage and redistribution of generated tiles.
- Commercial use is allowed (paid plans; the Free plan only "with some
  limitations" in production — use a paid plan).
- Attribution: OpenStreetMap always, OpenMapTiles for the OSM Bright style,
  Geoapify on the Free plan. The attribution above covers all three and is
  printed on the map.
- It publishes a GDPR Art. 28 data processing agreement
  (geoapify.com/data-processing-agreement) and is EU-based. Its imprint names
  KEPTAGO LTD (Cyprus) beside Geoapify GmbH (Germany): confirm the contracting
  entity when signing up.
- Volume: one tile costs 0.25 credits; a report uses 10–15 tiles (about 3–4
  credits), fewer when the cache answers.

The API key rides in the template's query, so `CAPTURE_LOCATION_TILE_URL` is a
**secret**: keep it only in the worker's env file. The worker never logs the
template, a tile URL or a runtime error message (only bounded failure codes),
and the key goes to Geoapify alone. Restrict the key in the Geoapify console
to the Map Tiles API (and to the worker's egress IP, if offered).

Alternatives considered:

- **OpenStreetMap standard tile server** (`tile.openstreetmap.org`; used for
  local verification and by the July 2026 reports). Its usage policy requires
  attribution, a unique User-Agent, honouring cache headers (at least 7 days)
  and no bulk download — all met — but says "offline use is not permitted",
  that commercial services' access "may be withdrawn at any point", and does
  not address PDFs. Not chosen for production.
- **Stadia Maps**: raw tiles may not be cached server-side or used in print
  without a licence; only its cacheable static-image endpoint grants
  document-embedding rights (paid, up to 5,000 copies per image). That is a
  different API, so not chosen (one implementation).
- **Thunderforest**: commercial use allowed and map images are CC-BY-SA 4.0,
  but "caching proxies or other redistribution methods are not permitted".
- **MapTiler**: its client guidance says static map files should not be stored
  or redistributed; printing is sold separately.
- No PROOVRA-operated or local imagery exists in any deployment.

## Remaining production dependency

1. Create PROOVRA's Geoapify account on a paid plan (owner action), accept its
   DPA, and create a key restricted to the Map Tiles API.
2. Put the four settings above, with that key, in `/opt/proovra/app/.env` and
   restart the worker.
3. Generate one report with a saved location and confirm the map and its
   attribution; the worker log line `[report-map] rendered` confirms it.
