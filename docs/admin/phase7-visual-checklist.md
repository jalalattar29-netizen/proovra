# Phase 7 — per-page visual checklist

<!--
  GENERATED. Do not edit by hand.
    node scripts/admin-ledger/visual-checklist.mjs

  Every column except `pattern`, `changed` and `disposition` is read
  from a capture artifact. Those three come from the INSPECTED map in
  the generator, which is the one claim no artifact can make on a
  person's behalf.
-->

## Coverage

```text
total pages                        = 47
desktop screenshot present         = 47
mobile screenshot present          = 47
responsive swept (7 widths + zoom) = 47
RTL verified                       = 47
exactly one H1                     = 46
composition individually reviewed  = 9
swept but not composition-reviewed = 38
```

> **38 of 47 pages carry `SWEEP_VERIFIED_COMPOSITION_NOT_REVIEWED`.**
> That is not one of the three dispositions §15 permits, and it is printed
> deliberately: those pages have had their tokens, contrast, target sizes,
> text floor, empty states, RTL and responsive behaviour verified by
> instrument across every required width, and they have NOT had a person
> decide, card by card, whether each one earns its place. Phase 7 is not
> complete until that number is 0.

## A. Admin Overview

**The operator's question:** Is anything critical, what needs me, what changed, where do I go?

| route | screens | cards | 1-val | tables | tabs | H1 | desktop | mobile | responsive | RTL | disposition |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `/admin` | 3.7 | 19 | 9 | 0 | no in-page tabs (secondary nav is links) | 1 | 457 KB | 381 KB | 7w+z200, no overflow | rtl, no overflow | REDESIGNED_AND_VISUALLY_VERIFIED |

### What was recomposed, and onto what

- **`/admin`** — *verdict banner -> attention list -> summary -> estate -> commercial -> evidence -> security -> traffic*
  - verdict promoted from the 4th block of section 1 to the page's first element; attention list moved above the summary; Customers+Workspaces+People (3 sections, 19 tiles) collapsed to 4 condition tiles + 1 fact card; MRR/ARR/storage folded into a Recurring revenue card; Traffic demoted from 3 tiles to a fact row naming /admin/dashboard; evidence grid 5+1 -> 3+3

## B. Customers and Organizations

**The operator's question:** What is owed, paid, and at risk?

| route | screens | cards | 1-val | tables | tabs | H1 | desktop | mobile | responsive | RTL | disposition |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `/admin/billing` | 3.1 | 26 | 4 | 5 | no in-page tabs (secondary nav is links) | 1 | 372 KB | 268 KB | 7w+z200, no overflow | rtl, no overflow | SWEEP_VERIFIED_COMPOSITION_NOT_REVIEWED |
| `/admin/contact-sales` | 1 | 2 | 0 | 1 | no in-page tabs (secondary nav is links) | 1 | 163 KB | 72 KB | 7w+z200, no overflow | rtl, no overflow | SWEEP_VERIFIED_COMPOSITION_NOT_REVIEWED |
| `/admin/contact-sales/:id` | 1.5 | 2 | 1 | 0 | no in-page tabs (secondary nav is links) | 1 | 199 KB | 122 KB | 7w+z200, no overflow | rtl, no overflow | SWEEP_VERIFIED_COMPOSITION_NOT_REVIEWED |
| `/admin/customers` | 1 | 1 | 0 | 1 | no in-page tabs (secondary nav is links) | 1 | 180 KB | 79 KB | 7w+z200, no overflow | rtl, no overflow | SWEEP_VERIFIED_COMPOSITION_NOT_REVIEWED |
| `/admin/customers/:id` | 3.3 | 11 | 0 | 1 | no in-page tabs (secondary nav is links) | 1 | 396 KB | 341 KB | 7w+z200, no overflow | rtl, no overflow | SWEEP_VERIFIED_COMPOSITION_NOT_REVIEWED |
| `/admin/demo-requests` | 1.3 | 6 | 0 | 0 | no in-page tabs (secondary nav is links) | 1 | 214 KB | 144 KB | 7w+z200, no overflow | rtl, no overflow | SWEEP_VERIFIED_COMPOSITION_NOT_REVIEWED |
| `/admin/demo-requests/:id` | 2.1 | 10 | 1 | 0 | no in-page tabs (secondary nav is links) | 1 | 225 KB | 148 KB | 7w+z200, no overflow | rtl, no overflow | SWEEP_VERIFIED_COMPOSITION_NOT_REVIEWED |
| `/admin/provisioning` | 2.1 | 6 | 0 | 0 | no in-page tabs (secondary nav is links) | 1 | 296 KB | 211 KB | 7w+z200, no overflow | rtl, no overflow | SWEEP_VERIFIED_COMPOSITION_NOT_REVIEWED |
| `/admin/users` | 1.6 | 5 | 0 | 2 | no in-page tabs (secondary nav is links) | 1 | 255 KB | 144 KB | 7w+z200, no overflow | rtl, no overflow | SWEEP_VERIFIED_COMPOSITION_NOT_REVIEWED |
| `/admin/users/:id` | 1.9 | 9 | 0 | 2 | no in-page tabs (secondary nav is links) | 1 | 238 KB | 146 KB | 7w+z200, no overflow | rtl, no overflow | SWEEP_VERIFIED_COMPOSITION_NOT_REVIEWED |
| `/admin/workspaces` | 1.2 | 2 | 0 | 1 | no in-page tabs (secondary nav is links) | 1 | 220 KB | 101 KB | 7w+z200, no overflow | rtl, no overflow | SWEEP_VERIFIED_COMPOSITION_NOT_REVIEWED |
| `/admin/workspaces/:id` | 2 | 11 | 3 | 1 | no in-page tabs (secondary nav is links) | 1 | 263 KB | 187 KB | 7w+z200, no overflow | rtl, no overflow | SWEEP_VERIFIED_COMPOSITION_NOT_REVIEWED |

