# D — PER-PAGE COMPARISON: `/home`, and the method it establishes

**Frozen revision:** `71e148f34410c7c231f8930d1387d8924b10b4e5`

`/home` is audited first and in full because it is the screen the user sees at
launch and the one behind the report of *"incorrect or missing information."*
It also demonstrates why the two mechanical measures in circulation are both
wrong, in opposite directions.

---

## D.1 The measurement problem, shown on one route

| Measure of `/home` | Value | What it implies |
|---|---:|---|
| Native ledger status (`native-destinations.mjs`) | `CODE_PARITY` | nothing missing |
| Element-count ratio (prior audit) | 104 / 1,478 = **7%** | almost nothing present |
| Handler ratio (prior audit) | 14 / 108 = **13%** | almost nothing present |
| Pairable elements paired | **4 of 205** | almost nothing present |
| **Module-level reading (this audit)** | **10 of 16 modules present** | substantial, with named holes |

The ledger is wrong because it is a hand-maintained claim. The element ratio is
wrong because React Native composes one `ProovraListRow` where the web nests a
dozen `div`s, and because label-based pairing fails whenever the two platforms
word the same control differently. **Neither number is reported here as the
answer.** The module reading below is, and it is traceable.

---

## D.2 What the applicable audience actually gets

`app/(app)/home/page.tsx:83-107` forks on `resolveHomeSurface`. For every
resolved non-enterprise user the surface is `SelfServeHomeDashboard`
(`components/home-experience/SelfServeHomeDashboard.tsx`, 281 lines), which
composes `HomeSections.tsx` (1,865) and `HomeDashboardSections.tsx` (1,428).

`CommandCenter` is **enterprise/platform-admin only** and is out of scope
(see `C-DESIGN-SYSTEM-AND-SHELL.md` §C.5).

The web groups its modules behind a segmented control,
`HOME_TABS = Overview | Operations | Analytics`
(`SelfServeHomeDashboard.tsx:265-270`).

---

## D.3 Module-by-module correspondence

| # | Web module (`SelfServeHomeDashboard.tsx`) | Web tab | Native counterpart | Verdict |
|---|---|---|---|---|
| 1 | `HomeHeader hero={vm.heroAction}` `:109` | Overview | — | **MISSING IN NATIVE** |
| 2 | `ExecutiveSummaryBand` `:141` | Overview | summary card, `(tabs)/index.tsx:289-301` (state badge + sentence + Capture CTA) | **PAIRED** |
| 3 | `KpiRow kpis={vm.kpis}` `:145` | Overview | `buildHomeKpis` → 5 KPIs, `src/product/home-dashboard.ts:86` | **PAIRED** (identity checked, D.4) |
| 4 | `WorkspaceHealthCard` `:181` | Overview | `ProovraSection "Workspace health"`, `src/ui/home-operations-sections.tsx:56` | **PAIRED** |
| 5 | `GettingStartedChecklist` `:186` | Overview | — (`"Getting started"` absent from the native tree) | **MISSING IN NATIVE** |
| 6 | `WorkspacePrioritiesCard` `:191` | Overview | `ProovraSection "What needs you now"`, `index.tsx:340` | **PAIRED, COPY DIFFERS** |
| 7 | `RecentEvidenceCard` `:197` | Overview | `ProovraSection t("recentEvidence")`, `index.tsx:363` | **PAIRED** |
| 8 | `ActiveMatters` `:198` | Overview | `ProovraSection "Active matters"`, `index.tsx:401` | **PAIRED** |
| 9 | `VerificationHealthCard` `:217` | Operations | — | **MISSING IN NATIVE** (reduced to the `trust` KPI) |
| 10 | `TrustStateCard` `:218` | Operations | — (`trustState` absent from the native tree) | **MISSING IN NATIVE** |
| 11 | `ReportProductionCard` `:221` | Operations | — (`reportProduction` absent) | **MISSING IN NATIVE** (reduced to the `deliverables` KPI) |
| 12 | `IntakePipelineCard` `:222` | Operations | — (`intakePipeline` absent) | **MISSING IN NATIVE** (reduced to the `intake` KPI) |
| 13 | `EvidenceTypeDonutCard` `:244` | Analytics | `ProovraSection "Records by type"`, `home-operations-sections.tsx:86` | **PAIRED, VALID PLATFORM ADAPTATION** (donut → list) |
| 14 | `EvidenceActivityChart` `:248` | Analytics | `ProovraSection "Recent activity"`, `:134` | **PAIRED** |
| 15 | `ActivityFeed groups={vm.activity}` `:251` | Analytics | `ProovraSection "What happened"`, `:182` | **PAIRED, COPY DIFFERS** |
| 16 | `TeamWorkCard` `:256` (conditional) | — | — (`TeamWork` absent) | **MISSING IN NATIVE** |
| — | storage (web: `SidebarStorageWidget` / health) | shell | `ProovraSection "Storage"`, `index.tsx:423` | **PAIRED, PLACEMENT DIFFERS** |
| — | — | — | search bar card, `index.tsx:277-287` | **NATIVE-ONLY** — compensating for the absent global search (V2-005); correct given the constraint |

