# PWA → NATIVE FORENSIC PARITY RE-AUDIT (v2)

**Frozen revision:** `71e148f34410c7c231f8930d1387d8924b10b4e5` · branch `main` · tree clean at start
**Date:** 2026-09-24
**Mode:** SOURCE-ONLY. No product code modified. No render, screenshot, emulator, simulator, device run, build, deploy or EAS invocation. No worktree, branch or stash touched. Files written: this directory only.

> ## RESULT: **INCOMPLETE**
> Source inspection is substantially complete in the dimensions listed in
> `F-COVERAGE-LEDGER.md`. **Proven product parity is not established, and the
> product is far from it.** Those are different claims and are kept apart
> throughout. 800 of 1,271 unpaired elements remain formally UNRESOLVED and are
> counted in the open, not absorbed into a coverage percentage.

---

## The five things that matter

**1. The user's five iPad failures all have source-traceable causes. Two are configuration, three are code.**

| Reported | Cause | Confidence |
|---|---|---|
| Google + Apple sign-in nonfunctional | the deployed API's OAuth **audience allow-list** holds only the *web* client id and `com.proovra.web`; native tokens carry the iOS client id / bundle id | **B (high)** — one `printenv` closes it |
| Missing search | native has **no app header at all**; `/search` has exactly **one** entry point in the entire app | **A** |
| Failed screen-capture finalization | the iOS button labelled **"Finish & Sign"** does not sign — it stages — while the copy above it says it seals | **A** |
| Incorrect / missing information | `/home` ships **10 of the web's 16 modules**; the whole "Verification & production" band is absent | **A** |
| Major visual divergence | the **web** renders ~295 distinct hex colours that exist in no design token; native renders the 46-colour token palette faithfully | **A** |

**2. A sixth failure the user has not hit yet: every iOS Universal Link is dead.**
`apps/web/public/.well-known/apple-app-site-association:6` still contains the
literal `<APPLE_TEAM_ID>` **in the committed file**. 14 of the 63 applicable
routes are reached by link — intake, portal, verify, invite, org-invites,
reset-password, verify-email, MFA recovery. All of them open Safari.
The guard at `universal-link-parity.test.ts:143` is written to **pass** on the
placeholder, so CI cannot tell you.

**3. The "62/62 CODE_PARITY" ledger is contradicted by the repository's own data.**
`native-destinations.mjs` claims code parity on all 62 surfaces. The prior
audit's element data, at the same SHA, reports `/home` at 13% of web handlers,
`/search` 21%, `/evidence/[id]` 24%, `/settings` 25%; **45% overall**. 0 of 62
are physically accepted.

**4. The prior audit's "525 missing elements" does not survive re-adjudication — and the honest replacement is worse, not better.**
525 was a *label-absence* count. Re-running with a counterpart-screen and
same-role test yields **0** mechanically-confirmable gaps and **584 items source
cannot decide**. That is a correction of method, not progress toward parity.
Resolving them needs per-module reading — demonstrated on `/home`, where "7% of
elements" became the truer **"10 of 16 modules present, 6 named absences."**

**5. Native's engineering is better than its reputation in several places, and that is stated too.**
Its workspace-id resolution is *more* correct than the deprecated hook the web's
own `/search` still uses. Its KPI logic degrades to `"Not available"` rather than
to a misleading `0`. Its token adapter parses the canonical CSS shadows instead
of hand-copying them, and carries only 6 hardcoded hex in the entire codebase.
The divergence is not native drifting from the design system — it is the web
bypassing it.

---

## Artifacts

| | File | Contents |
|---|---|---|
| **A** | [`00-BASELINE.md`](00-BASELINE.md) | Frozen SHA, staleness proof, route inventory **independently re-derived** (208 → 63 applicable + 1 borderline), and the 4 route dispositions that change |
| **C** | [`C-DESIGN-SYSTEM-AND-SHELL.md`](C-DESIGN-SYSTEM-AND-SHELL.md) | The colour-token divergence mechanism; the app-shell comparison element by element; the enterprise-branch false-positive class |
| **D** | [`D-HOME-PER-PAGE.md`](D-HOME-PER-PAGE.md) | `/home` at **module tier** — the method that resolves what element counts cannot |
| **E** | [`E-ROOT-CAUSE-REGISTER.md`](E-ROOT-CAUSE-REGISTER.md) | **V2-001 … V2-008**, each with file:line evidence, affected routes, confidence, and the exact minimal runtime evidence needed where source cannot decide |
| **F** | [`F-COVERAGE-LEDGER.md`](F-COVERAGE-LEDGER.md) | Every denominator from a discovered inventory; every item EXAMINED / JUSTIFIABLY EXCLUDED / **UNRESOLVED**; the 8 dimensions **not** covered |
| **G** | [`G-UC-MATRIX.md`](G-UC-MATRIX.md) | UC-1…UC-6 located and adjudicated. **UC-5 and UC-3 "CODE: COMPLETE" contradicted** |
| **I** | [`I-DEFECT-BACKLOG.md`](I-DEFECT-BACKLOG.md) | P0…P4 by shared root cause, incl. 6 **instrument defects** to fix so the next audit is cheaper |
| **J** | [`J-RE-ADJUDICATION.md`](J-RE-ADJUDICATION.md) | All 10 prior headline claims + all 1,271 items + all 15 prior artifacts adjudicated |

