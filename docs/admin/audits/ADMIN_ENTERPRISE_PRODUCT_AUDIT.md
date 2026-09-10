# PROOVRA Admin, Platform-Admin & Enterprise control-surfaces product audit

**Original baseline** `214315a527771aec8dbc84ea7ff4ddff34fbbda6` · **Completion baseline** `ec92bc6a92b6463a6e5684bc676262fc48c460b9` (1 commit (ec92bc6a — commercial/output/verify closure, 56 files)) · **Branch** `audit/admin-enterprise-completion`

**Generated** 2026-09-10T10:14:18.544Z · **Phase** COMPLETION PASS — audit only; no product source, migration, deployment or Production contact

> Rendered from `audit-output/current/admin-enterprise-product-audit.json`, which is the authority. Do not edit by hand.

## Verdict

`AUDIT INCOMPLETE — EXACT REMAINING ITEMS`

**Runtime execution of every unique safe control action**

- unique mutation actions discovered: **637**
- of those, reachable from a UI control: **554**
- executed end to end in a browser or through the API with a durable re-read: **12**
- **still unexecuted: 542**

*Why they are not done:* This pass executed the seven destructive/step-up families named in section 8 plus the five incident kinds of the Resolve family, each with a durable-effect re-read. The remaining UI-reachable mutations are traced to endpoint, authority, step-up requirement and audit emission from source, and the step-up mechanism is now PROVEN satisfiable end to end (SMS factor through the recording transport), so they are executable — they were not executed for time, not for risk.

*What blocks them:* Nothing external. The database is disposable and step-up is satisfiable.

*To close:* Drive the remaining actions through the same harness (scratchpad/audit2/destructive.mjs), which already performs elevate -> act -> durable re-read.

Every other conservation gate passes. The audit is not called complete on the strength of a static classification, which is what the brief forbids.

## What this pass closed

| Gap the previous audit recorded | Status now |
| --- | --- |
| 1,033 of 1,107 backend routes unclassified | **Closed.** 1140 routes (the 1,107 was itself low — see `PV-INV-001`), **1140 classified, 0 unknown, 0 ambiguous** |
| 19 Enterprise organization pages never exercised with data | **Closed.** 21 organization routes swept in a browser against a populated Enterprise Organization, 0 API failures |
| Destructive and step-up controls not executed | **Closed for the named families.** 7 executed with durable re-reads; step-up satisfied for real through the recording transport |
| 17 dynamic frontend call sites unresolved | **Closed.** 79 sites examined, **0 unresolved** |
| RTL and 200% zoom not measured | **Closed.** 88 cells across 9 widths, 200% zoom and RTL |
| `WEBHOOK_DELIVERY_INTERNAL_ONL` clipping not reproduced | **Reproduced.** See below |
| Access Reviews placement contradiction | **Resolved.** See Route placement |
| Most of 2,700 controls source-traced only | **Partially closed** — see Verdict |
| Working tree changed concurrently | **Closed.** Isolated worktree `D:/pv-audit-completion`, dedicated branch, clean tree |

## Baseline and provenance

| | |
| --- | --- |
| Original audit baseline | `214315a527771aec8dbc84ea7ff4ddff34fbbda6` |
| Completion baseline | `ec92bc6a92b6463a6e5684bc676262fc48c460b9` |
| Drift between them | 56 files |
| Files backing a finding that changed | `services/api/src/services/operations/remediation-executor.ts` |
| Previous artifact SHA-256 (JSON) | `91fb032bc0a41d440d9039c708c3f18ae5eb269bdf760d1d6d145870cc818c84` |
| Previous artifact SHA-256 (Markdown) | `08be3419beb6005066d2721d806c1df147b66626e5a191df67c401a0f1a4d6e4` |

PV-OPS-001 was retested against the new baseline and stands. Every other finding's cited files are byte-identical, so their evidence is revalidated rather than re-gathered.

## Conservation gates

- `surfacesDiscovered == surfacesClassified + surfacesOutOfScope` → **PASS**
- `pagesDiscovered == pagesReviewed` → **PASS**
- `elementsDiscovered == elementsClassified` → **PASS**
- `controlsDiscovered == controlsTraced` → **PASS**
- `UNKNOWN pages == 0` → **PASS**
- `NOT_REVIEWED pages == 0` → **PASS**
- `backend routes known == classified` → **PASS**
- `UNKNOWN backend routes == 0` → **PASS**
- `AMBIGUOUS backend routes == 0` → **PASS**
- `unresolved dynamic frontend calls == 0` → **PASS**
- `Enterprise Admin pages runtime-unreviewed == 0` → **PASS**
- `safe unique control actions == runtime executed` → **FAIL**

| Measure | Value |
| --- | ---: |
| Administrative surfaces classified | 141 |
| Elements classified | 4837 |
| Controls traced | 2700 |
| Unique mutation actions discovered | 637 |
| …of those UI-reachable | 554 |
| …executed end to end | 12 |
| …step-up gated | 98 |
| Backend routes known (was 1,107) | 1140 |
| Backend routes classified | 1140 |
| Unknown / ambiguous backend routes | 0 / 0 |
| Dynamic frontend call sites examined | 79 |
| …production sites | 18 |
| …unresolved | 0 |
| Enterprise organization routes runtime-reviewed | 21 |
| Destructive/step-up families executed | 7 |
| Viewport/zoom/RTL cells measured | 88 |
| …with page-level overflow | 0 |
| …with container overflow | 44 |
| Raw technical strings | 198 |
| Findings retained / revised / added | 27 / 3 / 7 |

Findings by severity: **P1_TRUST_OR_OPERATIONAL** 2 · **P2_PRODUCT_OR_WORKFLOW** 13 · **P3_PRESENTATION_OR_DEBT** 17 · **P1_SECURITY** 2

## Backend route classification (1140)

| Bucket | Count |
| --- | ---: |
| `PRODUCT_UI_COMPLETE` | 870 |
| `PRODUCT_UI_PARTIAL` | 138 |
| `PRODUCT_UI_MISSING` | 65 |
| `INTENTIONALLY_API_ONLY` | 24 |
| `CRON_INTERNAL` | 19 |
| `WORKER_INTERNAL` | 8 |
| `HEALTH_OR_TELEMETRY` | 5 |
| `WEBHOOK_RECEIVER` | 4 |
| `EXTERNAL_CALLBACK` | 3 |
| `TEST_OR_FIXTURE_ONLY` | 3 |
| `SECURITY_SENSITIVE_NO_UI_BY_DESIGN` | 1 |

### `PRODUCT_UI_MISSING` (65)

Routes in a resource family where no page issues any request. These are the operator capabilities without a control.

| Family | Routes |
| --- | ---: |
| `/v1/integrations/webhooks` | 7 |
| `/v1/integrations/api-keys` | 6 |
| `/v1/governance/export-snapshots` | 4 |
| `/v1/admin/runtime` | 4 |
| `/v1/governance/legal-holds` | 3 |
| `/v1/governance/case-legal-holds` | 3 |
| `/v1/integrations/webhook-deliveries` | 3 |
| `/v1/users/me` | 3 |
| `/v1/admin/organizations` | 2 |
| `/v1/external-review/access` | 2 |
| `/v1/identity/links` | 2 |
| `/v1/redaction/policy` | 2 |
| `/v1/search/reindex` | 2 |
| `/v1/ai/search` | 1 |
| `/v1/billing/subscription` | 1 |
| `/v1/billing/plan` | 1 |
| `/v1/cases/summary` | 1 |
| `/v1/collaboration-team-notifications` | 1 |
| `/v1/collaboration-team-notifications/:notificationId` | 1 |
| `/v1/collaboration-team-notifications/read-all` | 1 |
| `/v1/collaboration-team-invites/accept` | 1 |
| `/v1/collaboration-teams/entitlement` | 1 |
| `/v1/collaboration-teams/responsibility` | 1 |
| `/v1/break-glass/emergency` | 1 |
| `/v1/external-review/activity` | 1 |
| `/v1/identity-security/sessions` | 1 |
| `/v1/intelligence/search` | 1 |
| `/v1/internal/search` | 1 |
| `/v1/investigation/diagnostics` | 1 |
| `/v1/identity/mfa-admin` | 1 |
| `/v1/operations/signers` | 1 |
| `/v1/reviewer-ops/runtime-probe` | 1 |
| `/v1/runtime/otel-health` | 1 |
| `/v1/runtime/secrets-health` | 1 |
| `/v1/_test/rate-limit` | 1 |

Full per-route detail, with authority and call sites, is in the JSON under `backendInventory.routes`.

## Enterprise Organization authority matrix

Nine actors against a populated Enterprise Organization, and against a foreign one.

| Endpoint | org-owner | org-admin | security-admin | org-auditor | ordinary-member | workspace-admin | pa-member | pa-outsider | foreign-owner |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `GET /v1/orgs/:id` | 200 | 200 | 200 | 200 | 200 | 200 | 403 | 403 | 403 |
| `GET /v1/orgs/:id/members` | 200 | 200 | 200 | 200 | 200 | 200 | 403 | 403 | 403 |
| `GET /v1/orgs/:id/workspaces` | 200 | 200 | 200 | 200 | 200 | 200 | 403 | 403 | 403 |
| `GET /v1/orgs/:id/invites` | 200 | 200 | 403 | 403 | 403 | 403 | 403 | 403 | 403 |
| `GET /v1/orgs/:id/audit-events` | 200 | 200 | 200 | 200 | 403 | 403 | 403 | 403 | 403 |
| `GET /v1/orgs/:id/closure` | 200 | 403 owner_requ | 403 owner_requ | 403 owner_requ | 403 owner_requ | 403 owner_requ | 403 owner_requ | 403 owner_requ | 403 owner_requ |
| `GET /v1/orgs/:id/domains` | 200 | 200 | 403 forbidden | 403 forbidden | 403 forbidden | 403 forbidden | 403 forbidden | 403 forbidden | 403 forbidden |
| `GET /v1/orgs/:id/policies/retention` | 200 | 200 | 200 | 200 | 200 | 200 | 404 | 404 | 404 |
| `GET /v1/orgs/:id/billing/rollup` | 200 | 200 | 200 | 404 | 404 | 404 | 404 | 404 | 404 |
| `GET /v1/orgs/:id/governance/control-center` | 200 | 200 | 200 | 200 | 404 | 404 | 404 | 404 | 404 |

**Platform authority grants no organization reach.** Both platform admins — the one who IS a member of a customer workspace and the one who is not — are refused on every endpoint. That is the organization-level counterpart of the workspace-level experiment in `PV-PLACE-001`.

## Destructive and step-up execution

Step-up was satisfied for real: an SMS contact factor enrolled through the product's own route, the outbound code delivered to the fixture's **recording** transport instead of Twilio, and the verified challenge id presented in `x-proovra-step-up-challenge-id`. Only the carrier is stubbed.

| Action | Status | Disposition | Durable effect |
| --- | --- | --- | --- |
| SCIM token revoke | 200 | `RUNTIME_EXECUTED_SUCCESS` | REVOKED → REVOKED |
| SCIM token create (Enterprise) | 201 | `RUNTIME_EXECUTED_SUCCESS` | 3 → 4 **(changed)** |
| SCIM token create (FREE workspace, expect 402) | 402 | `RUNTIME_EXECUTED_REFUSAL` | 0 → 0 |
| Identity provider transition (revoke) | 200 | `RUNTIME_EXECUTED_SUCCESS` | REVOKED → REVOKED |
| MFA recovery approve | 200 | `RUNTIME_EXECUTED_SUCCESS` | PENDING_ADMIN_REVIEW → APPROVED **(changed)** |
| Access review decision | 200 | `RUNTIME_EXECUTED_SUCCESS` | PENDING → COMPLETED_KEEP **(changed)** |
| Emergency session revoke | 200 | `RUNTIME_EXECUTED_SUCCESS` | 3 → 8 **(changed)** |

## The mandated button journeys