**Totals: 10 paired (3 with copy or placement differences), 6 missing, 1 native-only.**

### Verification method for every "MISSING" row
Each was tested by searching the **entire** native tree
(`apps/mobile/app`, `apps/mobile/src`, `apps/mobile/modules`) case-insensitively
for the module's distinguishing identifier *and* its rendered copy. All six
return no match anywhere — so these are genuine absences, not placement
differences.

---

## D.4 KPI identity — checked, not assumed

Native `buildHomeKpis` (`src/product/home-dashboard.ts:86-170`) emits exactly 5:

| key | label | destination |
|---|---|---|
| `evidence` | "Total evidence" | `/evidence` |
| `matters` | "Active matters" | `/cases` |
| `trust` | "End-to-end ready" | — |
| `deliverables` | (reports) | — |
| `intake` | (intake links) | — |

The tone logic is deliberately conservative: *"Honest tone: only a real,
complete posture reads as verified"* (`:127`), and every value falls back to
`"Not available"` rather than `0` when the source read fails. That is a
**better** honesty posture than a naive port would give, and is recorded as such.

The web's KPI row is built in `HomeSections.tsx`; a value-by-value comparison of
the two KPI sets against the same envelope is **NOT** performed by this audit and
is listed as an open item in `F-COVERAGE-LEDGER.md` §4.

---

## D.5 The tab collapse is a documented, valid platform adaptation

The web hides modules 9-15 behind `Operations` / `Analytics` tabs. Native renders
everything in one scroll. The native source states the reason at
`app/(tabs)/index.tsx:432-438`:

> "The web keeps these behind a segmented control because Overview would
> otherwise carry eleven modules on one desktop page. A phone scrolls, and hiding
> the health matrix behind a tap on the surface whose job is to say whether
> anything is wrong would be the wrong trade. The content is the web's; the
> arrangement is the responsive adaptation."

**Classified VALID PLATFORM ADAPTATION with cited rationale.** Note the claim
"the content is the web's" is **only partly true** at the frozen revision —
modules 9-12 and 16 are not present in any arrangement (D.3).

---

## D.6 What this route says about the user's report

*"Incorrect or missing information across multiple screens"* is consistent with
D.3 on Home specifically: six modules absent, including the entire
**Verification & production** band (verification health, trust state, report
production, intake pipeline). A user who reads Home on the web and then on the
iPad sees four fewer cards in that band, each reduced to a single number in the
KPI row — or to nothing.

It is **not** explained by a bad workspace id: native reads `activeSpace.id`
correctly (see V2-006), and every KPI degrades to `"Not available"` rather than
to a wrong number.

---

## D.7 Status of the other 62 applicable routes

This register contains **one** route at full module-level depth. The remaining 62
carry the prior audit's element-level comparison (`pages/*.md`, re-read and
re-adjudicated in `adjudication.json`) plus the corrections in
`J-RE-ADJUDICATION.md` — which is a **lower** evidentiary tier than D.3.

That difference is declared, not blurred. See `F-COVERAGE-LEDGER.md` §2 for the
exact per-route tier.
