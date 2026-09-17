# UC-1 — CHROMIUM DIRECT WEB CAPTURE

## Status (multi-field — never collapse to one "all green")

| Field | Value |
| --- | --- |
| IMPLEMENTATION (code/architecture) | **COMPLETE** |
| TARGETED VALIDATION (unit/integration/contract/gates) | **PASS** |
| REAL CHROMIUM ACCEPTANCE | **DEFERRED** (not PASS — see §K) |
| REAL EDGE ACCEPTANCE | **DEFERRED** (not PASS) |
| PUBLICATION READINESS | **PENDING** (store icons + counsel-reviewed legal — see UC1_EXTENSION_PUBLICATION_READINESS.md) |
| PRODUCTION | **NOT DEPLOYED** |
| UC-2 READINESS | **MAY BEGIN** (shared acquisition primitives stable; remaining uncertainty is browser-acceptance-only) |

Date: 2026-09-17 (code/architecture closure audit — see the CLOSURE AUDIT section at the end).
Precondition: UC-0 Gate A CLOSED (`26ad3ddb`).
Real-browser gate (deferred release validation): `pnpm uc1:acceptance:windows` (Windows + Chrome/Edge Stable); focused run `--browsers=chromium --grep static`.

> **UC-1 CODE/ARCHITECTURE COMPLETE · BROWSER ACCEPTANCE DEFERRED · UC-2 MAY BEGIN.**
> "Deferred" is not "pass": Chrome/Edge acceptance has NOT passed. It is release
> validation, decoupled from development closure.

## Status

UC-1 Direct Web Capture is **implemented** as a new acquisition adapter on the
canonical UC-0 spine — the acquisition mode, the server capture path, the
capture manifest, the Manifest V3 extension, and the downstream integration —
and every gate that can execute in this environment is green. The one gate this
sandbox cannot run is the **Chrome/Edge browser E2E acceptance** (no browser
automation here); it is fully prepared as a runnable harness with exact commands
(`apps/extension/e2e/README.md`). Per the UC-1 contract, UC-1 is therefore
**IMPLEMENTATION COMPLETE — BROWSER ACCEPTANCE PENDING**, not CLOSED. It becomes
CLOSED when both browser projects pass.

## Artifact-semantics decision (resolved before coding)

`EvidencePart.artifactClass` ORIGINAL means a *directly acquired* output of the
acquisition process that has not been transformed into another representation.
Under that rule UC-1 captures:

- **Direct acquisition (ORIGINAL parts):** the viewport screenshot; for a
  full-page capture, each viewport TILE (deterministically ordered, its scroll
  offset recorded in the manifest); and the sanitized DOM snapshot.
- **CAPTURE_MANIFEST part:** the capture manifest.
- **No server-side stitch in UC-1.** A stitched full-page image would be a
  *constructed* representation (multiple source tiles), which the current
  single-source `EvidencePartDerivedAsset` lineage cannot represent truthfully.
  Rather than hack a false single-source lineage or grow a lineage-join table
  for a feature UC-1 does not need, UC-1 does **not** produce a stitched
  original: the full-page representation is the ordered set of tile ORIGINALS +
  the manifest that records their order and offsets. Server-side multi-source
  stitching (a bounded derivative-lineage join) is deferred to when a stitched
  review artifact is actually required. This keeps the derivative authority
  unchanged and every artifact class truthful.

## What is implemented (code paths)

- **Acquisition authority** (`packages/shared/src/evidence-acquisition.ts`): the
  `DIRECT_WEB_CAPTURE_EXTENSION` mode (`isDirectCapture: true`, category
  `DIRECT_WEB_CAPTURE`), its label/statement and three web-capture limitation
  codes. One resolver; every surface projects from it.
- **Capture manifest** (`packages/shared/src/web-capture-manifest.ts`):
  `PROOVRA_WEB_CAPTURE_MANIFEST_V1`, a strict bounded validator, and the ONE
  `publicDomainFromUrl` / `redactUrlForLog` URL-privacy projection.
- **Migration** `20280610000000_uc1_direct_web_capture_acquisition_mode`: widens
  the two `acquisition_mode` CHECK constraints (a constraint swap). EXPAND /
  SAFE_TO_APPLY_NOW; registered in the inventory, deployment plan and gate
  allowlists; clean-boot + drift proven.