| Journey | Disposition | What actually happened |
| --- | --- | --- |
| SCIM New token | `REVEALS_INLINE_FORM` | +17 elements, +1 visible inputs |
| Identity Providers New connection | `REVEALS_INLINE_FORM` | +42 elements, +7 visible inputs |
| SAML Configure | `CONTROL_NOT_PRESENT` | the named control does not exist on this page |
| Access reviews Regenerate queue | `OPENS_DIALOG` | confirmation dialog |
| Access reviews Refresh | `ISSUES_REQUEST` | `GET /v1/identity/access-reviews` |
| MFA recovery Refresh | `ISSUES_REQUEST` | `GET /v1/identity/mfa-admin/recovery-requests/0adf0000-0000-4000-8000-0000000000b1` |
| SSO mapping Preview | `ISSUES_REQUEST` | `POST /v1/saml/mapping/preview` |

`SAML Configure` **does not exist**. The page's primary action is `Ingest metadata`, which is disabled with no reason given — recorded as `PV-DIS-003`.

## The `WEBHOOK_DELIVERY_INTERNAL_ONL` clipping

REPRODUCED. The value is never text-truncated — 30 characters in source, in the live CHECK constraint, in a varchar(60) column and in the DOM, with scrollWidth == clientWidth at every width tested. What happens below 430 CSS px is that the list item runs off the RIGHT EDGE of the viewport inside the non-scrolling .admin-premium-shell.

| Viewport | Element right edge | Off-screen |
| ---: | ---: | ---: |
| 320px | 425px | **105px** |
| 360px | 425px | **65px** |
| 375px | 425px | **50px** |
| 390px | 425px | **35px** |
| 430px | 425px | fits |

**Threshold:** Visible in full at >= 430 CSS px; progressively cut below it.

## Corrections to the previous audit

### totals.backendRoutesKnown

- **Was:** 1107
- **Now:** 1140
- **Why:** The previous figure came from the repository inventory's scanner, whose comment-stripper deletes source regions and which counted only /v1 string-literal registrations. See PV-INV-001.

### runtimeProof.environment.isolation

- **Was:** services/api/.env neither read nor modified
- **Now:** DB, Redis, S3 and the transports were allowlisted and local, and every integration flag was off, so nothing outbound fired. But the API process DID back-fill non-allowlisted variables from services/api/.env in the previous audit's worktree. See PV-SEC-002.
- **Why:** Proven by comparing the startup snapshot in a worktree with and without that file.

### runtimeProof.needsRuntimeProof[0] — Enterprise organization pages

- **Was:** NEEDS_RUNTIME_PROOF
- **Now:** CURRENT_RUNTIME_PROVEN
- **Why:** The completion fixture seeds a real Enterprise Organization with six organization roles. All 21 organization routes were swept in a browser as org-admin with zero API failures and real data (6 members, 3 workspaces, 8 role rows, 2 billing rows, 3 integration rows).

### The claim that two mandated buttons produced no observable result

- **Was:** provisional CLICK_NO_OBSERVABLE_RESULT for SCIM 'New token' and IdP 'New connection'
- **Now:** REVEALS_INLINE_FORM for both
- **Why:** The first detector compared [role=dialog] counts on pages that already contain a dialog element, so the count did not change. Measuring element and visible-input counts shows the clicks add 5 and 23 elements respectively, including the provider select, display-name, secret and allowed-domains inputs. Recorded because a rejected hypothesis is a result.

## Findings (34)

| ID | Severity | Finding | Status |
| --- | --- | --- | --- |
| `PV-SEC-002` | P1_SECURITY | The fixture launcher's isolation does not cover the API's own .env loader, so a local run holds production secrets | PRIOR_EVIDENCE_REVALIDATED |
| `PV-SEC-002` | P1_SECURITY | The fixture launcher's isolation does not cover the API's own .env loader, so a local run holds production secrets | CURRENT_RUNTIME_PROVEN |
| `PV-AUD-001` | P1_TRUST_OR_OPERATIONAL | Identity Audit 'Actor' column is fabricated from the query filter | PRIOR_EVIDENCE_REVALIDATED |
| `PV-AUD-002` | P1_TRUST_OR_OPERATIONAL | Effective-retention resolver returns 500 on its default call path | PRIOR_EVIDENCE_REVALIDATED |
| `PV-PLACE-001` | P2_PRODUCT_OR_WORKFLOW | Eleven /admin pages are customer-tenant administration under a Platform-Admin URL and gate | SOURCE_CHANGED_RETESTED |
| `PV-DUP-001` | P2_PRODUCT_OR_WORKFLOW | Identity-provider administration exists twice, with different gates, and the stated reason for keeping the /admin copy no longer holds | PRIOR_EVIDENCE_REVALIDATED |
| `PV-OPS-001` | P2_PRODUCT_OR_WORKFLOW | A refused Resolve reports the wrong reason for one of the two refusal codes | SOURCE_CHANGED_RETESTED |
| `PV-A11Y-001` | P2_PRODUCT_OR_WORKFLOW | Thirty-three routes nest a second <main> landmark inside the shell's | PRIOR_EVIDENCE_REVALIDATED |
| `PV-DIS-001` | P2_PRODUCT_OR_WORKFLOW | Forty-three visible disabled controls across twenty-six routes offer no reason | PRIOR_EVIDENCE_REVALIDATED |
| `PV-LANG-001` | P2_PRODUCT_OR_WORKFLOW | Audit event labels are generated by mechanical title-casing, mangling 104 of 382 event types | PRIOR_EVIDENCE_REVALIDATED |
| `PV-LANG-003` | P2_PRODUCT_OR_WORKFLOW | 198 raw technical strings reach operator-facing text across the administrative surfaces | PRIOR_EVIDENCE_REVALIDATED |
| `PV-ALLOW-001` | P2_PRODUCT_OR_WORKFLOW | Trigger and Action allowlists are raw identifiers with no labels, no descriptions, and a two-column grid that overflows at 320px | PRIOR_EVIDENCE_REVALIDATED |
| `PV-STATE-001` | P2_PRODUCT_OR_WORKFLOW | Destruction requests render an empty state while the list request is refused | PRIOR_EVIDENCE_REVALIDATED |
| `PV-STEPUP-001` | P2_PRODUCT_OR_WORKFLOW | Step-up accepts only SMS or WhatsApp, so an authenticator-app user cannot perform any sensitive action | PRIOR_EVIDENCE_REVALIDATED |
| `PV-DIS-003` | P2_PRODUCT_OR_WORKFLOW | SAML metadata ingest and organization member actions are disabled with no reason offered | PRIOR_EVIDENCE_REVALIDATED |
| `PV-STEPUP-001` | P2_PRODUCT_OR_WORKFLOW | Step-up accepts only SMS or WhatsApp, so an authenticator-app user cannot perform any sensitive action | CURRENT_RUNTIME_PROVEN |
| `PV-DIS-003` | P2_PRODUCT_OR_WORKFLOW | SAML metadata ingest and organization member actions are disabled with no reason offered | CURRENT_RUNTIME_PROVEN |
| `PV-LANG-002` | P3_PRESENTATION_OR_DEBT | 'Event' and 'Summary' are the same value twice on the Identity Audit table | PRIOR_EVIDENCE_REVALIDATED |
| `PV-COPY-001` | P3_PRESENTATION_OR_DEBT | The Integrations unavailable panel contradicts itself and prints diagnostics | PRIOR_EVIDENCE_REVALIDATED |
| `PV-COPY-002` | P3_PRESENTATION_OR_DEBT | MFA recovery queue's empty state describes recovery codes rather than pending requests | PRIOR_EVIDENCE_REVALIDATED |
| `PV-NAV-001` | P3_PRESENTATION_OR_DEBT | Retention policies breadcrumb repeats 'Governance' | PRIOR_EVIDENCE_REVALIDATED |
| `PV-DOC-001` | P3_PRESENTATION_OR_DEBT | automation-actions.service.ts states an action is not implemented that the same file implements | PRIOR_EVIDENCE_REVALIDATED |
| `PV-API-001` | P3_PRESENTATION_OR_DEBT | The MFA recovery list route answers outside the error envelope and outside the family's anti-enumeration convention | PRIOR_EVIDENCE_REVALIDATED |
| `PV-DUP-002` | P3_PRESENTATION_OR_DEBT | Two retention resolvers answer the same operator question on one page | PRIOR_EVIDENCE_REVALIDATED |
| `PV-TOOL-001` | P3_PRESENTATION_OR_DEBT | The fixture web launcher exits 0 when the build fails | SOURCE_CHANGED_RETESTED |
| `PV-I18N-001` | P3_PRESENTATION_OR_DEBT | The sign-in page shows a German label on an English page | PRIOR_EVIDENCE_REVALIDATED |
| `PV-API-002` | P3_PRESENTATION_OR_DEBT | MFA enrolment always issues TOTP and silently ignores the requested kind | PRIOR_EVIDENCE_REVALIDATED |
| `PV-ORG-001` | P3_PRESENTATION_OR_DEBT | Organization sub-resources conceal with 404 while the organization itself refuses with 403 | PRIOR_EVIDENCE_REVALIDATED |
| `PV-A11Y-002` | P3_PRESENTATION_OR_DEBT | An unnamed button ships on the SAML SSO page | PRIOR_EVIDENCE_REVALIDATED |
| `PV-INV-001` | P3_PRESENTATION_OR_DEBT | The route-inventory scanner under-reports registrations, and the previous audit's 1,107 was low | PRIOR_EVIDENCE_REVALIDATED |
| `PV-API-002` | P3_PRESENTATION_OR_DEBT | MFA enrolment always issues TOTP and silently ignores the requested kind | CURRENT_RUNTIME_PROVEN |
| `PV-ORG-001` | P3_PRESENTATION_OR_DEBT | Organization sub-resources conceal with 404 while the organization itself refuses with 403 | CURRENT_RUNTIME_PROVEN |
| `PV-A11Y-002` | P3_PRESENTATION_OR_DEBT | An unnamed button ships on the SAML SSO page | CURRENT_RUNTIME_PROVEN |
| `PV-INV-001` | P3_PRESENTATION_OR_DEBT | The route-inventory scanner under-reports registrations, and the previous audit's 1,107 was low | CURRENT_RUNTIME_PROVEN |

### PV-SEC-002 — The fixture launcher's isolation does not cover the API's own .env loader, so a local run holds production secrets

**P1_SECURITY** · FIXTURE_ISOLATION_GAP · **PRIOR_EVIDENCE_REVALIDATED**

> Supporting files byte-identical on the completion baseline.

- **Route** `n/a (developer + audit tooling)`
- **Endpoint** `n/a`
- **Backend** `services/api/src/env.ts:31-71 (loadEnvFile) vs scripts/local-fixture-env/index.mjs:232-248 (DOTENV_CONFIG_PATH)`

**Observed.** The fixture environment is built from an allowlist and additionally sets DOTENV_CONFIG_PATH to a non-existent file, with the comment 'so services/api/.env cannot fill a variable this allowlist happens not to set'. That guard targets `import "dotenv/config"`, which services/api/src no longer imports anywhere. The loader the API actually runs is env.ts's own readFileSync loader, which reads <cwd>/.env, services/api/.env and the repo-root .env and fills every variable still undefined. It never consults DOTENV_CONFIG_PATH. The one switch that would stop it, PROOVRA_ENV_BOOTSTRAPPED, is set only by the test bootstrap and by neither fixture launcher.

**Expected.** A fixture process holds only the allowlisted environment. Any variable outside the allowlist stays undefined.

**Code evidence.** env.ts lines 65-71 call loadEnvFile(cwdEnv), loadEnvFile(serviceEnv), loadEnvFile(repoRootEnv); `grep -c DOTENV_CONFIG_PATH services/api/src/env.ts` returns 0; `grep -rn 'dotenv/config' services/api/src` returns only comments describing its REMOVAL. TWILIO_ACCOUNT_SID does not appear in scripts/local-fixture-env/index.mjs.

