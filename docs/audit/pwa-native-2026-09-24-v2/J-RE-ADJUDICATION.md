# J — RE-ADJUDICATION OF THE PRIOR AUDIT

**Prior audit:** `docs/audit/pwa-native-2026-09-24/` (baseline `f822de79a`, re-run `10668edbe`)
**This audit:** frozen `71e148f34410c7c231f8930d1387d8924b10b4e5`

**Staleness:** `git diff 10668edbe..HEAD -- apps/web apps/mobile packages` is **empty**.
The prior audit's product source is identical to the frozen revision, so every
prior finding is adjudicated on its merits, never dismissed as stale.

Verdict vocabulary: **CONFIRMED** · **RECLASSIFIED** · **FALSE POSITIVE** ·
**UNDERSTATED** · **STILL UNRESOLVED** · **RESOLVED IN CURRENT SOURCE**.

---

## J.1 Headline claims

| # | Prior claim | Verdict | Evidence |
|---|---|---|---|
| 1 | "Applicable routes: **64** of 208" | **CONFIRMED as to membership, RECLASSIFIED as to one row** | Independently re-derived. The route-id manifest yields 62; the runtime tier authority (`lib/surface/tiers.ts`) adds `/operations` + `/operations/health` (both **CORE/allow**) and removes `/workspaces` (**ENTERPRISE/redirect**, enforced by `app/(app)/workspaces/layout.tsx` re-exporting `EnterpriseSurfaceLayout`). Corrected set = **63 applicable + 1 borderline**. See `00-BASELINE.md` §3. |
| 2 | "**62/62 ledger rows at CODE_PARITY**" | **CONTRADICTED BY THE PRIOR AUDIT'S OWN DATA** | `native-destinations.mjs` declares `CODE_PARITY` for all 62. The same audit's `page-comparison-index.json` reports, at the same SHA: `/home` 14/108 handlers (13%), `/search` 14/67 (21%), `/evidence/[id]` 72/302 (24%), `/settings` 38/152 (25%); overall **1,215/2,703 = 45%**. The ledger is a hand-maintained claim that the audit generated the means to falsify and did not apply. See `F-COVERAGE-LEDGER.md` §3. |
| 3 | "Universal Links / App Links files deployed with **placeholder values still in them** — 4 of 25 critical journeys cannot complete" | **CONFIRMED for iOS, RESOLVED for Android, and UNDERSTATED in blast radius** | `apps/web/public/.well-known/apple-app-site-association:6` still reads `"<APPLE_TEAM_ID>.com.jalalattar29.proovra"` **in the repository at the frozen revision** — not merely undeployed. Android is fixed (`assetlinks.json` now carries a real SHA-256 fingerprint). The AASA declares **10** path components covering **14 of the 63 applicable routes** (`/intake/*`, `/portal`, `/portal/*`, `/legal/*`, `/verify/*`, `/invite/*`, `/org-invites/*`, `/reset-password`, `/auth/verify-email`, `/auth/mfa-recovery/*`). See J.4. |
| 4 | "No surface has ever been accepted on hardware (`physicallyAccepted: false` × 62)" | **CONFIRMED** | Re-read from `native-destinations.mjs`: 0 of 62 true. |
| 5 | "All visual parity is UNVERIFIED; this audit rendered nothing" | **CONFIRMED, and repeated here** | This audit also rendered nothing. |
| 6 | "**525** elements found nowhere in the native app — the real missing-element figure" | **NOT SUPPORTABLE AS STATED** | 525 is a **label-absence** count, not a control-absence count. Re-running the adjudication with a counterpart-screen and same-role test (`02-adjudicate-unclassified.mjs`) yields **0** mechanically-confirmable gaps and **584 COPY_OR_STRUCTURE_MISMATCH** — cases where the native screen *does* carry controls of that role but not that literal, so source alone cannot separate "control missing" from "same control, different words". See J.2. |
| 7 | "**177** root-cause groups remain UNCLASSIFIED" | **CLOSED** | All 1,159 items in those groups are now adjudicated; **33** remain `UNRESOLVED_NEEDS_MANUAL` and are listed individually rather than hidden. See J.2. |
| 8 | "2,703 PWA handlers were **not** individually traced" | **CONFIRMED, and not closed here either** | This audit did not trace 2,703 handlers end-to-end. It traced the handler chains behind the five reported failures to their terminal effect (`E-ROOT-CAUSE-REGISTER.md`). Declared, not blurred. |
| 9 | "238 distinct hex in web CSS; 222 distinct hardcoded bypassing tokens" | **CONFIRMED (independently, different extraction)** | 30 authored stylesheets; **305** distinct hex overall, **295** distinct outside `tokens.css`, **1,752** occurrences. Same conclusion, same order of magnitude. See `C-DESIGN-SYSTEM-AND-SHELL.md` §C.2. |
| 10 | "CSS files indexed: 30" | **CONFIRMED** | An intermediate count of 58 in this audit was contaminated by `.next/` build output and is **withdrawn**. The prior walker's scope is correct. |

