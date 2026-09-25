# CONTINUATION MANIFEST

**Frozen SHA:** `71e148f34410c7c231f8930d1387d8924b10b4e5` · branch `main` · tree clean
**Status:** **AUDIT IN PROGRESS — NOT COMPLETE**
**Verified at session start:** HEAD unchanged from the previous pass; `git diff 71e148f34..HEAD -- apps/web apps/mobile packages services` empty. All prior evidence valid, nothing revalidated for drift.

---

## 1. What is finished

| Dimension | State |
|---|---|
| Applicable route inventory (64 rows: 63 + 1 borderline) | **COMPLETE** — `routes.json` |
| Both entry points resolved per route | **COMPLETE** — 0 missing web entries |
| Recursive component tree, both platforms, **0 unresolved imports** | **COMPLETE** — `03-deep-extract.mjs` |
| Native counterpart **sets** (nav-graph widened) | **COMPLETE** — `native-counterparts.json` |
| Per-route register L1–L8 | **COMPLETE** — 64 files in `routes/` |
| Unpaired-element adjudication | **COMPLETE** — **5,699 of 5,699**, no sampling cap, `routes-raw/*.adjudicated.json` |
| Absent-control adjudication (individually read) | **COMPLETE** — 63 distinct, `M-ABSENT-CONTROLS.md` |
| Handler trace ledger | **COMPLETE** — 2,200 distinct bindings, `L-HANDLER-LEDGER.md` |
| Cross-screen data-flow matrix | **COMPLETE** — `K-DATA-FLOW-MATRIX.md` |
| Style resolution, both platforms, to literals | **COMPLETE** — `05-style-index.mjs` |
| UC-1…UC-6 disposition | **COMPLETE from the prior pass** — `G-UC-MATRIX.md`; **UC-1/2/4 not independently re-exercised** (see §2) |
| Historical finding reconciliation | **COMPLETE** — `J-RE-ADJUDICATION.md` |

## 2. What remains — the exact continuation queue, in order

### Q1 · `COPY_OR_COMPOSITION_DIFF` — **3,820 occurrences** (the largest open item)
The native screen carries elements of the role but not that literal. Source
cannot separate "control missing" from "same control, different words".
**Method that works:** the per-element reading in `M-ABSENT-CONTROLS.md` §M.3,
which converted 39 undecided SELECTs into 4 valid adaptations + 35 confirmed
absences.
**Resume point:** `routes-raw/*.adjudicated.json`, filter
`verdict === "COPY_OR_COMPOSITION_DIFF"`, process routes in descending
`missing` order: `/evidence/[id]` (702) → `/home` (572) → `/cases/[id]` (488) →
`/settings` (347) → `/teams/[id]` (249).

### Q2 · Per-element style comparison
`05-style-index.mjs` resolves both sides to literals and the registers carry
per-route totals (**1,600 PWA-only colour uses**, 43 routes with colour). What is
**not** done: pairing a specific web element's resolved value against its
specific native counterpart's value. Blocked on Q1 — you cannot compare the style
of two elements until you know they are the same element.

### Q3 · Which CSS declaration wins — **UNRESOLVABLE BY CONSTRUCTION**
Cascade, specificity and conditional class application are runtime facts. The
registers record the **competing rules** per route instead of asserting a winner.
Close only with rendered evidence; do not close by assertion.

### Q4 · 5,430 web classes with no matching CSS rule · 750 runtime-built `className`
Each needs either a rule source or an explicit UNRESOLVED disposition.

### Q5 · 181 unresolved handler bindings
Dominated by prop callbacks the static graph cannot bind. Each is listed with its
stopping point in `handler-ledger.json`. Closing them needs either an explicit
call-site enumeration or runtime evidence.

### Q6 · UC-1, UC-2, UC-4 independent re-verification
`G-UC-MATRIX.md` carries these as UPHELD **without** independent exercise. UC-3
and UC-5 were investigated and their `CODE: COMPLETE` claims contradicted.

### Q7 · Locale comparison
Native ships `src/i18n.ts` + `locale-context.tsx`; no locale-by-locale comparison
against the web's strings was performed.

### Q8 · Runtime-only items
Every `C` item in `K-DATA-FLOW-MATRIX.md` §K.5 and `E-ROOT-CAUSE-REGISTER.md`
(V2-001 above all). **Minimal safe diagnostics are named there.** No secret, token
or header is required by any of them.

## 3. Instruments — re-runnable, read-only, in dependency order

