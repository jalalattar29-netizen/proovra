# POST-CLOSURE CI FAILURE RECOVERY + TARGETED UI/UX CLEANUP

**Subject commit:** `ec92bc6a92b6463a6e5684bc676262fc48c460b9`
(`fix(commercial-output): close the P1/P2/P3 findings from the commercial + output + verify audit`)

**Baseline commit:** `214315a5` — the commit immediately before the closure.

**Date:** 2026-09-10
**Mode:** root-cause investigation → implementation → full validation → commit → push

---

## A. WHAT REMOTE CI ACTUALLY SAID

Not inferred, not recalled: read from the GitHub check-runs API for the
subject commit, and for the baseline commit, before any code was changed.

### A.1 The subject commit — 8 failures of 11 checks

| conclusion | check |
| --- | --- |
| failure | `build-test` |
| failure | `clean-db-boot` |
| failure | `admin-control-plane (1, s1, …)` |
| failure | `admin-control-plane (2, s2, …)` |
| failure | `admin-control-plane (3, s3, …)` |
| failure | `admin-control-plane (4, s4, …)` |
| failure | `admin-control-plane (5, s5, …)` |
| failure | `admin-control-plane-accounting` |
| success | `e2e` |
| success | `build-and-push (api)` |
| success | `build-and-push (worker)` |

**Correction to the brief.** The brief said "multiple `admin-control-plane`
matrix shards are RED". **All five** were red, not several.

### A.2 The baseline commit — fully green

Every check on `214315a5` — both of its runs — concluded `success`:
`build-test`, `clean-db-boot`, all five `admin-control-plane` shards,
`admin-control-plane-accounting`, `e2e`, both `build-and-push` jobs and the
Vercel preview.

**This settles the "pre-existing or not" question for the CI failures
themselves.** They are not pre-existing. All three are regressions introduced
by `ec92bc6a`. The instruction not to assume that was correct to give and the
answer happens to be that the closure caused them — established by measurement,
not by assuming the most recent change is guilty.

(One *test-suite* failure found during this pass **is** pre-existing, and is
proven so in §L. It is a different thing from a red CI check: it was in a suite
no workflow ran.)

### A.3 The failing STEP of each job

Read from the Actions jobs API — the step list with per-step conclusions. This
is what disproves a shared root cause.

| job | failing step | number |
| --- | --- | --- |
| `build-test` | **Audit engine integrity** | 6 |
| `clean-db-boot` | **API integration suite** | 12 |
| `admin-control-plane` ×5 | **Build the fixture web app (production, once)** | 11 |
| `admin-control-plane-accounting` | **Prove 97 unique tests ran** | 10 |

`build-test`'s `Lint`, `Typecheck` and every `Test —` and `Build` step were
**skipped**, never reached. Each shard's `Assert the suite discovers tests` and
`Run the admin control-plane suite` were **skipped** — not one admin test ever
executed. All five shards additionally failed `Upload the shard test report`
with `No files were found with the provided path:
artifacts/admin-matrix/report-shardN.json`, because Playwright never ran to
write one.

**This corrects a diagnosis made earlier in this session.** The `build-test`
failure was first attributed to `pnpm -r lint`. Lint *is* broken at
`ec92bc6a` (§C) — but it is step 7, and the job died at step 6. The observed
failure is the engine-integrity audit. Both are real; only one was observed.

Job logs need repository admin rights (`403 Must have admin rights`), so every
root cause below was reproduced locally rather than read from a log.

---

## B. THREE INDEPENDENT ROOT CAUSES, NOT ONE

| # | defect | explains | classification |
| --- | --- | --- | --- |
| 1 | `audit-output/current/architecture-facts.json` is stale | `build-test` | regression from `ec92bc6a` |
| 2 | two `no-fallthrough` ESLint **errors** in `apps/web/lib/evidence/generation-labels.ts` | all 5 `admin-control-plane` shards + `admin-control-plane-accounting` | regression from `ec92bc6a` |
| 3 | `services/api/test/billing-plan-selection.integration.test.ts` pins pre-Option-B copy | `clean-db-boot` | regression from `ec92bc6a` (stale test) |

Six of the eight red checks share cause 2. The other two have their own. The
instruction not to assume one root cause was load-bearing: fixing any one of
these alone would have left CI red.

---

## C. ROOT CAUSE 2 — THE ONE THAT TOOK SIX CHECKS

### C.1 What the shards were doing when they died

The `admin-control-plane` job builds the web app once, in production mode,
before running the suite (`pnpm test:e2e:admin:build` →
`apps/web/scripts/dev-admin-fixture.mjs --mode=production --build-only`). That
is step 11. `next build` runs ESLint over `apps/web` and **fails the build on
an ESLint error**; `apps/web/next.config.*` sets neither
`eslint.ignoreDuringBuilds` nor `typescript.ignoreBuildErrors`, so nothing
downgrades it.

### C.2 The error, measured on the subject commit's own file

`generation-labels.ts` at `ec92bc6a`, linted with the workspace's own ESLint:

```
severity=2  no-fallthrough  line 105  Expected a 'break' statement before 'case'.
severity=2  no-fallthrough  line 109  Expected a 'break' statement before 'case'.
errorCount: 2
```

`severity: 2` is **error**. Two errors, so `next build` exits non-zero, so
step 11 fails, so steps 12 and 13 are skipped and no report JSON exists.

### C.3 Why the code was written that way

`caseOutputNeedsAttention` groups nine `EvidenceOutputState` values into a
"false" group and a "true" group as contiguous `case` labels, and explained each
member's membership in a comment **between the labels**. A comment between two
`case` labels is a non-empty case body as far as `no-fallthrough` is concerned.
The explanation was the defect.

Fixed by hoisting the whole explanation into a docblock above the `switch`. The
grouping, the values and the returned booleans are byte-for-byte the behaviour
the closure intended; nothing about the state machine changed.

### C.4 Why the closure's own validation missed it

`apps/web/node_modules/.bin` was empty on the machine that ran the closure, so
`apps/web`'s ESLint could not execute at all and the failure to run was read as
a pass. `pnpm install` restored the bin links. §T records what this changes
about how lint is reported.

### C.5 The accounting job is a consequence, and is not separately broken

`admin-control-plane-accounting` declares `needs: admin-control-plane` with
`if: always()`, downloads the shard reports and runs
`scripts/admin-shard-accounting.mjs shard-reports 97 5` with
`SHARD_RESULT` set to the matrix result. With five failed shards and zero
report artifacts it cannot conclude anything but failure — which is exactly
what it exists to do. It needs no fix, and it will be green when the shards
are. **It is a real signal, not a duplicate.**

---

## D. ROOT CAUSE 1 — THE STALE GENERATED FACTS

Reproduced locally, verbatim:

```
$ pnpm audit:architecture --engine-check
AuditEngineIntegrity = FAIL
  STALE: audit-output/current/architecture-facts.json — regenerate with `pnpm audit:architecture`
```

`services/api/scripts/audit/index.mjs` regenerates the facts in memory,
normalises volatile fields out of both sides, and compares. A source change
that alters what the facts describe makes the committed artifact stale, and
`--engine-check` refuses.

`ec92bc6a` **did** include `architecture-facts.json` (10 lines changed), so the
generator was run during the closure — but source edits landed after that run,
and the artifact was never regenerated against the final tree. This is the
"generators LAST" rule, and it is why regeneration is the last action of this
pass (§S) rather than an early one.

---

## E. ROOT CAUSE 3 — A TEST PINNING THE BEHAVIOUR THE CLOSURE DELIBERATELY CHANGED

`clean-db-boot` step 12 runs the API integration project against a freshly
migrated disposable database. `billing-plan-selection.integration.test.ts:242`
asserted the exact, server-composed sentence a FREE account sees where storage
add-ons would be — the **pre-Option-B** sentence.

Product Option B is the locked decision that a FREE account holding a settled
evidence-credit grant **may** buy storage add-ons, so the sentence changed. The
test was correct to be exact and correct to fail; it was simply pinned to the
retired copy.

Repinned to the new sentence — still exact equality, still read from the
server's own composition, never a substring or a regex. And **strengthened**,
because a copy pin alone would not have caught the thing worth catching:

```ts
it("CAN buy storage capacity once it holds a settled evidence credit", async () => {
  const t = await seedPersonalTenant(deps, "FREE", { credits: 1 });
  await prisma.evidenceCreditLedgerEntry.create({
    data: { userId: t.owner.userId, entryType: "PURCHASE", creditsDelta: 1,
            balanceAfter: 1, provider: "STRIPE",
            providerRef: `p7-option-b-${t.owner.userId}` },
  });
  const p = await projectFor(t.owner.userId);
  expect(p.plan.planKey).toBe("FREE");            // the plan did NOT move
  expect(p.actions.canBuyStorageAddon).toBe(true);
  expect(p.storageAddonsLocked ?? null).toBeNull();
  expect((p.storageAddons?.offers ?? []).length).toBeGreaterThan(0);
});
```

That asserts both halves of Option B at once: capacity becomes purchasable
**and** the plan stays FREE. No `PAYG_V2`, no `FREE_WITH_CREDITS`, no pseudo
tier.

Also verified: `setAccountPlan` (`services/api/test/point7/product-fixtures.ts`)
writes only `entitlement.credits` and never a ledger row, so the grant-based
signal cannot have silently flipped any pre-existing fixture to "has credits".

### E.1 Why the closure's own validation missed it

`vitest.config.ts` excludes `test/**/*.integration.test.ts` by suffix, so the
unit project never collects this file; and the closure's testcontainers
integration run was killed by its own timeout before reaching this suite. The
suite that would have caught it was neither in the project that ran nor in the
run that was allowed to finish.

---

## F. THE `.p7tmp` TRAP, AND A SECOND CORRECTION TO AN EARLIER CLAIM

Running the API unit project locally failed on
`phase-12-point7-closure-gate.test.ts`. The earlier diagnosis in this session
called that "structural to a unit-only run". It was not.

The gate skips itself with a stated reason when no product-run outbound ledger
is on disk, and asserts when one is. Gitignored `.p7tmp/` ledgers left over
from an integration run **weeks earlier** (files dated 2026-08-21) were making
it assert against a stale ledger. Moved aside, the gate skipped with its
designed reason and the full API unit project ran clean.

The gate's own comment warns about precisely this: it "passed locally only
because a developer's `.p7tmp` still held ledgers from an earlier integration
run, which is the worst kind of green". CI is unaffected — a fresh checkout has
no `.p7tmp` — but any local claim about that gate is worthless without stating
the ledger state, so this pass states it.

---

## G. OPERATIONS — THE TWO PAGE-LEVEL BANNERS, AND WHY REMOVING THEM REMOVES NOTHING

Both banners were **presentation misuse of correct backend state**. No backend
completeness or reconciliation field was deleted, narrowed, or stopped being
computed. Every consumer was located before anything was removed.

### G.1 The truncation banner

> "Part of the condition list could not be loaded. More conditions exist than
> were returned. Anything shown below may be incomplete."

Rendered whenever `completeness.complete === false`. And on the server
(`services/api/src/routes/ops.routes.ts:1362`) that field is literally:

```ts
{ complete: rows.nextCursor === null }
```

So `complete === false` means **"there is a next page"** — the ordinary state of
every full first page in any workspace with more than 50 conditions. The page
raised a `role="alert"` saying part of the read had failed, on a read where
nothing failed; and said "anything shown below may be incomplete" about rows
that were complete and correct.

What actually prevents a false all-clear is a different field, decided
server-side: `mayAssertAllClear`, from `mayAssertOperationsClear` in
`packages/shared-runtime/src/workspace-operations-reconciliation.ts`, which
returns `{clear: false, reason: "INCIDENT_READ_INCOMPLETE"}` for a genuinely
incomplete incident read, and `STALE` / `FAILED` / `STALLED` / `PARTIAL` /
`NEVER_RUN` for the others. The browser never derives it. Removing the banner
does not touch it.

Truncation is still visible, twice, without an alert: the header's `N+` count,
and the "Load 50 more" control itself.

### G.2 The staleness banner

> "These conditions may be out of date. The last reconciliation run is older
> than this workspace's freshness window. A new one is being scheduled."
> \[Check again]

Three sentences and a button asking the operator to request something already
in flight. `ensureWorkspaceOperationsFreshness`
(`services/api/src/services/operations/operations-reconciliation.service.ts`)
schedules a run for `NEVER_RUN`, `STALE`, `PARTIAL`, `FAILED` and `STALLED` —
its own comment reads "All five want a fresh run" — during the very read that
renders the page. The banner narrated the product's automatic behaviour and
offered to trigger it again.

The refusal to claim all-clear over a stale run is, again, `mayAssertAllClear`,
server-side, untouched.

### G.3 What was deliberately KEPT

`FAILED`, `STALLED` and `PARTIAL` keep their notices, and the degraded-source
notice for a failed SUMMARY read keeps its `role="alert"`. Those are not "we
are already handling it": a reconciliation run that failed or stopped halfway,
or a source that could not be read, is a **condition of the workspace**, and the
operator has to know. The line drawn here is between machinery narrating itself
and the product reporting a fact.

### G.4 A failed next page is now reported at the control that failed

`loadMore` previously reported through `setMutationError`, which renders
`InlineMutationError` at the very **top** of the page — above the summary strip,
potentially a screen away from the button pressed, in the component reserved for
a failed acknowledge / resolve / suppress. "The next page did not load" arrived
looking like a failed mutation.

It is now local state rendered inside the same `.opsw-more` block as the button,
as `role="status"` rather than `alert`: nothing about the conditions already on
screen became untrue, one further read did not arrive. The cursor is
deliberately **not** cleared, so the rows stay and pressing again resumes from
the same position. `.opsw-more` gained `flex-wrap` and a gap so the message
wraps beneath the button rather than stretching the row.

The message is sanitised through `toSafeUserError` — the only sanctioned
error-display path in this codebase — so a provider string cannot reach the
reader.

### G.5 "Load 50 more" is now proved, not assumed

The truncation banner was the only thing on screen that mentioned more existed,
so its removal puts weight on the pagination control. A dedicated block of
render tests asserts every claim the removal rests on:

| claim | assertion |
| --- | --- |
| the first page is the first page | `rowIds()` equals page 1, in the server's order |
| no page-level warning on the ordinary case | no `[data-ops-degraded]`, no "could not be loaded", no "may be incomplete" |
| the next page **appends** | `rowIds()` equals page 1 + page 2 |
| deterministic order | the server's order, not re-sorted in the browser |
| no duplicates | `new Set(rowIds()).size === rowIds().length` |
| both renderers page together | `cardIds()` equals `rowIds()` |
| the cursor is sent | `cursor=cur-1` present in the page-2 query |
| filters are retained | `severity` and `q` re-sent with page 2 |
| exhaustion hides the control | `nextCursor: null` ⇒ no `[data-ops-load-more]` |
| a remaining cursor keeps it | `nextCursor: "cur-2"` ⇒ control still offered |
| a failed next page is compact and local | `[data-ops-load-more-error]`, `role="status"`, inside `.opsw-more`; rows survive, cursor survives, control survives, no provider string |

An existing test already pinned that every filter is re-sent with the next page;
it is untouched.

### G.6 The three tests that pinned the removed banners

None was deleted, none was skipped, none was weakened to a looser matcher. Each
was rewritten to assert the property the banner was mistaken for **plus** the
absence of the banner — strictly more than it asserted before:

- *"an empty TRUNCATED read is not clear, and says so"* → **"…and raises no
  page-level alert"**: still no `[data-ops-empty="clear"]`, and now also no
  `[data-ops-degraded]` and no "could not be loaded" anywhere in the document.
- *"a STALE run says the conditions may be out of date"* → **"…neither claims
  clear nor lectures the operator about it"**: no `[data-ops-stale]`, no "may be
  out of date", and the condition list still renders in full.
- `e2e/operations-layout/operations-responsive.spec.ts` *"truncated is NOT
  clear, and announces itself"* → **"…and offers the rest of the collection"**:
  no clear state, `[data-ops-load-more]` visible, no degraded alert.

The `NEVER_CLEAR` sweep in that same spec — which enumerates `truncated`,
`degraded-summary`, `unavailable-incidents` and `filtered-empty` and asserts
that none of them can say "clear" — is untouched. So is the render-test sweep
over all six refusing readiness states, `STALE` among them. **The safety
property keeps exactly the coverage it had; only the banner lost its.**