---

## J.2 The 192 groups / 1,271 items, fully re-adjudicated

Instrument: `02-adjudicate-unclassified.mjs` (read-only). It carries forward the
15 groups the prior audit *did* classify and decides the rest by explicit,
first-match-wins rules; anything a rule cannot decide is emitted as
`UNRESOLVED_NEEDS_MANUAL` with its reason.

| v2 verdict | Items | Meaning |
|---|---:|---|
| `COPY_OR_STRUCTURE_MISMATCH` | **584** | the native counterpart screen carries elements of this role, but not this literal — **undecidable from source**, needs per-element reading |
| `PRESENT_ELSEWHERE_IN_NATIVE` | 316 | placement difference, not a gap |
| `SOURCE_UNRESOLVED_LABEL` | 183 | the label is a runtime expression; not pairable by label at all |
| `NOT_APPLICABLE_ROUTE` | 38 | every carrying route is outside the corrected applicable set |
| `CARRIED:PLACEMENT_DIFFERENCE` | 34 | prior verdict upheld |
| `UNRESOLVED_NEEDS_MANUAL` | **33** | disclosed individually |
| `CARRIED:INTENTIONAL_PLATFORM_ADAPTATION` | 32 | prior verdict upheld |
| `CARRIED:PLACEMENT_OR_COPY_DIFFERENCE` | 17 | prior verdict upheld |
| `CARRIED:REAL_GAP` | 16 | prior verdict upheld |
| `CARRIED:SUBSUMED_BY_MISSING_SCREEN` | 8 | prior verdict upheld |
| `EXTRACTOR_FALSE_POSITIVE` | **5** | see J.3 |
| `CARRIED:PARTIAL` / two `FALSE_POSITIVE` rows | 5 | prior verdicts upheld |
| **Total** | **1,271** | |

**The honest headline:** the prior audit's 525 became 584 items that source
**cannot decide**, plus 0 that it can. Trading an overstated number for a
correctly-scoped unknown is the point of the re-adjudication; it is not progress
toward parity, and is not presented as such.

Resolving the 584 requires reading each element against its native counterpart —
the method demonstrated on `/home` in `D-HOME-PER-PAGE.md`, which converted a
"7% of elements" figure into **10 of 16 modules present, 6 named absences**.

---

## J.3 False positives found in the prior audit

| Class | Count | Evidence |
|---|---:|---|
| **Enterprise-branch attribution** | **51** | `components/command-center/CommandCenter.tsx` items were attributed to `/home`. `app/(app)/home/page.tsx:83-107` renders `CommandCenter` **only** for platform admin / enterprise workspace; the applicable audience always gets `SelfServeHomeDashboard`. NOT_APPLICABLE. |
| **Extractor artifacts — prop names read as labels** | **5** | e.g. `BUTTON "ariaLabel"` at `components/app-primitives/AppListbox.tsx:216`, reported across 13 routes. The extracted "label" is the prop *name*, not a rendered string. |
| **Marketing-shell elements counted as product gaps** | 32 (already carried) | `MarketingHeader` / `EnterpriseFooter` / `MarketingLanguageSwitcher` — "Request a demo", "Open menu", "Close menu". An installed app has no acquisition funnel. The prior audit classified these correctly; noted here because a naive re-run reclassifies them as gaps. |

An early pass of **this** audit reproduced the third error before the rule set was
corrected. Recorded so the correction is auditable.

---

## J.4 The iOS Universal Links finding, restated precisely

The repository **knowingly** ships a placeholder, and the guard is built to allow
it. `apps/web/__tests__/universal-link-parity.test.ts:139-158`:

> "This test PASSES while the Apple Team ID is a placeholder. It exists to
> [catch] … that is neither the placeholder nor a valid ten-character Team ID."

So CI is green while **every iOS Universal Link is non-functional**. iOS fetches
the AASA, cannot match `<APPLE_TEAM_ID>.com.jalalattar29.proovra` to the
installed app, and declines to associate the domain — so every
`https://www.proovra.com/...` link opens Safari rather than the app.

This is **category A / CONFIRMED-BY-SOURCE**, not a deployment hypothesis: the
placeholder is in the committed file at the frozen revision.

Affected applicable routes (14 of 63), derived from the 10 declared components:
`/intake/[token]`, `/intake/[token]/capture`, `/portal`, `/portal/[token]`,
`/portal/[token]/work/[workflowId]`, `/portal/accept/[grantId]`,
`/legal/[slug]`, `/verify`, `/verify/[token]`, `/invite/[token]`,
`/org-invites/[token]/accept`, `/reset-password`, `/auth/verify-email`,
`/auth/mfa-recovery/verify`.

Note this does **not** affect OAuth, which uses the custom `proovra://` scheme
and the reversed-client-id scheme, both correctly registered (`app.json:57-68`).

---

## J.5 Findings the prior audit did not have

The prior audit ran with **zero device evidence**. The five failures reported on
a physical iPad are new ground truth. Root-caused in
`E-ROOT-CAUSE-REGISTER.md`:

| ID | Finding | New relative to prior audit? |
|---|---|---|
| V2-001 | native OAuth `aud` values are not in the API allow-list; recovered production env shows the **web** client id and `com.proovra.web` only | **Upgraded** from `CODE_PRESENT / UNVERIFIED` to the leading explanation of an observed failure |
| V2-002 | local `.env` carries only the retired `EXPO_PUBLIC_GOOGLE_CLIENT_ID`, so a locally-bundled build refuses Google sign-in outright | **New** |
| V2-003 | two controls named "Finish & Sign"; the continuous-capture one **stages** while its own copy says it **seals** | **New** |
| V2-004 | `/screen-capture` is hard-gated to Android; iOS is silently routed to `/continuous-capture` | **New** |
| V2-005 | native has **no app header at all** → no global search, no workspace switcher, no account menu, no bell | **New as a root cause.** The prior audit counted the missing elements; it did not identify the absent shell as the single structure generating them |
| V2-006 | native `/search` goes silently idle when `activeTeamId` is null | **New** |
| V2-007 | `/operations` + `/operations/health` applicable and absent | **Confirms** the prior audit's hand-add and corrects the manifest |

---

## J.6 Prior artifacts: disposition

| Prior artifact | Disposition |
|---|---|
| `A-executive-reality-report.md` | superseded by `README.md` here; its 8 verified defects all upheld |
| `B-route-matrix.md` | **corrected** — see `00-BASELINE.md` §3c (3 rows change disposition) |
| `C-visual-discrepancy-register.md` | **upheld and extended** — `C-DESIGN-SYSTEM-AND-SHELL.md` |
| `D-interaction-register.md` (484 controls) | upheld; not re-derived |
| `E-critical-journey-matrix.md` | J-03 (Google OAuth) **upgraded**; rest upheld |
| `F-device-capability-matrix.md` | upheld |
| `G-test-coverage-matrix.md` | upheld; not re-executed (no tests were run by this audit) |
| `H-repair-backlog.md` | superseded by `I-DEFECT-BACKLOG.md` |
| `I-audit-coverage-certificate.md` | superseded by `F-COVERAGE-LEDGER.md` |
| `J-reconciliation-on-recovery-branch.md` | upheld; its Android note is now **RESOLVED IN CURRENT SOURCE** |
| `K-rendered-parity-plan.md` | upheld and still required |
| `L`–`O` instruments | re-read; **`M-style-resolver.mjs` scope confirmed correct** |
| `P-global-findings-register.md` | **superseded** by `adjudication.json` + J.2 |
| `Q-source-audit-coverage.md` | superseded by `F-COVERAGE-LEDGER.md`; its §5 and §6 honesty is upheld and imitated |
| `pages/*.md` (64 files) | retained as the element-tier evidence for 62 routes |

**Nothing in the prior directory was modified or deleted by this audit.**