```bash
node docs/audit/pwa-native-2026-09-24-v2/01-reclassify-routes.mjs
node docs/audit/pwa-native-2026-09-24-v2/04-route-map.mjs
node docs/audit/pwa-native-2026-09-24-v2/08-nav-graph.mjs
node docs/audit/pwa-native-2026-09-24-v2/06-compare.mjs
node docs/audit/pwa-native-2026-09-24-v2/07-adjudicate-routes.mjs
node docs/audit/pwa-native-2026-09-24-v2/09-handler-ledger.mjs
```

`05-style-index.mjs` and `03-deep-extract.mjs` are libraries used by the above
and also runnable standalone for a probe.

> Windows note: `06-compare.mjs --only /route` needs `MSYS_NO_PATHCONV=1` under
> Git Bash, which otherwise rewrites `/home` into a Windows path.

## 4. Instrument defects found and fixed during this pass — do not reintroduce

| Defect | Effect if reintroduced | Fix |
|---|---|---|
| `./foo.js` ESM specifiers unresolved | 183 unresolved imports on `/home` alone; the whole `packages/shared` layer silently dropped | `tryFile` strips `.js`/`.jsx`/`.mjs` and retries the `.ts` source |
| Native counterpart = one screen | web `/settings` (one page) compared against one native screen while **five siblings** implement the rest; reported the entire identity-security family as missing | `08-nav-graph.mjs` — counterpart is the entry **plus** nav-reachable screens not claimed by another audited route |
| `/v1/` bare counted as an endpoint | a phantom gap on 22 routes | filtered in `07-adjudicate-routes.mjs` |
| API gap not split app-wide vs per-screen | `switch-workspace` looked absent from the app; it is at `src/product/spaces.ts:47` | `NATIVE_APP_ENDPOINTS` split: `ABSENT_FROM_APP` vs `NOT_ON_THIS_SCREEN` |
| Primitive prop-forwards counted as untraced | would have inflated unresolved handlers by the whole design-system layer | `PROP_FORWARD` category |
| Windows path separators in the nav graph | 0 counterpart sets widened (silent) | normalise `join()` output to `/` |

## 5. Hypotheses raised and **falsified** during this pass — do not re-raise without new evidence

| Hypothesis | Why it failed |
|---|---|
| 18 native screens read data without workspace scoping | The **web** does not send `teamId` either; scope is server-derived on both sides. Verified on `/evidence`, `/billing`, `/notifications`, `/collaboration-teams` |
| The prior audit's CSS indexer missed half the stylesheets | An intermediate count of 58 was contaminated by `.next/` build output. Authored stylesheets are **30**, matching the prior audit |
| `TABLE "Actions"` is missing on 33 routes | One shared component (`DataTable.tsx:182`), and `patterns.tsx:23` documents the `ProovraDataList` mapping, whose row `trailing` slot is used in practice |

## 6. Honest status

**Source inspection is complete for structure, content correspondence, endpoints,
handlers and style *totals* on all 63 applicable routes + 1 borderline.**

**It is NOT complete for per-element style pairing (Q2), and 3,820 element
correspondences remain undecided (Q1).**

**No rendered evidence exists. Nothing in this directory is a rendered claim.
Proven product parity is not established.**

---

# V4 PASS — appended 2026-09-24. Nothing above retracted.

## V4.1 What the v4 pass closed

| Item | v3 state | **v4 state** |
|---|---|---|
| `COPY_OR_COMPOSITION_DIFF` | **3,820 undecided** | **0** — the class was an artifact of exact-literal pairing. Replaced by scoped trees + 4-pass semantic pairing + a curated reading of every near-miss |
| Element verdicts | 5,699 items, 3,820 unresolved | **4,360 items, 0 unresolved (100% decided)** |
| Sidebar / Login / Register deep audits | not done | **done** — `SIDEBAR-PARITY.md`, `AUTH-LOGIN-PARITY.md`, `AUTH-REGISTER-PARITY.md` |
| Per-element visual comparison | totals only | **done to the level the codebases permit** — `N-VISUAL-PARITY.md` |
| Locale parity | not done | **done** — `O-LOCALE-PARITY.md` |

## V4.2 Final element adjudication (`element-final.json`)