## C. Evidence Operations

**The operator's question:** Which evidence needs attention?

| route | screens | cards | 1-val | tables | tabs | H1 | desktop | mobile | responsive | RTL | disposition |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `/admin/evidence-ops` | 3.8 | 29 | 4 | 0 | no in-page tabs (secondary nav is links) | 1 | 568 KB | 469 KB | 7w+z200, no overflow | rtl, no overflow | REDESIGNED_AND_VISUALLY_VERIFIED |
| `/admin/evidence-ops/records` | 1.2 | 2 | 0 | 1 | no in-page tabs (secondary nav is links) | 1 | 246 KB | 87 KB | 7w+z200, no overflow | rtl, no overflow | REDESIGNED_AND_VISUALLY_VERIFIED |
| `/admin/platform/exports` | 1 | 3 | 0 | 0 | no in-page tabs (secondary nav is links) | 1 | 163 KB | 78 KB | 7w+z200, no overflow | rtl, no overflow | SWEEP_VERIFIED_COMPOSITION_NOT_REVIEWED |
| `/admin/platform/media-graph` | 2.2 | 32 | 0 | 0 | no in-page tabs (secondary nav is links) | 1 | 335 KB | 260 KB | 7w+z200, no overflow | rtl, no overflow | SWEEP_VERIFIED_COMPOSITION_NOT_REVIEWED |
| `/admin/platform/recovery` | 1.3 | 4 | 0 | 0 | no in-page tabs (secondary nav is links) | 1 | 190 KB | 103 KB | 7w+z200, no overflow | rtl, no overflow | SWEEP_VERIFIED_COMPOSITION_NOT_REVIEWED |
| `/admin/platform/signers` | 1.2 | 6 | 0 | 0 | no in-page tabs (secondary nav is links) | 1 | 174 KB | 102 KB | 7w+z200, no overflow | rtl, no overflow | SWEEP_VERIFIED_COMPOSITION_NOT_REVIEWED |

### What was recomposed, and onto what

- **`/admin/evidence-ops`** — *cohort row (3 cols) -> uploads -> evidence -> reports -> timestamping -> incidents -> queue health*
  - cohort grid 5 cols -> 3 (cards 340-730px -> 295-337px); the duplicated 80-word reason moved behind a <details> disclosure