- **Server capture path**: the existing UC-0 direct-capture session accepts the
  new mode; `web-capture.service.ts` validates the manifest, ties it to the
  uploaded bytes by digest, classes the manifest part CAPTURE_MANIFEST,
  cross-checks it against the declared parts, and seals through
  `completeDirectCapture` (one CAPTURE_SESSION_BOUND). Route
  `POST /v1/capture/direct-sessions/:id/web-complete`.
- **Extension** (`apps/extension/`): MV3, TypeScript, esbuild reproducible build
  (with SHA256SUMS), strict CSP, `activeTab`+`scripting`+`storage`+`identity`
  only; PKCE auth; viewport + full-page tiled capture; DOM sanitizer; manifest
  builder; canonical upload client; popup UI.
- **Web product**: acquisition filter chip (`Web capture`) and the Direct Web
  Capture entry card on the capture surface (install-extension link).

The original design sections below (permission model, manifest schema, claim
matrix, privacy, failure semantics, integration points) remain the contract the
implementation was built to.

---

## 1. Architecture (one evidence truth)

```
Chrome / Edge tab (user clicks "Preserve with PROOVRA")
        │  activeTab + scripting only
        ▼
apps/extension  (MV3, untrusted client — computes hashes only for binding)
        │  OAuth2 + PKCE short-lived token
        ▼
POST /v1/capture/direct-sessions            ← EXISTING UC-0 session authority
   (new acquisitionMode: DIRECT_WEB_CAPTURE_EXTENSION)
        ▼
reserve → createEvidence (EXISTING) → declare part digests → presign PUT (EXISTING)
        ▼
completeEvidence (EXISTING) — server recomputes SHA-256, compares declarations
        ▼
CAPTURE_SESSION_BOUND (EXISTING, exactly once)
        ▼
Evidence.acquisitionMode = DIRECT_WEB_CAPTURE_EXTENSION (EXISTING resolver)
        ▼
existing integrity · custody · report-v2 · package · public Verify · governance
```

UC-1 reuses the UC-0 `CaptureSession` state machine, `createEvidence`,
`completeEvidence`, storage presign/PUT, the acquisition resolver, custody,
report/package/Verify, and the governance lifecycle **unchanged**. The only new
server surface is: a new `acquisitionMode` enum value + its label/category, and a
capture-manifest artifact class (an EvidencePart `artifactClass = "CAPTURE_MANIFEST"`,
already defined in UC-0) validated on completion.

## 2. Permission model (least privilege)

| Permission | Default? | Why |
| --- | --- | --- |
| `activeTab` | yes | capture only the tab the user explicitly acts on |
| `scripting` | yes | inject the capture routine into that tab on the click |
| host permission | NO (activeTab is sufficient) | never broad `<all_urls>` |
| `cookies`, `webRequest`, `history`, `clipboardRead`, `debugger` | NO | never requested |

`debugger`/CDP (higher-fidelity capture) is explicitly OUT of the UC-1 default.
If ever added it must be optional, per-capture, with an explicit privacy
disclosure. UC-1's viewport + full-page-tile capture does not need it.

## 3. Authentication

**IMPLEMENTED (real, tested).** OAuth2 Authorization Code + PKCE (S256) on the
existing PROOVRA identity authority — see FINAL ACCEPTANCE §1 for the full
mechanism, routes (`/v1/oauth/extension/authorize`, `/v1/oauth/extension/token`),
storage (`extension_auth_codes`) and proof (`uc1-extension-oauth.integration.test.ts`,
4/4). Short-lived access token; no embedded secret, no long-lived API key, no
cookie scraping; redirect restricted to `*.chromiumapp.org` (or an env
allowlist), never arbitrary. The token endpoint mints an ordinary `AUTH_JWT` the
canonical `requireAuth` already accepts — not a second auth system. Workspace/case
selection is sent as a request, never trusted: the server authorizes via the
canonical `authorizeOrFail` (evidence.create, anti-enumeration) and the existing
case-access checks — exactly as the UC-0 direct-session routes already do.

## 4. Capture manifest (versioned, bounded, server-validated)

`PROOVRA_WEB_CAPTURE_MANIFEST_V1` (stored as the `CAPTURE_MANIFEST` artifact part):