| Verdict | Count | % |
|---|---:|---:|
| `CONTENT_ABSENT` | **2,275** | 52.2 |
| `PRESENT_ELSEWHERE_IN_APP` | 897 | 20.6 |
| `NOT_APPLICABLE_ENTERPRISE` | 462 | 10.6 |
| `MATCH_ROLE_DIFFERS` | 204 | 4.7 |
| `SUBSUMED_BY_MISSING_SCREEN` | 175 | 4.0 |
| `NOT_APPLICABLE_SHELL` | 145 | 3.3 |
| `MATCH_COPY_DIFFERS` | 83 | 1.9 |
| `ROLE_ABSENT_ON_SCREEN` | 58 | 1.3 |
| `MATCH_EXACT` | 47 | 1.1 |
| `EXTRACTOR_ARTIFACT` | 14 | 0.3 |
| **TOTAL** | **4,360** | **100** |

**The headline is `CONTENT_ABSENT` = 2,275 (52.2%).** These are web strings whose
literal appears nowhere in the native app, on a route whose native counterpart
does carry elements of that role. Roughly half the PWA's user-visible copy has no
native equivalent.

## V4.3 Three further instrument defects found and fixed (7–9)

| # | Defect | Effect | Fix |
|---|---|---|---|
| 7 | **Whole-file attribution.** A route importing ONE export of a multi-export module was charged with every export's elements. `HiddenFeaturePanels.tsx` exports 9 panels mounted on 9 different hosts, 3 of them Enterprise | 90 phantom elements on one route; 248 from enterprise-only `CommandCenter.tsx`; measured 71 files → 33 on `/evidence-requests/[id]` | `10-scoped-extract.mjs` — export-scoped crawl |
| 8 | **`natHasRole` from labelled elements only.** Native labels are largely `t()`/dynamic, so screens full of buttons reported "BUTTON role absent" | **496 false** `ROLE_ABSENT` rows → 240 → 58 after the scoped fix | derive the role set from **every** native element |
| 9 | **Windows backslash paths** from `resolve()` defeated every path-based rule | `NOT_APPLICABLE_SHELL` and `NOT_APPLICABLE_ENTERPRISE` both returned **0** | normalise to repo-relative POSIX in `extractScoped` |

## V4.4 Two automated pairing rules tried and REJECTED

Both blessed coincidences, so neither was used:

* **0.25 Jaccard threshold** — matched `"Clear Session"` to `"Capture Session"` (shared noun only).
* **"shares the longest significant token"** — matched `"Legal holds"` to `"Legal notes"`, which are *different product features* (a retention control vs reviewer annotations).

All **177** distinct near-miss locations were read individually instead
(`nearmiss-curated.json`): **19 genuine counterparts**, **158 coincidental**.

## V4.5 The remaining queue

### Q1 · ~~3,820 COPY_OR_COMPOSITION_DIFF~~ — **CLOSED**

### Q2 · Per-element style pairing — **CLOSED AS FAR AS SOURCE PERMITS**
Only **16 of 111** matched pairs carry a literal `className` on the web side and
**6** a literal `style` on the native side; the rest style through component
variants. The comparison was therefore done at the **primitive** level
(`N-VISUAL-PARITY.md` §N.4: button, card, input, geometry) — which is where both
codebases actually express styling. Further per-element pairing is not blocked by
effort; it is **not expressible** in this source.

### Q3 · Which CSS declaration wins — **UNRESOLVABLE BY CONSTRUCTION** (unchanged)

### Q4 · 5,430 unmatched classes — **DIAGNOSED, not closed**
`N-VISUAL-PARITY.md` §N.6 splits them into 4 groups (stock Tailwind, arbitrary-value
utilities, state/variant prefixes, genuinely absent). **None is a visual defect.**
Open: quantify group 4 by parsing arbitrary-value utilities.

### Q5 · 181 unresolved handler bindings — **unchanged**

### Q6 · UC-1, UC-2, UC-4 independent re-verification — **unchanged, still open**

### Q7 · Locale comparison — **CLOSED** (`O-LOCALE-PARITY.md`)

### Q8 · Runtime-only items — **unchanged**

### Q9 · NEW — 2,275 `CONTENT_ABSENT` strings
Decided (each has a verdict and source evidence) but **not yet grouped into
product requirements**. 1,879 distinct source locations; the largest shared
causes are `ProovraSupportReference.tsx` (33 routes), `PageRouteGate.tsx:98`
(25 routes), `LegalDocumentShell.tsx` (6), `ContextualHelp.tsx` (5).

## V4.6 Honest status after v4

**Every applicable route has a full L1–L8 register. Every one of the 4,360
element correspondences carries a verdict. Sidebar, Login and Register have
dedicated deep audits. Locale is closed. Per-element visual comparison is done to
the level the two codebases express.**

