# G — TEST COVERAGE MATRIX

> **Currency:** this document reports the BASELINE run at `f822de79a`. It was re-run on `uc6-public-launch` @ `10668edbe` — see **[J](J-reconciliation-on-recovery-branch.md)**. All findings persist; the Android fingerprint is now fixed in-repo but undeployed, and the measured counts moved slightly (tests 942→946, controls 484→485).

**Audited SHA:** `10668edbe4ac189ff965a09c7e8be17953d83f4a`

## G.1 What was actually executed

| Suite | Command | Result | When |
|---|---|---|---|
| `apps/mobile` unit + render | `node --test` | **942 pass / 0 fail / 0 skipped** (15.1 s) | this audit, after `pnpm run build:deps` |

`build:deps` is required first: `@proovra/shared` resolves through a gitignored
`dist/`, and a stale one fails the suite with
`No matching export … for import "userFacingErrorFor"`.

## G.2 Proof tiers — what each tier can and cannot establish

| Tier | Files | Establishes | Does NOT establish |
|---|---:|---|---|
| Pure logic / projection | 67 | parsers, path builders, state machines, gating math | that anything renders |
| Render (`*.render.test.mjs`) | 9 | a component tree mounts and shows expected text | native layout, fonts, safe areas, gestures |
| Authenticated integration | **0** | — | — |
| E2E against a running API | **0** | — | — |
| Simulator | **0** | — | — |
| Physical device | **0** | — | — |

`capture-lifecycle-e2e.test.mjs` is named e2e but runs in-process under `node --test`
with no server; it is counted above as logic, not as E2E.

## G.3 Per-route coverage

18 of 64 applicable routes have **no** referencing test file.
17 have a render test.