**Runtime evidence.** The same launcher at the same commit, in two worktrees. In D:/digital-witness, which contains services/api/.env, the startup snapshot reports communications.twilio {configured: true}. In D:/pv-audit-completion, which has no .env, the same snapshot reports {configured:false, reason:'missing:TWILIO_ACCOUNT_SID,TWILIO_API_KEY,TWILIO_API_SECRET'}. Nothing else differs.

**Root cause.** A mitigation written against the loader the code used at the time, left in place after the loader was replaced.

**Operator risk.** None for customers; this is a developer-tooling boundary.  
**Security / data risk.** A local fixture run holds every production credential in services/api/.env that the allowlist does not overwrite — Twilio, Resend, Sentry, OpenAI and anything else in that file. The allowlist DOES pin DATABASE_URL, REDIS_URL and S3, so storage and data stayed local, and every integration flag is off, so nothing outbound fired. The exposure is possession, not use. This also qualifies the previous audit's isolation statement, which is corrected in this pass.

**Fix.** Set PROOVRA_ENV_BOOTSTRAPPED=1 in buildLocalFixtureEnv. It is the switch env.ts already honours, it needs no new mechanism, and it makes allowlist completeness unnecessary — which is what the DOTENV_CONFIG_PATH note was trying to achieve.  
**Acceptance proof.** Start the fixture API in a worktree that HAS services/api/.env; the startup snapshot must report twilio {configured:false} and getEnvSourceHint() must report no .env source.

### PV-SEC-002 — The fixture launcher's isolation does not cover the API's own .env loader, so a local run holds production secrets

**P1_SECURITY** · FIXTURE_ISOLATION_GAP · **CURRENT_RUNTIME_PROVEN**

- **Route** `n/a (developer + audit tooling)`
- **Endpoint** `n/a`
- **Backend** `services/api/src/env.ts:31-71 (loadEnvFile) vs scripts/local-fixture-env/index.mjs:232-248 (DOTENV_CONFIG_PATH)`

**Observed.** The fixture environment is built from an allowlist and additionally sets DOTENV_CONFIG_PATH to a non-existent file, with the comment 'so services/api/.env cannot fill a variable this allowlist happens not to set'. That guard targets `import "dotenv/config"`, which services/api/src no longer imports anywhere. The loader the API actually runs is env.ts's own readFileSync loader, which reads <cwd>/.env, services/api/.env and the repo-root .env and fills every variable still undefined. It never consults DOTENV_CONFIG_PATH. The one switch that would stop it, PROOVRA_ENV_BOOTSTRAPPED, is set only by the test bootstrap and by neither fixture launcher.

**Expected.** A fixture process holds only the allowlisted environment. Any variable outside the allowlist stays undefined.

**Code evidence.** env.ts lines 65-71 call loadEnvFile(cwdEnv), loadEnvFile(serviceEnv), loadEnvFile(repoRootEnv); `grep -c DOTENV_CONFIG_PATH services/api/src/env.ts` returns 0; `grep -rn 'dotenv/config' services/api/src` returns only comments describing its REMOVAL. TWILIO_ACCOUNT_SID does not appear in scripts/local-fixture-env/index.mjs.

**Runtime evidence.** The same launcher at the same commit, in two worktrees. In D:/digital-witness, which contains services/api/.env, the startup snapshot reports communications.twilio {configured: true}. In D:/pv-audit-completion, which has no .env, the same snapshot reports {configured:false, reason:'missing:TWILIO_ACCOUNT_SID,TWILIO_API_KEY,TWILIO_API_SECRET'}. Nothing else differs.

**Root cause.** A mitigation written against the loader the code used at the time, left in place after the loader was replaced.

**Operator risk.** None for customers; this is a developer-tooling boundary.  
**Security / data risk.** A local fixture run holds every production credential in services/api/.env that the allowlist does not overwrite — Twilio, Resend, Sentry, OpenAI and anything else in that file. The allowlist DOES pin DATABASE_URL, REDIS_URL and S3, so storage and data stayed local, and every integration flag is off, so nothing outbound fired. The exposure is possession, not use. This also qualifies the previous audit's isolation statement, which is corrected in this pass.

**Fix.** Set PROOVRA_ENV_BOOTSTRAPPED=1 in buildLocalFixtureEnv. It is the switch env.ts already honours, it needs no new mechanism, and it makes allowlist completeness unnecessary — which is what the DOTENV_CONFIG_PATH note was trying to achieve.  
**Acceptance proof.** Start the fixture API in a worktree that HAS services/api/.env; the startup snapshot must report twilio {configured:false} and getEnvSourceHint() must report no .env source.

### PV-AUD-001 — Identity Audit 'Actor' column is fabricated from the query filter

**P1_TRUST_OR_OPERATIONAL** · FALSE_ATTRIBUTION · **PRIOR_EVIDENCE_REVALIDATED**

> admin-identity.routes.ts and auditPresentation.ts are byte-identical on the completion baseline.

- **Route** `/admin/identity/timeline`
- **Endpoint** `GET /v1/admin/identity/timeline`
- **Backend** `services/api/src/routes/admin-identity.routes.ts:1051-1060`

**Observed.** The projection sets actorUserId: q.subjectUserId ?? null. With no subjectUserId filter every row carries null and the page renders 'System'. With ?subjectUserId=<X> every row instead claims X as the actor, whoever really acted.

**Expected.** The Actor column shows the user who performed the event, or an explicit 'unknown' when attribution was never recorded.

**Code evidence.** admin-identity.routes.ts:1055 `actorUserId: q.subjectUserId ?? null`; page.tsx:275 `actorType: e.actorUserId ? "HUMAN" : "SYSTEM"` launders 'unknown' into 'System' even though presentActor (apps/web/lib/audit/auditPresentation.ts:106-125) has a correct UNKNOWN_LEGACY branch.

**Runtime evidence.** GET /v1/admin/identity/timeline?teamId=<northwind>&limit=5 -> every row actorUserId=null. Same query with &subjectUserId=0adf...0002 -> the identical rows return actorUserId=0adf...0002. The sso_health_checked row was in fact performed by 0adf...0001.

**Root cause.** The route projects the request filter instead of the stored actor. The writer (identity-operations-completion.routes.ts:464) records the actor only inside the details JSONB, never in the queryable SecurityEvent.userId column, so no correct value is available to project either.

**Operator risk.** The surface an operator opens to answer 'who changed our SSO' answers with a value derived from their own filter. On this fixture 100% of rows attribute to 'System'.  
**Security / data risk.** Audit-integrity: a compliance timeline that misattributes actions cannot support an investigation or an access review.

**Fix.** Persist the acting user in SecurityEvent.userId at write time and project that column. Keep presentActor's UNKNOWN_LEGACY branch for historical rows rather than defaulting them to SYSTEM.  
**Acceptance proof.** GET the timeline with and without subjectUserId; the actor of a known event is the same in both, and equals the user who performed it.

### PV-AUD-002 — Effective-retention resolver returns 500 on its default call path

**P1_TRUST_OR_OPERATIONAL** · UNCONDITIONAL_SERVER_ERROR · **PRIOR_EVIDENCE_REVALIDATED**

> retention-engine.service.ts unchanged; the '__never__' UUID sentinel is still present at lines 578/586/594.

- **Route** `/governance/retention`
- **Endpoint** `GET /v1/governance/retention-policies/effective`
- **Backend** `services/api/src/services/governance-lifecycle/retention-engine.service.ts:573-597`

**Observed.** Unless evidenceType, jurisdiction AND caseId are all supplied the query includes an OR arm { id: "__never__" }. `id` is @db.Uuid, so Prisma rejects the whole query with P2007 and the API answers 500 DATABASE_ERROR, additionally emitting an operational.alert at severity 'critical'.

**Expected.** A resolver called with no optional scope filters returns the workspace-level decision.

**Code evidence.** retention-engine.service.ts:578,586,594 `{ id: "__never__" }`; services/api/prisma/schema.prisma:8841 `id String @id ... @db.Uuid`.

**Runtime evidence.** ?teamId=<t> -> 500; ?teamId=<t>&evidenceType=PHOTO -> 500; ?teamId=<t>&evidenceType=PHOTO&jurisdiction=EU&caseId=<uuid> -> 200 {"policy":null,"reason":"no_active_policy"}. API log: prismaCode P2007, model EvidenceRetentionPolicy, then reason api_5xx_response severity critical.

**Root cause.** A sentinel chosen as an impossible string is not type-valid for a UUID column, so it invalidates the query rather than matching nothing.

**Operator risk.** The governance page's effective-retention panel never resolves on the default view; each load raises a critical operational alert, training operators to ignore that alert class.  
**Security / data risk.** None directly; the UI does render a safe failure card rather than a false answer.

**Fix.** Build the OR array by pushing only the arms whose input is present, instead of emitting an impossible-id no-op arm.  
**Acceptance proof.** GET the endpoint with teamId only and receive 200, and no api_5xx_response alert in the log for that request.

### PV-PLACE-001 — Eleven /admin pages are customer-tenant administration under a Platform-Admin URL and gate

**P2_PRODUCT_OR_WORKFLOW** · MISPLACED_ROUTE · **SOURCE_CHANGED_RETESTED**

> STRENGTHENED. The completion pass adds the organization dimension: a platform admin — whether or not they are a member of a customer WORKSPACE — receives 403/404 on every /v1/orgs/:id endpoint. Platform authority grants no reach at organization level either, so the eleven pages are tenant administration on both axes.

- **Route** `/admin/identity, /admin/identity/permission-matrix, /admin/identity/providers, /admin/identity/runtime, /admin/identity/scim, /admin/identity/sessions, /admin/identity/timeline, /admin/platform/analytics, /admin/platform/automation, /admin/platform/reliability, /admin/security`
- **Endpoint** `37 of 74 param-free GET endpoints reachable from /admin are platform; 32 are ordinary tenant endpoints`
- **Backend** `requireIdentityAdmin (admin-identity.routes.ts:133), requireScimAdmin (scim-admin.routes.ts:50), resolveAuthorizedWorkspaceSubject`