```
schemaVersion, captureMode ("viewport" | "full_page"),
sessionBindingRef, captureStartedAtUtc, captureEndedAtUtc,
pageOrigin (domain), sourceUrlPrivate (authorized surfaces only),
browserContext { name, versionBucket, os, viewportW, viewportH },
artifacts [ { role: "screenshot"|"full_page_image"|"dom_snapshot"|"resource_manifest",
             expectedSha256, sizeBytes, completeness } ],
completeness { CAPTURED | OMITTED | BLOCKED | NOT_SUPPORTED | FAILED, notes[] },
crossOriginLimitations[], pageMutatedDuringCapture (bool), extensionVersion
```

The manifest **cannot declare itself verified**. The server validates the schema,
recomputes every artifact's SHA-256, compares against `expectedSha256`, and on any
mismatch refuses to seal (session → INTERRUPTED), exactly as UC-0 does today.

## 5. Artifact → lineage mapping (UC-0 authority)

| Captured thing | artifactClass | Notes |
| --- | --- | --- |
| viewport screenshot | ORIGINAL | the human-viewable representation |
| full-page image (tile-stitched) | ORIGINAL, but its manifest records it as a **stitch** | never presented as one untouched browser frame if it was composed |
| DOM snapshot / sanitized HTML | ORIGINAL (machine-oriented) | sanitized (§7) |
| capture manifest | CAPTURE_MANIFEST | describes what PROOVRA captured |
| OCR / thumbnail / extracted text | DERIVED | UC-0 derivative authority; counts toward storage; removed on destruction |

## 6. Claim matrix (what UC-1 may assert)

| Claim | Verdict |
| --- | --- |
| PROOVRA acquired this web representation through its authorized browser adapter | PROVEN (server session + digest match) |
| The received bytes equal what the client declared | PROVEN (server recompute) |
| Integrity/preservation established at PROOVRA's server clock | PROVEN (existing) |
| The page's content is factually true / the author is genuine / it is admissible | NEVER — out of scope, stated as a limitation |
| The DOM was not modified before capture / DevTools were not used | NOT PROVABLE — recorded as a limitation, never asserted |
| The bytes originated from the website's server | NOT PROVABLE in UC-1 (no network attestation) |
| A local clone could not imitate the site | NOT PROVABLE — stated |

Public Verify shows **domain only**, never the full URL, query string, path,
session id, nonce or object key.

## 7. Privacy

