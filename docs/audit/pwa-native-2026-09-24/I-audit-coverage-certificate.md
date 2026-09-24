# I — AUDIT COVERAGE CERTIFICATE

**Audited SHA:** `f822de79ad9397928cb59d1760e42bd63e583457`
**Branch:** `main` · **Working tree:** clean at audit start and unchanged by this audit
**Audit date:** 2026-09-24
**Host:** `win32` — material to what could and could not be verified (§5)

This certificate states exactly what was inspected, by what method, and what was **not**.
**No claim of 100% coverage is made on any dimension**, and the dimensions where coverage
is zero are named first so they cannot be missed.

---

## 1. Dimensions with ZERO coverage

| Dimension | Covered | Why |
|---|---:|---|
| **Rendered visual comparison** | **0 / 64 routes** | No screenshots captured. iOS simulator impossible on `win32`; no Android SDK/AVD on host. |
| **Simulator sessions** | **0** | as above |
| **Physical-device sessions** | **0** | no hardware attached to this audit |
| **Authenticated runtime render** | **0 / 64** | `services/api/.env` holds live production credentials; a local API boot reaches production. **Deliberately not attempted.** |
| **Live API integration / E2E** | **0** | same cause |
| **iPad portrait / landscape** | **0** | needs hardware |
| **RTL Arabic rendered** | **0** | needs hardware |
| **English / German expansion rendered** | **0** | needs hardware |
| **Rendered accessibility (contrast in situ, font scaling, screen reader)** | **0** | needs hardware |

Consequently: **visual parity for all 64 applicable routes is UNVERIFIED**, and every
interaction verdict in (D) is a *source* verdict, never a runtime one.

## 2. Dimensions with full coverage

| Dimension | Covered | Method |
|---|---:|---|
| Web routes discovered | **208 / 208** | machine walk of `apps/web/app` for `page.tsx` |
| Routes dispositioned APPLICABLE or EXCLUDED | **208 / 208** | re-derived from `routeRegistry.ts`; 0 UNRESOLVED |
| Exclusion rationale recorded | **144 / 144** | (B.2) |
| Applicable routes | **64 / 64** | 62 manifest + 2 re-classified by this audit |
| Applicable routes joined against native | **64 / 64** | inverse endpoint coverage |
| Applicable routes with ledger + physical status read | **62 / 62** rows | `native-destinations.mjs` |
| Native screens control-inventoried | **41 distinct screens** serving 62 routes | — |
| Endpoints in the capability map examined | **961 with consumers** of 1161 | — |

## 3. Route counts

| | Count |
|---|---:|
| Web routes discovered | **208** |
| APPLICABLE | **64** |
| EXCLUDED — PLATFORM_ADMIN | 36 |
| EXCLUDED — Enterprise / org console | 92 |
| EXCLUDED — marketing funnel | 16 |
| Re-classified **into** scope by this audit | **2** |
| Applicable with a native screen | **62** |
| Applicable with **no** native screen | **2** (`/operations`, `/operations/health`) |
| Applicable with **no** ledger row | **2** (same) |
| Ledger rows at `CODE_PARITY` | **62 / 62** |
| Ledger rows `physicallyAccepted: true` | **0 / 62** |

## 4. Control counts

| | Count |
|---|---:|
| Interactive controls, whole native app | **514** |
| Interactive controls on **applicable** screens | **484** |
| …resolved to a concrete effect | **451 (93.2%)** |
| …**UNVERIFIED** (handler leaves the file) | **33 (6.8%)** |
| Interactive controls, whole web app (comparison side) | **1 815** |

**Calibration — the 33 are conservative, not precise.** The resolver follows named
handlers three levels **inside one file** and does not cross module boundaries. At least
some of the 33 are resolvable by eye — `() => Linking.openSettings()` is navigation but
the matcher only knows `Linking.openURL`; `oauth.promptGoogle` is a method on an
imported hook. The instrument prefers UNVERIFIED to a guess, so **6.8% is an upper bound
on real ambiguity, not a measured defect rate.** H-13 resolves them by hand.

**No control was passed on the existence of an `onPress`.** Every verdict names what the
handler is wired to. No control has a runtime verdict.

## 5. State counts

Detected structurally per file (a file that never references an affordance does not have
one), across 73 native and 347 web files carrying controls or states:

| State | Native files | Web files |
|---|---:|---:|
| loading | 66 | 286 |
| empty | 47 | 244 |
| error | 66 | 246 |
| **success** | **22** | 186 |

43 of 62 applicable native screens have no explicit success affordance.

Two screens have **none** of the four — and on inspection both are correct, not
defective:

| Screen | Why absent states are right |
|---|---|
| `(stack)/portal/index.tsx` (70 lines) | A pure token-entry form. It "exchanges nothing itself — it hands the token to `/portal/[token]`". Nothing to load, empty or fail. |
| `(stack)/support.tsx` (97 lines) | Static content and links. No fetch. |

*Method limit:* this detects the **presence** of an affordance, not whether one is
needed. Both zero-state screens and the success finding were read by hand before being
reported — `evidence/[id].tsx` alerts on failure (`Alert.alert("Could not post comment"…)`)
and re-fetches silently on success. **The state counts are an inventory, not a defect
list.**

## 6. Endpoint parity counts

| | Count |
|---|---:|
| Endpoints with a product consumer | **961** |
| Web consumer sites | 1 226 |
| Mobile consumer sites recorded by the capability map | 258 |
| **Native paths recovered by the independent extractor** | **191** (from 98 resolved builders) |
| Distinct endpoints called by applicable web routes, never called by native | **195** |
| Applicable routes with ≥ 1 such gap | **35 / 64** |
| Applicable routes with **zero** gaps | **29 / 64** |
| Shell-level gaps (reported once, not per page) | 9 |
| Native-only endpoints (no web consumer) | 12 |