**Observed.** Every param-free GET these pages make is callable by an ordinary organization owner, and the platform-admin capability grants no cross-tenant reach: for a workspace the operator is not a member of, /v1/admin/identity/* answers 404 for the platform admin while answering 200 for that workspace's own owner.

**Expected.** /admin is the Platform Admin console; a page under it administers the platform or a named tenant chosen by the operator, not the operator's own workspace.

**Code evidence.** requireIdentityAdmin resolves prisma.teamMember for the caller and returns 404 when absent; it never consults resolvePlatformAdmin. The eleven pages all read useTeamId() (the operator's own active workspace).

**Runtime evidence.** Cross-tenant matrix: /v1/admin/identity/providers?teamId=<Quiet Chambers> -> platform-admin 404, org-owner (that tenant's owner) 200. Same for scim/tokens and timeline. probe-admin-split: 32 endpoints reachable by org-owner, 37 refused to org-owner.

**Root cause.** The pages were built inside the platform console but bound to the operator's active workspace, so the URL and the gate describe an audience the code never had.

**Operator risk.** A genuine platform operator who is not a member of a customer workspace cannot use these pages for any customer; they silently administer the operator's own workspace instead.  
**Security / data risk.** None observed: the backend is tenant-correct and the frontend gate is stricter than the API. The risk is comprehension, not access.

**Fix.** Owner decision PV-OD-001. Either move them to a workspace/organization family, or keep them and add an explicit tenant selector so /admin means 'the platform, or a tenant I have chosen'.  
**Acceptance proof.** For each page, either the operator can pick which tenant it administers, or the route no longer sits under /admin.

### PV-DUP-001 — Identity-provider administration exists twice, with different gates, and the stated reason for keeping the /admin copy no longer holds

**P2_PRODUCT_OR_WORKFLOW** · DUPLICATE_SURFACE · **PRIOR_EVIDENCE_REVALIDATED**

> Both surfaces still consume /v1/admin/identity/providers; adminScopeDispositions.ts unchanged.

- **Route** `/admin/identity/providers  vs  /security-center/sso and /security-center/sso/mapping`
- **Endpoint** `GET /v1/admin/identity/providers — consumed by both`
- **Backend** `services/api/src/routes/admin-identity.routes.ts:326`

**Observed.** Two routes in two different navigation families read and write the same tenant SSO configuration through the same endpoint, under two different frontend gates.

**Expected.** One canonical surface per capability, or two surfaces with a stated division of responsibility.

**Code evidence.** Both pages call /v1/admin/identity/providers; adminScopeDispositions.ts:44-52 justifies keeping the /admin copy on the grounds that 'the platform gate is currently STRICTER than the API and moving it would widen the audience'.

**Runtime evidence.** GET /v1/platform/context shows org-owner and workspace-admin — neither a platform admin — both hold SECURITY_CENTER_VIEW, and /v1/admin/identity/providers returns 200 for org-owner. The audience is therefore already wide; the /admin copy restricts nothing.

**Root cause.** The two surfaces were built in different phases and the disposition register was written before /security-center/sso consumed the same endpoint.

**Operator risk.** Two places to configure SSO that can disagree about which is authoritative; a change made in one is invisible in the other's navigation.  
**Security / data risk.** None additional — the exposure already exists via /security-center.

**Fix.** Pick /security-center/sso as canonical for tenant SSO. Update adminScopeDispositions to record that the widening argument is obsolete.  
**Acceptance proof.** One route owns tenant SSO configuration; the other is a redirect or is gone; the disposition file no longer asserts the obsolete rationale.

### PV-OPS-001 — A refused Resolve reports the wrong reason for one of the two refusal codes

**P2_PRODUCT_OR_WORKFLOW** · MISLEADING_LABEL · **SOURCE_CHANGED_RETESTED**

> remediation-executor.ts CHANGED in ec92bc6a (artifact-regeneration outcome mapping). Retested: both refusal codes still reachable — 'Search index reconciliation failing' and 'Trusted timestamping failed' return CONDITION_STILL_ACTIVE, 'Worker heartbeat stale' returns CONDITION_NOT_DIRECTLY_RESOLVABLE — and the UI still shows one message for both. Finding stands unchanged.

- **Route** `/admin/operations`
- **Endpoint** `POST /v1/admin/incidents/:id/resolve`
- **Backend** `services/api/src/routes/admin-security.routes.ts:618-632`

**Observed.** The backend refuses with two distinct codes — CONDITION_STILL_ACTIVE and CONDITION_NOT_DIRECTLY_RESOLVABLE — and the UI shows one message for both: 'Its source still reports it as live, so the platform declined to close it.' That sentence is false for CONDITION_NOT_DIRECTLY_RESOLVABLE, where the condition has no direct remediation at all.

**Expected.** Each refusal code produces its own operator-facing sentence.

**Code evidence.** page.tsx:277-279 supplies a single fallback message for action === 'resolve'; the API sends message 'Incident action refused' plus the discriminating code.

**Runtime evidence.** Executing Resolve on one incident of each kind: IDENTITY_SECURITY 200 (OPERATOR_DECISION), REPORT 200 (SOURCE_TRUTH), RECONCILIATION 409 CONDITION_STILL_ACTIVE, EVIDENCE_INTEGRITY 409 CONDITION_STILL_ACTIVE, WORKER 409 CONDITION_NOT_DIRECTLY_RESOLVABLE.

**Root cause.** toSafeUserError is given one fallback per action rather than per refusal code.

**Operator risk.** An operator is told to wait for a source to clear when in fact no remediation exists, so they retry indefinitely.  
**Security / data risk.** None.

**Fix.** Map the two codes to two sentences; for NOT_DIRECTLY_RESOLVABLE say that the condition cannot be closed by hand and point at the runbook.  
**Acceptance proof.** Resolving a WORKER 'Unclassified security signal' shows a message that does not claim the source is still live.

### PV-A11Y-001 — Thirty-three routes nest a second <main> landmark inside the shell's

**P2_PRODUCT_OR_WORKFLOW** · INACCESSIBLE_STRUCTURE · **PRIOR_EVIDENCE_REVALIDATED**

> 33 routes still render a nested <main>.

- **Route** `33 routes (see runtimeProof.duplicateMainRoutes)`
- **Endpoint** `n/a`
- **Backend** `n/a`

**Observed.** The shell renders <main id="app-main-content" class="app-shell-v2-content"> and 33 pages render their own <main> inside it. Both are visible and carry content.

**Expected.** Exactly one main landmark per document.

**Code evidence.** Measured in the rendered DOM, not inferred from source.

**Runtime evidence.** e.g. /governance -> [{id:'app-main-content',w:1372,h:972,textLen:1202},{id:null,cls:'cc-page',w:1228,h:652,textLen:877}]; same shape on /integrations and /collaboration-teams/invites/:token/accept.

**Root cause.** Page components adopted a <main> wrapper independently of the shell that already provides one.

**Operator risk.** Landmark navigation offers two 'main' regions; the skip link targets only the outer one.  
**Security / data risk.** None.

**Fix.** Demote the page-level element to <div> or <section>; keep the shell's single <main>.  
**Acceptance proof.** document.querySelectorAll('main').length === 1 on every authenticated route.

### PV-DIS-001 — Forty-three visible disabled controls across twenty-six routes offer no reason

**P2_PRODUCT_OR_WORKFLOW** · DISABLED_WITHOUT_REASON · **PRIOR_EVIDENCE_REVALIDATED**

> Extended by PV-DIS-003 with three further named controls found on the Enterprise surfaces.

- **Route** `26 routes (see runtimeProof.disabledWithoutReason)`
- **Endpoint** `n/a`
- **Backend** `n/a`

**Observed.** 43 controls are rendered disabled with neither a title nor an aria-describedby. The same console does this well elsewhere — SCIM's 'New token' carries title='Issuing a token is part of the Enterprise plan. Existing tokens can still be revoked.' — so the omission is inconsistency, not an absent pattern.

**Expected.** Every disabled control states why, adjacently and accessibly.

**Code evidence.** 557 `disabled=` attributes across the in-scope tree; the rendered subset without a reason is 43.

**Runtime evidence.** Worst offenders: /organizations/:id/setup 6, /governance-platform/access-reviews 4, /governance-platform/policies 3, /admin/customers 2, /admin/users 2, /admin/workspaces 2, /admin/evidence-ops/records 2, /admin/identity/timeline 2, /governance/policy 2, /organizations/:id/admin/bulk-invite 2.

**Root cause.** No shared contract requiring a reason alongside `disabled`.

**Operator risk.** An operator cannot tell a missing permission from a missing plan from a missing prerequisite.  
**Security / data risk.** None.

**Fix.** Require a reason wherever `disabled` is set on an interactive control, and add a render-time guard.  
**Acceptance proof.** A DOM sweep finds zero visible disabled controls without title or aria-describedby.

### PV-LANG-001 — Audit event labels are generated by mechanical title-casing, mangling 104 of 382 event types

**P2_PRODUCT_OR_WORKFLOW** · RAW_TECHNICAL_VOCABULARY · **PRIOR_EVIDENCE_REVALIDATED**

> humaniseEventType unchanged; 104 of 382 event types still mangle an acronym.

- **Route** `/admin/identity/timeline, /admin/operations, /admin/security`
- **Endpoint** `GET /v1/admin/identity/timeline`
- **Backend** `services/api/src/routes/admin-identity.routes.ts:1190-1195`

**Observed.** humaniseEventType does eventType.replace(/_/g,' ').replace(/\b\w/g, c=>c.toUpperCase()). Every word is capitalised, so acronyms become Sso, Scim, Saml, Mfa, Rbac, Sla. 104 of the 382 SECURITY_EVENT_TYPES contain such an acronym. There is no curated label catalog.

**Expected.** Curated product labels ('SSO health checked'), with the technical identifier available as secondary detail.

**Code evidence.** The function's own comment says 'snake_case -> "Snake case"' while the code title-cases every word — the comment and the behaviour disagree.

**Runtime evidence.** GET timeline returns summary 'Sso Health Checked' for eventType sso_health_checked.

**Root cause.** A generated label was used where a curated vocabulary is needed.

**Operator risk.** The audit surface reads as machine output; 'Sso' is wrong in a document a customer may be shown.  
**Security / data risk.** None.

**Fix.** Introduce a label catalog keyed by event type; fall back to the mechanical transform only for unknown keys, and preserve a known-acronym list.  
**Acceptance proof.** sso_health_checked renders as 'SSO health checked'; no rendered label contains Sso/Scim/Saml/Mfa/Rbac/Sla.

### PV-LANG-003 — 198 raw technical strings reach operator-facing text across the administrative surfaces

**P2_PRODUCT_OR_WORKFLOW** · RAW_TECHNICAL_VOCABULARY · **PRIOR_EVIDENCE_REVALIDATED**

> 198 raw strings; none of the cited files changed.

- **Route** `63 routes; heaviest /admin/evidence-ops/records (10), /admin/identity/sessions (9), /intelligence-quality (8), /admin/platform/automation (7), /settings/notifications/deliveries (7)`
- **Endpoint** `various`
- **Backend** `various`

**Observed.** 74 string literals that are themselves identifiers appear in JSX text or label props (TSA_FAILED, HASH_MISMATCH, AUTO_RESOURCES, ENTERPRISE_DESK), and 124 bare member accesses of enum-valued fields render with no label lookup ({p.permission} printing identity.org_policy.read, {r.kind}, {detail.overview.status}).

**Expected.** Curated product language as primary text; the stored identifier only as secondary detail or copyable code.

**Code evidence.** e.g. permission-matrix/page.tsx:495 `<li key={p.permission}>{p.permission}</li>`; access-reviews/page.tsx:317 `<span className="adm-help">{r.kind}</span>`.

**Runtime evidence.** Two independent detectors over the 141 in-scope routes; 9 of the 198 sit inside <code>, which is the sanctioned secondary form.

**Root cause.** No shared enum-to-label layer; each surface decides individually.

**Operator risk.** Operators read database vocabulary and must learn it to use the product.  
**Security / data risk.** None.

**Fix.** One label module per enum family, consumed by every surface; keep the identifier as secondary text where an operator may need to quote it.  
**Acceptance proof.** The same two detectors return only the deliberate <code> cases.

### PV-ALLOW-001 — Trigger and Action allowlists are raw identifiers with no labels, no descriptions, and a two-column grid that overflows at 320px

**P2_PRODUCT_OR_WORKFLOW** · BOUNDED_ALLOWLIST_PRESENTATION · **PRIOR_EVIDENCE_REVALIDATED**

> automation/page.tsx unchanged.

- **Route** `/admin/platform/automation`
- **Endpoint** `GET /v1/automation/rules (allowlist travels in the envelope)`
- **Backend** `services/api/src/services/automation/automation.service.ts:60`

**Observed.** Each value renders as `<li><code>{t}</code></li>` — no human label, no description of what the trigger or action does, and no marking of which are internal-only. The section note reads 'Read-only. Adding a value requires a coordinated DB migration', which is a developer's explanation shown to an operator. The section uses a hard-coded gridTemplateColumns '1fr 1fr' with inline font sizes and no responsive fallback.

**Expected.** Curated name, then the technical identifier as secondary, then one sentence of business meaning.

**Code evidence.** page.tsx:663 `gridTemplateColumns: "1fr 1fr"`, :668-673 and :678-683 render bare <code>.

**Runtime evidence.** At 320px the section's scrollWidth is 394 against clientWidth 258 — a 136px overflow inside the container (the page body itself does not overflow). At 320/768/1440 the longest value, WEBHOOK_DELIVERY_INTERNAL_ONLY, renders complete and unclipped (201px), so the '...ONL' seen in the reported screenshot is display clipping under some other viewport, not data loss: the value is 30 characters in source, in the live CHECK constraint, and in the DOM.

**Root cause.** A diagnostic list was shipped as product UI.

**Operator risk.** An operator cannot tell what any trigger or action does, and at narrow widths the second column is pushed outside its container.  
**Security / data risk.** None.

**Fix.** Render each value as name + identifier + description, generated from one catalog beside the allowlist constant, and replace the fixed two-column grid with a responsive one.  
**Acceptance proof.** Each allowlist entry shows a curated name and a description; the section does not overflow at 320px.

### PV-STATE-001 — Destruction requests render an empty state while the list request is refused

**P2_PRODUCT_OR_WORKFLOW** · FAILURE_HIDDEN · **PRIOR_EVIDENCE_REVALIDATED**

> evidence-lifecycle/destruction unchanged.

- **Route** `/evidence-lifecycle/destruction`
- **Endpoint** `GET /v1/lifecycle/destruction/requests`
- **Backend** `services/api/src/routes (delegated-tier gate)`

**Observed.** GET /v1/lifecycle/destruction/requests returns 403, and the table shows 'No destruction requests pending — Create a destruction request above to route evidence through the approval and certified-destruction...'. The page states 'Permission required: DELEGATED_ADMIN' as a raw capability constant, and the 'Create Request' button is disabled with no reason attached.

**Expected.** A refused read says it was refused and what is needed; it does not claim the list is empty.

**Code evidence.** Empty-state branch is reached because the fetch rejection is not distinguished from an empty result.

**Runtime evidence.** Runtime sweep as platform-admin: apiFailures ['403 /v1/lifecycle/destruction/requests'], main text contains 'No destruction requests pending'.

**Root cause.** One branch serves both 'no rows' and 'could not read rows'.

**Operator risk.** An operator concludes there is nothing to approve when in fact they cannot see the queue.  
**Security / data risk.** A governance queue that appears empty when it is unreadable is a control gap in appearance if not in fact.

**Fix.** Split the refusal branch from the empty branch (the codebase already does this on /admin/identity/access-reviews, which renders a truthful refusal for its 402); replace 'Permission required: DELEGATED_ADMIN' with product language; give the disabled button its reason.  
**Acceptance proof.** With the read refused, the page says so; the empty state appears only on a 200 with zero rows.

### PV-STEPUP-001 — Step-up accepts only SMS or WhatsApp, so an authenticator-app user cannot perform any sensitive action

**P2_PRODUCT_OR_WORKFLOW** · UNSATISFIABLE_GATE_FOR_A_VALID_FACTOR · **PRIOR_EVIDENCE_REVALIDATED**

> Supporting files byte-identical on the completion baseline.

- **Route** `every step-up-gated control (SCIM rotate/revoke, emergency revoke, member role/suspend/revoke, IdP transitions, SAML mapping write, legal-hold place/release, public-verify publish)`
- **Endpoint** `POST /v1/identity-security/step-up/start`
- **Backend** `services/api/src/services/security/verified-contact-factor.service.ts:53-56 and :151-172; services/api/src/services/identity-security/step-up.service.ts:153-161`

**Observed.** startStepUpChallenge resolves the factor with resolveActiveContactFactor, whose CONTACT_FACTOR_KINDS is exactly ['SMS','WHATSAPP']. A TOTP factor — ACTIVE and verified — does not match, so the account is told 'This action needs a verified second factor. Enrol a device in Security settings, then try again.' even though it has one.

**Expected.** Either an authenticator factor satisfies step-up, or the refusal says which KIND of factor is required and links to the surface that enrols it.

**Code evidence.** CONTACT_FACTOR_KINDS = ['SMS','WHATSAPP']; resolveActiveContactFactor filters kind: { in: CONTACT_FACTOR_KINDS }; step-up.service.ts:161 throws enrollment_required when it returns null.

**Runtime evidence.** org-owner enrolled TOTP through the product's own /v1/identity/mfa/enroll/start and /enroll/verify (factor ACTIVE in mfa_factors). POST /v1/identity-security/step-up/start then returned 403 STEP_UP_ENROLLMENT_REQUIRED. After enrolling an SMS factor via /v1/identity-security/contact-factors/enroll/*, the identical call succeeded and the gated actions completed.

**Root cause.** Step-up is implemented on the external verification provider (one-time code to a phone), so the authenticator factor the product issues by default is not a candidate.

**Operator risk.** An enterprise that mandates authenticator apps and forbids SMS second factors cannot use any sensitive control. The refusal text sends the operator to enrol a device they already enrolled.  
**Security / data risk.** It also makes SMS the effective floor for the most privileged actions, which is the weaker factor.

**Fix.** Owner decision PV-OD-011. Minimum: make the refusal name the required kind and link to contact-factor enrolment. Better: accept TOTP as a step-up factor.  
**Acceptance proof.** With only a TOTP factor enrolled, a step-up-gated action either succeeds or refuses with a message naming the factor kind it needs.

### PV-DIS-003 — SAML metadata ingest and organization member actions are disabled with no reason offered

**P2_PRODUCT_OR_WORKFLOW** · DISABLED_WITHOUT_REASON · **PRIOR_EVIDENCE_REVALIDATED**

> Supporting files byte-identical on the completion baseline.

- **Route** `/security-center/sso, /organizations/:id/admin/members`
- **Endpoint** `POST /v1/auth/saml/:connectionId/ingest-metadata`
- **Backend** `services/api/src/routes (saml)`

**Observed.** 'Ingest metadata' renders disabled with no title and no aria-describedby. Its real condition is `busy[p.id] || !(metadataXml[p.id] ?? '').trim()` — the operator has not pasted metadata XML yet. On the organization members page, 'Send invite' and 'Suspend Org Admin' are likewise disabled with no reason.

**Expected.** The prerequisite is stated, as it already is on Archive Tiers' 'Move tier' ('Enter an evidence ID first').

**Code evidence.** sso/page.tsx:772 `disabled={busy[p.id] || !(metadataXml[p.id] ?? "").trim()}` with no title prop.

**Runtime evidence.** DOM capture at 1440px as platform-admin: /security-center/sso buttons = [Copy, Copy, {text:'Ingest metadata', disabled:true, title:null}, {text:'', disabled:false}]. Enterprise sweep as org-admin: /organizations/:id/admin/members disabledControls = [{name:'Send invite', reason:null},{name:'Suspend Org Admin', reason:null}].

**Root cause.** Same as PV-DIS-001: no shared contract requiring a reason beside `disabled`.

**Operator risk.** The SAML page's primary action looks broken rather than waiting for input.  
**Security / data risk.** None.

**Fix.** Add the reason to these three, and adopt the guard proposed in PV-DIS-001.  
**Acceptance proof.** Each of the three states its prerequisite.

### PV-STEPUP-001 — Step-up accepts only SMS or WhatsApp, so an authenticator-app user cannot perform any sensitive action

**P2_PRODUCT_OR_WORKFLOW** · UNSATISFIABLE_GATE_FOR_A_VALID_FACTOR · **CURRENT_RUNTIME_PROVEN**

- **Route** `every step-up-gated control (SCIM rotate/revoke, emergency revoke, member role/suspend/revoke, IdP transitions, SAML mapping write, legal-hold place/release, public-verify publish)`
- **Endpoint** `POST /v1/identity-security/step-up/start`
- **Backend** `services/api/src/services/security/verified-contact-factor.service.ts:53-56 and :151-172; services/api/src/services/identity-security/step-up.service.ts:153-161`

**Observed.** startStepUpChallenge resolves the factor with resolveActiveContactFactor, whose CONTACT_FACTOR_KINDS is exactly ['SMS','WHATSAPP']. A TOTP factor — ACTIVE and verified — does not match, so the account is told 'This action needs a verified second factor. Enrol a device in Security settings, then try again.' even though it has one.

**Expected.** Either an authenticator factor satisfies step-up, or the refusal says which KIND of factor is required and links to the surface that enrols it.

**Code evidence.** CONTACT_FACTOR_KINDS = ['SMS','WHATSAPP']; resolveActiveContactFactor filters kind: { in: CONTACT_FACTOR_KINDS }; step-up.service.ts:161 throws enrollment_required when it returns null.

**Runtime evidence.** org-owner enrolled TOTP through the product's own /v1/identity/mfa/enroll/start and /enroll/verify (factor ACTIVE in mfa_factors). POST /v1/identity-security/step-up/start then returned 403 STEP_UP_ENROLLMENT_REQUIRED. After enrolling an SMS factor via /v1/identity-security/contact-factors/enroll/*, the identical call succeeded and the gated actions completed.

**Root cause.** Step-up is implemented on the external verification provider (one-time code to a phone), so the authenticator factor the product issues by default is not a candidate.

**Operator risk.** An enterprise that mandates authenticator apps and forbids SMS second factors cannot use any sensitive control. The refusal text sends the operator to enrol a device they already enrolled.  
**Security / data risk.** It also makes SMS the effective floor for the most privileged actions, which is the weaker factor.

**Fix.** Owner decision PV-OD-011. Minimum: make the refusal name the required kind and link to contact-factor enrolment. Better: accept TOTP as a step-up factor.  
**Acceptance proof.** With only a TOTP factor enrolled, a step-up-gated action either succeeds or refuses with a message naming the factor kind it needs.

### PV-DIS-003 — SAML metadata ingest and organization member actions are disabled with no reason offered

**P2_PRODUCT_OR_WORKFLOW** · DISABLED_WITHOUT_REASON · **CURRENT_RUNTIME_PROVEN**

- **Route** `/security-center/sso, /organizations/:id/admin/members`
- **Endpoint** `POST /v1/auth/saml/:connectionId/ingest-metadata`
- **Backend** `services/api/src/routes (saml)`

**Observed.** 'Ingest metadata' renders disabled with no title and no aria-describedby. Its real condition is `busy[p.id] || !(metadataXml[p.id] ?? '').trim()` — the operator has not pasted metadata XML yet. On the organization members page, 'Send invite' and 'Suspend Org Admin' are likewise disabled with no reason.

**Expected.** The prerequisite is stated, as it already is on Archive Tiers' 'Move tier' ('Enter an evidence ID first').

**Code evidence.** sso/page.tsx:772 `disabled={busy[p.id] || !(metadataXml[p.id] ?? "").trim()}` with no title prop.

**Runtime evidence.** DOM capture at 1440px as platform-admin: /security-center/sso buttons = [Copy, Copy, {text:'Ingest metadata', disabled:true, title:null}, {text:'', disabled:false}]. Enterprise sweep as org-admin: /organizations/:id/admin/members disabledControls = [{name:'Send invite', reason:null},{name:'Suspend Org Admin', reason:null}].

**Root cause.** Same as PV-DIS-001: no shared contract requiring a reason beside `disabled`.

**Operator risk.** The SAML page's primary action looks broken rather than waiting for input.  
**Security / data risk.** None.

**Fix.** Add the reason to these three, and adopt the guard proposed in PV-DIS-001.  
**Acceptance proof.** Each of the three states its prerequisite.

### PV-LANG-002 — 'Event' and 'Summary' are the same value twice on the Identity Audit table

**P3_PRESENTATION_OR_DEBT** · DUPLICATE_COLUMN · **PRIOR_EVIDENCE_REVALIDATED**

> summary is still humaniseEventType(eventType).

- **Route** `/admin/identity/timeline`
- **Endpoint** `GET /v1/admin/identity/timeline`
- **Backend** `services/api/src/routes/admin-identity.routes.ts:1053,1059`

**Observed.** 'Event' renders <code>{e.kind}</code>; 'Summary' renders e.summary, and the API computes summary = humaniseEventType(eventType). Summary is a pure function of Event and carries no additional information.

**Expected.** A summary describes what happened to what; otherwise the column should not exist.

**Code evidence.** summary: humaniseEventType(e.eventType) at admin-identity.routes.ts:1059.

**Runtime evidence.** Row: kind sso_health_checked, summary 'Sso Health Checked'.

**Root cause.** The projection had no real summary to give and synthesised one.

**Operator risk.** A column of table width is spent restating the adjacent column.  
**Security / data risk.** None.

**Fix.** Either populate summary from the event's sanitised details (what changed, on which resource) or drop the column and show the curated label as the Event column with the identifier as secondary text.  
**Acceptance proof.** Summary is not derivable from Event alone for any row.

### PV-COPY-001 — The Integrations unavailable panel contradicts itself and prints diagnostics

**P3_PRESENTATION_OR_DEBT** · CONTRADICTORY_COPY · **PRIOR_EVIDENCE_REVALIDATED**

> integrations page unchanged.

- **Route** `/integrations`
- **Endpoint** `GET /v1/integrations/webhooks \| api-keys \| health`
- **Backend** `integrations routes (feature flag)`

**Observed.** The panel says 'Integrations are disabled because the API key signing secret is not configured in the running API environment.' and immediately prints 'reason=feature_flag_off apiKeySecret=ok cronSecret=...'. The stated cause (secret missing) is contradicted by the adjacent diagnostic (apiKeySecret=ok); the real reason is the feature flag.

**Expected.** One truthful sentence naming the actual reason, with diagnostics behind a disclosure.

**Code evidence.** Panel renders a fixed sentence plus a raw key=value diagnostic string.

**Runtime evidence.** API returns 503 {"error":{"code":"INTEGRATIONS_DISABLED","reason":"feature_flag_off"}}; main-region text captured as quoted above.

**Root cause.** The explanatory sentence is hard-coded to one cause while the reason is supplied by the API.

**Operator risk.** An operator chases a missing secret that is present.  
**Security / data risk.** None; the diagnostics shown are configuration states, not secret values.

**Fix.** Render the reason the API returns; move the key=value diagnostics behind 'Technical details'.  
**Acceptance proof.** With the flag off, the panel names the flag and does not assert a missing secret.

### PV-COPY-002 — MFA recovery queue's empty state describes recovery codes rather than pending requests

**P3_PRESENTATION_OR_DEBT** · WRONG_EMPTY_STATE_TEXT · **PRIOR_EVIDENCE_REVALIDATED**

> mfa-recovery page unchanged.

- **Route** `/security-center/mfa-recovery`
- **Endpoint** `GET /v1/identity/mfa-admin/recovery-requests/:teamId`
- **Backend** `services/api/src/routes/mfa-admin.routes.ts:595`

**Observed.** The Pending requests table renders the heading 'No recovery codes generated' immediately before the correct sentence 'No pending MFA recovery requests.' Recovery codes are a different object from recovery requests.

**Expected.** The empty state names the thing the table lists.

**Code evidence.** Two adjacent strings in the same empty branch.

**Runtime evidence.** Main-region capture: '... Pending requests USER REASON EMAIL VERIFIED APPROVALS EXPIRES No recovery codes generated No pending MFA recovery requests.'

**Root cause.** An empty-state title was reused from a neighbouring component.

**Operator risk.** Minor confusion on an otherwise well-written page.  
**Security / data risk.** None.

**Fix.** Title the empty state 'No pending recovery requests'.  
**Acceptance proof.** The empty state mentions requests, not codes.

### PV-NAV-001 — Retention policies breadcrumb repeats 'Governance'

**P3_PRESENTATION_OR_DEBT** · BREADCRUMB_DEFECT · **PRIOR_EVIDENCE_REVALIDATED**

> governance/retention breadcrumb unchanged.

- **Route** `/governance/retention`
- **Endpoint** `n/a`
- **Backend** `n/a`

**Observed.** The breadcrumb renders 'Northwind Legal > Governance > Governance > Retention policies'.

**Expected.** Each ancestor appears once.

**Code evidence.** Breadcrumb assembled from both a group label and a parent route label that resolve to the same word.

**Runtime evidence.** Main-region capture at 1440px.

**Root cause.** Group name and parent route name collide.

**Operator risk.** Cosmetic.  
**Security / data risk.** None.

**Fix.** De-duplicate adjacent identical crumbs when assembling the trail.  
**Acceptance proof.** No two adjacent crumbs are identical on any route.

### PV-DOC-001 — automation-actions.service.ts states an action is not implemented that the same file implements

**P3_PRESENTATION_OR_DEBT** · STALE_DOCUMENTATION · **PRIOR_EVIDENCE_REVALIDATED**

> automation-actions.service.ts unchanged; header still contradicts the dispatch table.

- **Route** `n/a (backend)`
- **Endpoint** `n/a`
- **Backend** `services/api/src/services/automation/automation-actions.service.ts:13-15 vs :157-159`

**Observed.** The header says 'WEBHOOK_DELIVERY_INTERNAL_ONLY is intentionally NOT implemented — DEF-022 remains open and the DB CHECK constraint blocks its persistence.' Line 157 dispatches it to actionWebhookDelivery, and the live CHECK constraint on automation_rules.action_type includes the value.

**Expected.** The header describes the file.

**Code evidence.** Both lines are in the same file; migration 20260802000000_phase_e3_2_webhook_delivery:43 adds the value to the constraint.

**Runtime evidence.** pg_get_constraintdef on automation_rules lists 'WEBHOOK_DELIVERY_INTERNAL_ONLY' among the eight allowed values; the column is varchar(60) so the value is not storage-truncated either.

**Root cause.** Phase E3.2 implemented the action without updating the header written when it was deferred.

**Operator risk.** None directly; an engineer reading the header would wrongly believe the action is inert.  
**Security / data risk.** None.

**Fix.** Update the header to describe the implemented behaviour and its constraints.  
**Acceptance proof.** The header and the dispatch table agree.

### PV-API-001 — The MFA recovery list route answers outside the error envelope and outside the family's anti-enumeration convention

**P3_PRESENTATION_OR_DEBT** · INCONSISTENT_ERROR_CONTRACT · **PRIOR_EVIDENCE_REVALIDATED**

> mfa-admin.routes.ts unchanged; the list route still bypasses authorizeMfaAdminScope.

- **Route** `/security-center/mfa-recovery`
- **Endpoint** `GET /v1/identity/mfa-admin/recovery-requests/:teamId`
- **Backend** `services/api/src/routes/mfa-admin.routes.ts:595-617`

**Observed.** This route uses readUserMfaPosture + mapScopeFailure rather than the module's own authorizeMfaAdminScope (mfa-admin.routes.ts:193), so it answers 403 {"error":"admin_not_in_team"} — a bare string, not the {error:{code}} envelope the rest of the surface uses — while every other /v1/admin/identity/* read answers 404 for the same situation.

**Expected.** One error envelope and one concealment convention across the family.

**Code evidence.** mapScopeFailure returns 403 for admin_not_in_team and admin_not_admin, 404 for target_not_in_team; authorizeMfaAdminScope's header states every denial should be the same 404 body.

**Runtime evidence.** Tested for enumeration and found none: a real team the caller is not in, another user's personal workspace, and two non-existent UUIDs all return the identical 403 {"error":"admin_not_in_team"}. The distinguishable 404 branch is reachable only once the caller is already an admin of the team, so no foreign-team existence is disclosed. This is a consistency defect, not a leak.

**Root cause.** The list route predates the Phase 12B gate and was not migrated with the rest of the module.

**Operator risk.** None visible; the page handles the refusal.  
**Security / data risk.** None proven — the enumeration hypothesis was tested and disconfirmed.

**Fix.** Route the list through authorizeMfaAdminScope so the module has one gate and one envelope.  
**Acceptance proof.** The list route returns the same shape and status as its siblings for an unauthorized team.

### PV-DUP-002 — Two retention resolvers answer the same operator question on one page

**P3_PRESENTATION_OR_DEBT** · PARALLEL_AUTHORITY · **PRIOR_EVIDENCE_REVALIDATED**

> Two retention resolvers still render on one page.

- **Route** `/governance/retention`
- **Endpoint** `GET /v1/governance/retention-policies/effective and GET /v1/governance/retention/inheritance`
- **Backend** `retention-engine.service.ts and the inheritance resolver`

**Observed.** The page renders two panels, each asking a resolver 'what retention governs this workspace', through different endpoints. One of them (PV-AUD-002) currently always fails, so the page shows a failure card beside a working answer to the same question.

**Expected.** One authority answers the question; a second view of it reads the same resolver.

**Code evidence.** Two independent fetches with two independent error branches.

**Runtime evidence.** On one load: /retention-policies/effective 500, /retention/inheritance 200 'No retention policy applies. The default (indefinite retention) is in effect.'

**Root cause.** Two phases added a resolver each.

**Operator risk.** Two answers that can disagree, on a governance surface where the answer is the point.  
**Security / data risk.** None.

**Fix.** Decide which resolver is canonical and have both panels read it. Confirms the retention-engine duplication candidate raised by the 2026-07-12 architecture audit.  
**Acceptance proof.** Both panels derive from one resolver call.

### PV-TOOL-001 — The fixture web launcher exits 0 when the build fails

**P3_PRESENTATION_OR_DEBT** · TOOLING_FALSE_SUCCESS · **SOURCE_CHANGED_RETESTED**

> REPRODUCED INDEPENDENTLY on the completion baseline: `pnpm run build:shared` failed at prisma:generate ('DATABASE_URL is not set') and the wrapper still reported exit code 0. The finding is broader than the web launcher — it is the pnpm script chain.

- **Route** `n/a (tooling)`
- **Endpoint** `n/a`
- **Backend** `n/a`

**Observed.** With --build-only, a failed `next build` prints 'next build failed (exit 1)' and the process nevertheless terminated with exit code 0 in this environment, so a caller that checks the status code sees success and the next step fails later with 'no build at ...'.

**Expected.** A failed build fails the command.

**Code evidence.** process.exit(built.status ?? 1) — when spawnSync cannot launch the binary, status is null and the ?? 1 path is intended; the observed exit was 0, so the failure did not propagate through the wrapper in this environment.

**Runtime evidence.** Two build attempts printed 'next build failed (exit 1)' and the task reported exit code 0; the subsequent serve step then failed with 'no build at node_modules/.cache/admin-fixture-next-prod'.

**Root cause.** Not fully diagnosed — registered with the evidence rather than a guessed cause. Incidental to the audit; found because this tree has no apps/web/node_modules/.bin, so `npx next` could not resolve the binary.

**Operator risk.** A CI job can report a green build step and fail confusingly later.  
**Security / data risk.** None.

**Fix.** Assert the exit status propagates, and add a check that BUILD_ID exists after --build-only.  
**Acceptance proof.** A deliberately broken build makes the command exit non-zero.

### PV-I18N-001 — The sign-in page shows a German label on an English page

**P3_PRESENTATION_OR_DEBT** · UNTRANSLATED_TEXT · **PRIOR_EVIDENCE_REVALIDATED**

> The sign-in page still shows 'Weiter mit Google' beside English labels.

- **Route** `/login`
- **Endpoint** `n/a`
- **Backend** `n/a`

**Observed.** With the page in English ('Continue with Apple', 'Forgot password?', 'Sign in with Email'), the Google button reads 'Weiter mit Google'.

**Expected.** One language per render.

**Code evidence.** Not traced — reported from the rendered DOM.

**Runtime evidence.** DOM capture of /login at 1440px: buttons ['Solutions','Resources','Company','EN','','Continue with Apple',...] and body text '... Weiter mit Google Continue with Apple ...'.

**Root cause.** Not traced; likely a locale-dependent third-party button rendered with the browser locale rather than the app locale.

**Operator risk.** Reads as unfinished on the first screen a customer sees.  
**Security / data risk.** None.

**Fix.** Pass the app locale to the provider button, or use an app-owned label.  
**Acceptance proof.** With the app in English the Google button reads in English.

### PV-API-002 — MFA enrolment always issues TOTP and silently ignores the requested kind

**P3_PRESENTATION_OR_DEBT** · IGNORED_REQUEST_PARAMETER · **PRIOR_EVIDENCE_REVALIDATED**

> Supporting files byte-identical on the completion baseline.

- **Route** `/settings (security), /security-center`
- **Endpoint** `POST /v1/identity/mfa/enroll/start`
- **Backend** `services/api/src/routes (mfa enrolment)`

**Observed.** POST with {kind:'SMS', destination:'+1...'} returns 200 with a TOTP otpauth:// URI and a base32 secret, and writes an mfa_factors row of kind TOTP carrying the caller's SMS label. The request is neither honoured nor rejected.

**Expected.** Either honour the kind, or reject it so the caller learns that contact factors are enrolled through /v1/identity-security/contact-factors/enroll/start.

**Code evidence.** The enrolment body schema does not carry a kind that reaches factor creation; the contact-factor surface is a separate route family.

**Runtime evidence.** Two POSTs with kind 'SMS' produced factors d8eb…/7e88…/354f… all of kind TOTP, labelled 'Audit SMS factor'. The neighbouring /v1/identity-security/contact-factors/enroll/start REJECTS an unknown key ('Unrecognized key: kind'), so the strictness exists elsewhere in the same domain.

**Root cause.** Two enrolment surfaces with different strictness; the older one accepts and discards.

**Operator risk.** A client that believes it enrolled an SMS factor has enrolled an authenticator, and — because of PV-STEPUP-001 — still cannot perform a sensitive action.  
**Security / data risk.** None directly.

**Fix.** Make the body .strict() like its neighbour, and point the error at the contact-factor route.  
**Acceptance proof.** POST with kind:'SMS' returns 400 naming the correct route, or returns an SMS factor.

### PV-ORG-001 — Organization sub-resources conceal with 404 while the organization itself refuses with 403

**P3_PRESENTATION_OR_DEBT** · INCONSISTENT_CONCEALMENT · **PRIOR_EVIDENCE_REVALIDATED**

> Supporting files byte-identical on the completion baseline.

- **Route** `/organizations/:id/admin/**`
- **Endpoint** `GET /v1/orgs/:id and its sub-resources`
- **Backend** `services/api/src/routes (orgs)`

**Observed.** For a caller who is not a member of the organization, GET /v1/orgs/:id, /members, /workspaces, /invites, /audit-events and /domains answer 403, while /policies/retention, /billing/rollup and /governance/control-center answer 404 for the same caller and the same organization.

**Expected.** One concealment convention per resource. Either the organization's existence is disclosed to a non-member or it is not.

**Code evidence.** Two different gate helpers on one resource family (requireAuthAndLegal + org role check vs requireOrgAdmin).

**Runtime evidence.** Nine-actor matrix against Northwind Legal: platform-admin-outsider and foreign-owner receive 403 on the first six endpoints and 404 on the last three. Northwind's own owner receives the same split against the foreign organization Meridian Trust.

**Root cause.** Sub-resources adopted a different helper as they were added.

**Operator risk.** None visible.  
**Security / data risk.** Minor: the 403 arm confirms the organization id exists. It is bounded — the caller must already be authenticated, and the previous audit's enumeration test on the identity surface found no oracle — but the split means one half of the family leaks what the other half conceals.

**Fix.** Pick one convention for /v1/orgs/* and route every sub-resource through it.  
**Acceptance proof.** A non-member receives the same status for every /v1/orgs/:id sub-resource.

### PV-A11Y-002 — An unnamed button ships on the SAML SSO page

**P3_PRESENTATION_OR_DEBT** · INACCESSIBLE_CONTROL · **PRIOR_EVIDENCE_REVALIDATED**

> Supporting files byte-identical on the completion baseline.

- **Route** `/security-center/sso`
- **Endpoint** `n/a`
- **Backend** `n/a`

**Observed.** The page renders four visible buttons; one has an empty accessible name.

**Expected.** Every control has an accessible name.

**Code evidence.** Measured in the rendered DOM, not inferred.

**Runtime evidence.** buttons = [{t:'Copy'},{t:'Copy'},{t:'Ingest metadata',d:true},{t:'',d:false}] at 1440px as platform-admin. The previous pass counted 76 unnamed controls across 30 routes; this is one of them, on a mandated page.

**Root cause.** An icon-only control without an aria-label.

**Operator risk.** A screen-reader user is offered a control that announces nothing.  
**Security / data risk.** None.

**Fix.** Give it an aria-label; sweep the other 75.  
**Acceptance proof.** No visible control has an empty accessible name.

### PV-INV-001 — The route-inventory scanner under-reports registrations, and the previous audit's 1,107 was low

**P3_PRESENTATION_OR_DEBT** · MEASUREMENT_INSTRUMENT_DEFECT · **PRIOR_EVIDENCE_REVALIDATED**

> Supporting files byte-identical on the completion baseline.

- **Route** `n/a (audit tooling)`
- **Endpoint** `n/a`
- **Backend** `n/a`

**Observed.** codeOf strips block comments with /\/\*[\s\S]*?\*\//g over raw source. That matcher starts inside string literals containing '/*' and deletes to the next '*/', removing whole regions. It also scans only for a STRING literal as the first argument, so a route registered through a hoisted path constant is invisible, and only /v1 paths were counted.