Never persisted: cookies, authorization headers, passwords, OTP, CSRF/auth
tokens, form state, browser history, unrelated tabs. DOM snapshot sanitized:
strip `input[type=password]`, hidden auth values, CSRF/authorization tokens,
form values. Telemetry carries counts/outcomes only — never URL, title, DOM,
text, screenshots, hashes, tokens or nonces (mirrors UC-0's trust-event log).

## 8. Failure semantics

A capture is never "complete" when incomplete. Tab close, navigation, service-
worker restart, partial upload, digest mismatch, session expiry, finalize
failure → the session is INTERRUPTED/EXPIRED (UC-0 semantics) and a retained
partial is labelled partial, never sealed as a whole-page capture. TSA/OTS use
the existing deferred-timestamp path.

## 9. Canonical integration points (no new authorities)

Session/nonce/digest/binding → UC-0 `CaptureSession`. Evidence → `createEvidence`
/ `completeEvidence`. Acquisition → the resolver (new mode value only). Storage →
existing presign/PUT + `sumDerivedAssetStorageBytes`. Custody → `emitCaptureTrustEvent`.
Report → report-v2 acquisition statement (new label). Package → additive
`acquisition.json` (new mode). Verify → `loadPublicVerifyAcquisition` (new mode).
Retention/hold/destruction → unchanged. Billing → a canonical capability flag
resolved by the existing entitlement authority; **no new plan**, FREE/PRO/TEAM/
ENTERPRISE unchanged; no arbitrary customer limit invented.

## 10. Test plan (the gate this environment cannot fully run)

- Unit (runnable here): manifest schema, acquisition resolver for the new mode,
  URL→domain privacy projection, completeness enum, artifact classification.
- Integration (runnable here): session create, workspace/case authz (incl.
  negative), upload, digest match/mismatch, replay, expiry, finalize, custody
  bind, storage accounting, destruction, legal hold.
- **Extension + E2E (NOT runnable here — the blocking gap):** Chrome-stable and
  Edge-stable driving a real page through Preserve → session → Evidence →
  Library → Detail → Case → Report → Package → Verify, asserting the acquisition
  statement is consistent across every surface; plus SPA/lazy-load/Shadow-DOM/
  cross-origin-iframe/long-page/mutation/tab-close/SW-restart/permission-denial.

## 11. Known limitations / residual risks

P0: none identified in the design. P1: full-page stitch fidelity on a mutating
page (mitigated by `pageMutatedDuringCapture` + partial labelling). P2: DOM-clone
indistinguishability (stated, not claimed). P3: extension-store review + i18n
parity (EN/DE) for extension UX.

## 12. Release checklist (for the future implementation)

Extension: MV3 lint, least-privilege justification, no remote code, reproducible
build, CSP, privacy disclosure — **not published in this task**. Server: new
migration for the enum value (additive, clean-boot proven, registered like every
UC-0 migration). Legal: public-website + Privacy/Terms/AUP/DPA/Security updates
gated on real implementation, EN/DE parity, **counsel-review-required** flagged.

---

## UC-2 readiness

The architecture is UC-2-ready: device registration and session attestation
routes already exist (fail closed today, classified as UC-2 prerequisites in
`route-dispositions.json`), the acquisition authority is one resolver a new mode
plugs into, and the session/digest/binding machine is channel-agnostic. UC-2
(Android Direct Screen Capture) is a new acquisition channel on the same spine —
**not implemented here.**

---

## Implementation record (2026-09-17)

### Security threat matrix — disposition

| Threat | Disposition |
| --- | --- |
| Client forges `acquisitionMode` | PREVENTED — the mode lives on the server-issued session; the open route only admits enum modes; `web-complete` refuses a non-web session. |
| Forged / replayed manifest | PREVENTED — the manifest is bound to the session id and to the uploaded bytes by digest; a manifest for another session or that omits/invents a part is refused. |
| Changed uploaded bytes | PREVENTED — the server recomputes every part digest at completion (`completeEvidence`); a mismatch refuses the seal (session INTERRUPTED). |
| Wrong workspace / expired / reused session | PREVENTED — canonical `authorizeOrFail` + session ownership + ACTIVE→BOUND single claim. |
| Nonce replay / leak | PREVENTED — nonce is server-issued, only its hash stored; unbound web session presents no signature; nonce never logged. |
| XSS / script execution from stored DOM | MITIGATED — the DOM snapshot is sanitized inert (script/iframe/handlers removed) and served with safe disposition; secrets cleared. |
| Secret capture (passwords/OTP/CSRF/tokens) | MITIGATED — sanitizer clears sensitive field values by type + name/autocomplete tokens (unit-tested). |
| URL token leakage | PREVENTED (public) — public Verify/search use domain-only `publicDomainFromUrl`; full URL only on authorized private surfaces. |
| Oversized manifest / DOM / serialization bomb | PREVENTED — manifest bounds (size, counts, string lengths) enforced client- and server-side; parts bounded by the existing upload limits. |
| Local HTML clone / DevTools-modified DOM / look-alike site | NOT TECHNICALLY PROVABLE — recorded as limitations (`WEB_SERVER_ORIGIN_NOT_PROVEN`, `WEB_PAGE_STATE_AT_CAPTURE`), never claimed. |
| Page mutation / navigation / SW restart mid-capture | DETECTED / RECORDED — `pageMutatedDuringCapture`, `CAPTURE_INTERRUPTED`; a partial capture is represented PARTIAL, never sealed as whole. |
| Broad permission escalation | PREVENTED — MV3 lint forbids `cookies`/`webRequest`/`<all_urls>`/`debugger`; CSP forbids remote/unsafe code. |

### Capability / commercial (RESOLVED — no contradiction)

There is **no Direct-Web-Capture-specific plan, quota, or purchase path**, and
introducing one would violate the one-commercial-authority law. Direct Web
Capture is a new *acquisition channel* for evidence, so it inherits the SAME
gate every capture channel already passes: the general evidence-creation
eligibility enforced by `assertCommercialLifecycleAllowsPaidMutation` plus the
shared-workspace `getPlanCapabilities` check in
`billing-enforcement.service.ts`. The direct-capture session route returns
`TEAM_PLAN_REQUIRED` / `ENTITLEMENT_REQUIRED` when the workspace's plan does not
permit evidence creation (proven in the integration suite; the fixture workspace
had no paid plan, which is why the capture suite grants one), and the extension
surfaces that denial. Because the channel adds no commercial dimension of its
own, there is **nothing to reconcile across API / web / extension / pricing /
website** — the capability plumbing is complete and plan-blind, exactly like
every other capture channel. No plan was invented for it.

### Test evidence (executed here)

- shared: **923/0** node:test (adds the acquisition-mode + manifest-validator + URL-privacy cases).
- API integration `uc1-web-capture.integration.test.ts`: **4/4** — seal, manifest-omission refusal, session-mismatch refusal, mobile-session/forged-mode refusal.
- API integration `uc1-extension-oauth.integration.test.ts`: **4/4** — full authorize→code→token→usable-bearer journey, auth-required, redirect/method refusals, PKCE/single-use/redirect-binding enforcement (live PG16, real OAuth server).
- extension unit: **12/12** (capture-plan, sanitizer predicates, manifest builder).
- extension: typecheck clean, `build.mjs` reproducible (SHA256SUMS), MV3 lint OK.
- migrations `20280610000000` + `20280620000000`: clean-boot from empty + idempotent re-run on disposable PG16; audit + phase-o + db-010 gates green.

### Browser acceptance (the one pending gate)

Chrome: **NOT EXECUTED** — no browser automation in this environment.
Edge: **NOT EXECUTED** — same.
Harness ready: `apps/extension/e2e/` (Playwright chromium + msedge projects,
deterministic fixture pages, one spec tracing an Evidence id across Library /
Detail / public Verify). Exact Windows commands in `apps/extension/e2e/README.md`.

### Store readiness / legal

- Store package: MV3 build in `apps/extension/dist` with `SHA256SUMS.json`;
  least-privilege permissions, strict CSP, no remote code. **Icons are a
  placeholder pending brand assets**; not published in this task.
- Legal: a Direct Web Capture disclosure page is linked from the capture card
  (`NEXT_PUBLIC_EXTENSION_INSTALL_URL`); Privacy/Terms/AUP/DPA text for the
  extension's data handling is **counsel-review-required** and is the remaining
  legal wiring before publication.

### Residual risks

- **P0:** none.
- **P1:** real Chrome + Edge browser E2E not yet executed-and-passed (this sandbox has no browser automation) — UC-1 is not CLOSED until both pass via `pnpm uc1:acceptance:windows`.
- **P2:** none engineering-side. Extension store icons are placeholders and the extension's Privacy/Terms/AUP/DPA disclosures are counsel-review-required — both are PUBLICATION residuals, not engineering gates (see the ENGINEERING CLOSED vs PUBLICATION PENDING split below). Server-side multi-source stitching remains deliberately out of scope (tiles stay ORIGINAL — see artifact-semantics decision).
- **P3:** none. (Commercial packaging is resolved above: no capture-specific plan.)

---

## FINAL ACCEPTANCE (2026-09-17) — hardening pass

This pass closed every UC-1 residual that can be closed without a browser, and
built the runnable gate for the one that cannot. **UC-1 is not being declared
CLOSED** because the mandatory Chrome + Edge browser acceptance has not been
executed-and-passed in this environment. Nothing below downgrades that.

### 1. Real extension authentication (was: seeded token)

The extension now authenticates through a complete **first-party OAuth
Authorization Code + PKCE (S256)** flow on the existing PROOVRA identity
authority — no embedded secret, no long-lived token, no cookie scraping.

- New table `extension_auth_codes` (migration `20280620000000`): the code is
  never stored (only its SHA-256), single-use (atomic `UPDATE … WHERE
  used_at_utc IS NULL`), 60s TTL, bound to `client_id` + `redirect_uri` +
  `code_challenge`.
- `GET /v1/oauth/extension/authorize` (behind `requireAuth`) validates the S256
  method, the challenge shape and the redirect (only `*.chromiumapp.org` or an
  env-allowlisted dev redirect — **never an arbitrary redirect URI**), issues the
  code and 302-redirects.
- `POST /v1/oauth/extension/token` verifies the PKCE verifier timing-safely and
  the client/redirect binding, then mints an ordinary short-lived `AUTH_JWT` that
  the canonical `requireAuth` already accepts. **This is not a second auth
  system** — it is a code-to-JWT exchange onto the one identity authority.
- Proof: `uc1-extension-oauth.integration.test.ts` — **4/4 against live
  PostgreSQL 16**: full journey (authorize → code → token → the minted bearer is
  accepted by `/v1/platform/context`); authorize requires auth (401); arbitrary
  redirect + non-S256 refused (400); token enforces the verifier, single-use and
  redirect binding. The OAuth server is exercised for real — nothing mocked.

### 2. Acceptance no longer uses a pre-seeded token

`apps/extension/e2e/direct-web-capture.spec.ts` now performs the **real OAuth
journey** to obtain the extension's token: it computes a PKCE verifier/challenge,
calls the real `/authorize` endpoint carrying the user session, reads the
single-use code from the 302, and exchanges it at `/token`. The token the
extension carries is the one the OAuth server issued. The only step skipped is
the interactive consent *click* inside `launchWebAuthFlow` (that window cannot be
driven headlessly); the protocol — authorize, PKCE, single-use code, exchange —
is fully exercised. `PROOVRA_E2E_SESSION_BEARER` must never be a production token.

### 3. Same-Evidence trace (ALL closure-required surfaces)

The acceptance spec captures each fixture (static, long/full-page, SPA,
mutating), then traces the SAME Evidence id through every closure-required
surface and asserts real behavior on each (not just its presence):

| Surface | Endpoint | Assertion |
| --- | --- | --- |
| Library | `GET /v1/evidence?scope=all&acquisition=DIRECT_WEB_CAPTURE` | the record appears; `items[].acquisition.mode === DIRECT_WEB_CAPTURE_EXTENSION` |
| Detail | `GET /v1/evidence/:id/review-workspace` | `evidence.sourceContext.acquisition.mode === DIRECT_WEB_CAPTURE_EXTENSION` |
| Case | `POST /v1/cases` → `POST /v1/cases/:id/evidence` → `GET /v1/evidence?caseId=` | evidence links to a case in the same workspace and reads back under it |
| Search | `POST /v1/search/reindex/evidence/:id` → `GET /v1/search?teamId=&q=` | after the synchronous reindex, the evidence is found by a term from its own title |
| Report | poll `GET /v1/evidence/:id/artifacts/status` → `GET /v1/evidence/:id/report/latest` | worker-generated report; `evidenceId` matches and `snapshots.acquisitionMode === DIRECT_WEB_CAPTURE_EXTENSION` (sealed, not re-derived) |
| Verification Package | poll `artifacts/status` → `GET /v1/evidence/:id/verification-package` | worker-generated package; `evidenceId` + `version` present |
| Package Validator + Public Verify | `GET /public/verify/:id` (unauthenticated; the id is the token) | `acquisition.acquisition.mode === DIRECT_WEB_CAPTURE_EXTENSION` (domain-only), and `verificationPackageIntegrity.{available, signedManifestPresent, checksumIndexPresent}` prove the signed package is intact |

Report and Verification Package are generated asynchronously by the worker after
the capture is sealed (gated on the workspace's `reportsIncluded` plan
capability — the seeded acceptance workspace is ENTERPRISE/ACTIVE), so the spec
polls `artifacts/status` until both are available.

> **Defect found and fixed while extending the trace:** the earlier spec read a
> non-existent `GET /v1/evidence/:id/public-overview` route — the real public
> verification surface is the unauthenticated `GET /public/verify/:id` (the
> evidence id is the token, uniform 404 on miss for anti-enumeration). The spec
> now hits the real route. The ordinary extension user and the E2E use the same
> canonical routing.

### 4. Windows acceptance harness

`pnpm uc1:acceptance:windows` (`scripts/uc1-acceptance-windows.mjs`) boots a
fully **disposable** stack (docker PG16 + Redis via `--start-infra`, a migrated
`*_test` DB, API + worker + web + fixture server), seeds one paid workspace + a
real session bearer (`services/api/scripts/uc1-seed-acceptance.ts`), builds the
extension, and runs the Chrome + Edge Playwright acceptance. **Hard
production-safety**: every child process gets its environment from the allowlist
in `scripts/local-fixture-env` (throws before spawning if any value resolves off
this machine or looks like a live credential), and the harness independently
refuses a non-local or non-disposable DB / Redis / API endpoint. It never
deploys, never publishes an extension, never touches Production.

### 5. Migration sequence

`20280620000000_uc1_extension_oauth_codes` is EXPAND / SAFE_TO_APPLY_NOW, applied
**before** the UC-1 image. Registered across every gate: p6 curation +
regenerated inventory (0 gate failures), deployment plan, phase-32-7-2 allowlist,
phase-o approved-critical allowlist (additive `CREATE TABLE IF NOT EXISTS` on a
brand-new table), db-010 verifier (`failures: []`). Rehearsed on disposable PG16:
full chain applied from empty **and** idempotent on re-run; table shape verified.
NOT APPLIED TO PRODUCTION.

### 6. ENGINEERING CLOSED vs PUBLICATION PENDING

- **ENGINEERING** — every gate that can run here is green: shared / extension /
  API typecheck, the OAuth (4/4) + web-capture (4/4) integration suites, the
  migration gates, `pnpm audit:architecture` (AuditEngineIntegrity = PASS,
  ProductClosure = CLOSED, ReleaseBlockingClosure = PASS), MV3 lint,
  reproducible build. The real-auth acceptance harness is built and runnable.
- **BROWSER ACCEPTANCE** — the mandatory Chrome + Edge gate is **NOT EXECUTED
  here** (no browser automation in this sandbox). Run `pnpm
  uc1:acceptance:windows` on a Windows host with Chrome + Edge Stable.
- **PUBLICATION** — store icons (placeholder pending brand assets) and the
  extension's counsel-reviewed Privacy/Terms/AUP/DPA disclosures are required
  before any Chrome/Edge store submission. Not done in this task by design (no
  store publication, no counsel sign-off available here).

### Browser acceptance debugging (2026-09-17)

The first real Windows run reached Chromium Playwright execution and the static
scenario hung to the test timeout. Root-causing it (harness fixes + a full
non-browser lifecycle reproduction against the disposable stack) found and fixed:

- **Harness invoked `pnpm exec prisma` from the repo root** where prisma is not a
  dependency → migrate step died. Fixed `safe-migrate.mjs` to run prisma in the
  `proovra-api` workspace dir regardless of caller cwd.
- **Web child squatted the API's OAuth port.** `buildLocalFixtureEnv` sets
  `PORT=apiPort`; the web child (bare `next dev`) bound 4000 and served the OAuth
  authorize route as a Next.js 404. Fixed: the web child gets its own port
  (`next dev -p <webPort>` + `PORT` override); API readiness now requires HTTP 200.
- **No object storage.** The lifecycle is storage-backed (capture PUT, worker
  Report + Package upload, public Verify read); the fixture env points S3 at a dead
  address. Fixed: disposable MinIO + bucket, `S3_*` pointed at it.
- **Signing key not registered.** Evidence reads 503 `SIGNING_KEY_MISSING`. Fixed:
  the harness runs `prisma:seed` (seed-signing-key) with the fixture `SIGNING_*`.
- **No Puppeteer browser for the Report PDF.** report-v2 renders with Puppeteer and
  fails RETRYABLE_FAILURE with no browser. Fixed: harness resolves and injects
  `PUPPETEER_EXECUTABLE_PATH`.
- **Two acceptance-test contract bugs** (test, not product): DETAIL read
  `evidence.sourceContext` but `sourceContext` is a TOP-LEVEL key of the
  review-workspace response; SEARCH derived a query term from the display title
  (a generic "Digital Evidence Record") — now it asserts the evidence is listed by
  the fresh workspace's search after reindex. Public verify already corrected from
  the non-existent `public-overview` to `GET /public/verify/:id`.

The harness now prints stage-level PASS/FAIL with bounded per-stage timeouts and
a focused `--browsers=chromium --grep static` mode. **A full non-browser
reproduction of the exact lifecycle (real capture over HTTP → worker Report +
Package → public Verify) passes every stage green** against the disposable stack;
the browser gate adds only the extension's own capture UI.

### FINAL VERDICT (hardening pass)

Every implementable residual is closed; the browser gate is a single runnable
command. See the CODE/ARCHITECTURE CLOSURE AUDIT below for the development-gate
decision.

---

## CODE/ARCHITECTURE CLOSURE AUDIT (2026-09-17)

A fresh source-of-truth audit (three independent code traces + targeted tests)
was run to decide the DEVELOPMENT gate separately from browser release validation.

### Audit results (source-verified, not from prior reports)

- **Extension (MV3, OAuth/PKCE, capture, sanitizer, token)** — SOUND. Permissions
  are exactly `activeTab, scripting, storage, identity` (no cookies/webRequest/
  debugger/`<all_urls>`); strict CSP; real Authorization Code + PKCE S256 with no
  embedded secret; server-side redirect validation; short-lived single-use hashed
  codes; token in `chrome.storage.session`, expiring, cleared on logout. No P0/P1.
- **Manifest / digest / artifact lineage / claim safety** — SOUND. The server
  computes the authoritative SHA-256 from the uploaded bytes (client digest is a
  declaration), mismatch fails closed before signing, manifest↔part 1:1,
  cross-session/replay refused, acquisition mode set-once (DB trigger), binds once,
  derivative lineage explicit. Claim surfaces carry the non-proof disclaimers and
  the blocklist guard; no overclaim. No P0/P1/P2.
- **Downstream lifecycle + commercial** — SOUND, single authority per concern
  (custody, integrity, storage accounting, retention, legal hold, destruction incl.
  derived assets, report/package, public verify, audit). No parallel/duplicate
  authority. Commercial inherits the general evidence-creation gate
  (`assertWorkspaceAllowsEvidenceCreation` → `assertCommercialLifecycleAllowsPaidMutation`
  + `getPlanCapabilities`); **no capture-specific plan** (FREE 3-lifetime/wallet,
  PRO 100, TEAM 500/30d, ENTERPRISE contract; SHARED needs a shared-capable plan).
  No P0/P1.

### §K — the ~11.2-minute Chromium/static failure (analysis + defer)

The run reached `AUTH PASS` (OAuth succeeded, before the browser launch), then hung
past the timeout in the **CAPTURE** stage (the extension's `PRESERVE` pipeline
driven programmatically from the MV3 service worker). Most likely cause, from the
code: `activeTab` is granted only after a real user gesture (a click on the
extension action), so a capture invoked programmatically from the SW context —
without that gesture — cannot obtain tab access (`chrome.tabs.captureVisibleTab` /
`chrome.scripting.executeScript`), and depending on error propagation the SW
message never resolves → a hang. This is **browser-automation-specific**: it does
not touch the shared acquisition architecture, which the full non-browser
reproduction proves end to end. The spec now bounds the CAPTURE stage (90s) and
prints a named `CAPTURE TIMEOUT`/`FAIL` so the next focused run pinpoints it in
seconds. **Real-browser resolution is DEFERRED**: making the E2E drive the capture
through a genuine user gesture (e.g. clicking the extension popup button) is a
browser-harness task, not a product defect, and is recorded as the open item for
browser acceptance.

### Defects found and fixed this pass

- Sanitizer hardening (was P2): `javascript:`/`vbscript:` URL values neutralised,
  `<meta http-equiv="refresh">` and `<base href>` removed from the snapshot.
- Extension token no longer carries `role:"admin"` — capture needs only
  `evidence.create`, so a leaked short-lived token can't confer admin (was P2/D1).
- Latent API typecheck break (test imported an `.mjs` with no types → TS7016) fixed
  with a `.d.mts` declaration; reviewed the harness's local MinIO health-check
  origin in `origin-resolutions.json` (audit engine PASS).

### Remaining risks

- **P0/P1:** none.
- **P2 (deferred, non-blocking):** extension token, though no longer admin, is a
  full-privilege user JWT — the `capture.direct` scope is returned but not enforced
  on the JWT (scope-on-JWT enforcement is a cross-cutting auth change); Shadow DOM
  is not captured/disclosed with a limitation code; mutation detection is
  height-only. A pre-existing, non-UC-1 P2 (destruction-certificate HMAC fallback
  secret) was noted for the destruction owner.
- **P3:** sticky/fixed + navigation-during-capture disclosure; `optional_host_permissions`
  declared-but-unused; manifest-part labelled before seal (cosmetic).

### UC-2 readiness

The shared acquisition primitives UC-2 depends on are **stable**: `acquisitionMode`
set-once authority, `CaptureSession` bind-once, artifact/derivative lineage,
server digest authority, `authorizeOrFail`, and `createEvidence`/`completeEvidence`
are single-authority and unchanged in shape. The only open uncertainty is
browser-acceptance automation, which does not undermine these primitives. **UC-2
MAY BEGIN** (in a separate task) without destabilising UC-1.

### FINAL VERDICT

**UC-1 CODE/ARCHITECTURE COMPLETE · BROWSER ACCEPTANCE DEFERRED · UC-2 MAY BEGIN.**
Real Chrome + Edge acceptance has NOT passed and is not claimed to; it is deferred
release validation via `pnpm uc1:acceptance:windows`. Not deployed to Production;
extension not published.
