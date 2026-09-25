# A — FINAL COVERAGE LEDGER

**Frozen SHA:** `71e148f34410c7c231f8930d1387d8924b10b4e5` · branch `main` · tree clean · 0 product changes
**Mode:** SOURCE-ONLY. Nothing rendered. No screenshot, emulator, simulator, device, build, deploy or EAS invocation.

> ## VERDICT: **SOURCE AUDIT COMPLETE — PRODUCT PARITY NOT ESTABLISHED**
> Every source-resolvable dimension is adjudicated. **28 handler bindings** and
> **1 asset-rendering question** remain source-unresolved, each named with the
> evidence that closes it. **No runtime or physical-device claim is made anywhere.**

---

## 1. Routes — 208 discovered, 208 dispositioned

| | Count | Status |
|---|---:|---|
| Discovered `page.tsx` | **208** | EXAMINED |
| ADMIN_ONLY | 36 | JUSTIFIABLY EXCLUDED |
| ENTERPRISE_ONLY | 93 | JUSTIFIABLY EXCLUDED |
| PUBLIC_INFORMATIONAL_ONLY | 16 | JUSTIFIABLY EXCLUDED |
| `/settings/security/saml` (redirect shim into an Enterprise surface) | 1 | JUSTIFIABLY EXCLUDED |
| **APPLICABLE** | **63** | **all registered** |
| `/workspaces` — **BORDERLINE**, Enterprise-tier (`SurfaceGate` redirects self-serve) | 1 | compared; **excluded from all gap counts** |
| Registered rows | **64** | `COMPARED` 54 · `ALIAS_REDIRECT` 8 · `NO_NATIVE_SCREEN` 2 |

**Routes not compared: 0.**

## 2. Component trees

| | PWA | Native |
|---|---:|---:|
| Unresolved imports | **0** | **0** |
| Export-scoped crawl | yes | yes |
| Unbound exports | 526 | 345 |
| …verified type-only on every sample inspected | yes | yes |

## 3. Elements — 4,360 correspondences, 0 unresolved

| Verdict | v4 | **FINAL** | Change |
|---|---:|---:|---|
| `CONTENT_ABSENT` | 2,275 | **2,732** | +457 from the PRESENT_ELSEWHERE re-check |
| `PRESENT_ELSEWHERE_IN_APP` | 897 | **69** | only the genuinely one-hop-reachable survive |
| `MATCH_*` (exact / copy / role) | 334 | **705** | +371 mis-binned items proved present on the counterpart |
| `NOT_APPLICABLE_ENTERPRISE` | 462 | **462** | **validated**, unchanged |
| `NOT_APPLICABLE_SHELL` | 145 | **132** | **−13** — `ForgotPasswordModal` was a false exclusion |
| `SUBSUMED_BY_MISSING_SCREEN` | 175 | 175 | unchanged |
| `ROLE_ABSENT_ON_SCREEN` | 58 | 58 | unchanged |
| `EXTRACTOR_ARTIFACT` | 14 | 14 | unchanged |
| **Comparable (was excluded as shell)** | — | **+13** | modal→screen adaptation |
| **TOTAL** | **4,360** | **4,360** | **UNRESOLVED: 0** |

### The three mandated re-checks (§4)

| Re-check | Result |
|---|---|
| **897 `PRESENT_ELSEWHERE`** | **371** were mis-binned — the literal *is* on the counterpart screen set → promoted to `MATCH`. **69** reachable in one nav hop → genuine placement difference. **457 live on a screen NOT reachable from this route** → promoted to `CONTENT_ABSENT`. Presence in the app is not parity. |
| **462 `NOT_APPLICABLE_ENTERPRISE`** | **UPHELD.** 354 from `command-center/*` — excluded by the **branch** (`app/(app)/home/page.tsx:83-107`, `resolveHomeSurface`), not by path; 108 from `workspace-admin/*` on ENTERPRISE-tier routes. |
| **145 `NOT_APPLICABLE_SHELL`** | **132 UPHELD** (`MarketingHeader` 75, `EnterpriseFooter` 35, `MarketingLanguageSwitcher` 22). **13 OVERTURNED** — `ForgotPasswordModal` posts to `/v1/auth/password-reset/request`; a product control that merely lives in `components/marketing/`. Native implements it as `(stack)/forgot-password.tsx`. |