**Still open:** Q4 (group-4 quantification), Q5 (181 handlers), Q6 (UC-1/2/4),
Q8 (runtime-only), Q9 (grouping 2,275 absent strings into requirements).

**Nothing was rendered. Proven product parity is NOT established.**

---

# FINAL CLOSURE PASS — appended. Nothing above retracted.

## F.1 Queue disposition

| Q | State | Evidence |
|---|---|---|
| **Q4** CSS | **CLOSED** | 2,841 tokens: 94.2% resolved (CSS rule / TW arbitrary / TW stock / TW variant); residue split into 35 TSX-`<style>`, ~12 decoder gap, **~115 genuinely unstyled** (`q4-css-closure.json`, `q4-residue.json`, `q4-final.json`) |
| **Q5** handlers | **CLOSED to 84.5%** | 181 re-opened → 89 via call-site enumeration + 21 inline + 25 local closure + 16 prop-forward + 2 platform = **153**. **28 `HOOK_RETURNED_CALLABLE` remain = U-1** (`q5-closure-final.json`) |
| **Q6** UC | **CLOSED** | UC-1/2/4 independently re-audited and **upheld on their own evidence**; UC-3/UC-5 CODE **contradicted** |
| **Q9** content | **CLOSED** | 2,732 strings → 191 owning files (`q9-content-absent.json`); three mandated re-checks run (`q9-rechecks.json`) |

## F.2 The three mandated re-checks changed the numbers

| Re-check | Result |
|---|---|
| 897 `PRESENT_ELSEWHERE` | **371** mis-binned → promoted to `MATCH`; **69** one-hop reachable; **457 unreachable from the route that needs them** → promoted to `CONTENT_ABSENT` (RC-15) |
| 462 `NOT_APPLICABLE_ENTERPRISE` | **UPHELD** — 354 `command-center/*` (excluded by the `resolveHomeSurface` **branch**, not the path), 108 `workspace-admin/*` on ENTERPRISE routes |
| 145 `NOT_APPLICABLE_SHELL` | **132 upheld; 13 OVERTURNED** — `ForgotPasswordModal` posts to `/v1/auth/password-reset/request`; a product control that merely lives in `components/marketing/` |

## F.3 Three more instrument defects found (10–12)

| # | Defect | Effect |
|---|---|---|
| 10 | CSS index ignored **TSX `<style>` blocks** (17 files, 57 selectors) | 35 classes reported as unstyled that are styled |
| 11 | Handler prop-name taken as the first token | `busy ? undefined : onCancel` → prop name `"busy"`; every call site reported `PROP_NEVER_PASSED` |
| 12 | Call-site resolution had no **second hop** | every resolution returned an empty effect set — indistinguishable from "bound but does nothing" |

Running total across the audit: **12 instrument defects**, every one of which
*understated* or *mis-stated* the gap.

## F.4 Final deliverables

`FINAL-COVERAGE-LEDGER.md` · `FINAL-ROOT-CAUSE-REGISTER.md` (25 root causes) ·
`FINAL-PER-ROUTE-DEFECT-MATRIX.md` (64 rows) · `FINAL-IMPLEMENTATION-BACKLOG.md`
(23 tasks, dependency-ordered) · `FINAL-RUNTIME-VALIDATION-PLAN.md` (11 validations)
· `FINAL-EXECUTION-READINESS.md`

## F.5 Remaining work — the only open items

| # | Item | Count | Needs a device? |
|---|---|---:|---|
| **U-1** | `HOOK_RETURNED_CALLABLE` handlers — read ~6 hooks and map each returned key to its body | 28 | **no** — audit work |
| U-2 | Which CSS declaration wins | all | yes (rendered) |
| U-3 | Composed `className` strings | 108 | yes (rendered) |
| U-4 | `.app-shell-v2` background, 5 competing rules | 1 | yes (RV-08) |
| U-5 | Native font actually rendered | 1 | yes (RV-06) |
| U-6 | Runtime validations | 11 | yes |

**U-1 is the only outstanding source-inspection item. Everything else is runtime by construction.**

## F.6 Status

**SOURCE AUDIT COMPLETE** (U-1 excepted and named) · **PRODUCT PARITY NOT ESTABLISHED** ·
**PHYSICAL-DEVICE PARITY NOT ESTABLISHED AND NOT CLAIMED** ·
**GO for implementation (21 of 23 tasks) · NOT READY for launch (4 blockers).**
