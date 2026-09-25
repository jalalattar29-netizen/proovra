# F — AUDIT COVERAGE LEDGER (v3)

**Frozen SHA:** `71e148f34410c7c231f8930d1387d8924b10b4e5`

Every denominator comes from a **discovered source inventory**, never a
hand-entered target. Every item is **EXAMINED**, **JUSTIFIABLY EXCLUDED** or
**UNRESOLVED**. No percentage here absorbs an unresolved item.

> ## RESULT: **AUDIT IN PROGRESS — NOT COMPLETE**
> All 64 applicable rows now carry a full L1–L8 register. **3,820 element
> correspondences remain undecided** and per-element style pairing has not been
> done. **Proven product parity is not established.** Completeness of source
> inspection and proven parity are different claims and are kept apart.

---

## 1. Routes — 208 discovered, every one dispositioned

| | Count | Status |
|---|---:|---|
| Discovered `page.tsx` routes | **208** | EXAMINED |
| ADMIN_ONLY | 36 | JUSTIFIABLY EXCLUDED — `domain: PLATFORM_ADMIN` / `requiredActiveSpace: PLATFORM_ADMIN` |
| ENTERPRISE_ONLY | 93 | JUSTIFIABLY EXCLUDED — `ENTERPRISE_ONLY_ROUTE_IDS`, `ORGANIZATION_ONLY`, or an ENTERPRISE tier rule with a deny policy |
| PUBLIC_INFORMATIONAL_ONLY (marketing) | 16 | JUSTIFIABLY EXCLUDED — `middleware.ts` routes these to the marketing host |
| `/settings/security/saml` | 1 | JUSTIFIABLY EXCLUDED — pure `redirect()` into an ENTERPRISE surface |
| **APPLICABLE** | **63** | **EXAMINED — all registered** |
| `/workspaces` (borderline, Enterprise-gated) | 1 | compared; excluded from gap counts |

### Per-route disposition of the 64 registered rows

| Disposition | Count | Meaning |
|---|---:|---|
| `COMPARED` | **54** | both sides have a tree; full L1–L8 register |
| `ALIAS_REDIRECT` | **8** | the web page is a pure `redirect()`/retired shim with **no UI of its own** — verified individually. Compared at the target |
| `NO_NATIVE_SCREEN` | **2** | `/operations`, `/operations/health` — applicable, native has nothing |

**Routes not compared: 0.**

## 2. Component trees — the depth that matters

| | PWA | Native |
|---|---:|---:|
| Files in the recursive trees (sum over routes) | 8,360 | 8,856 |
| **Unresolved imports** | **0** | **0** |
| Max import depth reached | 7 | 7 |

Zero unresolved imports on both platforms, across all 64 rows. The prior
instrument truncated at a depth bound and named the truncated branches; this one
resolves relative, workspace-alias, barrel, `export {default} from` and ESM
`./foo.js`→`.ts` specifiers to a fixed point.

**Native counterpart sets:** 12 web routes have a native counterpart of **more
than one screen** (`/settings` → 8). Comparing only the entry screen was a real
defect in this audit's first pass and is recorded in `CONTINUATION-MANIFEST.md` §4.

## 3. Elements and content

| | Count | Status |
|---|---:|---|
| Labelled PWA elements across applicable routes | **6,101** | EXAMINED |
| Labelled native elements | **1,983** | EXAMINED |
| Paired (same role + same literal) | 145 | EXAMINED |
| **Unpaired PWA labels** | **5,699** | fully adjudicated below |

### Adjudication of all 5,699 unpaired labels — no sampling cap

| Verdict | Count | Status |
|---|---:|---|
| **`COPY_OR_COMPOSITION_DIFF`** | **3,820** | **UNRESOLVED** — native has the role, not the literal |
| `PRESENT_ELSEWHERE_IN_APP` | 1,379 | EXAMINED — placement, not a gap |
| `SUBSUMED_BY_MISSING_SCREEN` | 231 | EXAMINED — `/operations` ×2 |
| `NOT_APPLICABLE_SHELL` | 153 | JUSTIFIABLY EXCLUDED — web marketing/app chrome |
| **`ROLE_ABSENT_ON_SCREEN`** | **101** | **EXAMINED — individually read**, → 63 distinct (`M-ABSENT-CONTROLS.md`) |
| `EXTRACTOR_ARTIFACT` | 15 | EXAMINED — prop names, not rendered strings |

**UNRESOLVED at element level: 3,820 of 5,699 (67.0%).** Stated here, not diluted.

Of the 101 `ROLE_ABSENT_ON_SCREEN`: **63 distinct** controls; of the 39 absent
SELECTs, **4 are a valid native adaptation and 35 are confirmed absent controls**;
the 33-route `TABLE "Actions"` is **one** documented adaptation.

## 4. Styles and colour

