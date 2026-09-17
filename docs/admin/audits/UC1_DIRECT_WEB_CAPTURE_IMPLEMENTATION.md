# UC-1 — CHROMIUM DIRECT WEB CAPTURE

Status: **IMPLEMENTATION COMPLETE — BROWSER ACCEPTANCE PENDING**
Date: 2026-09-17
Precondition: UC-0 Gate A CLOSED (`26ad3ddb`).

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

OAuth2 authorization-code + PKCE against the existing auth system; short-lived
access token, refresh via the platform's existing rotation; no embedded secret,
no long-lived API key, no cookie scraping. Workspace/case selection is sent as a
request, never trusted: the server authorizes via the canonical `authorizeOrFail`
(evidence.create, anti-enumeration) and the existing case-access checks — exactly
as the UC-0 direct-session routes already do.

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

### Capability / commercial

No new plan, no invented quota. The direct-capture session route already gates
on the ONE canonical commercial authority (it returns `TEAM_PLAN_REQUIRED` /
`ENTITLEMENT_REQUIRED` when the workspace's plan does not permit capture — proven
in the integration suite). The extension surfaces that denial ("Direct Web
Capture isn't available on this workspace's plan"). The exact FREE/PRO/TEAM/
ENTERPRISE packaging of Direct Web Capture is a **product decision left open**;
the capability plumbing is complete and reuses the canonical authority.

### Test evidence (executed here)

- shared: **923/0** node:test (adds the acquisition-mode + manifest-validator + URL-privacy cases).
- API integration `uc1-web-capture.integration.test.ts`: **4/4** — seal, manifest-omission refusal, session-mismatch refusal, mobile-session/forged-mode refusal.
- extension unit: **12/12** (capture-plan, sanitizer predicates, manifest builder).
- extension: typecheck clean, `build.mjs` reproducible (SHA256SUMS), MV3 lint OK.
- migration `20280610000000`: clean-boot + drift OK on disposable PG16.

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
- **P1:** browser E2E not yet executed (environment) — UC-1 is not CLOSED until it is.
- **P2:** OAuth extension client + redirect URI must be registered server-side for the interactive PKCE flow (the E2E seeds the token directly); server-side multi-source stitching deferred; extension store icons + counsel-reviewed legal text pending.
- **P3:** Direct Web Capture plan packaging unresolved (capability plumbing complete).