**Expected.** The inventory counts every registration.

**Code evidence.** grep finds app.get("/v1/evidence/:id/annotations") at evidence.routes.ts:7541 and app.post("/v1/evidence/bulk") at :6980; the scanner reported 37 routes for that file and neither of those. workspace-ai-policy.routes.ts registers via `const AI_POLICY_PATH = "/v1/teams/ai-policy"`.

**Runtime evidence.** Blanking comment LINES instead of matching comment BLOCKS raised the count from 1,103 to 1,120; resolving hoisted path constants added 4 more; including non-/v1 paths (the /v2/scim protocol surface, /stripe, /paypal, /healthz, /readyz, /metrics, /public/verify) added 16. Final: 1,140 registrations, against an independent ground truth of 1,141 app.<method>( call sites.

**Root cause.** A regex comment-stripper applied to source that contains comment-like text inside strings.

**Operator risk.** None.  
**Security / data risk.** An endpoint the inventory cannot see is an endpoint no coverage gate can require.

**Fix.** Adopt the line-based comment blanking and the path-constant resolution in apps/web/scripts/admin-inventory.mjs, and stop scoping the scan to /v1.  
**Acceptance proof.** The inventory's registration count equals the count of app.<method>( call sites minus those whose first argument is not a path.

### PV-API-002 — MFA enrolment always issues TOTP and silently ignores the requested kind

**P3_PRESENTATION_OR_DEBT** · IGNORED_REQUEST_PARAMETER · **CURRENT_RUNTIME_PROVEN**

- **Route** `/settings (security), /security-center`
- **Endpoint** `POST /v1/identity/mfa/enroll/start`
- **Backend** `services/api/src/routes (mfa enrolment)`

**Observed.** POST with {kind:'SMS', destination:'+1...'} returns 200 with a TOTP otpauth:// URI and a base32 secret, and writes an mfa_factors row of kind TOTP carrying the caller's SMS label. The request is neither honoured nor rejected.

**Expected.** Either honour the kind, or reject it so the caller learns that contact factors are enrolled through /v1/identity-security/contact-factors/enroll/start.

**Code evidence.** The enrolment body schema does not carry a kind that reaches factor creation; the contact-factor surface is a separate route family.

**Runtime evidence.** Two POSTs with kind 'SMS' produced factors d8eb…/7e88…/354f… all of kind TOTP, labelled 'Audit SMS factor'. The neighbouring /v1/identity-security/contact-factors/enroll/start REJECTS an unknown key ('Unrecognized key: kind'), so the strictness exists elsewhere in the same domain.

**Root cause.** Two enrolment surfaces with different strictness; the older one accepts and discards.

**Operator risk.** A client that believes it enrolled an SMS factor has enrolled an authenticator, and — because of PV-STEPUP-001 — still cannot perform a sensitive action.  
**Security / data risk.** None directly.

**Fix.** Make the body .strict() like its neighbour, and point the error at the contact-factor route.  
**Acceptance proof.** POST with kind:'SMS' returns 400 naming the correct route, or returns an SMS factor.

### PV-ORG-001 — Organization sub-resources conceal with 404 while the organization itself refuses with 403

**P3_PRESENTATION_OR_DEBT** · INCONSISTENT_CONCEALMENT · **CURRENT_RUNTIME_PROVEN**

- **Route** `/organizations/:id/admin/**`
- **Endpoint** `GET /v1/orgs/:id and its sub-resources`
- **Backend** `services/api/src/routes (orgs)`

**Observed.** For a caller who is not a member of the organization, GET /v1/orgs/:id, /members, /workspaces, /invites, /audit-events and /domains answer 403, while /policies/retention, /billing/rollup and /governance/control-center answer 404 for the same caller and the same organization.

**Expected.** One concealment convention per resource. Either the organization's existence is disclosed to a non-member or it is not.

**Code evidence.** Two different gate helpers on one resource family (requireAuthAndLegal + org role check vs requireOrgAdmin).

**Runtime evidence.** Nine-actor matrix against Northwind Legal: platform-admin-outsider and foreign-owner receive 403 on the first six endpoints and 404 on the last three. Northwind's own owner receives the same split against the foreign organization Meridian Trust.

**Root cause.** Sub-resources adopted a different helper as they were added.

**Operator risk.** None visible.  
**Security / data risk.** Minor: the 403 arm confirms the organization id exists. It is bounded — the caller must already be authenticated, and the previous audit's enumeration test on the identity surface found no oracle — but the split means one half of the family leaks what the other half conceals.

**Fix.** Pick one convention for /v1/orgs/* and route every sub-resource through it.  
**Acceptance proof.** A non-member receives the same status for every /v1/orgs/:id sub-resource.

### PV-A11Y-002 — An unnamed button ships on the SAML SSO page

**P3_PRESENTATION_OR_DEBT** · INACCESSIBLE_CONTROL · **CURRENT_RUNTIME_PROVEN**

- **Route** `/security-center/sso`
- **Endpoint** `n/a`
- **Backend** `n/a`

**Observed.** The page renders four visible buttons; one has an empty accessible name.

**Expected.** Every control has an accessible name.

**Code evidence.** Measured in the rendered DOM, not inferred.

**Runtime evidence.** buttons = [{t:'Copy'},{t:'Copy'},{t:'Ingest metadata',d:true},{t:'',d:false}] at 1440px as platform-admin. The previous pass counted 76 unnamed controls across 30 routes; this is one of them, on a mandated page.

**Root cause.** An icon-only control without an aria-label.

**Operator risk.** A screen-reader user is offered a control that announces nothing.  
**Security / data risk.** None.

**Fix.** Give it an aria-label; sweep the other 75.  
**Acceptance proof.** No visible control has an empty accessible name.

### PV-INV-001 — The route-inventory scanner under-reports registrations, and the previous audit's 1,107 was low

**P3_PRESENTATION_OR_DEBT** · MEASUREMENT_INSTRUMENT_DEFECT · **CURRENT_RUNTIME_PROVEN**

- **Route** `n/a (audit tooling)`
- **Endpoint** `n/a`
- **Backend** `n/a`

**Observed.** codeOf strips block comments with /\/\*[\s\S]*?\*\//g over raw source. That matcher starts inside string literals containing '/*' and deletes to the next '*/', removing whole regions. It also scans only for a STRING literal as the first argument, so a route registered through a hoisted path constant is invisible, and only /v1 paths were counted.

**Expected.** The inventory counts every registration.

**Code evidence.** grep finds app.get("/v1/evidence/:id/annotations") at evidence.routes.ts:7541 and app.post("/v1/evidence/bulk") at :6980; the scanner reported 37 routes for that file and neither of those. workspace-ai-policy.routes.ts registers via `const AI_POLICY_PATH = "/v1/teams/ai-policy"`.

**Runtime evidence.** Blanking comment LINES instead of matching comment BLOCKS raised the count from 1,103 to 1,120; resolving hoisted path constants added 4 more; including non-/v1 paths (the /v2/scim protocol surface, /stripe, /paypal, /healthz, /readyz, /metrics, /public/verify) added 16. Final: 1,140 registrations, against an independent ground truth of 1,141 app.<method>( call sites.

**Root cause.** A regex comment-stripper applied to source that contains comment-like text inside strings.

**Operator risk.** None.  
**Security / data risk.** An endpoint the inventory cannot see is an endpoint no coverage gate can require.

**Fix.** Adopt the line-based comment blanking and the path-constant resolution in apps/web/scripts/admin-inventory.mjs, and stop scoping the scan to /v1.  
**Acceptance proof.** The inventory's registration count equals the count of app.<method>( call sites minus those whose first argument is not a path.

## Owner decisions (8)

### PV-OD-001 — Is /admin the PLATFORM console, or the ADMINISTRATIVE console?

**Current behaviour.** 47 routes sit under /admin behind requiredActiveSpace PLATFORM_ADMIN. 25 are platform-only at runtime, 11 are purely tenant administration of the operator's own active workspace, 8 have no param-free GET to classify this way, and 3 are inconclusive. Every one of the 11 already carries an explicit WORKSPACE chip in the console navigation and an on-page notice reading 'Workspace-scoped surface. This page administers your own active workspace — not the platform.'

- **A** — Move the 11 tenant pages out of /admin into the workspace/organization families (e.g. /security-center/*, /organizations/:id/admin/*). /admin then means the platform, without exception.
- **B** — Keep them and give each a tenant selector, so /admin means 'the platform, or a customer tenant I have explicitly chosen'. This is the only option that makes them useful to a platform operator who is not a member of the customer workspace — today they answer 404 for exactly that person.
- **C** — Keep them exactly as they are and rely on the WORKSPACE chip plus the scope notice, accepting that they administer only the operator's own workspace.

**Security.** A is neutral-to-positive: the API is already tenant-gated, and the capability is already reachable outside /admin via /security-center/sso, so moving does not widen anything. B widens materially — it requires cross-tenant identity administration, which does not exist today and would need its own authority, step-up and audit design. C changes nothing.  
**UX.** A gives one home per capability. B is the only option that delivers what the URL currently promises. C leaves an operator reading 'Platform admin' above a page that administers their own workspace — mitigated but not removed by the notice.  
**Operational.** A is a route move plus redirects and navigation updates. B is a feature. C is free.

**Recommendation.** Option A. The disposition register's stated reason for keeping them ('the platform gate is currently STRICTER than the API and moving it would widen the audience') is obsolete: /security-center/sso already exposes the same endpoint to every SECURITY_CENTER_VIEW holder, and both org-owner and workspace-admin hold it. Keeping the pages under /admin therefore restricts nothing and costs comprehension. Option B is defensible only if cross-tenant identity administration is genuinely wanted as a product.

**Approval question.** Do we move the eleven workspace-scoped pages out of /admin (A), build a tenant selector so they become genuinely cross-tenant (B), or accept the current labelled state (C)?

### PV-OD-002 — Should a VIEWER be able to read SSO configuration and the identity audit timeline?

**Current behaviour.** packages/shared/src/permissions.ts grants identity.org_policy.read to ADMIN, REVIEWER and VIEWER. Because /v1/admin/identity/providers and /v1/admin/identity/timeline default to that permission, the read-only fixture persona receives 200 on both.

- **A** — Keep it. A read-only auditor arguably should see identity policy and the identity audit trail — that is what an auditor is for.
- **B** — Narrow the two reads to a dedicated identity.audit.read / identity.sso.read held by ADMIN and an explicit auditor role, leaving VIEWER without them.

**Security.** A exposes the IdP configuration (entity IDs, endpoints, allowed domains, certificate fingerprints) and the full identity event history to every VIEWER in the workspace. B reduces that but adds a permission to the catalog and to every grant path.  
**UX.** A means an auditor needs no extra grant. B means an explicit grant before an audit.  
**Operational.** B touches the permission catalog, which is consumed by the matrix page and the access-review projections.

**Recommendation.** Option A, deliberately and in writing. The grant is already explicit in the catalog rather than accidental, the projection carries no secret material, and the surfaces are read-only. This should be recorded as a decision rather than left to be rediscovered as a finding.

**Approval question.** Do we confirm that VIEWER legitimately holds identity.org_policy.read, or narrow it?

### PV-OD-003 — Should the Organization Admin console be reachable for a personal workspace?

**Current behaviour.** Every user's personal workspace exists as a row in `organizations` with an ORG_OWNER membership for that user. /organizations/:id/admin/** — a 19-page Enterprise console — therefore resolves and returns data for a personal workspace; only the Enterprise-gated parts (e.g. /domains) refuse, with a clean 402 ENTERPRISE_FEATURE_REQUIRED and an upgradeCta.

- **A** — Keep it: the console degrades honestly, showing one member, one workspace and 402 on Enterprise features.
- **B** — Hide the organization-admin family for organizations whose kind is a personal workspace, and route those users to /settings.

**Security.** Neither option changes authorization; the organization gate already holds.  
**UX.** A presents a 19-page enterprise console to a single-seat personal user, most of it empty or upgrade-gated. B keeps the personal experience small.  
**Operational.** B needs a reliable personal-vs-organization discriminator on the organization row.

**Recommendation.** Option B for navigation, Option A for direct URLs — do not advertise the console to personal workspaces, but let a direct link keep working and refuse honestly, which it already does.

**Approval question.** Do we hide the organization-admin family from personal workspaces in navigation?

### PV-OD-004 — Should Resolve be offered for conditions that cannot be resolved by hand?

**Current behaviour.** The Resolve button appears for every OPEN or ACKNOWLEDGED condition. For a WORKER 'Unclassified security signal' the server refuses with 409 CONDITION_NOT_DIRECTLY_RESOLVABLE. The confirmation dialog warns in advance that 'The platform will refuse the resolve if the condition's own source still reports it as live.'

- **A** — Keep the button and fix its refusal message (PV-OPS-001). Offering it and refusing honestly keeps one code path and one authority.
- **B** — Hide or disable Resolve for condition types whose resolutionAuthority is not OPERATOR_DECISION or SOURCE_TRUTH, with read-only guidance instead.

**Security.** None; hiding a control has never been the boundary here and the server decides either way.  
**UX.** A costs one round trip to learn the answer. B tells the operator up front but requires the resolvability of each type to be projected to the client.  
**Operational.** B needs the lifecycle projection extended to the list rows.

**Recommendation.** Option A. The refusal is already correct, audited and specific; the only real defect is the message, which is PV-OPS-001. Option B is worth doing later if the list projection grows a resolvability field anyway.

**Approval question.** Do we keep Resolve universally offered with an accurate refusal, or gate it on projected resolvability?

### PV-OD-011 — Should an authenticator app satisfy step-up, or must it be SMS/WhatsApp?

**Current behaviour.** Step-up resolves only CONTACT_FACTOR_KINDS = ['SMS','WHATSAPP']. A verified TOTP factor — the only kind /v1/identity/mfa/enroll/start issues — does not satisfy it, and the refusal tells the holder to enrol a device they already have.

- **A** — Accept TOTP for step-up. The factor is already enrolled, verified and stronger than SMS.
- **B** — Keep SMS/WhatsApp only, but fix the refusal to name the required kind and link to contact-factor enrolment.
- **C** — Keep SMS/WhatsApp for the highest tier of action and accept TOTP for the rest, declared per purpose.

**Security.** A removes a hard dependency on SMS, the weakest common second factor, for the most privileged actions. B leaves that dependency in place. C is the most precise and the most work.  
**UX.** Today an enterprise that forbids SMS cannot use any sensitive control, and the error message misdirects.  
**Operational.** A needs the challenge flow to verify a TOTP code instead of sending one; the verification service is already abstracted.

**Recommendation.** Option A, with Option B's copy fix shipped first because it is a one-line change that stops misdirecting people today.

**Approval question.** Do we accept TOTP as a step-up factor, or keep step-up on SMS/WhatsApp and fix only the refusal message?

### PV-OD-012 — Should ORG_SECURITY_ADMIN be able to manage verified domains?

**Current behaviour.** GET /v1/orgs/:id/domains returns 200 for ORG_OWNER and ORG_ADMIN and 403 for ORG_SECURITY_ADMIN, ORG_AUDITOR and ORG_MEMBER. Domain verification is the control that decides which email domains SSO and JIT provisioning will trust.

- **A** — Grant ORG_SECURITY_ADMIN read and write on domains — it is an identity-security control and that is the role's job.
- **B** — Grant read only, keeping the write with ORG_ADMIN.
- **C** — Leave as is; domains are an ownership concern.

**Security.** A puts the control with the role accountable for it. C means the security admin cannot see which domains are trusted for automatic provisioning, which is a gap in exactly their remit.  
**UX.** Today the role named for security is refused the SSO trust surface.  
**Operational.** A permission-catalog change.

**Recommendation.** Option B at minimum: a security admin who cannot READ the verified-domain list cannot audit JIT provisioning. Option A if the role is meant to own SSO end to end.

**Approval question.** Does ORG_SECURITY_ADMIN get read, read+write, or no access to organization domains?

### PV-OD-011 — Should an authenticator app satisfy step-up, or must it be SMS/WhatsApp?

**Current behaviour.** Step-up resolves only CONTACT_FACTOR_KINDS = ['SMS','WHATSAPP']. A verified TOTP factor — the only kind /v1/identity/mfa/enroll/start issues — does not satisfy it, and the refusal tells the holder to enrol a device they already have.

- **A** — Accept TOTP for step-up. The factor is already enrolled, verified and stronger than SMS.
- **B** — Keep SMS/WhatsApp only, but fix the refusal to name the required kind and link to contact-factor enrolment.
- **C** — Keep SMS/WhatsApp for the highest tier of action and accept TOTP for the rest, declared per purpose.

**Security.** A removes a hard dependency on SMS, the weakest common second factor, for the most privileged actions. B leaves that dependency in place. C is the most precise and the most work.  
**UX.** Today an enterprise that forbids SMS cannot use any sensitive control, and the error message misdirects.  
**Operational.** A needs the challenge flow to verify a TOTP code instead of sending one; the verification service is already abstracted.

**Recommendation.** Option A, with Option B's copy fix shipped first because it is a one-line change that stops misdirecting people today.

**Approval question.** Do we accept TOTP as a step-up factor, or keep step-up on SMS/WhatsApp and fix only the refusal message?

### PV-OD-012 — Should ORG_SECURITY_ADMIN be able to manage verified domains?

**Current behaviour.** GET /v1/orgs/:id/domains returns 200 for ORG_OWNER and ORG_ADMIN and 403 for ORG_SECURITY_ADMIN, ORG_AUDITOR and ORG_MEMBER. Domain verification is the control that decides which email domains SSO and JIT provisioning will trust.

- **A** — Grant ORG_SECURITY_ADMIN read and write on domains — it is an identity-security control and that is the role's job.
- **B** — Grant read only, keeping the write with ORG_ADMIN.
- **C** — Leave as is; domains are an ownership concern.

**Security.** A puts the control with the role accountable for it. C means the security admin cannot see which domains are trusted for automatic provisioning, which is a gap in exactly their remit.  
**UX.** Today the role named for security is refused the SSO trust surface.  
**Operational.** A permission-catalog change.

**Recommendation.** Option B at minimum: a security admin who cannot READ the verified-domain list cannot audit JIT provisioning. Option A if the role is meant to own SSO end to end.

**Approval question.** Does ORG_SECURITY_ADMIN get read, read+write, or no access to organization domains?

## Environment and isolation

- Isolated worktree `D:/pv-audit-completion` on branch `audit/admin-enterprise-completion`, clean tracked and untracked state at start, no junctions, no production `.env` present.
- Disposable PostgreSQL (pgvector/pgvector:pg16) and Redis containers on non-default ports; all integrations disabled; the messaging transport set to **recording**.
- Production contacted: **false**. Product files modified: **false**.

**One correction to the previous audit's isolation claim.** See `PV-SEC-002`: the fixture launcher's allowlist does not stop `services/api/src/env.ts` from back-filling non-allowlisted variables out of `services/api/.env`. Database, Redis, storage and transports were pinned local and every integration flag was off, so nothing outbound fired — but in the previous audit's worktree, which contains that file, the API process did hold production credentials it did not need.