- **`/admin/evidence-ops/records`** — *filters -> cohort statement -> table with expandable detail -> pager*
  - the Required action column carried the decision AND two paragraphs in 244px, off the end of the container's scroll; decision stays on the row, narrative moves to expandable detail; record UUID -> AdmId (truncated + copy); preservation badges nowrap. Rows 385px -> 77px

## D. Identity and Access

**The operator's question:** Who has access and what is failing?

| route | screens | cards | 1-val | tables | tabs | H1 | desktop | mobile | responsive | RTL | disposition |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `/admin/identity` | 3.2 | 22 | 0 | 3 | no in-page tabs (secondary nav is links) | 1 | 548 KB | 415 KB | 7w+z200, no overflow | rtl, no overflow | SWEEP_VERIFIED_COMPOSITION_NOT_REVIEWED |
| `/admin/identity/access-reviews` | 1.2 | 5 | 0 | 1 | no in-page tabs (secondary nav is links) | 1 | 200 KB | 99 KB | 7w+z200, no overflow | rtl, no overflow | SWEEP_VERIFIED_COMPOSITION_NOT_REVIEWED |
| `/admin/identity/permission-matrix` | 1.7 | 9 | 0 | 0 | no in-page tabs (secondary nav is links) | 1 | 244 KB | 158 KB | 7w+z200, no overflow | rtl, no overflow | SWEEP_VERIFIED_COMPOSITION_NOT_REVIEWED |
| `/admin/identity/providers` | 1.2 | 5 | 0 | 0 | no in-page tabs (secondary nav is links) | 1 | 226 KB | 154 KB | 7w+z200, no overflow | rtl, no overflow | SWEEP_VERIFIED_COMPOSITION_NOT_REVIEWED |
| `/admin/identity/runtime` | 1.4 | 5 | 0 | 2 | no in-page tabs (secondary nav is links) | 1 | 227 KB | 123 KB | 7w+z200, no overflow | rtl, no overflow | SWEEP_VERIFIED_COMPOSITION_NOT_REVIEWED |
| `/admin/identity/scim` | 1 | 4 | 0 | 1 | 4 tabs, all opened (tabs.json) | 1 | 189 KB | 87 KB | 7w+z200, no overflow | rtl, no overflow | REDESIGNED_AND_VISUALLY_VERIFIED |
| `/admin/identity/sessions` | 2.6 | 12 | 0 | 4 | no in-page tabs (secondary nav is links) | 1 | 361 KB | 228 KB | 7w+z200, no overflow | rtl, no overflow | SWEEP_VERIFIED_COMPOSITION_NOT_REVIEWED |
| `/admin/identity/timeline` | 1 | 0 | 0 | 0 | no in-page tabs (secondary nav is links) | 0 | 6 KB | 72 KB | 7w+z200, no overflow | rtl, no overflow | SWEEP_VERIFIED_COMPOSITION_NOT_REVIEWED |

### What was recomposed, and onto what

- **`/admin/identity/scim`** — *URL-addressable tablist -> tab panels*
  - the console's only real tablist: state moved to ?tab=, adopted AdmTabs/AdmTabPanel for arrow keys + roving tabindex + tabpanel semantics; all 4 tabs opened and verified

## E. Security and Support

**The operator's question:** What is firing and does anybody own it?

| route | screens | cards | 1-val | tables | tabs | H1 | desktop | mobile | responsive | RTL | disposition |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `/admin/alerts` | 3.9 | 26 | 0 | 0 | no in-page tabs (secondary nav is links) | 1 | 469 KB | 369 KB | 7w+z200, no overflow | rtl, no overflow | SWEEP_VERIFIED_COMPOSITION_NOT_REVIEWED |
| `/admin/audit` | 2.4 | 11 | 0 | 1 | no in-page tabs (secondary nav is links) | 1 | 427 KB | 300 KB | 7w+z200, no overflow | rtl, no overflow | SWEEP_VERIFIED_COMPOSITION_NOT_REVIEWED |
| `/admin/security` | 3.9 | 17 | 1 | 4 | no in-page tabs (secondary nav is links) | 1 | 454 KB | 367 KB | 7w+z200, no overflow | rtl, no overflow | SWEEP_VERIFIED_COMPOSITION_NOT_REVIEWED |
| `/admin/support-access` | 1.9 | 7 | 0 | 2 | no in-page tabs (secondary nav is links) | 1 | 276 KB | 174 KB | 7w+z200, no overflow | rtl, no overflow | SWEEP_VERIFIED_COMPOSITION_NOT_REVIEWED |
| `/admin/timeline` | 2.3 | 1 | 0 | 1 | no in-page tabs (secondary nav is links) | 1 | 458 KB | 219 KB | 7w+z200, no overflow | rtl, no overflow | SWEEP_VERIFIED_COMPOSITION_NOT_REVIEWED |

