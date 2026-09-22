# PROOVRA NATIVE — FINAL CLOSURE REPORT

Branch `worktree-native-convergence`, 114 commits ahead of `main` (`8d24b4cb4`,
untouched). Nothing pushed. 7 stashes untouched. No production contact.

---

## A. The stop condition

| | |
|---|---|
| **PARTIAL** | **0** |
| **SHELL** | **0** |
| **NOT_STARTED** | **0** |
| CODE_PARITY | 62 of 62 |

The derived manifest still resolves 62 NATIVE_REQUIRED routes from 208 web
routes against 142 registry entries, with **0 UNRESOLVED**. The 62 ledger rows
and the 62 derived rows are the same 62.

## B. Gates

| Gate | Result |
|---|---|
| mobile tests | **816 / 816** |
| web tests | **3220 / 3220** |
| api tests | **25193 / 25193**, 819 / 819 files |
| mobile typecheck | clean |
| mobile lint | clean |
| `audit:architecture --engine-check` | **exit 0 — AuditEngineIntegrity = PASS** |
| `audit:architecture --closure-check` | **exit 0 — ProductClosure = CLOSED** |

The engine began this session at **FAIL**. The committed
`architecture-facts.json` recorded zeroes, but it was stale: one flagged item
sits in a web file this branch never touched. The first honest regeneration
read 103 / 2 / 1 / 5.

## C. The 14 PARTIAL surfaces

| § | Surface | What closed it |
|---|---|---|
| 7.1 | `/home` | Operations, Analytics, Activity — health matrix, records-by-type, activity series, activity feed |
| 7.2 | `/capture` | Templates, intake stages, readiness, suggestions — plus the plan fields the draft was dropping |
| 7.3 | `/evidence/[id]` | Duplicates, generation, annotations, legal notes, lifecycle gating, unlock |
| 7.4 | `/cases/[id]` | Viewer-gated controls, note resolve/delete, deliverables, rename, delete |
| 7.5 | `/settings` | TOTP enrolment (the half that could strengthen the account) |
| 7.6/7.7 | billing, pricing | Already closed pre-session; transaction matrix held |
| 7.8 | `/evidence-requests/[id]` | The transition workflow, deliveries, history |
| 7.9 | `/collaboration-teams/[teamId]` | Work and Settings tabs, roles, history |
| 7.10 | `/organizations/[id]` | Audit timeline, leave, transfer, closure |
| 7.11 | `/teams/[id]` | Roles, case links, activity, rename, transfer, closure |
| 7.12 | `/workspaces` | Its own Spaces screen — and workspace switching, which did not exist |
| 7.13 | `/operations/batch-analysis` | Create, process, export, cancel |
| 7.14 | `/settings/reviewer-criteria` | Draft authoring, creation, per-version usage |

## D. Defects found and closed

These were not ports. Each is something the product was doing wrong.

1. **A false custody event on every phone capture.** `capture.tsx` polled
   `GET /v1/evidence/:id/report/latest` to detect readiness. That route appends
   `REPORT_DOWNLOADED` to the custody chain. Every record captured on a phone
   carried a download that never happened, in the one log whose purpose is to
   be an accurate account of what was done to the evidence.

2. **A credential in a URL.** The native invite screen POSTed the token in the
   path. The web moved it to the body because "a path token is written to
   access logs by every intermediary".

3. **A button that could only fail.** The new Spaces screen offered workspace
   creation over `POST /v1/teams`, a tombstone returning 409 on every path.

4. **A display of nothing.** The batch Results card aggregated
   classification/moderation/tag fields `processBatch` never writes — an empty
   list and a zero, presented as an analysis of the operator's evidence.

5. **Lock without unlock.** Evidence lifecycle controls were unconditional and
   there was no unlock, so a record could be locked from the phone and never
   released there.

6. **Controls offered, then refused.** Case detail ignored the `viewer` block
   the envelope already carried.

