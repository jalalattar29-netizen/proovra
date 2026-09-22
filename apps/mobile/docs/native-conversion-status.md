# PROOVRA Native — conversion status

Generated from `src/product/native-destinations.mjs` and
`tools/derive-product-manifest.mjs`. Those two are the authorities; this file
is a readable summary of what they say, and it is wrong the moment it
disagrees with them.

## Scope

The derived manifest walks `apps/web/app` and resolves every route against
`apps/web/lib/navigation/routeRegistry.ts`:

| Classification | Count |
|---|---:|
| NATIVE_REQUIRED | **62** |
| ADMIN_ONLY | 36 |
| ENTERPRISE_ONLY | 94 |
| PUBLIC_INFORMATIONAL_ONLY | 16 |
| UNRESOLVED | **0** |
| **Total web routes** | **208** |

## The §28 stop condition — NOT YET REACHED

Every NATIVE_REQUIRED row must end as `CODE_PARITY`, `BLOCKED_BY_EXTERNAL` or
`BLOCKED_BY_USER_DECISION`. `PARTIAL`, `SHELL` and `NOT_STARTED` are not end
states.

| Status | Count | End state? |
|---|---:|---|
| CODE_PARITY | **41** | yes |
| BLOCKED_BY_EXTERNAL | **6** | yes |
| BLOCKED_BY_USER_DECISION | **1** | yes |
| PARTIAL | **14** | **no** |
| SHELL | 0 | — |
| NOT_STARTED | 0 | — |

**48 of 62 rows are at an end state. 14 are not.** The invariant is not met.

## CODE_PARITY is not physical acceptance

They are independent dimensions and are tracked separately. `physicallyAccepted`
is `false` on every row and may never be set from CI: automated tests prove what
a component renders and which request it makes, and nothing about native layout,
gestures, fonts, safe areas, Hermes, or whether bytes reached storage.

`docs/physical-acceptance.md` is the script for a human with real hardware.

## The 14 rows that are not finished

| Route | What is outstanding |
|---|---|
| `/home` | Operations / Analytics / Activity tabs |
| `/capture` | templates, intake stages, readiness checks, suggestions |
| `/evidence/[id]` | annotations, legal notes, duplicates, report regeneration |
| `/cases/[id]` | access management, assignment mutation, risk, export |
| `/settings` | TOTP enrolment start/verify |
| `/billing` | storage add-ons |
| `/pricing` | add-on catalogue, pay-per-evidence credit offer |
| `/evidence-requests/[id]` | send, cancel, close, needs-more-info, deliveries, response review |
| `/collaboration-teams/[teamId]` | Work tab, Settings tab |
| `/organizations/[id]` | org audit feed, invitation management |
| `/teams/[id]` | role changes, case links, activity feed |
| `/workspaces` | cross-workspace administration |
| `/operations/batch-analysis` | create, process, cancel, export |
| `/settings/reviewer-criteria` | draft criterion authoring, per-version usage |

Several rows ALSO carry a difference that is decided rather than outstanding —
ownership transfer and closure are one-way doors the web builds real
confirmation around; a published criteria set has no edit because the API
answers 409; there is no in-app purchase because app-store rules govern it.
Each is argued in the row's own `gaps`. They are recorded as decisions, not
counted as progress.

## The 7 rows that are blocked

**6 BLOCKED_BY_EXTERNAL** — the intake and portal surfaces. One exact
dependency: the production web domain must host
`/.well-known/apple-app-site-association` and `/.well-known/assetlinks.json`,
and the app must declare `associatedDomains` and App Links intent filters.
`docs/EXTERNAL_CONFIG.md` records this as "Universal / App Links (M7) —
pending"; `app.json` declares only the `proovra://` scheme and no domain.

Their token exists only inside a link, the API mints that link from
`WEB_BASE_URL` as an https URL, and no `proovra://` form exists — so on a phone
it opens the browser. Writing the screens first would recreate the failure this
conversion already fixed once: complete screens nothing could navigate to.

**1 BLOCKED_BY_USER_DECISION** — `/share/[id]`, whose web page renders "Share
Link Page Not Active". Recorded as Q5 in `docs/open-questions.md`.

## Tests

| Suite | Result |
|---|---|
| `apps/mobile` | **580 / 580** |
| `services/api` | 16 failures / ~25,100 — see `docs/api-test-failures.md` |
| `apps/web` (legal + capture gates) | pass |

## Environment-blocked

Docker is unavailable and `TEST_DATABASE_URL` is unset, so
`services/api/test/uc0-discard-lifecycle.integration.test.ts` is not collected.
The discard lifecycle is unproven against a real database.