## F. Platform Operations

**The operator's question:** What is this costing and where?

| route | screens | cards | 1-val | tables | tabs | H1 | desktop | mobile | responsive | RTL | disposition |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `/admin/costs` | 2.2 | 18 | 3 | 3 | no in-page tabs (secondary nav is links) | 1 | 377 KB | 288 KB | 7w+z200, no overflow | rtl, no overflow | SWEEP_VERIFIED_COMPOSITION_NOT_REVIEWED |
| `/admin/operations` | 3.7 | 8 | 4 | 2 | no in-page tabs (secondary nav is links) | 1 | 683 KB | 343 KB | 7w+z200, no overflow | rtl, no overflow | SWEEP_VERIFIED_COMPOSITION_NOT_REVIEWED |
| `/admin/platform-health` | 2.7 | 31 | 7 | 0 | no in-page tabs (secondary nav is links) | 1 | 499 KB | 462 KB | 7w+z200, no overflow | rtl, no overflow | REDESIGNED_AND_VISUALLY_VERIFIED |
| `/admin/platform/automation` | 1.7 | 5 | 0 | 0 | no in-page tabs (secondary nav is links) | 1 | 219 KB | 121 KB | 7w+z200, no overflow | rtl, no overflow | SWEEP_VERIFIED_COMPOSITION_NOT_REVIEWED |
| `/admin/platform/observability` | 3.2 | 6 | 0 | 12 | no in-page tabs (secondary nav is links) | 1 | 384 KB | 326 KB | 7w+z200, no overflow | rtl, no overflow | SWEEP_VERIFIED_COMPOSITION_NOT_REVIEWED |
| `/admin/platform/queues` | 1.9 | 3 | 0 | 1 | no in-page tabs (secondary nav is links) | 1 | 303 KB | 223 KB | 7w+z200, no overflow | rtl, no overflow | SWEEP_VERIFIED_COMPOSITION_NOT_REVIEWED |
| `/admin/platform/readiness` | 2.7 | 6 | 0 | 0 | no in-page tabs (secondary nav is links) | 1 | 373 KB | 291 KB | 7w+z200, no overflow | rtl, no overflow | SWEEP_VERIFIED_COMPOSITION_NOT_REVIEWED |
| `/admin/platform/reliability` | 1.5 | 10 | 0 | 0 | no in-page tabs (secondary nav is links) | 1 | 237 KB | 147 KB | 7w+z200, no overflow | rtl, no overflow | SWEEP_VERIFIED_COMPOSITION_NOT_REVIEWED |
| `/admin/search` | 1 | 2 | 0 | 0 | no in-page tabs (secondary nav is links) | 1 | 145 KB | 65 KB | 7w+z200, no overflow | rtl, no overflow | SWEEP_VERIFIED_COMPOSITION_NOT_REVIEWED |

### What was recomposed, and onto what

- **`/admin/platform-health`** — *verdict -> needs attention -> now -> measured healthy -> not measured*
  - 24 equal cards partitioned into attention/probed/unprobed with the verdict derived from the rows; 16 unprobed cards -> 1 fact list; Now grid 5+2 -> 4+3

## G. Runbooks

**The operator's question:** Which procedure applies, and what exactly do I do?

| route | screens | cards | 1-val | tables | tabs | H1 | desktop | mobile | responsive | RTL | disposition |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `/admin/platform/runbooks` | 4.2 | 33 | 0 | 0 | no in-page tabs (secondary nav is links) | 1 | 628 KB | 608 KB | 7w+z200, no overflow | rtl, no overflow | REDESIGNED_AND_VISUALLY_VERIFIED |
| `/admin/platform/runbooks/:slug` | 3.8 | 0 | 0 | 0 | no in-page tabs (secondary nav is links) | 1 | 614 KB | 547 KB | 7w+z200, no overflow | rtl, no overflow | REDESIGNED_AND_VISUALLY_VERIFIED |