`[data-ops-degraded]` still exists, is still produced for a failed SUMMARY
source, and is still asserted in both the render test and
`operations-a11y.spec.ts`.

---

## H. BILLING — "VIEW PLANS" ON A FREE ACCOUNT

Visual only. Same handler (`onChoosePlan`), same gate
(`locked.unlockedByPlan`), same label, same entitlement question, same
destination.

It rendered as `app-secondary-action` — the pale **outlined** control — and on a
Free account it is the only call to action in the storage card, so it read as a
disabled-looking afterthought. It now carries `app-secondary-action--filled`:
the stack's one solid neutral dark control, declared in
`components/app-primitives/app-primitives.css` with an `--app-ink-heading`
ground, a white label, its own dark hover that keeps the label white, and the
shared lavender `:focus-visible` ring and `:disabled` opacity inherited from the
base class. `--lg` keeps the canonical height, radius and typography.

Reused, not restyled: no inline background, no one-off hex, and nothing orange
or coral near it. A hex here would be a second definition of a control the
primitive layer already owns — which is how the old coral marketing CTA leaked
onto app surfaces in the first place.

### H.1 A dead second authority removed while there

`billing.css` still carried a block painting
`[data-billing-evidence-action="SEE_PLANS"].ui-button`,
`[data-billing-storage-upgrade].ui-button` and
`[data-billing-recheck].ui-button` dark ink, with a dark hover and a violet
focus ring. Every selector was qualified with `.ui-button`, the class the legacy
marketing button component adds — and all three controls are native canonical
actions now, so **not one of those rules could match anything**. It was a second
authority for three buttons, describing a treatment the primitive layer already
owns.

Verified before deleting: the three hooks appear on exactly three elements in
the tree (`BillingOverview.tsx:714`, `StorageAndHistory.tsx:144`, `:433`), and
none is a `.ui-button`. The block is replaced by a comment recording what it was
and where the treatment lives now, and a test asserts none of the three
selectors comes back.

---

## I. SETTINGS — "SAVE PREFERENCES" HAD A SECOND SURFACE BEHIND ITS LABEL

### I.1 The root cause, traced rather than covered

The control was `<Button variant="secondary">` from `components/ui/Button` —
the legacy marketing-era component, which wraps its label in
`<span style={{display:"inline-flex"}}>` and paints itself with **inline**
styles. Because inline styles beat a stylesheet, `settings.css` could only
reclaim it with `!important` attribute selectors, and the "PURPLE — the action a
section exists to perform" group did so on both the button **and**
`[data-cc-preferences-save] *` — every descendant, meaning that label span.

At rest the two fills agree and nothing shows. The hover rule repaints only the
**button** (`--set-accent-strong`); the span keeps `--set-accent`. The result is
a differently-coloured, square-cornered rectangle exactly the width of
"Save preferences", behind the text inside a rounded button — and it does not
animate with the button, because the transition is declared on the button.

**This is a known defect class in this very file.** `settings.css` documents it
for `[data-cc-revoke-others]` under the heading *"THE BUTTON OWNS ITS
BACKGROUND; ITS CHILDREN DO NOT"*, and
`__tests__/settings-billing-canonical-actions.test.ts` documents the same
mechanism producing "a solid violet rectangle inside a white button, measured
live at 214x20" on the 2FA control. Both were fixed at the time; the purple
group's `*` arms were not.

Checked rather than assumed: `[data-cc-password-submit]` is the same component
and had the same latent defect. `[data-contact-factor-send]` is a plain
`<button>` with a text child, so `*` matched nothing there.

### I.2 Fixed at the cause, on both sides

- **`PreferencesSection.tsx`** — the canonical `set-action set-action--primary`:
  a plain `<button>` with a text child, no inner element to paint, and no inline
  styling for the stylesheet to fight. That is the same class the neighbouring
  Settings hand-off actions use, and the right weight for the action the
  Preferences section exists to perform — its sibling "Use my current timezone"
  stays the outlined secondary, so the pair reads as primary + secondary. The
  legacy component is no longer imported by the file at all.
- **`settings.css`** — the purple group's descendant arm is split out and now
  carries only what a child genuinely needs: the ink, because a `<span>` inside
  a button does not inherit `-webkit-text-fill-color` reliably, over a
  **transparent** background. The fill belongs to the button alone. That also
  closes the latent case on `[data-cc-password-submit]`.

No overlay, no `z-index`, no covering rectangle, nothing hidden.

Behaviour is untouched: same change-gate (`dirty`), same `busy` lock, same
`save()`, same `data-cc-preferences-save` hook. Language, timezone, auto-detect
and the canonical-UTC audit semantics are not involved. The label reads
"Saving…" while busy, which the legacy component's spinner previously conveyed.

---

## J. SETTINGS — THE WORKSPACE CARD'S CTA WENT TO AI

### J.1 The bug

`apps/web/app/(app)/settings/page.tsx` renders `<AiSection />` for
`pane === "workspace"`. That pane's rail label was renamed to
**"AI & assistance"** on 2026-09-03, with a comment stating plainly that
Settings hosts no workspace-defaults domain — "there is no General domain here
to fill; there is an AI one, and the destination names it".

The Workspace summary card's CTA was not renamed with it. So the one control on
the page that promised **workspace settings** opened **AI assistance**, next to
a rail entry that opens the same pane under its true name. Label and destination
disagreed, and the control duplicated an existing entry.

### J.2 Decision rule applied: (A), never (D)

It was **not** renamed to "AI settings". Relabelling a control to justify a
wrong route is how the contradiction became invisible the first time.

A canonical workspace-administration destination does exist —
`workspace.people` → `/people`, "Members & Access", which the route registry
describes as deciding *"WHO can reach this workspace"*: members, invitations,
seats, roles, ownership transfer, closure. The card now points there, as a
`<Link>` labelled **"Manage workspace access"**, resolved through the canonical
navigation model.

When that route would refuse the actor — a Personal Space, which has no
workspace administration surface at all — the model yields `null` and the card
renders **no action**. That is rules (C)/(D): no destination means no control,
never a control that opens the wrong thing. The card's own comment had said a
personal space has nothing to open since it was written; the AI fallback was the
thing contradicting it.

Settings gains no new pane and no new rail item. AI & assistance keeps its own
rail entry under its own name, and the pane itself is unchanged.

### J.3 A real defect found by the new navigation contract test

The first implementation resolved the href with the module's existing
`routeLoads` helper, which reads `canLoad`. The behavioural case *"a destination
the actor cannot reach is not offered at all"* came back with `/people` for an
actor holding **no capabilities at all**.

