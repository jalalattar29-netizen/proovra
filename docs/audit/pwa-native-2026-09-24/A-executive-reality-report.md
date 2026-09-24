# A — EXECUTIVE REALITY REPORT

**Audited SHA:** `f822de79ad9397928cb59d1760e42bd63e583457` (branch `main`, working tree clean)
**Audit date:** 2026-09-24
**Scope:** every Personal / shared / public PROOVRA web route versus iOS and Android Native.
**Mode:** AUDIT ONLY. No product code, migration, stash, worktree or deployment was modified.

---

## 1. The number that governs everything else

| | Count |
|---|---:|
| Web routes discovered (machine-walked `apps/web/app`) | **208** |
| **Applicable to Native (this audit's scope)** | **64** |
| Excluded — PLATFORM_ADMIN consoles | 36 |
| Excluded — Enterprise / organization consoles | 92 |
| Excluded — public marketing funnel | 16 |
| Re-classified **into** scope by this audit | **2** |

The repository's own deriver produced 62 NATIVE_REQUIRED. This audit re-derived the
inventory from the same canonical authority and found **two routes wrongly excluded**
(§3.2). The applicable set is therefore **64**, not 62.

Legal, trust and public-verification pages (`/privacy`, `/terms`, `/subprocessors`,
`/trust`, `/legal/[slug]`, `/settings/legal/[slug]`, `/trust-center/*`, `/verify`,
`/verify/[token]`, `/support`, `/pricing`) are already inside the applicable set and
were audited. The 16 excluded public routes are the acquisition funnel
(`/for-lawyers`, `/request-demo`, …), which an installed app does not carry.

## 2. Headline verdict

> **The code is far better than its own paperwork says, and the product is
> nevertheless not shippable — because the single piece of configuration that
> makes an installed app reachable from a link is deployed to production with
> its placeholder values still in it.**

Three separate statements are all true at this SHA:

1. **62 of 62 ledger rows say `CODE_PARITY`.** The native app is substantial:
   484 interactive controls on the applicable screens, 451 of them resolvable
   to a real effect, 942 of 942 unit/render tests passing.
2. **Not one surface has ever been accepted on hardware.** `physicallyAccepted`
   is `false` on all 62 rows. This audit captured 0 screenshots, ran 0 simulator
   sessions and 0 physical-device sessions. **All visual parity is UNVERIFIED**,
   by the project's own instrument and by this one.
3. **Every https deep link into the app is broken in production** (§3.1).

## 3. Verified defects

### 3.1 P0 — Universal Links and App Links are deployed with unsubstituted placeholders

Measured live over the network on 2026-09-24:

| Probe | Result |
|---|---|
| `GET https://www.proovra.com/.well-known/apple-app-site-association` | **200** — body contains `"appIDs": ["<APPLE_TEAM_ID>.com.jalalattar29.proovra"]` |
| `GET https://www.proovra.com/.well-known/assetlinks.json` | **200** — body contains `"sha256_cert_fingerprints": ["<ANDROID_SIGNING_SHA256_FINGERPRINT>"]` |
| `GET https://proovra.com/.well-known/apple-app-site-association` | **301 →** `https://www.proovra.com/...` |
| `GET https://proovra.com/.well-known/assetlinks.json` | **301 →** `https://www.proovra.com/...` |

Consequences, in order of severity:

- **iOS**: `<APPLE_TEAM_ID>` is not a Team ID. No `appID` in the file can ever match
  the installed app, so iOS associates nothing and every `applinks:` domain is inert.
- **Android**: `<ANDROID_SIGNING_SHA256_FINGERPRINT>` is not a fingerprint. `autoVerify`
  **fails**, so the App Links claim is rejected and https links open the browser.
- **Apex domain**: `app.json` declares `applinks:proovra.com`, and Apple does **not**
  follow redirects when fetching an AASA. The apex association fails independently of
  the placeholder, and would still fail after the placeholders are fixed.

`app.json` itself is correct and complete — `associatedDomains` lists both hosts and
the Android `intentFilters` declare all ten path prefixes with `autoVerify: true`.
The defect is entirely in what production serves.

**Every token-bearing journey is affected**: `/intake/*`, `/portal/*`, `/invite/*`,
`/org-invites/*`, `/verify/*`, `/reset-password`, `/auth/verify-email`,
`/auth/mfa-recovery/*`, `/legal/*`. The API mints these as https URLs from
`WEB_BASE_URL`; with no working association they open the mobile browser, which is
the exact failure the ledger recorded as `BLOCKED_BY_EXTERNAL` and later closed.

### 3.2 P1 — Two personal-scope Operations routes were excluded from the programme by a heuristic, not by the authority

`tools/derive-product-manifest.mjs` classifies `ENTERPRISE_ONLY` partly from its own
constant `ENTERPRISE_DOMAINS = {GOVERNANCE, REVIEW_OPERATIONS, OPS}`. Two routes are
caught by that heuristic alone:

| Route | routeId | domain | requiredActiveSpace | In `ENTERPRISE_ONLY_ROUTE_IDS`? |
|---|---|---|---|---|
| `/operations` | `workspace.operations` | OPS | **PERSONAL_OR_ORG** | **No** |
| `/operations/health` | `workspace.operations_health` | OPS | **PERSONAL_OR_ORG** | **No** |

The registry author listed `operations.reliability`, `operations.automation` and
`operations.analytics` in `ENTERPRISE_ONLY_ROUTE_IDS` **and deliberately omitted these
two**. Both are reachable by an ordinary Personal user. They have **no native screen,
no ledger row and no test**. The web `/operations` page consumes 19 page-scoped
endpoints; native calls none of them.

### 3.3 P1 — The ledger's own progress counter is broken

`apps/mobile/src/product/native-destinations.mjs:877`:

```js
const counts = { NOT_STARTED: 0, BLOCKED_BY_DECISION: 0, SHELL: 0, PARTIAL: 0, PARITY: 0 };
for (const d of Object.values(NATIVE_DESTINATIONS)) counts[d.status] += 1;
```

`CODE_PARITY` is not a key, so every row computes `undefined + 1` → `NaN`.
`destinationCounts()` returns `{NOT_STARTED:0, …, PARITY:0, CODE_PARITY:NaN}` — it
reports **zero progress** over a 62/62 ledger.

Severity is contained: the export has **no consumers** in the repository. It is a
loaded gun on a shelf, not a live misreport.

### 3.4 P1 — The capability map is blind to path-builder call sites

`docs/architecture/current-runtime-capability-map.json` records 258 MOBILE consumer
sites and **none at all** in `apps/mobile/src/product/evidence-detail.ts` — a module
defining 22 `/v1/...` path builders that the evidence screen calls directly.

The generator detects a call by the literal path *at the call site*, and these builders
compose (`buildEvidenceArchivePath` returns `` `${buildEvidencePath(id)}/archive` ``),
so every leaf endpoint is invisible.

This is not theoretical. The ledger's own S15 cross-check (recorded in the
`/evidence/[id]` gaps) used this map, concluded "11 of 16 unconsumed", and had to
hand-correct three of them. An independent extractor written for this audit resolves
the 98 builders to a fixed point and recovers 191 distinct native paths — versus the
map's undercount. Correcting for it moved this audit's own gap count from 220 to 195.