## 4. CSS and visual (Q4 — CLOSED)

| | Count | Status |
|---|---:|---|
| Distinct `className` tokens on applicable routes | **2,841** | EXAMINED |
| `CSS_RULE_EXISTS` | 1,975 (69.5%) | RESOLVED |
| `TW_STOCK` | 239 (8.4%) | RESOLVED to Tailwind defaults (`tailwind.config.ts` is `extend: {}`, so defaults are the real values) |
| `TW_ARBITRARY` | 144 (5.1%) | RESOLVED — value is in the class name |
| `TW_VARIANT` | 101 (3.6%) | RESOLVED — base resolves; variant recorded |
| `EXTRACTOR_ARTIFACT` | 217 (7.6%) | EXAMINED — JS identifiers/template heads lifted by the prior harvester |
| **RESOLVED TOTAL** | **2,676 (94.2%)** | |
| Residue | 165 | split below |
| — styled by a TSX `<style>` block (17 files, 57 selectors) | **35** | RESOLVED — **not a defect** |
| — residual Tailwind decoder gap | ~12 | RESOLVED in principle |
| — **genuinely unstyled custom classes** | **~115 distinct / 375 uses** | **CONFIRMED DEFECT (PWA-side)** |

**The `cc-*` finding:** components use **551 distinct `cc-*` class names**; only **2** (`.cc-page`, `.cc-title`) have rules. `command-center.css` declares **213 `.ec-*`** rules — the stylesheet was renamed `cc-` → `ec-` and the components were not updated. On applicable routes this is **22 classes / 196 uses / 6 routes**. Those elements render unstyled **in the PWA reference itself**.

| Dynamic `className` expressions | **108 distinct** | EXAMINED — literal fragments harvested; the composed string is a runtime fact |
| Which declaration wins | all | **UNRESOLVABLE BY CONSTRUCTION** — competing rules recorded, no winner asserted |

## 5. Handlers (Q5 — CLOSED to 84.5%)

| | Count | Status |
|---|---:|---|
| Distinct bindings (both platforms) | **2,200** | EXAMINED |
| Previously `UNRESOLVED` | 181 | re-opened and worked |
| — `RESOLVED_VIA_CALL_SITES` (parent enumeration + 2nd hop) | **89** | RESOLVED |
| — `RESOLVED_INLINE_BODY` | **21** | RESOLVED |
| — `LOCAL_CLOSURE` | 25 | RESOLVED — calls a same-scope function |
| — `PROP_FORWARD_TO_OWN_PROP` | 16 | RESOLVED — effect belongs to the enumerated call site |
| — `PLATFORM_API` / `INLINE_DOM_STYLE` | 2 | RESOLVED |
| **— `HOOK_RETURNED_CALLABLE`** | **28** | **UNRESOLVED** — see §8 |

## 6. Data paths

| | Count |
|---|---:|
| Distinct `/v1` endpoints the PWA reaches | 478 |
| Distinct `/v1` endpoints native reaches | 359 |
| **`ABSENT_FROM_APP`** | **111** |
| `NOT_ON_THIS_SCREEN` | 33 |
| Parameter-level comparison | done per route; worked example `library-summary` **12 params vs 1** |

## 7. Locale (Q7 — CLOSED)

| | Status |
|---|---|
| Dictionary | **one shared object**; no web↔native drift possible |
| Locales advertised / genuinely translated | **7 / 2** (`ar` 41/42, `de` 38/42) |
| Untranslated placeholders | **4** — `fr`, `es`, `tr`, `ru` return English for all 42 keys |
| Coverage | 42 keys vs 6,101 labelled PWA elements; native uses **11 keys / 18 call sites** |
| Interpolation / plurals | **none exists** on either platform |