### What was recomposed, and onto what

- **`/admin/platform/runbooks`** — *searchable catalog rail + reader*
  - catalog gained a filter over title/slug/summary/subsystems with a truthful count and a distinct filtered-empty state
- **`/admin/platform/runbooks/:slug`** — *searchable catalog rail + 36em reading column*
  - 394 list items across 21 runbooks were split mid-sentence by the renderer (hard-wrap continuation lines fell through to the paragraph branch); bullets were absent entirely (flex children are not list items, and the reset's list-style:none was never overridden); reading column measured 124 chars and now measures ~72 (ch resolved against the wrong font size AND ch is 0.73em in this family); the docs/runbooks/*.md source path removed; fences gained a language label and a copy control

## H. Business Insight

**The operator's question:** Which capabilities are actually adopted?

| route | screens | cards | 1-val | tables | tabs | H1 | desktop | mobile | responsive | RTL | disposition |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `/admin/adoption` | 2 | 1 | 0 | 1 | no in-page tabs (secondary nav is links) | 1 | 316 KB | 204 KB | 7w+z200, no overflow | rtl, no overflow | SWEEP_VERIFIED_COMPOSITION_NOT_REVIEWED |
| `/admin/dashboard` | 2.6 | 36 | 6 | 1 | 3-option window control, verified | 1 | 337 KB | 277 KB | 7w+z200, no overflow | rtl, no overflow | REDESIGNED_AND_VISUALLY_VERIFIED |
| `/admin/executive` | 1.9 | 16 | 8 | 2 | no in-page tabs (secondary nav is links) | 1 | 285 KB | 221 KB | 7w+z200, no overflow | rtl, no overflow | REDESIGNED_AND_VISUALLY_VERIFIED |
| `/admin/platform/analytics` | 2.8 | 35 | 0 | 0 | 3-option window control, verified | 1 | 368 KB | 342 KB | 7w+z200, no overflow | rtl, no overflow | SWEEP_VERIFIED_COMPOSITION_NOT_REVIEWED |

### What was recomposed, and onto what

- **`/admin/dashboard`** — *window control -> KPI row -> geography -> traffic+funnel -> signals -> distributions -> activity*
  - MetricTile rebuilt on AdmKpi (10 tiles now uniform 163px, values on one line per row, was 7 distinct tops); the #1e3a5f navy accent removed from 8 of 11 tiles; 4 empty states 120-330px -> 56px; NotConnectedCard (Card+EmptyState, ~190px each) -> 56px inline rows; 3 content grids stop stretching
- **`/admin/executive`** — *top-line KPIs -> usage -> not-measured fact list -> top customers -> at-risk*
  - 'Not measured' 30px/750 -> 15px muted (6 of 16 tiles were non-values); Failed operations no longer red at zero; the 4-tile not-measured section -> 1 fact card

## Tab surface

A grep of the admin tree for `role="tab"` returns ONE page. Every other
section switches view through the console's secondary navigation row, which
is real links with real URLs — which is what §10 asks for. Two pages carry a
time-window segmented control. That is the complete surface, and all six were
opened.

```text
/admin/identity/scim tab=tokens     selected="Tokens" one-selected=true url=/admin/identity/scim overflow=0 mobileOverflow=0
/admin/identity/scim tab=ownership  selected="Managed membership" one-selected=true url=/admin/identity/scim?tab=ownership overflow=0 mobileOverflow=0
/admin/identity/scim tab=drift      selected="Drift detection" one-selected=true url=/admin/identity/scim?tab=drift overflow=0 mobileOverflow=0
/admin/identity/scim tab=replay     selected="Sync replay" one-selected=true url=/admin/identity/scim?tab=replay overflow=0 mobileOverflow=0
  ArrowRight -> "Managed membership"  reload -> "Managed membership"
/admin/dashboard window options=["24 hours","7 days","30 days"] targets=["85x44","71x44","81x44"]
/admin/platform/analytics window options=[] targets=[]
```