### 3.5 P2 — `docs/native-conversion-status.md` is materially false at this SHA

| It says | Measured at `f822de79a` |
|---|---|
| `CODE_PARITY` 41, `PARTIAL` 14, `BLOCKED_BY_EXTERNAL` 6, `BLOCKED_BY_USER_DECISION` 1 | **62 CODE_PARITY, 0 of everything else** |
| "48 of 62 rows are at an end state. **The invariant is not met.**" | All 62 are at an end state |
| `apps/mobile` tests **580 / 580** | **942 / 942** |
| "`app.json` declares only the `proovra://` scheme and no domain" | `associatedDomains` + 10 `autoVerify` intent filters are declared |

The document warns "it is wrong the moment it disagrees with [the authorities]". It does.

### 3.6 P2 — The `/evidence/[id]` ledger row names five implemented capabilities as absent

Gap `[3]` reads: *"STILL ABSENT and named rather than implied: editing the record label
(PATCH /label), creating and deleting relationships, the reviewer-workflow PATCH and
its event feed, and downloading the ORIGINAL file."*

All five are wired at this SHA, in `apps/mobile/app/(stack)/evidence/[id].tsx`:

| Claimed absent | Actually at |
|---|---|
| `PATCH /v1/evidence/:id/label` | line 418–420 (`buildEvidenceLabelPath`) |
| create relationship | line 473 (`buildEvidenceRelationshipsPath`) |
| delete relationship | line 509 (`buildEvidenceRelationshipPath`) |
| reviewer-workflow PATCH + events | line 1101 (`<ReviewerWorkflowPanel />`) |
| download ORIGINAL | line 537 (`buildEvidenceOriginalPath`) |

This is the same blind spot as §3.4, fossilised into prose: the row under-claims here
while the ledger over-claims `CODE_PARITY` elsewhere.

## 4. Source-inferred discrepancies (not yet verified defects)

### 4.1 195 endpoints consumed by applicable web routes are never called by native

35 of 64 applicable routes carry at least one page-local endpoint the native app does
not call anywhere. Concentration is extreme and matches the product's depth:

| Route | Page-scoped web endpoints | Native calls | Never called by native | Ledger |
|---|---:|---:|---:|---|
| `/cases/[id]` | 73 | 11 | **43** | CODE_PARITY |
| `/evidence/[id]` | 110 | 24 | **42** | CODE_PARITY |
| `/operations` | 19 | 0 | **19** | *no row* |
| `/settings` | 47 | — | 19 | CODE_PARITY |
| `/home` | 24 | 6 | 18 | CODE_PARITY |

These are **not** all missing features. Triage of the two largest showed three distinct
causes, and only the first is a defect:

- **genuinely absent** — e.g. `/home`'s entire `/v1/ops/*` cluster (workflows, causality
  chains, bulk actions, escalate/resolve/suppress);