7. **A capability claimed but not built.** `billing.ts` listed
   retry-storage-cancellation as BUILT; nothing called it, and the guarding
   test passed on the dead path builder alone.

8. **Two identifiers collapsed.** `parseOrgMembers` merged membership id with
   user id, so an ownership transfer would have been refused as
   `target_not_member` — the right rule for the wrong reason.

9. **A gate the screen could not read.** `parseOrgDetail` dropped `callerRole`.

10. **Tombstoned aliases kept alive.** The native inbox called `snooze` and
    `dismiss`; the web migrated to `remind` and `archive` in Attention
    Architecture Phase 1. A tombstone with a live caller is a route nobody can
    retire.

11. **The plan fields never left the device.** The capture draft was not
    sending `role`, `privateNote` or `checklistStepId`, which the canonical
    item schema has always accepted.

12. **An error with no disposition.** `LEGAL_DOCUMENT_NOT_FOUND` rendered as an
    HTTP-status bucket.

## E. The instrument

`resolvePathExpr` followed an import to read a path in an exported **const**
but not in an exported **function**. The native app states every endpoint as a
pure builder, so ~100 calls to routes this repository owns were counted
unresolvable, and every number depending on which routes are consumed was that
much of a guess.

Teaching it the imported case took `DynamicUnresolvedConsumers` 100 → 0 — and
made findings 3, 4 and 10 visible for the first time.

`103 / 2 / 1 / 5` → `0 / 0 / 0 / 0`.

## F. Corrections to the ledger's own claims

Four gap lines were wrong, and said so rather than being quietly edited:

* `/workspaces` claimed native "switches workspace through the account menu".
  No switcher existed anywhere in the app.
* `/organizations/[id]` recorded invitation management as a native gap. The web
  moved it to an ENTERPRISE_ONLY admin console.
* `/cases/[id]` measured Native against the 12-tab enterprise branch; the
  native-required surface is the 5-tab one.
* `/settings` called cookie consent "the one remaining absence". It was not.

## G. What is NOT closed, by axis

| Axis | Item |
|---|---|
| **CLOSED 2026-09-22** | `ENVIRONMENT_BLOCKED_DATABASE_PROOF` is resolved. A disposable PostgreSQL 16 (pgvector) was brought up and every registered migration applied on a clean boot; `db:drift-check` and `db:raw-schema-verify` both OK; the UC-5 constraint verified from the live catalogue. The deployment-plan row now records the rehearsal because it was run. |
| **ENVIRONMENT** | `apps/web` typecheck reports 179 errors, all from two `@types/react` in the pnpm store (18.2.46 and 18.3.31). None touches the 11 web files this branch changed. Pre-existing dependency resolution, not code. |
| **BACKEND** | BD-1 `cancelJob` reports success without cancelling · BD-2 batch jobs are process memory · BD-3 `/v1/cases/summary` counters have no home on `matter-queue`. Recorded in `docs/backend-debt.md`, not worked around. |
| **EXTERNAL** | UC-1 store listing · UC-5 signing identity · universal-link files carry `<APPLE_TEAM_ID>` and `<ANDROID_SIGNING_SHA256_FINGERPRINT>` placeholders, uninvented as §6 requires. |
| **PHYSICAL** | UC-2 / UC-3 Android device · UC-5 iOS device. See `docs/uc-disposition.md`. |
| **SCOPE** | Named per row from the §15 cross-check: saved-view update/delete/default, typeahead suggest, per-response review actions, AI-policy reads, and label / relationships / reviewer-workflow / original-download on evidence detail. |

**CODE is complete for all five use cases and all 62 surfaces.** Everything in
G is environment, hardware, a store, a signing identity, or a backend decision
that is not mine to make.

## H. Git safety

No hard reset · no destructive clean · no stash pop or drop (7 stashes, byte
identical before and after) · no force push · **no push** · no production
deployment · no production mutation. `services/api/.env` is absent, so no local
boot could reach production. Every generator run was verified read-only first.