| Route | Test files | Render? |
|---|---|---|
| `/abuse-reporting` | **none** | no |
| `/cases/[id]` | **none** | no |
| `/collaboration-teams/[teamId]` | **none** | no |
| `/collaboration-teams/[teamId]/collaboration` | **none** | no |
| `/data-retention` | **none** | no |
| `/evidence/[id]` | **none** | no |
| `/forgot-password` | **none** | no |
| `/inbox` | **none** | no |
| `/legal/[slug]` | **none** | no |
| `/notifications` | **none** | no |
| `/operations` | **none** | no |
| `/operations/health` | **none** | no |
| `/organizations` | **none** | no |
| `/privacy` | **none** | no |
| `/settings/legal/[slug]` | **none** | no |
| `/share/[id]` | **none** | no |
| `/subprocessors` | **none** | no |
| `/terms` | **none** | no |
| `/auth/mfa-recovery/verify` | `credential-deep-link.test.mjs` | no |
| `/evidence-requests/[id]` | `evidence-request-review.render.test.mjs` | yes |
| `/operations/batch-analysis` | `operations.test.mjs` | no |
| `/operations/quotas` | `operations.test.mjs` | no |
| `/organizations/[id]` | `native-action-inventory.test.mjs` | no |
| `/people` | `workspace-people.test.mjs` | no |
| `/portal` | `external-flows.test.mjs` | no |
| `/portal/[token]/work/[workflowId]` | `external-flows.test.mjs` | no |
| `/portal/accept/[grantId]` | `external-flows.test.mjs` | no |
| `/settings/reviewer-criteria` | `reviewer-criteria.test.mjs` | no |
| `/teams/[id]` | `workspace-people.test.mjs` | no |
| `/collaboration-teams/invites/[token]/accept` | `credential-deep-link.test.mjs`, `external-flows.test.mjs` | no |
| `/intake/[token]` | `credential-deep-link.test.mjs`, `external-flows.test.mjs` | no |
| `/invite/[token]` | `credential-deep-link.test.mjs`, `external-flows.test.mjs` | no |
| `/org-invites/[token]/accept` | `credential-deep-link.test.mjs`, `external-flows.test.mjs` | no |
| `/portal/[token]` | `credential-deep-link.test.mjs`, `external-flows.test.mjs` | no |
| `/trust` | `pricing-support.test.mjs`, `trust-center.test.mjs` | no |
| `/trust-center` | `pricing-support.test.mjs`, `trust-center.test.mjs` | no |
| `/trust-center/ai-disclosure` | `pricing-support.test.mjs`, `trust-center.test.mjs` | no |
| `/trust-center/methodology` | `pricing-support.test.mjs`, `trust-center.test.mjs` | no |
| `/trust-center/security` | `pricing-support.test.mjs`, `trust-center.test.mjs` | no |
| `/trust-center/status` | `pricing-support.test.mjs`, `trust-center.test.mjs` | no |
| `/trust-center/subprocessors` | `pricing-support.test.mjs`, `trust-center.test.mjs` | no |
| `/auth/verify-email` | `credential-deep-link.test.mjs`, `deep-link-families.test.mjs`, `native-route-reachability.test.mjs` | no |
| `/reset-password` | `credential-deep-link.test.mjs`, `deep-link-families.test.mjs`, `password-rules.test.mjs` | no |
| `/collaboration-teams` | `ai-assistance.test.mjs`, `collaboration.test.mjs`, `spaces.test.mjs`, `workspace-people.test.mjs` | no |
| `/intake-links` | `home-dashboard.test.mjs`, `home.render.test.mjs`, `intake-links.render.test.mjs`, `intake-links.test.mjs` | yes |
| `/register` | `auth-api-contract.test.mjs`, `oauth-build-config.test.mjs`, `password-rules.test.mjs`, `protected-native-register.test.mjs` | no |
| `/workspaces` | `ai-assistance.test.mjs`, `billing.test.mjs`, `organizations.test.mjs`, `spaces.test.mjs` | no |
| `/auth/mfa-challenge` | `account-security.test.mjs`, `auth-api-contract.test.mjs`, `credential-deep-link.test.mjs`, `settings-security.render.test.mjs`, `step-up.test.mjs` | yes |
| `/billing` | `ai-assistance.test.mjs`, `billing.test.mjs`, `home-dashboard.test.mjs`, `home.render.test.mjs`, `pricing-support.test.mjs` | yes |
| `/pricing` | `ai-assistance.test.mjs`, `billing.test.mjs`, `home-dashboard.test.mjs`, `home.render.test.mjs`, `pricing-support.test.mjs` | yes |
| `/search` | `ai-assistance.test.mjs`, `collaboration.test.mjs`, `evidence-library.test.mjs`, `home.render.test.mjs`, `mobile-boot-contract.test.mjs`, `search.test.mjs`, `ui-patterns.render.test.mjs` | yes |
| `/verify` | `account-security.test.mjs`, `auth-api-contract.test.mjs`, `credential-deep-link.test.mjs`, `journeys.test.mjs`, `native-route-reachability.test.mjs`, `product-manifest-coverage.test.mjs`, `verify-id.test.mjs` | no |
| `/verify/[token]` | `account-security.test.mjs`, `auth-api-contract.test.mjs`, `credential-deep-link.test.mjs`, `journeys.test.mjs`, `native-route-reachability.test.mjs`, `product-manifest-coverage.test.mjs`, `verify-id.test.mjs` | no |
| `/settings` | `case-workspace.test.mjs`, `collaboration.test.mjs`, `deep-link-families.test.mjs`, `legal.test.mjs`, `native-action-inventory.test.mjs`, `organizations.test.mjs`, `pbxproj-integrity.test.mjs`, `settings-security.render.test.mjs` | yes |
| `/intake/[token]/capture` | `capture-draft.test.mjs`, `capture-lifecycle-e2e.test.mjs`, `capture-lifecycle.render.test.mjs`, `capture-plan.test.mjs`, `capture-session-store.test.mjs`, `direct-capture-seal.test.mjs`, `external-flows.test.mjs`, `native-action-inventory.test.mjs`, `native-route-reachability.test.mjs` | yes |
| `/cases` | `case-workspace.test.mjs`, `credential-deep-link.test.mjs`, `deep-link-families.test.mjs`, `deep-link.contract.test.mjs`, `domain-enums-generated.test.mjs`, `external-flows.test.mjs`, `home-dashboard.test.mjs`, `home-operations.test.mjs`, `home.render.test.mjs`, `inbox.test.mjs`, `journeys.test.mjs`, `native-action-inventory.test.mjs`, `ui-patterns.render.test.mjs`, `workspace-people.test.mjs` | yes |
| `/home` | `android-manifest-contract.test.mjs`, `capture-plan.test.mjs`, `deep-link-families.test.mjs`, `error-presentation.test.mjs`, `evidence-detail.test.mjs`, `external-flows.test.mjs`, `home.render.test.mjs`, `legal.render.test.mjs`, `legal.test.mjs`, `mobile-boot-contract.test.mjs`, `native-module-contract.test.mjs`, `native-route-reachability.test.mjs`, `network-state.test.mjs`, `protected-native-register.test.mjs`, `ui-kit.render.test.mjs` | yes |
| `/reports` | `case-workspace.test.mjs`, `evidence-detail.test.mjs`, `evidence-library.test.mjs`, `home-dashboard.test.mjs`, `home-operations.test.mjs`, `home.render.test.mjs`, `inbox.test.mjs`, `network-state.test.mjs`, `operations.test.mjs`, `pricing-support.test.mjs`, `reports.test.mjs`, `search.test.mjs`, `settings-security.render.test.mjs`, `ui-kit.render.test.mjs`, `ui-patterns.render.test.mjs` | yes |
| `/support` | `capture-lifecycle-e2e.test.mjs`, `capture-lifecycle.render.test.mjs`, `capture-plan.test.mjs`, `collaboration.test.mjs`, `deep-link.contract.test.mjs`, `evidence-detail.test.mjs`, `evidence-internal-materials.render.test.mjs`, `evidence-request-review.render.test.mjs`, `home.render.test.mjs`, `i18n-locale.test.mjs`, `intake-links.render.test.mjs`, `journeys.test.mjs`, `legal.render.test.mjs`, `legal.test.mjs`, `pbxproj-integrity.test.mjs`, `pricing-support.test.mjs`, `settings-security.render.test.mjs`, `ui-kit.render.test.mjs`, `ui-patterns.render.test.mjs` | yes |
| `/capture` | `android-manifest-contract.test.mjs`, `capture-draft.test.mjs`, `capture-lifecycle-e2e.test.mjs`, `capture-lifecycle.render.test.mjs`, `capture-plan.test.mjs`, `capture-session-store.test.mjs`, `continuous-capture-flow.test.mjs`, `deep-link.contract.test.mjs`, `direct-capture-seal.test.mjs`, `domain-enums-generated.test.mjs`, `error-presentation.test.mjs`, `evidence-detail.test.mjs`, `external-flows.test.mjs`, `home.render.test.mjs`, `mobile-boot-contract.test.mjs`, `native-action-inventory.test.mjs`, `native-module-contract.test.mjs`, `native-route-reachability.test.mjs`, `protected-native-register.test.mjs`, `screen-capture-flow.test.mjs`, `ui-patterns.render.test.mjs` | yes |
| `/auth` | `account-security.test.mjs`, `auth-api-contract.test.mjs`, `auth-runtime-binding.test.mjs`, `bootstrap-machine.test.mjs`, `branding-config.test.mjs`, `capture-lifecycle.render.test.mjs`, `capture-plan.test.mjs`, `case-workspace.test.mjs`, `contract-audit.test.mjs`, `credential-deep-link.test.mjs`, `deep-link-families.test.mjs`, `deep-link.contract.test.mjs`, `discussion.test.mjs`, `domain-enums-generated.test.mjs`, `evidence-detail.test.mjs`, `evidence-internal-materials.render.test.mjs`, `evidence-requests.test.mjs`, `external-flows.test.mjs`, `home.render.test.mjs`, `journeys.test.mjs`, `legal.test.mjs`, `native-action-inventory.test.mjs`, `native-route-reachability.test.mjs`, `oauth-build-config.test.mjs`, `operations.test.mjs`, `organizations.test.mjs`, `pending-intent.test.mjs`, `platform-context.test.mjs`, `product-manifest-coverage.test.mjs`, `reviewer-criteria.test.mjs`, `reviewer-workflow.test.mjs`, `safe-error.test.mjs`, `settings-security.render.test.mjs`, `step-up.test.mjs` | yes |
| `/auth/callback/ui` | `account-security.test.mjs`, `auth-api-contract.test.mjs`, `auth-runtime-binding.test.mjs`, `bootstrap-machine.test.mjs`, `branding-config.test.mjs`, `capture-lifecycle.render.test.mjs`, `capture-plan.test.mjs`, `case-workspace.test.mjs`, `contract-audit.test.mjs`, `credential-deep-link.test.mjs`, `deep-link-families.test.mjs`, `deep-link.contract.test.mjs`, `discussion.test.mjs`, `domain-enums-generated.test.mjs`, `evidence-detail.test.mjs`, `evidence-internal-materials.render.test.mjs`, `evidence-requests.test.mjs`, `external-flows.test.mjs`, `home.render.test.mjs`, `journeys.test.mjs`, `legal.test.mjs`, `native-action-inventory.test.mjs`, `native-route-reachability.test.mjs`, `oauth-build-config.test.mjs`, `operations.test.mjs`, `organizations.test.mjs`, `pending-intent.test.mjs`, `platform-context.test.mjs`, `product-manifest-coverage.test.mjs`, `reviewer-criteria.test.mjs`, `reviewer-workflow.test.mjs`, `safe-error.test.mjs`, `settings-security.render.test.mjs`, `step-up.test.mjs` | yes |
| `/login` | `account-security.test.mjs`, `auth-api-contract.test.mjs`, `auth-runtime-binding.test.mjs`, `bootstrap-machine.test.mjs`, `branding-config.test.mjs`, `capture-lifecycle.render.test.mjs`, `capture-plan.test.mjs`, `case-workspace.test.mjs`, `contract-audit.test.mjs`, `credential-deep-link.test.mjs`, `deep-link-families.test.mjs`, `deep-link.contract.test.mjs`, `discussion.test.mjs`, `domain-enums-generated.test.mjs`, `evidence-detail.test.mjs`, `evidence-internal-materials.render.test.mjs`, `evidence-requests.test.mjs`, `external-flows.test.mjs`, `home.render.test.mjs`, `journeys.test.mjs`, `legal.test.mjs`, `native-action-inventory.test.mjs`, `native-route-reachability.test.mjs`, `oauth-build-config.test.mjs`, `operations.test.mjs`, `organizations.test.mjs`, `pending-intent.test.mjs`, `platform-context.test.mjs`, `product-manifest-coverage.test.mjs`, `reviewer-criteria.test.mjs`, `reviewer-workflow.test.mjs`, `safe-error.test.mjs`, `settings-security.render.test.mjs`, `step-up.test.mjs` | yes |
| `/evidence` | `ai-assistance.test.mjs`, `billing.test.mjs`, `capture-draft.test.mjs`, `capture-lifecycle-e2e.test.mjs`, `capture-lifecycle.render.test.mjs`, `capture-plan.test.mjs`, `capture-session-store.test.mjs`, `case-workspace.test.mjs`, `continuous-capture-flow.test.mjs`, `credential-deep-link.test.mjs`, `deep-link-families.test.mjs`, `deep-link.contract.test.mjs`, `derived-review.test.mjs`, `discussion.test.mjs`, `domain-enums-generated.test.mjs`, `error-presentation.test.mjs`, `evidence-detail.test.mjs`, `evidence-internal-materials.render.test.mjs`, `evidence-library.test.mjs`, `evidence-request-review.render.test.mjs`, `evidence-requests.test.mjs`, `external-flows.test.mjs`, `file-integrity.test.mjs`, `home-dashboard.test.mjs`, `home-operations.test.mjs`, `home.render.test.mjs`, `inbox.test.mjs`, `intake-links.render.test.mjs`, `intake-links.test.mjs`, `journeys.test.mjs`, `legal.test.mjs`, `mobile-boot-contract.test.mjs`, `operations.test.mjs`, `product-manifest-coverage.test.mjs`, `reports.test.mjs`, `reviewer-workflow.test.mjs`, `safe-error.test.mjs`, `screen-capture-flow.test.mjs`, `search.test.mjs`, `ui-kit.render.test.mjs`, `ui-patterns.render.test.mjs` | yes |