**Instrument correction recorded in the count itself:** the first pass reported 220
gaps using the capability map alone. The map is blind to path-builder call sites
(H-4), which made it report Archive / Unarchive / Unlock as absent when they are
implemented. Adding the independent extractor moved the figure to **195**. The earlier
number is stated here rather than quietly replaced.

## 7. Test counts — executed, not inherited

| Suite | Command | Result |
|---|---|---|
| `apps/mobile` | `node --test` (after `pnpm run build:deps`) | **942 pass / 0 fail / 0 skip**, 15.1 s |

| | Count |
|---|---:|
| Mobile test files | **76** |
| …render tests (`*.render.test.mjs`) | **9** |
| …authenticated-integration tests | **0** |
| …E2E against a running API | **0** |
| Applicable routes with ≥ 1 referencing test | **46 / 64** |
| Applicable routes with **no** test | **18 / 64** |
| Applicable routes with a render test | **17 / 64** |

`services/api` and `apps/web` suites were **not** run by this audit. The status
document's claim of 16 API failures is **unverified here** and is not carried forward.

## 8. Findings by evidence class

| Class | Count | Meaning |
|---|---:|---|
| **VERIFIED DEFECT** | **8** | proven at this SHA by source reading or live network probe |
| **SOURCE-INFERRED DISCREPANCY** | **4** | derived from source; consequence not observed |
| **UNVERIFIED BEHAVIOUR** | **22 element classes + all 25 journeys + all 484 controls** | needs hardware or a live session |
| **INTENTIONALLY DEFERRED** | **5** | argued in the ledger and agreed by this audit |

**The 8 verified defects**

| # | Defect | How verified |
|---|---|---|
| 1 | AASA served with `<APPLE_TEAM_ID>` placeholder | live HTTP probe, 200 + body |
| 2 | `assetlinks.json` served with `<ANDROID_…FINGERPRINT>` placeholder | live HTTP probe, 200 + body |
| 3 | Apex `.well-known` 301-redirects; Apple does not follow redirects | live HTTP probe |
| 4 | `/operations` + `/operations/health` excluded by heuristic, not authority | read `routeRegistry.ts` + deriver constant |
| 5 | `destinationCounts()` returns `NaN` for every row | read source; executed the function |
| 6 | Capability map records 0 mobile consumers in `evidence-detail.ts` | queried the map; read the 22 builders |
| 7 | `native-conversion-status.md` false on 4 material points | compared to authorities + a real test run |
| 8 | `/evidence/[id]` gap `[3]` names 5 implemented capabilities as absent | read the screen at lines 418/473/509/537/1101 |

**The 4 source-inferred discrepancies**

| # | Discrepancy | Why not "verified" |
|---|---|---|
| 1 | 195 endpoints uncalled by native | mixes real absence, different-endpoint and argued decisions; only the routes read by hand are promoted |
| 2 | RTL row direction unmirrored in 42 of 45 files | rendered result not observed |
| 3 | `userInterfaceStyle: "dark"` over a light palette, no `StatusBar` | source contradiction certain; on-screen result not observed |
| 4 | Success feedback on 22 of 73 files | presence measured; adequacy not observed |

## 9. What this audit did NOT do

- Did not modify product code, migrations, stashes, worktrees or branches.
- Did not push, merge, deploy, build a binary, or run a migration.
- Did not boot the API, create a session, or issue an authenticated product request.
- Did not run `services/api` or `apps/web` test suites.
- Did not render any screen on any platform.
- Did not verify that any native control reaches the server.
- Did not open the 144 excluded routes; they were dispositioned from the registry and
  are listed with rationale in (B.2) for challenge, not inspected.
- Did not re-generate `current-runtime-capability-map.json`; it was consumed as
  committed, and its one proven blind spot is recorded (H-4).

**Files written by this audit:** only `docs/audit/pwa-native-2026-09-24/**`.
Two side effects, both gitignored build output, both required to run the test suite:
`packages/shared/dist` and `packages/shared-evidence-presentation/dist` were rebuilt by
`pnpm run build:deps`.

## 10. Reproducibility

Every count in every artifact is emitted by the analyzers in this directory:

| Instrument | Produces |
|---|---|
| `native-endpoints.mjs` | `native-endpoints.json` — 98 builders resolved → 191 paths |
| `inverse-coverage.mjs` | `endpoint-gap-register.json` — the web→native join |
| `controls-and-states.mjs` | control + state extraction, both platforms |
| `emit-artifacts.mjs` | `route-matrix.json`, `interaction-register.json`, all counts |
| `emit-markdown.mjs` | `B-…md`, `D-…md`, `G-…md` |

Run from `D:\digital-witness` with Node 24, in that order. They read only; they write
only into this directory.

---

## 11. Certificate

At `f822de79ad9397928cb59d1760e42bd63e583457`:

- **208 of 208** web routes were inventoried and dispositioned.
- **64 of 64** applicable routes were analysed for endpoint parity, controls and states.
- **484 of 484** controls on applicable screens were inventoried; **451** resolved,
  **33** reported UNVERIFIED rather than assumed.
- **0 of 64** routes were visually verified. **0** simulator runs. **0** device runs.
- **8** verified defects, **4** source-inferred discrepancies, **5** deferrals agreed.

> **Launch readiness is NOT established by this audit, and cannot be** — four of
> twenty-five critical journeys are broken in production today (one root cause), and no
> surface in the product has ever been accepted on hardware.

*Signed: automated audit, evidence-based, no dimension claimed beyond its evidence.*