### Machine data and instruments (read-only, re-runnable from `D:\digital-witness`, Node 24)

```bash
node docs/audit/pwa-native-2026-09-24-v2/01-reclassify-routes.mjs
node docs/audit/pwa-native-2026-09-24-v2/02-adjudicate-unclassified.mjs
```

| File | Contents |
|---|---|
| `reclass.json` | all 208 routes × {manifest classification, runtime tier, direct-access policy} |
| `adjudication.json` | all 1,271 unpaired elements with a v2 verdict and a stated reason |

---

## Relationship to the prior audit

`docs/audit/pwa-native-2026-09-24/` is **not replaced and was not modified**.
Its product source is byte-identical to this frozen revision
(`git diff 10668edbe..HEAD -- apps/web apps/mobile packages` is empty), so every
finding was adjudicated on its merits. Its `pages/*.md` remain the element-tier
evidence for 61 routes. What changed is listed in `J-RE-ADJUDICATION.md`.

It was also honest about its own limits in a way this audit has imitated rather
than improved on — in particular its §5 and §6, which declined to claim 2,703
handler traces. This audit does not claim them either.

---

## Read it in this order

1. **README** (here) for the verdict.
2. **E** for why each reported failure happens.
3. **I** for what to do, in dependency order.
4. **F** to check that nothing above is claimed beyond its evidence.

> Launch readiness is **not** established by this audit. P0 must close first, and
> P0 cannot be closed from a repository — it needs the deployed API's environment
> and a real Apple Team ID.

---

## v3 PASS — FULL ROUTE COVERAGE (appended; nothing above retracted)

The v2 pass raised only `/home` to module tier. The v3 pass built deeper
instruments and produced **a full L1–L8 register for every applicable route**.

| | v2 | **v3** |
|---|---|---|
| Routes with a full register | 1 | **64 of 64** |
| Unresolved imports in the crawls | depth-bounded, truncated branches named | **0 / 0** |
| Element correspondences adjudicated | 1,271 | **5,699** (no sampling cap) |
| Handler bindings traced to a terminal effect | 9 | **1,395 distinct** (2,200 dispositioned) |
| API comparison | per route | **478 web / 359 native**, split into **111 absent-from-app** vs 33 off-screen |
| Absent controls individually read | — | **63 distinct** from 101 occurrences |

**New artifacts:** [`ROUTES-INDEX.md`](ROUTES-INDEX.md) · [`routes/`](routes/) (64 registers) ·
[`K-DATA-FLOW-MATRIX.md`](K-DATA-FLOW-MATRIX.md) · [`L-HANDLER-LEDGER.md`](L-HANDLER-LEDGER.md) ·
[`M-ABSENT-CONTROLS.md`](M-ABSENT-CONTROLS.md) · [`CONTINUATION-MANIFEST.md`](CONTINUATION-MANIFEST.md)

### What v3 adds to the verdict

* **111 `/v1` endpoints are called by the PWA and by no native file anywhere.**
  Largest families: `/v1/ops` (17), `/v1/search` (9), `/v1/billing` (8),
  `/v1/identity-security` (7). This — not a workspace-scope bug — is the
  substantive cause of missing information.
* **Same endpoint ≠ same request.** `/v1/evidence/library-summary` receives
  **12 parameters** from the web and **1** from native. Endpoint-level comparison
  scores that a match; it is not one.
* **35 confirmed absent controls** (after 4 of the 39 absent SELECTs proved to be
  valid native adaptations, and the 33-route `TABLE "Actions"` proved to be one
  documented adaptation).
* **`/v1/platform/context/switch-workspace` is reachable on 33 web routes and one
  native screen.** That is V2-005 — the absent app shell — measured rather than
  argued.