| | Count | Status |
|---|---:|---|
| Authored web stylesheets (build output excluded) | 30 | EXAMINED |
| CSS rules indexed | 5,458 | EXAMINED |
| CSS classes indexed | 2,515 | EXAMINED |
| `:root` custom properties | 235 | EXAMINED |
| Native theme leaves resolved to literals (by **evaluating** the real modules) | 213 | EXAMINED |
| PWA style properties resolved to literals, on applicable routes | **~53,000** (sum of per-route) | EXAMINED |
| **PWA-only colour uses (no native counterpart value)** | **1,600** | EXAMINED |
| Shared colour uses | 178 | EXAMINED |
| Mean distinct colours per colour-bearing route | PWA **41.3** vs native **18.4** (43 routes) | EXAMINED |
| **Classes with no matching CSS rule** | **5,430** | **UNRESOLVED** |
| **`className` built from a runtime expression** | **750** | **UNRESOLVED** |
| **Which declaration wins** | all | **UNRESOLVABLE BY CONSTRUCTION** — competing rules recorded per route instead |
| **Per-element style pairing (web element ↔ its native counterpart)** | — | **NOT DONE** — blocked on §3's 3,820 |

## 5. Interactions

| | PWA | Native | Status |
|---|---:|---:|---|
| **Distinct handler bindings** | **1,555** | **645** | EXAMINED |
| Traced to a terminal effect | 921 | 474 | EXAMINED |
| `PROP_FORWARD` (primitive forwards its own callback) | 257 | 109 | JUSTIFIABLY EXCLUDED |
| `NO_EFFECT_FOUND` | 207 | 51 | EXAMINED |
| **`UNRESOLVED`** | **170** | **11** | **UNRESOLVED** — stopping point named per binding |
| Accounted for | **75.8%** | **90.4%** | |

No three-level cap; depth bound 12, and exceeding it is reported, not truncated.

## 6. Data paths

| | Count | Status |
|---|---:|---|
| Distinct `/v1` endpoints the PWA reaches | 478 | EXAMINED |
| Distinct `/v1` endpoints native reaches | 359 | EXAMINED |
| **`ABSENT_FROM_APP`** (no native file calls it) | **111** | EXAMINED — `K-DATA-FLOW-MATRIX.md` §K.2 |
| `NOT_ON_THIS_SCREEN` | 33 | EXAMINED |
| Request-parameter comparison | done per route; worked example: `library-summary` **12 params vs 1** | EXAMINED |

## 7. UC requirements

| | Status |
|---|---|
| UC-1…UC-6 specifications located | EXAMINED |
| UC-3, UC-5 `CODE: COMPLETE` | **CONTRADICTED** — `G-UC-MATRIX.md` |
| UC-1, UC-2, UC-4 | **UPHELD BUT NOT INDEPENDENTLY RE-EXERCISED** — open item Q6 |
| Physical acceptance | **0 of 62 surfaces** |

## 8. Dimensions NOT covered — so no figure above is read as covering them

1. **Rendered output** — 0 screenshots, 0 simulator runs, 0 device runs.
2. **Per-element style pairing** (§4) — totals only.
3. **3,820 element correspondences** (§3) — undecided.
4. **5,430 unresolved CSS classes / 750 runtime-built `className`** (§4).
5. **181 unresolved handler bindings** (§5).
6. **UC-1, UC-2, UC-4 independent re-exercise** (§7).
7. **Locale-by-locale comparison** — native has `src/i18n.ts`; not compared.
8. **Accessibility beyond source declarations** — no focus-order, contrast or screen-reader audit.
9. **No test was executed.** The prior "942/942 passing" is carried as its claim.

## 9. Gate self-assessment against the mandate's §15

| Gate | Met? |
|---|---|
| Every discovered route has an explicit disposition | **YES** — 208/208 |
| Every applicable route has a fully expanded L1–L8 register | **YES** — 64/64 |
| All reachable component trees traversed | **YES** — 0 unresolved imports, both platforms |
| Every source-backed visible element accounted for | **YES as counted; NO as adjudicated** — 3,820 undecided |
| Every style/asset compared or given a stated limitation | **PARTIAL** — totals yes, per-element pairing no |
| Every applicable interaction traced or explicitly unresolved | **YES** — 2,200 distinct bindings dispositioned |
| Every historical finding reconciled | **YES** — `J-RE-ADJUDICATION.md` |
| Every UC requirement mapped | **YES**, with 3 not independently re-exercised |
| Every reported defect carries source evidence | **YES** — file:line throughout |
| Every unresolved item counted and disclosed | **YES** — §3, §4, §5, §8 |
| 100% parity or coverage claimed anywhere | **NO** |

---

# V4 COVERAGE — appended. Supersedes §3 and §4 above; nothing else retracted.

> ## RESULT AFTER V4: **AUDIT IN PROGRESS — NOT COMPLETE**
> Every applicable route has a full L1–L8 register. **Every one of the 4,360
> element correspondences now carries a verdict — 0 unresolved.** Sidebar, Login,
> Register, per-element visual and locale audits are done.
> **Five items remain open (V4.5 of the manifest). Proven product parity is NOT
> established and nothing was rendered.**

## V4.A Elements — 100% adjudicated