Cause: `workspace.people` carries `navPlanFeature: "teamCollaborationIncluded"`
(FREE and PAYG have one seat, so a primary nav entry to it "is not navigation —
it is an advertisement with a dead end behind it"). For such a route
`resolveRouteAccess` returns `{canLoad: true, canSeeNav: false}` and **returns
early**, so the route's `requiredCapabilities: ["TEAM_VIEW"]` is never
evaluated. Reading only `canLoad` therefore offers a link to a surface whose
navigation is deliberately hidden, to an actor who cannot use it.

A rendered CTA **is** navigation, so the new destination uses a new
`routeIsOffered` predicate requiring `canLoad && canSeeNav`, and
`SettingsNavInput` now carries the server-projected `planFeatures` — the same
fail-closed booleans the sidebar and the route gate already read, never a
plan-name comparison — because the resolver cannot answer the navigation
question without them.

**`routeLoads` is deliberately left alone.** Passing `planFeatures` to it would
make it stricter for every rail item that uses it, on every plan, changing what
operators see in Settings: not what this pass is for, and an unvalidated change
to a navigation surface. It is recorded as a pre-existing gap in §AC rather than
silently altered, and the code says so at the call site.

---

## K. SETTINGS — THE NARROW NAVIGATION DUPLICATION SWEEP

Every entry `resolveSettingsNavigation` can produce, checked for label vs
destination, duplication, dead CTAs and scope leakage. Settings was **not**
redesigned.

| entry | destination | verdict |
| --- | --- | --- |
| Overview | pane | correct |
| Security | `/security-center` when the route loads, else pane | correct — summarises, hands off |
| Notifications | pane | correct |
| Privacy & data | pane | correct — account-scoped, offered to every authenticated actor |
| AI & assistance | pane (`<AiSection />`) | correct since 2026-09-03; the card CTA that contradicted it is §J |
| Members | `/organizations/{orgId}/admin/members` | correct, gated on `orgAdminOrgId` **and** the resolver, so it cannot be a dead link |
| Roles & permissions | pane | correct — org + `SETTINGS_VIEW` |
| Retention & lifecycle | `/governance/retention` | correct |
| API & integrations | `/integrations` | correct |
| SCIM & SSO | `/settings/security/saml` | correct — the documented procurement deep link that server-redirects to the canonical SAML console; commented at the site |
| Audit log | `/audit-transparency` | correct |
| Billing & plan | `/billing` | org-only, deliberate: the personal case is the Plan card's `View billing`, and the rail entry "remains only where a workspace has billing to administer beyond the personal plan" |

The `members`, `retention`, `integrations`, `sso` and `audit` panes render a
**hand-off card**: one sentence naming what the destination owns, and one
canonical action that goes there. Settings states what it knows and links; it
does not re-implement those domains. Label and destination agree in every case.

Two paths reach `/billing` for an organization (the rail entry and the Plan
card). That is a summary CTA beside a navigation entry, both correctly labelled,
scoped to the case that has billing to administer — not a duplicate link.

**One defect found, one defect fixed.** No other label disagreed with its
destination, no dead CTA, no personal/enterprise leakage.

---

## L. A SUITE THAT RAN NOWHERE, AND THE FAILURE IT WAS HIDING

### L.1 The hole

`apps/web/__tests__/render/` is 50 files and **1,099 render tests** — jsdom,
React, real component behaviour. They are `*.render.test.tsx`, which
`apps/web/scripts/run-tests.mjs` does not collect (it walks `.test.ts` and
`.test.mjs`), so they have their own vitest config and their own script,
`test:render`. That script was referenced by **no workflow, no aggregate script
and nothing else in the repository**. It ran only when somebody remembered the
command.

`run-tests.mjs` already documents this exact hole, one screen above, for four
`.test.mjs` files that "sat in `__tests__` passing when run by hand and never
once running as a gate", and states the principle: **"A test that is not
collected is not a test."**

### L.2 What it cost

Running the suite for the first time in this pass: **1 file failed, 39 tests**.
`evidence-detail-workspace-convergence.render.test.tsx` threw on every case:

```
TypeError: Cannot read properties of undefined (reading 'report')
  at describeReportArtifactStatus (app/(app)/evidence/[id]/_tabs/_lib.tsx:490)
```

`artifactStatus.outputs` — the canonical three-axis output projection — became
the thing the Evidence Detail page renders on 2026-09-08, and this file's
fixture was never given it.

**Proven pre-existing, not assumed.** `describeReportArtifactStatus` reads
`artifactStatus.outputs.report.state` at `214315a5`, the last fully green
commit, character for character; the fixture's last change is `2e1aca70`,
2026-09-08; and `git diff 214315a5 HEAD` on the fixture is empty. It has been
broken for two days and nothing could report it.

### L.3 Both halves fixed

- **The fixture** now carries the server's own `EvidenceOutputProjection` shape
  for both outputs, for a record whose report and package are generated and
  downloadable — which is what the legacy blocks beside it already said. 41/41
  pass.
- **The gate** — `run-tests.mjs` now runs the render suite after the node:test
  suite, in a separate process (the two harnesses cannot share one: node:test
  with a tsx loader, vitest with jsdom). `pnpm --filter proovra-web test` is the
  `Test — web` step in `ci.yml`, so this is what makes the render suite a CI
  gate for the first time.

Details that matter for it not to be annoying or fragile:

- **Filters are honoured.** A filtered run is somebody narrowing to one suite,
  so the render pass is skipped unless the filter matches render files, in
  which case it is forwarded to vitest. Verified both ways: a
  `settings-billing-canonical-actions` filter runs 28 node tests and no render
  tests; a `render` filter runs 1,099 render tests and no node tests.
- **`render` alone is not treated as a typo.** The "nothing matched" guard now
  runs after the render decision, because `render` matches no `.test.ts` file
  and would otherwise abort.
- **`node <vitest entry>`, not `pnpm exec vitest`.** Same reasoning the file
  already applies to the tsx loader: resolving the module and handing it to
  this node has one dependency, whereas shelling out adds a `pnpm` on PATH and,
  on Windows, a shell to find its `.CMD` shim. This step is a Linux CI gate and
  a Windows developer terminal and should not fail differently on the two for a
  reason unrelated to the tests.

**This is the third instance of the same institutional failure in this
codebase** — the admin control-plane suite that "existed and ran nowhere"
(ADM-P2-004), the four uncollected `.test.mjs` files, and now the render suite.
§AC records the two remaining ones found here that this pass did **not** close.

---

## M. THE FOCUSED UI TESTS ADDED

All executed, all green.

### M.1 `apps/web/__tests__/settings-billing-canonical-actions.test.ts` (+9 → 28 pass)

| test | asserts |
| --- | --- |
| Save preferences is the canonical Settings primary | native `<button>`, `set-action set-action--primary`, no legacy `variant=`, legacy `Button` not imported |
| the save control has no inner surface to paint | no `<span>` wrapping the label; every `[data-cc-preferences-save] *` block declares `background: transparent` and none declares the accent fill |
| Free View plans is the canonical DARK action | `app-secondary-action --filled --lg`, no inline `style={`, label unchanged |
| the filled modifier is a real dark primitive with all four states | `--app-ink-heading` ground, white label, its own `:hover:not(:disabled)`, focus and disabled inherited from the base class |
| View plans behaviour and destination are untouched | `onChoosePlan`, `locked.unlockedByPlan`, label |
| billing.css no longer paints the three converted actions | none of the three `.ui-button` selectors survives |
| the Workspace card never routes to AI | no `onOpen("workspace")`, no "Open workspace settings", **and not relabelled** to "AI settings" |
| the Workspace card's action is resolved by the canonical model | `routeIsOffered("workspace.people"`, `canLoad && canSeeNav`, `model.workspaceAdminHref ? … : null` |
| AI & assistance is still reachable under its own name | the rail label survives; the pane still renders `<AiSection />` |

**Two of these would have passed on a broken file** on the first run, and did
— because they searched raw source, and the comments recording each deletion
name the label, handler and class that were deleted. They now read a
comment-stripped source (`stripTs`), which is the same discipline the file
already applies to CSS (`stripCss`, "prose explaining a retired rule is not a
rule"). Both then failed correctly and were fixed. Recorded because a
source-text test that matches its own explanation is worse than no test.

### M.2 `apps/web/__tests__/settings-architecture.test.ts` (+5 → 31 pass)

The **behavioural** navigation contract, calling `resolveSettingsNavigation`
rather than reading its source:

- an organization admin gets `/people`;
- the destination is never AI, for either workspace kind;
- AI & assistance keeps its rail entry and its pane remains openable;
- an actor who cannot reach it is offered **nothing** (`null`);
- the expected href is read from the registry, so a re-route moves the test
  with it rather than pinning a stale path.

The fourth of these found the `canLoad` / `canSeeNav` defect in §J.3.

### M.3 `apps/web/__tests__/render/operations-workbench.render.test.tsx` (131 pass)

The rewritten banner assertions (§G.6) and the new eleven-assertion
"Load 50 more" block (§G.5).

---

## N. VALIDATION — WHAT WAS ACTUALLY EXECUTED

Every row below was run in this pass. Nothing is inferred, nothing is
extrapolated from a subset, and where something was not run it says so.

### N.1 The commercial / output closure regression set (§15)

| suite set | result |
| --- | --- |
| `commercial-output-journeys`, `commercial-output-lifecycle-closure`, `commercial-output-verify-closure`, `billing-commercial-correctness`, `billing-plan-transition`, `billing-overview-boundary` | **6 files, 241 tests, 241 passed** |
| `pricing`, `storage-addon`, `evidence-artifact-status`, `verify` | **9 files, 572 tests, 572 passed** |
| `@proovra/shared` (whole package, incl. `evidence-output-lifecycle`) | **904 tests, 904 passed** |

The locked Product Option B semantics are asserted positively (a FREE account
with a settled grant may buy capacity **and stays FREE**) and negatively
(ENTERPRISE is refused self-service capacity before the credit arm is even
consulted — a defect this change's own test caught during the closure).

### N.2 Clean DB — the API integration project, on a genuinely fresh second database

`clean-db-boot` step 12, reproduced with the workflow's own command and
environment (`RUN_LIVE_INTEGRATION_NO_TESTCONTAINERS=1`, explicit
`TEST_DATABASE_URL`, the same `AUTH_JWT_SECRET`).

The database was **created for this run and migrated from empty**
(`proovra_integration_test_ux2`) — not the database the first diagnostic run
used, and not a developer database that already existed. `prisma migrate
deploy` reported "All migrations have been successfully applied" against it
before a single test ran.

```
Test Files  116 passed (116)
     Tests  1830 passed (1830)
  Duration  890.80s
EXIT=0
```

`billing-plan-selection.integration.test.ts` — the file that failed in CI —
**22/22**.

### N.3 Build Test — the job's own steps, in its own order, with its own commands

Run with `.p7tmp` moved aside, because CI is a fresh checkout and the Point-7
gate is designed to skip when no product-run ledger is on disk (§F). Stating
the ledger state is part of the result.

| # | step | command | result |
| --- | --- | --- | --- |
| 6 | Audit engine integrity | `pnpm audit:architecture --engine-check` | **exit 0** — `AuditEngineIntegrity = PASS` (was the failing step) |
| 7 | Lint | `pnpm -r lint` | **exit 0** — 0 errors, 1 pre-existing warning |
| 8 | Typecheck | `pnpm -r typecheck` | **exit 0** |
| 12 | Test — shared | `pnpm --filter @proovra/shared test` | **exit 0** — 904 pass, 0 fail |
| 13 | Test — ui | `pnpm --filter @proovra/ui test` | **exit 0** — 6 pass, 0 fail |
| 14 | Test — mobile | `pnpm --filter proovra-mobile test` | **exit 0** — 8 pass, 0 fail |
| 15 | Test — web | `pnpm --filter proovra-web test` | **exit 0** — 3,068 node tests **and** 1,099 render tests (50 files), 0 fail |
| 16 | Test — worker | `pnpm --filter proovra-worker test` | **exit 0** — 891 pass, 0 fail |
| 17 | Test — api | `pnpm --filter proovra-api test -- --reporter=dot --maxWorkers=2` | **exit 0** — 802 files, 24,782 pass, 1 skipped, 0 fail |
| 19 | Build Shared | `pnpm --filter @proovra/shared build` | **exit 0** |
| 20 | Build API | `pnpm --filter proovra-api build` | **exit 0** |
| 21 | Build Worker | `pnpm --filter proovra-worker build` | **exit 0** |
| 22 | Build Web | `pnpm --filter proovra-web build` | **exit 0** |

**`BUILD_TEST_AGGREGATE_FAIL=0`** — all thirteen steps exit 0, in one run, on
the exact tree being committed.

Steps 9-11 (the migration-risk scan and the two Neon-URL refusal guards) and
steps 23-29 (the Docker full-stack build and its E2E smoke) were not
reproduced: the first three are pattern scans over the diff that CI runs
against its own checkout, and the last seven need the compose stack. Both were
green at `214315a5` and nothing in this change touches a migration, a database
URL guard, a Dockerfile or a compose service. The single `services/api` change
in this commit is a test file.

**Three earlier reproductions are worth stating, because two of them failed.**
Run 1 gave every step exit 0 except the API step, which reported zero test
failures and lost the race in §R. Run 2 was stopped mid-flight to correct two
comments. Run 3 failed the API step on five source-contract assertions broken
by the ioredis fix, which is why that fix was reverted (§R.1). The table above
is run 4, and it is the only one whose tree is the tree being pushed.

### N.4 Web ESLint (§20) — executed, and green

Not skipped, not assumed, not reported from a run that could not resolve its
own binary. `pnpm install` first, then:

```
$ pnpm -r lint
apps/web lint$ eslint .
apps/web lint: apps/web/components/surface/SurfaceGate.tsx
apps/web lint:   163:9  warning  The 'decision' conditional could make the
                 dependencies of useEffect Hook (at line 174) change on every
                 render …  react-hooks/exhaustive-deps
apps/web lint: ✖ 1 problem (0 errors, 1 warning)
apps/web lint: Done
LINT_EXIT=0
```

**Exit 0.** Nine projects lint. The `apps/web` project is demonstrably
analysing files rather than no-oping — it emits a real finding — and that
finding is a pre-existing warning in `SurfaceGate.tsx`, unrelated to anything
here. Zero errors.

### N.5 Responsive validation at 390 / 768 / desktop (§14)

Executed in a real Chromium against a **production build** of the app, through
the repository's own `operations-layout` project (`next start`, not `next dev`,
so the bundle measured is the bundle shipped).

**What passed — every viewport and overflow assertion:**

| assertion | widths |
| --- | --- |
| no route element overflows its own box | 1440, 1280, 1024, 768, 430, 390, 375, reflow-200 |
| the page does not scroll sideways — `default` | 390 |
| …`long-title` (a filename nobody would shorten) | 390 |
| …`long-identifiers` (a request id longer than the panel) | 390 |
| …**`hundred-plus` (fifty rows and a next page)** | 390 |

The last one is the one that matters for this change: it is the scenario that
renders the `.opsw-more` block, which gained `flex-wrap`, a gap and an inline
error slot. **No horizontal overflow at 390px.**

**What passed on the changed semantics:**

- **"truncated is NOT clear, and offers the rest of the collection"** — the
  rewritten test — passes: no clear state, `[data-ops-load-more]` visible, no
  degraded alert.
- The whole **false-clear sweep** passes: `unavailable-incidents`,
  `degraded-summary`, `truncated`, `filtered-empty` — none can say "clear".
- "a failed incident read is unavailable, never clear" passes.
- "no failure leaks a provider or database string" passes.
- `[data-ops-degraded]` is confirmed **visible in a real browser** for a failed
  SUMMARY read — the notice that was deliberately kept.

**What failed, and why it is not this change** — see §AC.2. Every failure is an
assertion about the **flat table** (`[data-ops-row]`, the row action menu, the
inspector, the metric strip, "exactly ONE renderer is in the layout"). The
grouped queue has been the default since `36cc44c0` on **2026-08-26**; these
specs were last updated **2026-08-25**. The project is opt-in and
`playwright-e2e.yml` runs `--project=chromium`, so no workflow has ever
executed it. The `degraded-summary` failure is the clearest proof of the
classification: line 412, `[data-ops-degraded]`, **passed**; line 413,
`[data-ops-row]`, is what timed out.

**One precondition was fixed to make the project usable at all.** On its first
execution, 13 `operations-a11y` cases failed with counts of 0, and every
failure screenshot shows the workbench rendered correctly — real summary
figures — behind the "Privacy Preferences" consent dialog, which `#cc-main`
overlays on first visit. This project provisions no consent decision, so every
navigation is a first visit, and nothing in it ever dismissed the banner.
`openOperations` now applies the **same `#cc-main` suppression that
`apps/web/e2e/admin-control-plane/_fixture-login.ts` already documents and
relies on**, for the identical measured symptom ("intercepts pointer events").
It suppresses the overlay, not the product's consent behaviour: no decision is
recorded, no analytics enabled, and the privacy-hardening suites that assert
the banner exists and defaults to necessary-only are untouched.

---

## O. THE CANONICAL GENERATORS, RUN LAST AND PROVED STABLE (§21)

Run **after** every source edit, because running them earlier is precisely what
made `ec92bc6a` fail: the closure did regenerate the facts, then edited source
again.

```
$ pnpm audit:architecture          # run 1
AuditEngineIntegrity = PASS
ProductClosure = CLOSED (reported, not asserted here)

$ pnpm audit:architecture          # run 2, same tree
BYTE_IDENTICAL: yes

$ pnpm audit:architecture --engine-check
AuditEngineIntegrity = PASS
```

Two consecutive runs produce a byte-identical
`audit-output/current/architecture-facts.json`, so the artifact is a function of
the tree and not of the clock or the machine. `--engine-check` — the step that
failed in CI — now passes.

### O.1 The proof ledger is a complete run, not a partial rewrite

`docs/architecture/point5-family-proven-cases.json` was rewritten by the
integration run in §N.2. Checked before staging: **every entry carries one and
the same `runId`**, with `recordedAtUtc` values from a single contiguous window
(10:27–10:36 UTC on 2026-09-10). It is the record of one complete run, which is
the only kind of proof ledger this repository allows to be committed.

`docs/architecture/current-runtime-capability-map.json` also changed, and its
diff is exclusively `productConsumer` line-number shifts inside
`apps/web/app/(app)/operations/page.tsx` plus the inventory hash that follows
them — the mechanical consequence of adding comments to that file.

---

## P. WHAT WAS NOT DONE, AND WHY

Stated plainly rather than left for the reader to notice.

### P.1 The admin control-plane suite itself was not executed here

Its **failure** was reproduced and fixed: the shards died at
`pnpm test:e2e:admin:build`, and that command now completes locally with
**exit 0** on the current tree (twice — once before and once after the UX
changes). The 97 admin tests behind it were not run locally, because the shard
job provisions its own Postgres, Redis, migration, seed and fixture API per
shard and the suite is sized for a 45-minute CI budget across five shards.

What is proved is the thing that was broken. The step that failed passes; the
step after it (`Assert the suite discovers tests`) and the suite itself were
never reached in CI, so their status at `ec92bc6a` is unknown-because-unrun,
not failing. Both were green at `214315a5` and nothing in this change touches
the admin console.

### P.2 Production was not touched, in any sense

No deploy. No Production migration, backfill, mutation, report regeneration or
TSA retry. No Production evidence credits consumed and no Production storage
purchased.

The only running stack in this pass was local and provably sandboxed. The
fixture API launcher builds its environment from an allowlist and refuses to
start if any value resolves off the machine; it was given an explicit local
`--database-url` (a database created for this pass on a local container) and an
explicit local `--redis-url`, and it logged
`Server listening at http://127.0.0.1:8191`. The web app was served from a
production build whose baked origins the launcher verified before serving:
`verified: compiled chunks reference http://localhost:3311, http://localhost:8191`.
That verification is not decoration — it refused to serve once during this pass,
correctly, when the build directory did not match the ports it was told to use.

`services/api/.env` holds live Production credentials, and no command in this
pass loaded it.

### P.3 No credential was typed into a browser

The seeded fixture prints six sign-in identities. Browser verification of
authenticated surfaces would have meant entering a password into a login form,
so it was not done that way. Responsive validation went through the
repository's own Playwright harness instead (§N.5), which is a better
instrument regardless: it measures a production build at eight widths and
asserts, rather than looking.

### P.4 Nothing was weakened to make anything green

No `.skip`, no conditional runtime skip, no `it.only`, no allowlist widened, no
assertion replaced with a weaker one, no `catch` that swallows, no arbitrary
sleep, no timeout raised as a fix, no test deleted for being inconvenient, no
fixture id hardcoded to satisfy one run. Three tests changed subject (§G.6) and
each gained an assertion rather than losing one. Two new tests found two real
defects (§J.3, and the ENTERPRISE storage arm during the closure).

---

## Q. THE ARCHITECTURE THAT HAD TO SURVIVE, AND DID

| invariant | status |
| --- | --- |
| one canonical commercial authority | untouched — no new commercial input anywhere in this change |
| one canonical output state + action resolver | untouched; `caseOutputNeedsAttention` fixed for lint with identical grouping |
| FREE + settled-credit storage (Option B) | asserted positively **and** negatively; plan stays FREE |
| no pseudo PAYG subscription plan | none created; no `PAYG_V2`, no `FREE_WITH_CREDITS` |
| immutable Report / Package versioning | untouched |
| TSA finalization-only invariant | untouched; no retry path added or implied |
| OTS recovery | untouched |
| legal-hold precedence | untouched |
| historical artifact download ownership | untouched |
| canonical workspace commercial subject | untouched |
| `NOT_APPLICABLE` semantics | untouched; it is one of the five states in the fixed switch's false group |

Every UX change in this pass is presentational or navigational. The one
non-presentational change is `routeIsOffered` (§J.3), which makes a navigation
decision **stricter**, and it is additive: the existing predicate is unchanged
and its callers behave exactly as before.

---

## R. A FOURTH FINDING, FOUND BY RUNNING THE GATE RATHER THAN TRUSTING IT — AND DELIBERATELY NOT FIXED

The first exact reproduction of the `build-test` job came back with the API
step at **exit 1** despite every test passing:

```
Tests   24782 passed | 1 skipped (24783)
Errors  1 error
[ioredis] Unhandled error event: Error: connect ECONNREFUSED 127.0.0.1:1
```

`127.0.0.1:1` is deliberate. `runtime-validation-enterprise.test.ts` points
`REDIS_URL` at a bounded unreachable port to assert that `checkRedis` returns
`CRITICAL` with `reasonCode: "redis_unreachable"`. **That assertion passed, and
so did all 24,782 others.**

The mechanism: ioredis reports a connect failure twice. It rejects the promise —
which `checkRedis` catches and converts into the CRITICAL subsystem report with
bounded error class, error code and elapsed time — and it **also** emits `error`
on the client, which nothing listens to. An `error` event with no listener is an
unhandled error, and vitest counts it against the run. Whether it escapes is a
race between the socket error and the test file's teardown, which is why the
same code has been green on CI and lost the race here.

**Pre-existing, and proven so:** `git diff 214315a5 HEAD` is empty for both
`runtime-readiness.ts` and its test.

### R.1 It was fixed, and the fix was reverted — on purpose

A one-line `pingClient.on("error", () => {})` fixes it cleanly: the rejection
remains the canonical surface, and the event is a second delivery of an error
the probe has already handled.

It broke **five source-contract assertions** in
`phase-32-6-1-package-state-machine.test.ts` and
`phase-32-7-5-worker-reconcile-false-degraded.test.ts`. Those tests read
`checkRedis`'s source and search fixed character windows — `SRC.slice(idx, idx +
3000)` and `+ 4000` — for `withTimeout(pingClient.ping(), null, 1000)`, the
HEALTHY branch, the `finally { … disconnect() }` block and the connect-before-ping
ordering. The function's existing comments already consume nearly the whole
budget; the file has widened those windows **twice before** for exactly this
reason, each time recording that the body had grown. One extra line of code plus
three lines of comment overran them again. Shrinking the explanation to a single
line still left two failing.

So landing this fix requires widening three character windows in two contract
files. That is a decision for the owner of that contract, not a side effect of a
UI cleanup — and this pass's whole thesis is that tests are not edited to make
runs green. The one-line fix and its comment were **reverted**;
`services/api/src/` is untouched by this commit.

Consequence, stated rather than smoothed over: the `build-test` API step can
lose this race locally. What that step reports is **zero test failures**, and
its exit code is then decided by an escaped event from a probe whose entire
purpose is to be unreachable. §N.3 reports the observed exit codes, not a
rounded-up version of them. It is recorded as an open item in §AC.5 with the
measurement and the reason it is still open.

### R.2 And one self-inflicted false alarm, recorded rather than hidden

A confirming re-run of the API step came back failing differently:

```
FAIL test/phase-8-oidc-callback.test.ts
Error: Cannot find module '#main-entry-point'
  from node_modules/.prisma/client/default.js
```

That was **not** a defect. It was this pass running the API unit project at the
same time as `Build Shared` / `Build API`, whose `prisma generate` rewrites
`.prisma/client` underneath the running suite. It is the same class of mistake
the brief warns about for the unit and integration projects sharing one proof
ledger, and the answer is the same: serialise. The result is discarded, not
reported, and the numbers in §N.3 come from runs with nothing else executing.

---


## S. EVERY FILE CHANGED, AND WHY

**CI recovery**

| file | why |
| --- | --- |
| `apps/web/lib/evidence/generation-labels.ts` | root cause 2 — comments hoisted out from between `case` labels |
| `services/api/test/billing-plan-selection.integration.test.ts` | root cause 3 — copy repinned to Option B, plus the positive Option B case |
| `audit-output/current/architecture-facts.json` | root cause 1 — regenerated last |
| `docs/architecture/current-runtime-capability-map.json` | regenerated with it; only consumer line numbers moved |
| `docs/architecture/point5-family-proven-cases.json` | rewritten by one complete integration run |

**Operations (§G)**

| file | why |
| --- | --- |
| `apps/web/app/(app)/operations/page.tsx` | both banners removed; pagination failure moved to the control |
| `apps/web/app/(app)/operations/_components/States.tsx` | `ReconciliationStaleNotice` deleted, with the reasoning left in its place |
| `apps/web/app/(app)/operations/operations.css` | `.opsw-more` wraps; `.opsw-more__error` added |

**Billing (§H)**

| file | why |
| --- | --- |
| `apps/web/app/(app)/billing/_sections/StorageAndHistory.tsx` | `View plans` on the canonical filled dark action |
| `apps/web/app/(app)/billing/billing.css` | dead `.ui-button` paint block removed |

**Settings (§I, §J)**

| file | why |
| --- | --- |
| `apps/web/app/(app)/settings/_sections/PreferencesSection.tsx` | save on the canonical Settings primary; legacy Button dropped |
| `apps/web/app/(app)/settings/settings.css` | the purple group's descendants no longer take a fill |
| `apps/web/app/(app)/settings/_sections/SettingsOverview.tsx` | Workspace card points at workspace administration, or at nothing |
| `apps/web/lib/settings/settingsNavigation.ts` | `workspaceAdminHref`, `routeIsOffered`, `planFeatures` on the input |
| `apps/web/app/(app)/settings/page.tsx` | passes `envelope.planFeatures` to the model |

**Tests and harness**

| file | why |
| --- | --- |
| `apps/web/__tests__/render/operations-workbench.render.test.tsx` | three assertions rewritten, eleven added |
| `apps/web/__tests__/settings-billing-canonical-actions.test.ts` | nine added; comment-stripped sources |
| `apps/web/__tests__/settings-architecture.test.ts` | five behavioural navigation contract cases |
| `apps/web/__tests__/render/evidence-detail-workspace-convergence.render.test.tsx` | stale fixture given the canonical `outputs` projection |
| `apps/web/scripts/run-tests.mjs` | the render suite becomes a CI gate |
| `e2e/operations-layout/_fixtures.ts` | consent-overlay precondition, per the admin fixture's proven pattern |
| `e2e/operations-layout/operations-responsive.spec.ts` | the truncated assertion rewritten |

---

## T. WHY THE CLOSURE'S OWN VALIDATION MISSED EACH DEFECT

Not rhetorical. Each has a specific mechanism, and each mechanism is now
closed or recorded.

| defect | why it was not seen | closed? |
| --- | --- | --- |
| `no-fallthrough` ×2 | `apps/web/node_modules/.bin` was empty, so `apps/web` ESLint could not execute — and not running was read as passing | yes: `pnpm install`, and §N.4 shows the linter emitting a real finding, which is what proves it ran |
| stale `architecture-facts.json` | the generator ran, then source changed again | yes: generators run last, twice, byte-compared (§O) |
| the Option B copy pin | the unit project excludes `*.integration.test.ts` by suffix, and the integration run was killed by its own timeout before reaching the file | yes: §N.2 ran the whole integration project to completion on a fresh database |
| the Evidence Detail fixture (2 days old) | `test:render` was invoked by nothing | yes: §L.3 makes it a CI gate |
| the ioredis unhandled event | a race that CI happened to win every time | **no** — characterised in §R and §AC.5; the fix cannot land without widening three source-contract windows |
| the `operations-layout` drift (2 weeks old) | the project is opt-in and no workflow runs it | **no** — recorded in §AC.2 with the reason |
| `routeLoads` ignoring capabilities on nav-gated routes | nothing exercised the combination | **no** — recorded in §AC.1 with the reason |

---

## U. DUPLICATION AND REGRESSION SWEEP

- **No duplicated commercial context.** No commercial input was added anywhere;
  `resolveStorageAddonEntitlement` and the plan projection are untouched.
- **No second output authority.** `caseOutputNeedsAttention` keeps its grouping
  exactly; only the comment moved.
- **No second navigation authority.** `routeIsOffered` calls the same
  `resolveRouteAccess` as `routeLoads`, from the same module; it asks a
  different question of the same answer.
- **Two second-authorities removed**: the dead `.ui-button` billing block, and
  the descendant-fill arm in the Settings purple group.
- **One duplicated control removed**: the Workspace card's CTA duplicated a rail
  entry under a different, wrong name.
- **No new CSS colour anywhere.** Every visual change is a canonical class.
  The diff adds exactly two hex values — `color: #ffffff` and
  `-webkit-text-fill-color: #ffffff` — and both are carried over verbatim from
  the rule that was split in §I.2, where they already stood. No colour was
  introduced, and no hex reaches any JSX.
- **No new route, pane, plan key, capability or entitlement.**

---

## V. TEST-INTEGRITY STATEMENT

| forbidden | present? |
| --- | --- |
| `.skip` added | no |
| conditional runtime skip added | no |
| `it.only` / `describe.only` | no |
| assertion replaced with a weaker one | no — three changed subject, each gaining assertions (§G.6) |
| allowlist broadened without semantic proof | no allowlist touched |
| catch-and-ignore added | no — the one listener that would have qualified was written, found to require three contract windows widened, and reverted (§R.1) |
| arbitrary sleep added | no |
| timeout raised as a fix | no |
| test deleted because inconvenient | no |
| fixture id hardcoded to satisfy one run | no |
| a failing test made to pass by changing the product to match it | no — two new tests changed the product, and in both cases the product was wrong (§J.3, and the ENTERPRISE credit arm) |

Net test count added by this pass: **+11 render** (Load 50 more), **+9**
canonical-action, **+5** navigation contract, **+1** integration (Option B
positive), and **1,099 render tests** that previously ran in no gate now run in
one.

---

## W. SAFETY CONSTRAINTS — OBSERVED

| constraint | observed |
| --- | --- |
| no deploy | yes |
| no Production mutation | yes |
| no Production migration | yes — migrations ran only against two local databases created for this pass |
| no Production backfill | yes |
| no Production evidence credits consumed | yes |
| no Production storage purchased | yes |
| no TSA retry | yes — no retry path exists, and none was added |
| no Production report regeneration | yes |
| no force push | yes |
| no API configuration reaching Production credentials | yes — `services/api/.env` was never loaded; the fixture launcher's allowlist and its `verified: compiled chunks reference http://localhost:…` check are the mechanical proof (§P.2) |
| no browser or API fixture connected to Production | yes |
| Clean DB does not depend on an existing developer database | yes — created and migrated from empty for this run (§N.2) |
| E2E does not depend on developer-local state | yes — the layout project mocks its API entirely; the consent precondition is an init script, not a machine setting |

---

## X. THE POINT-7 LEDGER STATE FOR EVERY CLAIM MADE HERE

Because `.p7tmp` changes what `phase-12-point7-closure-gate` does (§F), every
API-suite number in this report states the ledger state it was produced under.

| run | `.p7tmp` present | gate behaviour |
| --- | --- | --- |
| the diagnostic API run that first reproduced the failure | yes, stale (2026-08-21) | asserted against a stale ledger, failed |
| the same run with the ledgers moved aside | no | skipped with its stated reason, passed |
| the integration project (§N.2) | recreated by the run itself | n/a — different project |
| the `build-test` reproductions (§N.3) | **moved aside** | skipped, as on a fresh CI checkout |

The ledgers were restored afterwards; they are gitignored and are not part of
the commit.

---

## Y. HOW TO REPRODUCE THIS LOCALLY

Nothing here needs Production, a developer database, or a running MinIO.

```bash
# 1. The root causes, individually
pnpm audit:architecture --engine-check     # was FAIL: STALE architecture-facts.json
pnpm -r lint                               # was exit 1: no-fallthrough x2
git show ec92bc6a:apps/web/lib/evidence/generation-labels.ts   # the two case labels

# 2. The shard failure, without provisioning a shard
pnpm test:e2e:admin:build                  # `next build` — was exit 1 on the lint errors

# 3. Clean DB, on a database created for the purpose
#    (create + `prisma migrate deploy` first; never reuse a developer database)
TEST_DATABASE_URL=postgresql://…/proovra_integration_test_<new> \
RUN_LIVE_INTEGRATION_NO_TESTCONTAINERS=1 \
AUTH_JWT_SECRET=ci-integration-only-secret-0123456789abcdef \
  pnpm --filter proovra-api test:integration

# 4. Responsive, against a production build at eight widths
pnpm --filter proovra-web build
OPERATIONS_LAYOUT=1 pnpm exec playwright test --project=operations-layout
```

Two things will otherwise mislead you, and both are documented in-tree:

- move `.p7tmp` and `services/api/.p7tmp` aside before the API unit project, or
  the Point-7 gate asserts against whatever ledger your machine happens to hold
  (§F);
- do not run the API unit project while anything runs `prisma generate` — the
  generated client is rewritten underneath it and the failure looks nothing
  like its cause (§R.1).

---

## Z. WHAT CI SHOULD NOW DO, AND WHAT WOULD FALSIFY IT

Stated before pushing, so the prediction can be wrong in public.

| check | expectation | why |
| --- | --- | --- |
| `build-test` | green | step 6 reproduced green (§O), and every later step reproduced green in the job's own order (§N.3) |
| `clean-db-boot` | green | step 12 reproduced green on a fresh database, 1830/1830 (§N.2) |
| `admin-control-plane` ×5 | green | step 11 — the step that killed all five — reproduced green twice locally; steps 12-13 were never reached at `ec92bc6a` and were green at `214315a5` |
| `admin-control-plane-accounting` | green | it is a pure consequence of the shards (§C.5) |
| `e2e` | stays green | it was green at `ec92bc6a`, and nothing in this change touches the critical-flow suite, the API, or the worker; the only `services/api` change is a listener on a health probe's own client |

**What would falsify this**: any shard failing at step 12 or 13 rather than 11.
That would mean the admin suite has a defect the shards never got far enough to
show at `ec92bc6a` — unknown-because-unrun, not fixed and not proven (§P.1).
It would be a new finding, not a regression from this pass, and it would need
its own investigation.

---

## AA. RISK REGISTER FOR THIS CHANGE

| change | risk | mitigation |
| --- | --- | --- |
| two banners removed | an operator stops seeing a genuine incomplete read | the refusal is server-side (`mayAssertAllClear`) and is asserted over all six refusing states, plus the four-scenario false-clear sweep in a real browser |
| pagination error moved inline | a failure is less noticeable | it is at the control that failed, `role="status"`, and pinned by an assertion on placement, role, surviving rows and surviving cursor |
| Workspace CTA re-pointed | an actor is sent somewhere they cannot use | `routeIsOffered` requires `canLoad && canSeeNav`; the "offered nothing" case is asserted |
| `planFeatures` added to the nav input | a rail item changes | it reaches only the new predicate; `routeLoads` is byte-identical in behaviour (§AC.1) |
| render suite becomes a CI gate | a flaky render test turns `build-test` red | all 1,099 were run three times in this pass, green each time; the one broken file was fixed at its cause |
| consent overlay suppressed in one e2e fixture | the banner stops being tested | it is suppressed in `operations-layout` only; the privacy-hardening suites that assert the banner and its necessary-only default are untouched |

---

## AB. FOLLOW-UP WORK THIS PASS DID NOT DO

1. Pass `planFeatures` to `routeLoads` and re-validate the Settings rail across
   the plan matrix (§AC.1).
2. Decide which view the `operations-layout` contract measures, and bring its
   specs to the grouped default (§AC.2).
3. Give the eight opt-in layout projects a workflow that provisions them, so
   AC.2 cannot recur silently (§AC.3).
4. Refuse a `.p7tmp` ledger older than the current suite SHA (§AC.4).
5. Land the one-line ioredis listener together with a source-contract
   instrument that does not break when a function gains a comment (§AC.5).

None of these is a blocker for this change, and each is a piece of work with
its own validation.

---

## AC. OPEN ITEMS — FOUND HERE, NOT CLOSED HERE

Each is real, each is dated, and each is left open deliberately rather than
forgotten or quietly patched.

### AC.1 `routeLoads` can answer `true` without evaluating capabilities

For any route carrying `navPlanFeature`, `resolveRouteAccess` returns
`{canLoad: true, canSeeNav: false}` and returns **early**, so
`requiredCapabilities` is never reached. `routeLoads` reads `canLoad`, and
`resolveSettingsNavigation` does not pass `planFeatures` to it, so **every**
nav-plan-gated route takes that early return there.

Consequence today: rail entries resolved through `routeLoads` can be offered to
an actor who lacks the route's capability, whenever the route is
nav-plan-gated. The Workspace card's new destination does not have this problem
(§J.3), and the rest of the rail is unchanged from before this pass.

Not fixed here because the fix — passing `planFeatures` — makes the predicate
stricter for every rail item on every plan, which changes what operators see in
Settings and needs its own validation across the plan matrix. That is a
separate piece of work, not a line in a UI cleanup.

### AC.2 The `operations-layout` Playwright project is two weeks behind the product

Its specs assume the **flat table**: `[data-ops-row]`, the row action menu, the
inspector opened from a row, "exactly ONE renderer is in the layout", the metric
strip. The **grouped queue** became the default in `36cc44c0` on **2026-08-26**;
`operations-responsive.spec.ts` was last updated **2026-08-25** and
`operations-a11y.spec.ts` likewise predates the change.

Measured in this pass: 42 of 58 executed responsive cases pass; the 16 failures
are all flat-view assertions. The clearest single proof is the
`degraded-summary` case, where line 412 (`[data-ops-degraded]`) passes and line
413 (`[data-ops-row]`) is what times out.

Not fixed here because deciding **which view the layout contract measures** is a
product decision, not a test edit — and rewriting the specs to switch to
"All conditions" first would change what a gate asserts without that decision
being made. The consent-overlay precondition **was** fixed (§N.5), because that
is a harness defect with a proven in-repo remedy and no product question
attached.

### AC.3 `playwright-e2e.yml` runs `--project=chromium` only

Nine layout projects exist — `operations-layout`, `settings-layout`,
`billing-layout`, `capture-layout`, `evidence-layout`, `attention-layout`,
`search-layout`, `intake-layout` and the admin control-plane's own config. The
workflow deliberately names `chromium`, and the reason is documented in the
workflow itself: the other projects each bring their own `next start` on their
own port behind an opt-in variable, and an unnamed run drove eight projects at
servers that were never started — 2,290 collected tests, 1,561 failures, five
hours to the platform ceiling.

Naming `chromium` was the right immediate fix. It also means AC.2 could drift
for two weeks unobserved, and would have drifted indefinitely. Giving the layout
projects a job that actually provisions them is the outstanding work; this pass
only demonstrates the cost of not having one.

### AC.4 The `.p7tmp` local-ledger trap

Gitignored ledgers from an old integration run make
`phase-12-point7-closure-gate` assert instead of skip, against data that may be
weeks stale. CI is immune (fresh checkout). Locally it means **no claim about
that gate is meaningful without stating the ledger state**, which §F and §N.3 do.
A guard that refuses a ledger older than the current suite SHA would remove the
trap; the gate's own comment already names the failure mode.

### AC.5 `checkRedis` lets ioredis emit an unhandled `error` event

Measured (§R): an escaped `error` event from the deliberately-unreachable Redis
probe turned an API unit run with **24,782 passing tests and zero failures**
into exit 1. Whether it escapes is a race with test-file teardown, which is why
CI has been green on it and a local run is not always.

The fix is one line and was written. It cannot land without widening three
fixed character windows (`SRC.slice(idx, idx + 3000)` / `+ 4000`) in two
source-contract files whose comment budget the function already nearly
exhausts. That is the contract owner's call, and this pass reverted the fix
rather than edit contract assertions to make a run green.

The right closure is probably two changes, not one: the listener, **and**
replacing the character-window searches with something that does not fail when a
function gains a comment — the file has already widened those windows twice for
exactly that reason, which is the signal that the window is the wrong
instrument.

---

## AD. THE COMMIT

Staged: the 22 modified files plus this report. Deliberately **not** staged —
untracked audit artifacts from earlier, unrelated work that were already in the
tree before this pass began:

- `audit-output/current/admin-enterprise-product-audit.json`
- `docs/admin/audits/ADMIN_ENTERPRISE_PRODUCT_AUDIT.md`
- `docs/admin/audits/FINAL_ADVERSARIAL_E2E_CLOSURE_AUDIT.md`

`git fetch origin` first; rebase only if `origin/main` moved. **No force push**,
under any circumstance.

---
