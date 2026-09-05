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
composition individually reviewed  = 47
swept but not composition-reviewed = 0
```

> All pages carry a permitted disposition.

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
| `/admin/billing` | 3.1 | 26 | 4 | 5 | no in-page tabs (secondary nav is links) | 1 | 372 KB | 268 KB | 7w+z200, no overflow | rtl, no overflow | REDESIGNED_AND_VISUALLY_VERIFIED |
| `/admin/contact-sales` | 1 | 2 | 0 | 1 | no in-page tabs (secondary nav is links) | 1 | 163 KB | 72 KB | 7w+z200, no overflow | rtl, no overflow | REDESIGNED_AND_VISUALLY_VERIFIED |
| `/admin/contact-sales/:id` | 1.5 | 2 | 1 | 0 | no in-page tabs (secondary nav is links) | 1 | 199 KB | 122 KB | 7w+z200, no overflow | rtl, no overflow | REDESIGNED_AND_VISUALLY_VERIFIED |
| `/admin/customers` | 1 | 1 | 0 | 1 | no in-page tabs (secondary nav is links) | 1 | 180 KB | 79 KB | 7w+z200, no overflow | rtl, no overflow | REDESIGNED_AND_VISUALLY_VERIFIED |
| `/admin/customers/:id` | 3.3 | 11 | 0 | 1 | no in-page tabs (secondary nav is links) | 1 | 396 KB | 341 KB | 7w+z200, no overflow | rtl, no overflow | REDESIGNED_AND_VISUALLY_VERIFIED |
| `/admin/demo-requests` | 1.3 | 6 | 0 | 0 | no in-page tabs (secondary nav is links) | 1 | 214 KB | 144 KB | 7w+z200, no overflow | rtl, no overflow | REDESIGNED_AND_VISUALLY_VERIFIED |
| `/admin/demo-requests/:id` | 2.1 | 10 | 1 | 0 | no in-page tabs (secondary nav is links) | 1 | 225 KB | 148 KB | 7w+z200, no overflow | rtl, no overflow | REDESIGNED_AND_VISUALLY_VERIFIED |
| `/admin/provisioning` | 2.1 | 6 | 0 | 0 | no in-page tabs (secondary nav is links) | 1 | 296 KB | 211 KB | 7w+z200, no overflow | rtl, no overflow | ALREADY_COMPLIANT |
| `/admin/users` | 1.6 | 5 | 0 | 2 | no in-page tabs (secondary nav is links) | 1 | 255 KB | 144 KB | 7w+z200, no overflow | rtl, no overflow | REDESIGNED_AND_VISUALLY_VERIFIED |
| `/admin/users/:id` | 1.9 | 9 | 0 | 2 | no in-page tabs (secondary nav is links) | 1 | 238 KB | 146 KB | 7w+z200, no overflow | rtl, no overflow | REDESIGNED_AND_VISUALLY_VERIFIED |
| `/admin/workspaces` | 1.2 | 2 | 0 | 1 | no in-page tabs (secondary nav is links) | 1 | 220 KB | 101 KB | 7w+z200, no overflow | rtl, no overflow | REDESIGNED_AND_VISUALLY_VERIFIED |
| `/admin/workspaces/:id` | 2 | 11 | 3 | 1 | no in-page tabs (secondary nav is links) | 1 | 263 KB | 187 KB | 7w+z200, no overflow | rtl, no overflow | REDESIGNED_AND_VISUALLY_VERIFIED |

### What was recomposed, and onto what

- **`/admin/billing`** — *revenue -> attention lists -> add-ons -> webhooks -> reconciliation*
  - the reconciliation history was twenty-five bold lines of shouted enum with a stamp to the second on each ('WORKSPACE_OPERATIONS · SUCCEEDED · 05 Sept 2026, 18:41:00 Europe/Berlin'); it reads 'Workspace operations · Succeeded · scanned 14 · 13m ago' with the instant on the hover, and the 25-row cap the server reads under is now stated
- **`/admin/contact-sales`** — *stage summary -> filter bar -> inquiry table -> quick-view drawer*
  - the row's second action rendered 5px past the visible edge of a sideways-scrolling table; the actions cell is pinned to the container's inline end, matching the rule added to DataTable. The table itself is hand-rolled and is recorded as debt rather than migrated in this pass
- **`/admin/contact-sales/:id`** — *identity header -> inquiry facts -> routing -> internal notes*
  - migrated off the legacy style-object system onto the canonical Card/Badge/Button set; the return link carries the list state it came from
- **`/admin/customers`** — *filter bar -> customer directory -> row disclosure*
  - onto the canonical DataTable and FilterBar with one reset that appears only when something is filtered; the created stamp dropped from a wrapping seconds-precision string to a date
- **`/admin/customers/:id`** — *identity -> commercial -> workspaces -> people -> lifecycle actions*
  - twelve cards on the legacy system rebuilt on the canonical surfaces; the single destructive action ('Suspend customer') is the only filled red control on the page, which the destructive sweep confirms
- **`/admin/demo-requests`** — *summary row -> filter bar + list -> request detail pane*
  - each summary card printed its own label twice, eight pixels apart, and tinted a count by its category so 'SPAM FLAGGED 0' wore red; rows read 'Clean 0' and 'ACTIVE · S0' and now state the verdict with the score on the hover; 'Clear Filters' moved off the always-visible actions slot onto FilterBar's filtered/onReset
- **`/admin/demo-requests/:id`** — *identity header -> qualification -> routing -> follow-up -> spam signals*
  - off the legacy style objects onto the canonical components; the metadata dump moved behind a disclosure instead of printing raw JSON as page content
- **`/admin/provisioning`** — *provisioning posture -> invitation governance -> per-invite disclosure*
  - reviewed against the capture and left alone. The doubled description reads as a repetition but is not one: the outer line states the section's scope and the inner line states what the governance table itself measures, and the inner text carries a fact the outer does not. Its legacy-palette and empty-state work landed with the console-wide passes
- **`/admin/users`** — *filter bar -> people roster -> lifecycle request queue*
  - the 'joined' line under every address was a wrapping seconds-precision stamp that made each row three lines tall, and is now a date; the shareable URL is derived from the filters rather than written from inside the fetch callback, so a row clicked during the load opens instead of navigating the reader back
- **`/admin/users/:id`** — *identity -> commercial -> memberships -> security posture -> lifecycle*
  - off the legacy style objects onto the canonical surfaces; the return link carries the roster state it came from
- **`/admin/workspaces`** — *filter bar -> workspace directory -> row navigation*
  - the created stamp under every workspace name wrapped to two lines and made each row three lines tall in a table an operator scans; it is a date now. Same URL-sync fix as the roster, proven by clicking a customer link at the earliest moment it is possible
- **`/admin/workspaces/:id`** — *identity -> commercial context -> members and usage -> provider subscriptions -> activity*
  - the page announced 'Enterprise contract', showed a green ACTIVE badge, and four fields later admitted 'No stored contract row. It is not a contract'; the qualification now arrives with the claim — the heading says 'no stored row', the badge is neutral because a derived status is not a contract status, and the field reads 'derived, not stored'

## C. Evidence Operations

**The operator's question:** Which evidence needs attention?

| route | screens | cards | 1-val | tables | tabs | H1 | desktop | mobile | responsive | RTL | disposition |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `/admin/evidence-ops` | 3.8 | 29 | 4 | 0 | no in-page tabs (secondary nav is links) | 1 | 568 KB | 469 KB | 7w+z200, no overflow | rtl, no overflow | REDESIGNED_AND_VISUALLY_VERIFIED |
| `/admin/evidence-ops/records` | 1.2 | 2 | 0 | 1 | no in-page tabs (secondary nav is links) | 1 | 246 KB | 87 KB | 7w+z200, no overflow | rtl, no overflow | REDESIGNED_AND_VISUALLY_VERIFIED |
| `/admin/platform/exports` | 1 | 3 | 0 | 0 | no in-page tabs (secondary nav is links) | 1 | 163 KB | 78 KB | 7w+z200, no overflow | rtl, no overflow | REDESIGNED_AND_VISUALLY_VERIFIED |
| `/admin/platform/media-graph` | 2.2 | 32 | 0 | 0 | no in-page tabs (secondary nav is links) | 1 | 335 KB | 260 KB | 7w+z200, no overflow | rtl, no overflow | REDESIGNED_AND_VISUALLY_VERIFIED |
| `/admin/platform/recovery` | 1.3 | 4 | 0 | 0 | no in-page tabs (secondary nav is links) | 1 | 190 KB | 103 KB | 7w+z200, no overflow | rtl, no overflow | REDESIGNED_AND_VISUALLY_VERIFIED |
| `/admin/platform/signers` | 1.2 | 6 | 0 | 0 | no in-page tabs (secondary nav is links) | 1 | 174 KB | 102 KB | 7w+z200, no overflow | rtl, no overflow | REDESIGNED_AND_VISUALLY_VERIFIED |

### What was recomposed, and onto what

- **`/admin/evidence-ops`** — *cohort row (3 cols) -> uploads -> evidence -> reports -> timestamping -> incidents -> queue health*
  - cohort grid 5 cols -> 3 (cards 340-730px -> 295-337px); the duplicated 80-word reason moved behind a <details> disclosure
- **`/admin/evidence-ops/records`** — *filters -> cohort statement -> table with expandable detail -> pager*
  - the Required action column carried the decision AND two paragraphs in 244px, off the end of the container's scroll; decision stays on the row, narrative moves to expandable detail; record UUID -> AdmId (truncated + copy); preservation badges nowrap. Rows 385px -> 77px. LATER IN THE PHASE: the row's 'What to do' control was measured 348px past the right edge of an 1661px table in a 1206px container — invisible until an operator thought to scroll a table sideways to look for a row action — so DataTable's actions column is pinned to the container's inline end; and Created + Last change were 514px of nowrap timestamps, 31% of the table, now a date and an interval with their instants on the hover, taking the table to 1368px
- **`/admin/platform/exports`** — *export posture -> job list -> destination facts*
  - the console's last centred-prose empty state — a 74px card holding one centred muted line and no label, which reads as 'loading, forever' — became the shared left-aligned state that names which state it is and why
- **`/admin/platform/media-graph`** — *snapshot freshness -> intelligence tiles -> graph tiles -> operator actions*
  - eleven metric keys rendered split mid-word ('media_intelligence_processo / r_started_total'), now broken at the underscores; a tile's tone no longer fires on a zero value, and the metric key was demoted from headline to caption
- **`/admin/platform/recovery`** — *recovery posture -> request queue -> per-request disclosure*
  - off the legacy palette and style objects; the queue's empty state explains what would appear there rather than being blank
- **`/admin/platform/signers`** — *signer posture -> signer table -> key facts*
  - 246 lines off the legacy system onto the shared surfaces; the search filter is labelled and the table states its count

## D. Identity and Access

**The operator's question:** Who has access and what is failing?

| route | screens | cards | 1-val | tables | tabs | H1 | desktop | mobile | responsive | RTL | disposition |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `/admin/identity` | 3.2 | 22 | 0 | 3 | no in-page tabs (secondary nav is links) | 1 | 548 KB | 415 KB | 7w+z200, no overflow | rtl, no overflow | REDESIGNED_AND_VISUALLY_VERIFIED |
| `/admin/identity/access-reviews` | 1.2 | 5 | 0 | 1 | no in-page tabs (secondary nav is links) | 1 | 200 KB | 99 KB | 7w+z200, no overflow | rtl, no overflow | REDESIGNED_AND_VISUALLY_VERIFIED |
| `/admin/identity/permission-matrix` | 1.7 | 9 | 0 | 0 | no in-page tabs (secondary nav is links) | 1 | 244 KB | 158 KB | 7w+z200, no overflow | rtl, no overflow | REDESIGNED_AND_VISUALLY_VERIFIED |
| `/admin/identity/providers` | 1.2 | 5 | 0 | 0 | no in-page tabs (secondary nav is links) | 1 | 226 KB | 154 KB | 7w+z200, no overflow | rtl, no overflow | REDESIGNED_AND_VISUALLY_VERIFIED |
| `/admin/identity/runtime` | 1.4 | 5 | 0 | 2 | no in-page tabs (secondary nav is links) | 1 | 227 KB | 123 KB | 7w+z200, no overflow | rtl, no overflow | REDESIGNED_AND_VISUALLY_VERIFIED |
| `/admin/identity/scim` | 1 | 4 | 0 | 1 | 4 tabs, all opened (tabs.json) | 1 | 189 KB | 87 KB | 7w+z200, no overflow | rtl, no overflow | REDESIGNED_AND_VISUALLY_VERIFIED |
| `/admin/identity/sessions` | 2.6 | 12 | 0 | 4 | no in-page tabs (secondary nav is links) | 1 | 361 KB | 228 KB | 7w+z200, no overflow | rtl, no overflow | REDESIGNED_AND_VISUALLY_VERIFIED |
| `/admin/identity/timeline` | 1 | 0 | 0 | 0 | no in-page tabs (secondary nav is links) | 0 | 6 KB | 72 KB | 7w+z200, no overflow | rtl, no overflow | REDESIGNED_AND_VISUALLY_VERIFIED |

### What was recomposed, and onto what

- **`/admin/identity`** — *member table -> extra access -> service accounts -> mappings -> session governance -> specialist surfaces -> scope disclosure*
  - the member id column rendered one indistinguishable string on every row (an eight-character head of a sequentially-allocated UUID); it now shows head and tail through the one canonical shortener. The four per-row Revoke controls are the page's only filled red buttons and were left as they are — one per row is the console's destructive convention, which the cross-route measurement confirms
- **`/admin/identity/access-reviews`** — *campaign summary -> review table -> decision controls*
  - onto the canonical surfaces and the shared empty state; a disabled decision control now says why it is disabled instead of being inert and silent
- **`/admin/identity/permission-matrix`** — *role selector -> permission matrix -> capability disclosure*
  - a card was showing 12 of 93 permissions with no indication the other 81 existed; the matrix now discloses its own size, and amber stopped being applied to rows that carry no warning
- **`/admin/identity/providers`** — *provider list -> per-provider configuration -> health*
  - nine cards migrated off the legacy system; a raw ISO timestamp rendered as prose became a formatted instant
- **`/admin/identity/runtime`** — *runtime posture -> session monitor -> quarantine -> emergency control*
  - all twenty-five session rows printed the identical string '0adf0000-000…' in the User column, so an operator picking a session to quarantine could not tell which row they were acting on; the shortener keeps head AND tail now. 'Emergency org revoke' is the page's single filled red control
- **`/admin/identity/scim`** — *URL-addressable tablist -> tab panels*
  - the console's only real tablist: state moved to ?tab=, adopted AdmTabs/AdmTabPanel for arrow keys + roving tabindex + tabpanel semantics; all 4 tabs opened and verified. LATER IN THE PHASE: the tab was reading its state back from the URL, so it did not change until the router's replace landed — it now switches on the click and treats the URL as a reflection of that, which is why the tab sweep measures the panel rather than the address bar
- **`/admin/identity/sessions`** — *filter bar -> session table -> quarantine -> trusted devices -> policy impact -> member risk*
  - every row carried TWO solid-red buttons, fifty on a full page, and the more dangerous of the pair ('Revoke all', member-scoped, step-up gated) was indistinguishable from the safer one; it is a secondary action now. The row's last action also rendered 41px past the visible edge — Timeline, a read rather than a mutation, moved to the Member cell and the table went from 1268px to 1214px inside a 1216px wrapper with no sideways scroll
- **`/admin/identity/timeline`** — *filter bar -> identity event timeline -> per-event disclosure*
  - the actor was stated twice in each row (once as a name, once as the same name in the kind slot); the presenter now renders the kind only when it differs from the name

## E. Security and Support

**The operator's question:** What is firing and does anybody own it?

| route | screens | cards | 1-val | tables | tabs | H1 | desktop | mobile | responsive | RTL | disposition |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `/admin/alerts` | 3.9 | 26 | 0 | 0 | no in-page tabs (secondary nav is links) | 1 | 469 KB | 369 KB | 7w+z200, no overflow | rtl, no overflow | REDESIGNED_AND_VISUALLY_VERIFIED |
| `/admin/audit` | 2.4 | 11 | 0 | 1 | no in-page tabs (secondary nav is links) | 1 | 427 KB | 300 KB | 7w+z200, no overflow | rtl, no overflow | REDESIGNED_AND_VISUALLY_VERIFIED |
| `/admin/security` | 3.9 | 17 | 1 | 4 | no in-page tabs (secondary nav is links) | 1 | 454 KB | 367 KB | 7w+z200, no overflow | rtl, no overflow | REDESIGNED_AND_VISUALLY_VERIFIED |
| `/admin/support-access` | 1.9 | 7 | 0 | 2 | no in-page tabs (secondary nav is links) | 1 | 276 KB | 174 KB | 7w+z200, no overflow | rtl, no overflow | REDESIGNED_AND_VISUALLY_VERIFIED |
| `/admin/timeline` | 2.3 | 1 | 0 | 1 | no in-page tabs (secondary nav is links) | 1 | 458 KB | 219 KB | 7w+z200, no overflow | rtl, no overflow | REDESIGNED_AND_VISUALLY_VERIFIED |

### What was recomposed, and onto what

- **`/admin/alerts`** — *posture row -> alert list -> delivery*
  - the alert list was one card per alert at ~190px each; it is now a compact row list on the shared surface, and the last sub-11px text on the route was raised
- **`/admin/audit`** — *filter bar -> server-paged log -> per-row disclosure*
  - the actor and target cells printed a six-character tail with the full id nowhere on the page, so an operator correlating a row against a person had nothing to correlate with; the id is now on the cell's title, which also lets the composition sweep tell an honestly repeated column from one whose truncation hides a difference
- **`/admin/security`** — *scope note -> posture strip -> events + scans -> MFA policy -> member lifecycle -> activity -> digest -> self-check*
  - two filters offered values their endpoints refuse — 'Critical' against a domain of INFO/WARNING/HIGH, and 'Infected' where the status is SUSPICIOUS — so both returned 400 and rendered a form-validation sentence on a list; SUSPICIOUS also fell through to neutral grey, the one scan result an operator must act on. Five scan counters read 0 because no scanner is configured, two empty states blamed a filter that was not applied, and the page's own note card restated the amber scope banner 100px above it
- **`/admin/support-access`** — *grant posture -> active grants -> grant history*
  - onto the canonical surfaces with a labelled filter set and one reset; a disabled grant control states its reason
- **`/admin/timeline`** — *filter bar -> platform event timeline -> per-event disclosure*
  - the same actor duplication as the identity timeline, from the same shared presenter; the timeline rail moved onto the shared adm-* treatment rather than carrying its own

## F. Platform Operations

**The operator's question:** What is this costing and where?

| route | screens | cards | 1-val | tables | tabs | H1 | desktop | mobile | responsive | RTL | disposition |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `/admin/costs` | 2.2 | 18 | 3 | 3 | no in-page tabs (secondary nav is links) | 1 | 377 KB | 288 KB | 7w+z200, no overflow | rtl, no overflow | REDESIGNED_AND_VISUALLY_VERIFIED |
| `/admin/operations` | 3.7 | 8 | 4 | 2 | no in-page tabs (secondary nav is links) | 1 | 683 KB | 343 KB | 7w+z200, no overflow | rtl, no overflow | REDESIGNED_AND_VISUALLY_VERIFIED |
| `/admin/platform-health` | 2.7 | 31 | 7 | 0 | no in-page tabs (secondary nav is links) | 1 | 499 KB | 462 KB | 7w+z200, no overflow | rtl, no overflow | REDESIGNED_AND_VISUALLY_VERIFIED |
| `/admin/platform/automation` | 1.7 | 5 | 0 | 0 | no in-page tabs (secondary nav is links) | 1 | 219 KB | 121 KB | 7w+z200, no overflow | rtl, no overflow | REDESIGNED_AND_VISUALLY_VERIFIED |
| `/admin/platform/observability` | 3.2 | 6 | 0 | 12 | no in-page tabs (secondary nav is links) | 1 | 384 KB | 326 KB | 7w+z200, no overflow | rtl, no overflow | REDESIGNED_AND_VISUALLY_VERIFIED |
| `/admin/platform/queues` | 1.9 | 3 | 0 | 1 | no in-page tabs (secondary nav is links) | 1 | 303 KB | 223 KB | 7w+z200, no overflow | rtl, no overflow | REDESIGNED_AND_VISUALLY_VERIFIED |
| `/admin/platform/readiness` | 2.7 | 6 | 0 | 0 | no in-page tabs (secondary nav is links) | 1 | 373 KB | 291 KB | 7w+z200, no overflow | rtl, no overflow | REDESIGNED_AND_VISUALLY_VERIFIED |
| `/admin/platform/reliability` | 1.5 | 10 | 0 | 0 | no in-page tabs (secondary nav is links) | 1 | 237 KB | 147 KB | 7w+z200, no overflow | rtl, no overflow | REDESIGNED_AND_VISUALLY_VERIFIED |
| `/admin/search` | 1 | 2 | 0 | 0 | no in-page tabs (secondary nav is links) | 1 | 145 KB | 65 KB | 7w+z200, no overflow | rtl, no overflow | REDESIGNED_AND_VISUALLY_VERIFIED |

### What was recomposed, and onto what

- **`/admin/costs`** — *window control -> cost summary -> entitlement table -> disclosure*
  - an all-empty list printed its empty state and then repeated it as a count line underneath; ResultCount suppresses the plain-empty sentence now, here and on every other console list
- **`/admin/operations`** — *posture row -> filter bar -> condition table -> security events*
  - five conditions read 'Trusted timestamping failed · EVIDENCE_INTEGRITY · seen 10x · last 1m ago' against the same workspace at the same severity and status, while their own summary said each covers one record — the projection had always carried relatedEvidenceId and the page declared none of it; each row now names and links its subject. The Affected column read 'Northwind Legal / Northwind Legal' on every row. And a router.replace fired from inside the fetch callback, so a link clicked during the load navigated the reader back to the list they had just left
- **`/admin/platform-health`** — *verdict -> needs attention -> now -> measured healthy -> not measured*
  - 24 equal cards partitioned into attention/probed/unprobed with the verdict derived from the rows; 16 unprobed cards -> 1 fact list; Now grid 5+2 -> 4+3
- **`/admin/platform/automation`** — *rule summary -> rule table -> run history*
  - onto the shared apf-* surfaces with one filter reset; the run list states the cap it reads under
- **`/admin/platform/observability`** — *alert rollup -> signal tiles -> per-source charts*
  - the page used apf-* classes throughout and was the one page under /admin/platform that never imported the stylesheet defining them, so every tile measured 0px border, transparent background and 0 padding and the platform's alert rollup rendered as bare stacked text outside any surface; a node:test now asserts every admin page loads the stylesheet whose classes it uses
- **`/admin/platform/queues`** — *queue posture -> queue table -> worker leases*
  - the page reported fifteen queues 'healthy' directly above its own table saying fifteen worker leases were missing; health is now derived from both, so a queue with no worker reports unknown rather than healthy
- **`/admin/platform/readiness`** — *verdict -> gate list -> unprobed disclosure*
  - ten warning-coloured zeros stopped wearing the colour of the thing they count; the shouted paragraph in the header became sentence case
- **`/admin/platform/reliability`** — *window control -> reliability tiles -> incident correlation*
  - the filter labels were page-local inline styles with their own ink; they name the one canonical field-label authority now, which is what made this route the first admin consumer of that primitive
- **`/admin/search`** — *query field -> result groups -> per-result disclosure*
  - the search field is labelled and its icon is named; results land on destinations that read the deep-link parameters they are sent, which they previously emitted and ignored

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
| `/admin/adoption` | 2 | 1 | 0 | 1 | no in-page tabs (secondary nav is links) | 1 | 316 KB | 204 KB | 7w+z200, no overflow | rtl, no overflow | REDESIGNED_AND_VISUALLY_VERIFIED |
| `/admin/dashboard` | 2.6 | 36 | 6 | 1 | 3-option window control, verified | 1 | 337 KB | 277 KB | 7w+z200, no overflow | rtl, no overflow | REDESIGNED_AND_VISUALLY_VERIFIED |
| `/admin/executive` | 1.9 | 16 | 8 | 2 | no in-page tabs (secondary nav is links) | 1 | 285 KB | 221 KB | 7w+z200, no overflow | rtl, no overflow | REDESIGNED_AND_VISUALLY_VERIFIED |
| `/admin/platform/analytics` | 2.8 | 35 | 0 | 0 | 3-option window control, verified | 1 | 368 KB | 342 KB | 7w+z200, no overflow | rtl, no overflow | REDESIGNED_AND_VISUALLY_VERIFIED |

### What was recomposed, and onto what

- **`/admin/adoption`** — *window control -> funnel -> cohort table -> disclosure*
  - legacy style objects and the second palette removed; the funnel's ratio over a zero denominator now states the denominator instead of printing a percentage of nothing
- **`/admin/dashboard`** — *window control -> KPI row -> geography -> traffic+funnel -> signals -> distributions -> activity*
  - MetricTile rebuilt on AdmKpi (10 tiles now uniform 163px, values on one line per row, was 7 distinct tops); the #1e3a5f navy accent removed from 8 of 11 tiles; 4 empty states 120-330px -> 56px; NotConnectedCard (Card+EmptyState, ~190px each) -> 56px inline rows; 3 content grids stop stretching
- **`/admin/executive`** — *top-line KPIs -> usage -> not-measured fact list -> top customers -> at-risk*
  - 'Not measured' 30px/750 -> 15px muted (6 of 16 tiles were non-values); Failed operations no longer red at zero; the 4-tile not-measured section -> 1 fact card
- **`/admin/platform/analytics`** — *window control -> reading guide -> five metric groups -> generation footer*
  - the source trace under the last Automation tile rendered 'source: AutomationWebhookDestinati / on' — a 28-character model name split mid-syllable in a 120px tile, on a surface whose whole claim is that a number can be checked against its table; IdentifierText offers the break at the CamelCase boundary and contributes no character, so the value still copies exactly

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