Denominator: 4,360 correspondences over 64 registered rows, from **export-scoped**
trees (v3's whole-file attribution inflated this; see `CONTINUATION-MANIFEST.md` §V4.3).

| Verdict | Count | % | Status |
|---|---:|---:|---|
| `CONTENT_ABSENT` | **2,275** | 52.2 | **EXAMINED — confirmed gap** |
| `PRESENT_ELSEWHERE_IN_APP` | 897 | 20.6 | EXAMINED — placement, not a gap |
| `NOT_APPLICABLE_ENTERPRISE` | 462 | 10.6 | JUSTIFIABLY EXCLUDED |
| `MATCH_ROLE_DIFFERS` | 204 | 4.7 | EXAMINED |
| `SUBSUMED_BY_MISSING_SCREEN` | 175 | 4.0 | EXAMINED |
| `NOT_APPLICABLE_SHELL` | 145 | 3.3 | JUSTIFIABLY EXCLUDED |
| `MATCH_COPY_DIFFERS` | 83 | 1.9 | EXAMINED (incl. 19 from the curated near-miss reading) |
| `ROLE_ABSENT_ON_SCREEN` | 58 | 1.3 | EXAMINED — individually read |
| `MATCH_EXACT` | 47 | 1.1 | EXAMINED |
| `EXTRACTOR_ARTIFACT` | 14 | 0.3 | EXAMINED |
| **TOTAL** | **4,360** | **100** | **UNRESOLVED: 0** |

The v3 figure of **3,820 `COPY_OR_COMPOSITION_DIFF`** is **withdrawn**: it was an
artifact of exact-literal pairing against a whole-file tree, not a real class.

## V4.B Component trees — export-scoped

| | PWA | Native |
|---|---:|---:|
| Unresolved imports | **0** | **0** |
| Unbound exports | 526 | 345 |
| …of which type-only (erased, render nothing) | verified on samples: **all inspected cases** | same |

## V4.C Visual — per element, to the level the source expresses

| | Count | Status |
|---|---:|---|
| Matched element pairs | 111 | EXAMINED |
| …with a literal web `className` | **16** | EXAMINED — 232 properties resolved |
| …with a literal native `style` | **6** | EXAMINED |
| **Per-element pairing beyond those** | — | **NOT EXPRESSIBLE** — both codebases style through component variants, so the comparison is done at primitive level (`N-VISUAL-PARITY.md` §N.4) |
| Primitives compared property-by-property | button, auth/social button, card, input, geometry tokens | EXAMINED |
| Fonts | **VIS-1 — native loads none** | EXAMINED |
| Image assets | 56 web / 5 native | EXAMINED |
| PWA-only colour uses | 1,600 | EXAMINED |
| Unmatched CSS classes | 5,430 | **DIAGNOSED into 4 groups** (`N-VISUAL-PARITY.md` §N.6) — none is a visual defect; group-4 quantification open |
| Runtime-built `className` | 750 | **UNRESOLVED by construction** |
| Which declaration wins | all | **UNRESOLVABLE by construction** |

## V4.D Locale — closed

| | Status |
|---|---|
| Dictionary | **one shared object**, both platforms import it — no web/native drift possible |
| Locales advertised | 7 |
| Genuinely translated | **2** (`ar` 41/42, `de` 38/42) |
| **Untranslated placeholders** | **4** (`fr`, `es`, `tr`, `ru` — 42/42 English) |
| Dictionary coverage | 42 keys vs 6,101 labelled PWA elements; native uses **11 keys / 18 call sites** |
| Interpolation / pluralization | **none exists** on either platform |
| RTL | native implements direction, alignment, family; web root layout shows **no `dir` wiring** |

## V4.E Still open

| Q | Item |
|---|---|
| Q4 | Quantify how many of the 5,430 unmatched classes are group-4 (genuinely absent rules) by parsing arbitrary-value Tailwind utilities |
| Q5 | 181 unresolved handler bindings (prop callbacks the static graph cannot bind) |
| Q6 | UC-1, UC-2, UC-4 independent re-verification |
| Q8 | Runtime-only items — V2-001 above all |
| Q9 | Group the 2,275 `CONTENT_ABSENT` strings into product requirements (1,879 distinct locations) |

## V4.F Gate self-assessment

| Gate | Met? |
|---|---|
| Every discovered route dispositioned | **YES** — 208/208 |
| Every applicable route has a full L1–L8 register | **YES** — 64/64 |
| Every element correspondence adjudicated | **YES** — 4,360/4,360, 0 unresolved |
| Sidebar / Login / Register deep audits | **YES** |
| Per-element visual comparison | **YES to the level the source expresses**; limit stated in V4.C |
| Locale parity | **YES** |
| Every applicable interaction traced or explicitly unresolved | **YES** — 2,200 distinct bindings; 181 unresolved, each with a named stopping point |
| Every historical finding reconciled | **YES** |
| UC requirements mapped | **YES**, with UC-1/2/4 not independently re-exercised (Q6) |
| Every unresolved item counted and disclosed | **YES** — V4.E |
| Rendered evidence | **NONE — 0 screenshots, 0 simulator, 0 device** |
| 100% parity claimed | **NO** |