- **same capability, different endpoint** — `/cases/[id]` export uses
  `GET /v1/cases/:id/export` natively where the web uses `POST /v1/cases/:id/siu-export`;
- **argued product decision** — `/cases/[id]` renders the 5-tab personal branch, not the
  12-tab enterprise `MatterWorkspace`, and the ledger argues this explicitly.

The register (C/D) carries the per-endpoint detail. **No endpoint gap in this audit is
promoted to VERIFIED DEFECT without reading both sides**, and only the ones named in
§3 were read.

### 4.2 RTL is opt-in per component and 42 of 45 row layouts do not opt in

`I18nManager.forceRTL` / `allowRTL` are **never called**. RTL is handled manually:
`locale-context` exposes `isRTL` and swaps to *Noto Sans Arabic*, and individual
primitives apply `writingDirection`, `textAlign` and `flexDirection: "row-reverse"`.

| Measure | Count |
|---|---:|
| Files using `flexDirection: "row"` | 45 |
| …of those, files that read `isRTL` | **3** |
| Physical-edge styles (`marginLeft`, `left:` …) | 6 total |
| Logical-edge styles (`marginStart`/`paddingEnd` …) | **0** |

Because `I18nManager.isRTL` is always false, RN's logical props would not flip even if
used. Row direction is therefore LTR on 42 files under Arabic. Text alignment is
handled; row order is not. **Rendered confirmation requires a device — UNVERIFIED.**

### 4.3 Success feedback is inconsistent

| | Native | Web |
|---|---:|---:|
| Files with a loading affordance | 66 | 286 |
| Files with an empty affordance | 47 | 244 |
| Files with an error affordance | 66 | 246 |
| **Files with a success affordance** | **22** | 186 |
| Files using the toast system | **12 of 73** | — |

43 of 62 applicable native screens have no explicit success signal. Verified by reading
`evidence/[id].tsx`: failures raise `Alert.alert("Could not post comment", …)`; successes
re-fetch silently. For a list mutation that is defensible; for Archive, Lock and
Regenerate — one-way or long-running actions — it means the user is told nothing.

## 5. What is genuinely deferred, and correctly so

- **In-app purchase** — app-store rules govern it; `/billing` and `/pricing` argue this.
- **Enterprise `CommandCenter` fork on `/home`** — native targets the self-serve surface.
- **Spatial annotations (POINT/BOX/REGION)** — native writes TEXT with a TIME_ONLY anchor
  and reads every type; a coordinate guessed from a thumbnail would be a false claim
  about *where* in the evidence something is. This is the correct call.
- **Client-sampled records-by-type donut** — native reads the server aggregate only.
- **`/share/[id]`** — the web page itself renders "Share Link Page Not Active".

## 6. Coverage of this audit — stated plainly

| Dimension | Covered | Method |
|---|---|---|
| Route inventory | **208 / 208** | machine-walked + re-derived |
| Applicable dispositioned | **64 / 64** | machine + hand-checked exclusions |
| Endpoint parity | 64 / 64 routes | two independent extractors |
| Interactive controls inventoried | **484** on applicable screens | AST-ish extraction, handlers followed 3 deep |
| Controls resolved to an effect | **451 / 484 (93%)** | — |
| Controls UNVERIFIED | **33** | handler leaves the file |
| **Rendered visual comparison** | **0 / 64** | **none possible — see §7** |
| Simulator runs | **0** | — |
| Physical-device runs | **0** | — |

## 7. Why visual parity is UNVERIFIED and cannot be otherwise from here

The audit host is `win32`. iOS simulators cannot run on Windows at all. Booting the
API locally was refused on purpose: `services/api/.env` holds live production
credentials, so a local boot reaches production data — a known trap in this repository.
An authenticated web render was therefore not attempted either.

**No screenshots were taken, so no visual claim is made.** Deliverable (C) is a
source-inferred register of element-level risk, explicitly labelled, plus the exact
device matrix (F) that a human with an iPhone, an Android phone and an iPad must
execute. `docs/physical-acceptance.md` already exists and should be the vehicle.

## 8. Recommended order of work

1. **Substitute the two placeholders and serve the apex without a redirect** (§3.1).
   Nothing else in this report matters until a link opens the app.
2. Decide `/operations` + `/operations/health`: port, or add them to
   `ENTERPRISE_ONLY_ROUTE_IDS` with an argument. Today they are neither (§3.2).
3. Teach the capability-map generator to resolve path builders (§3.4), then re-run
   the ledger's S15 cross-check — its conclusions are built on an undercount.
4. Correct `native-conversion-status.md` and the `/evidence/[id]` gap `[3]` (§3.5, §3.6).
5. Triage the 195-endpoint register into port / different-endpoint / decided.
6. Run the device matrix (F). Until then `physicallyAccepted: false` is the honest state
   and **launch readiness cannot be claimed**.

---

*Artifacts B–I accompany this report in the same directory. Every count above is
emitted by `emit-artifacts.mjs` from the analyzers in this folder and is reproducible
at this SHA.*