**Status: AUDIT IN PROGRESS — NOT COMPLETE.** 3,820 element correspondences
remain undecided and per-element style pairing has not been done.
See [`CONTINUATION-MANIFEST.md`](CONTINUATION-MANIFEST.md) §2 for the exact resume queue.

### Six instrument defects were found and fixed inside this audit

ESM `./foo.js`→`.ts` specifiers (183 unresolved on `/home` alone, silently
dropping the whole `packages/shared` layer) · native counterpart treated as one
screen (reported the entire identity-security family as missing when
`settings/security.tsx` implements it) · `/v1/` counted as an endpoint · API gaps
not split app-wide vs per-screen · primitive prop-forwards counted as untraced ·
Windows path separators silently zeroing the nav graph. All six are recorded in
`CONTINUATION-MANIFEST.md` §4 so they are not reintroduced.

### Three hypotheses were raised and falsified

"18 native screens read data unscoped" — the web does not send `teamId` either;
scope is server-derived on both sides. · "The prior CSS indexer missed half the
stylesheets" — my count was contaminated by `.next/`; 30 is correct. ·
"`TABLE "Actions"` missing on 32 routes" — one shared component, documented
adaptation, verified against behaviour. Recorded in `CONTINUATION-MANIFEST.md` §5.

---

## v4 PASS — element adjudication closed; Sidebar / Login / Register / visual / locale added

| | v3 | **v4** |
|---|---|---|
| Element correspondences | 5,699 items, **3,820 unresolved** | **4,360 items, 0 unresolved** |
| Sidebar / Login / Register deep audits | — | **3 dedicated reports** |
| Per-element visual comparison | totals only | **done to the level the source expresses** |
| Locale parity | — | **closed** |

**New artifacts:** [`SIDEBAR-PARITY.md`](SIDEBAR-PARITY.md) · [`AUTH-LOGIN-PARITY.md`](AUTH-LOGIN-PARITY.md) ·
[`AUTH-REGISTER-PARITY.md`](AUTH-REGISTER-PARITY.md) · [`N-VISUAL-PARITY.md`](N-VISUAL-PARITY.md) ·
[`O-LOCALE-PARITY.md`](O-LOCALE-PARITY.md) · `element-final.json` · `nearmiss-curated.json` · `paired-styles.json` · `routes-v4/`

### The five v4 findings that matter

1. **Native loads no fonts at all.** `expo-font` is not installed, there is no `useFonts`/`loadAsync`, and there are **zero font files** — yet `locale-context.tsx:111` asks for `"Inter"`. Every text element on all 64 routes renders in the platform system face. And `"Inter"` is not the web's family either (body is **Plus Jakarta Sans**). Invisible to any token comparison.
2. **No background artwork exists in the native bundle.** 56 web image assets vs **5** native, all icons. That single fact causes the missing sidebar background, the missing login background and the missing register background.
3. **The nav palette exists in native and the shell ignores it.** All 7 `theme.color.nav.*` tokens carry values byte-identical to the web's `--nav-*`; `shell.tsx` uses none of them, so a dark-artwork-with-light-ink sidebar renders as white-with-dark-ink.
4. **Native registration offers no Google or Apple sign-up** — `register.tsx` never imports `useOAuth`, though `auth.tsx` does.
5. **52% of the PWA's user-visible copy has no native equivalent** — 2,275 `CONTENT_ABSENT` across 1,879 distinct locations. And **4 of 7 advertised locales** (`fr`, `es`, `tr`, `ru`) return English for all 42 keys.

### The 3,820 "unresolved elements" were largely an instrument artifact

Three more extractor defects were found and fixed (9 in total across the audit):
whole-file attribution charging a route with every export of a multi-export module
(`HiddenFeaturePanels` exports 9 panels mounted on 9 different hosts); `natHasRole`
derived from labelled elements only (**496 false** "role absent" rows); and Windows
backslash paths defeating every path rule (`NOT_APPLICABLE_*` returned **0**).

**Two automated pairing rules were tried and rejected** because both blessed
coincidences — `"Clear Session"`↔`"Capture Session"` and `"Legal holds"`↔`"Legal notes"`
(different features). All 177 near-miss locations were read individually instead:
**19 genuine counterparts, 158 coincidental**.

**Status: AUDIT IN PROGRESS — NOT COMPLETE.** Five items remain open
(`CONTINUATION-MANIFEST.md` §V4.5). Nothing was rendered; proven parity is not established.