## 8. UC acceptance (Q6 — CLOSED for source)

| UC | Spec claim | Independent re-audit |
|---|---|---|
| UC-1 | CODE complete, EXTERNAL pending | **UPHELD.** The PWA itself renders *"The PROOVRA browser extension has not been published yet, so there is nothing to install."* (`CaptureDirectWebCaptureCard.tsx:40`); the install anchor is guarded `canInstall && installUrl`. No store URL exists anywhere in the repo. |
| UC-2 | CODE complete, PHYSICAL pending | **UPHELD.** `ScreenCaptureService.kt`, `ProovraScreenCaptureModule.kt` present; `screen-capture.tsx:57` gates to Android, consistent with this UC's scope. |
| UC-3 | CODE complete | **CONTRADICTED** — shares the `continuous-capture` finalize handler carrying V2-003. |
| UC-4 | CODE complete | **UPHELD.** `EVIDENCE_ACQUISITION_MODES` is the single origin authority (`packages/shared/src/evidence-acquisition.ts:35`); no second capture model found. |
| UC-5 | CODE complete | **CONTRADICTED** — V2-003 (label lies) + V2-004 (no iOS `/screen-capture`). Both are CODE, resolvable in this repository. |
| UC-6 | §0 pre-flight | **UPHELD and now urgent** — it predicted exactly V2-001. |

**Physical acceptance: 0 of 62 surfaces.** Unchanged and not claimable from source.

## 9. What remains SOURCE-UNRESOLVED — complete list

| # | Item | Count | Why source cannot decide | What closes it |
|---|---|---:|---|---|
| U-1 | `HOOK_RETURNED_CALLABLE` handlers | **28** | the callable (`downloadReport()`, `loadWorkflowEvents()`, `links.onUnlink()`) is destructured from a custom hook's return object; binding it needs the hook's return-shape resolved per call site | read each owning hook (`useEvidenceArtifacts`, `useWorkflowEvents`, `useCaseLinks`) and map the returned key to its body — ~6 hooks |
| U-2 | Which CSS declaration wins | all 26k+ | cascade + specificity + conditional class application are runtime facts | rendered evidence only |
| U-3 | Composed `className` strings | 108 distinct expressions | the string does not exist until render | rendered evidence only |
| U-4 | `.app-shell-v2` background image | 1 | **5 competing rules**, one re-declaring `background-image: none`; U-2 applies | rendered evidence only. *(The sidebar image has no competitor and IS certain.)* |
| U-5 | Native font family actually rendered | 1 | RN's fallback face is platform-decided | device screenshot, or simply note that **no font is loaded** — which IS source-certain |
| U-6 | Every runtime item in `FINAL-RUNTIME-VALIDATION-PLAN.md` | 11 | deployed configuration and device behaviour | see that document |

## 10. Gate self-assessment

| Gate | Met? |
|---|---|
| Every discovered route dispositioned | **YES** 208/208 |
| Every applicable route has a full L1–L8 register | **YES** 64/64 |
| Every element correspondence adjudicated | **YES** 4,360/4,360 |
| Q4 CSS closed | **YES** — 94.2% mechanically + residue split; `cc-*` defect isolated |
| Q5 handlers closed | **84.5%**; 28 named with their resolution path (U-1) |
| Q6 UC re-audited independently | **YES** — UC-1/2/4 upheld on own evidence; UC-3/5 contradicted |
| Q9 grouped into requirements | **YES** — 191 owning files, deduplicated |
| The three mandated re-checks | **YES** — 371 promoted, 457 demoted, 13 exclusions overturned |
| Borderline route explicit | **YES** — `/workspaces`, excluded from gap counts |
| Rendered evidence | **NONE** |
| Physical-device parity claimed | **NO** |
| 100% product parity claimed | **NO** |
