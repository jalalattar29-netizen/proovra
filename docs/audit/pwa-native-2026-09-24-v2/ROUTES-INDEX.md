# ROUTE REGISTER INDEX — all 64 applicable rows

**Frozen SHA:** `71e148f34410c7c231f8930d1387d8924b10b4e5` · one register per route in [`routes/`](routes/)

Dispositions: ALIAS_REDIRECT 8 · COMPARED 54 · NO_NATIVE_SCREEN 2

| Route | Disp. | web→nat files | web→nat labels | paired | unpaired | role-absent | web→nat handlers | web→nat API | API gap | web-only colours | Register |
|---|---|---|---|---:|---:|---:|---|---|---:|---:|---|
| `/abuse-reporting` | A | 1→139 | 0→18 | 0 | 0 | 0 | 0→37 | 0→2 | 0 | 0 | [md](routes/abuse-reporting.md) |
| `/auth` | A | 1→144 | 0→24 | 0 | 0 | 0 | 0→33 | 0→13 | 0 | 0 | [md](routes/auth.md) |
| `/auth/callback/ui` | C | 135→144 | 19→24 | 2 | 17 | 1 | 29→33 | 4→13 | 3 | 20 | [md](routes/auth-callback-ui.md) |
| `/auth/mfa-challenge` | C | 130→146 | 46→21 | 2 | 41 | 1 | 42→32 | 7→17 | 2 | 15 | [md](routes/auth-mfa-challenge.md) |
| `/auth/mfa-recovery/verify` | C | 2→137 | 11→14 | 1 | 8 | 0 | 0→26 | 3→4 | 0 | 0 | [md](routes/auth-mfa-recovery-verify.md) |
| `/auth/verify-email` | C | 141→143 | 45→14 | 2 | 41 | 1 | 55→25 | 8→13 | 4 | 23 | [md](routes/auth-verify-email.md) |
| `/billing` | C | 179→141 | 109→26 | 6 | 97 | 4 | 98→32 | 14→6 | 10 | 50 | [md](routes/billing.md) |
| `/capture` | C | 207→161 | 242→102 | 10 | 227 | 1 | 111→85 | 14→9 | 7 | 163 | [md](routes/capture.md) |
| `/cases` | C | 172→144 | 105→18 | 4 | 96 | 3 | 99→33 | 6→5 | 3 | 59 | [md](routes/cases.md) |
| `/cases/[id]` | C | 193→141 | 505→38 | 5 | 488 | 6 | 180→47 | 23→3 | 22 | 73 | [md](routes/cases-id-.md) |
| `/collaboration-teams` | C | 163→140 | 94→22 | 2 | 88 | 6 | 66→33 | 4→4 | 3 | 54 | [md](routes/collaboration-teams.md) |
| `/collaboration-teams/[teamId]` | C | 174→145 | 230→61 | 9 | 186 | 8 | 146→64 | 4→5 | 3 | 72 | [md](routes/collaboration-teams-teamId-.md) |
| `/collaboration-teams/[teamId]/collaboration` | C | 1→145 | 1→61 | 0 | 1 | 0 | 0→64 | 0→5 | 0 | 0 | [md](routes/collaboration-teams-teamId-collaboration.md) |
| `/collaboration-teams/invites/[token]/accept` | C | 154→138 | 40→16 | 2 | 38 | 3 | 31→28 | 4→1 | 3 | 22 | [md](routes/collaboration-teams-invites-token-accept.md) |
| `/data-retention` | A | 1→139 | 0→18 | 0 | 0 | 0 | 0→37 | 0→2 | 0 | 0 | [md](routes/data-retention.md) |
| `/evidence` | C | 182→141 | 108→67 | 8 | 85 | 3 | 126→80 | 10→7 | 3 | 77 | [md](routes/evidence.md) |
| `/evidence-requests/[id]` | C | 161→141 | 122→33 | 2 | 118 | 2 | 46→38 | 11→1 | 10 | 18 | [md](routes/evidence-requests-id-.md) |
| `/evidence/[id]` | C | 262→152 | 750→110 | 9 | 702 | 14 | 341→85 | 34→5 | 32 | 95 | [md](routes/evidence-id-.md) |
| `/forgot-password` | A | 1→139 | 0→20 | 0 | 0 | 0 | 0→28 | 0→13 | 0 | 0 | [md](routes/forgot-password.md) |
| `/home` | C | 202→147 | 588→26 | 6 | 572 | 5 | 89→32 | 25→12 | 15 | 51 | [md](routes/home.md) |
| `/inbox` | C | 166→146 | 54→30 | 3 | 49 | 1 | 66→44 | 5→9 | 1 | 45 | [md](routes/inbox.md) |
| `/intake-links` | C | 184→146 | 190→26 | 4 | 181 | 3 | 122→34 | 9→4 | 5 | 74 | [md](routes/intake-links.md) |
| `/intake/[token]` | C | 121→138 | 63→27 | 0 | 61 | 0 | 13→31 | 1→1 | 0 | 29 | [md](routes/intake-token-.md) |
| `/intake/[token]/capture` | C | 1→138 | 4→20 | 0 | 4 | 0 | 0→28 | 0→1 | 0 | 0 | [md](routes/intake-token-capture.md) |
| `/invite/[token]` | C | 143→138 | 35→16 | 2 | 33 | 1 | 43→28 | 6→1 | 6 | 21 | [md](routes/invite-token-.md) |
| `/legal/[slug]` | C | 146→139 | 34→18 | 2 | 32 | 1 | 42→37 | 4→2 | 4 | 17 | [md](routes/legal-slug-.md) |
| `/login` | C | 148→144 | 68→24 | 6 | 57 | 1 | 61→33 | 11→13 | 4 | 42 | [md](routes/login.md) |
| `/notifications` | C | 167→146 | 54→30 | 3 | 49 | 1 | 66→44 | 5→9 | 1 | 45 | [md](routes/notifications.md) |
| `/operations` | **X** | 178→0 | 189→0 | 0 | 189 | 189 | 127→0 | 15→0 | 15 | 68 | [md](routes/operations.md) |
| `/operations/batch-analysis` | C | 161→140 | 39→31 | 2 | 33 | 1 | 38→41 | 8→5 | 7 | 14 | [md](routes/operations-batch-analysis.md) |
| `/operations/health` | **X** | 157→0 | 42→0 | 0 | 42 | 42 | 17→0 | 3→0 | 3 | 28 | [md](routes/operations-health.md) |
| `/operations/quotas` | C | 161→137 | 35→19 | 2 | 33 | 1 | 30→27 | 8→3 | 6 | 14 | [md](routes/operations-quotas.md) |
| `/org-invites/[token]/accept` | C | 145→143 | 18→21 | 0 | 18 | 0 | 4→30 | 3→3 | 1 | 0 | [md](routes/org-invites-token-accept.md) |
| `/organizations` | C | 146→138 | 46→14 | 1 | 44 | 0 | 14→27 | 4→2 | 3 | 0 | [md](routes/organizations.md) |
| `/organizations/[id]` | C | 172→143 | 217→45 | 6 | 204 | 5 | 99→51 | 24→2 | 23 | 17 | [md](routes/organizations-id-.md) |
| `/people` | C | 146→147 | 11→64 | 1 | 10 | 0 | 2→68 | 2→4 | 1 | 0 | [md](routes/people.md) |
| `/portal` | C | 121→134 | 8→15 | 0 | 8 | 0 | 8→26 | 6→0 | 6 | 0 | [md](routes/portal.md) |
| `/portal/[token]` | C | 123→139 | 18→20 | 0 | 18 | 0 | 11→28 | 6→5 | 2 | 0 | [md](routes/portal-token-.md) |
| `/portal/[token]/work/[workflowId]` | C | 124→139 | 28→24 | 0 | 28 | 0 | 23→32 | 6→5 | 2 | 0 | [md](routes/portal-token-work-workflowId-.md) |
| `/portal/accept/[grantId]` | C | 122→138 | 16→15 | 0 | 16 | 0 | 10→25 | 6→5 | 2 | 0 | [md](routes/portal-accept-grantId-.md) |
| `/pricing` | C | 143→141 | 59→26 | 2 | 57 | 1 | 42→32 | 5→6 | 4 | 17 | [md](routes/pricing.md) |
| `/privacy` | A | 1→139 | 0→18 | 0 | 0 | 0 | 0→37 | 0→2 | 0 | 0 | [md](routes/privacy.md) |
| `/register` | C | 147→140 | 68→27 | 4 | 60 | 3 | 61→31 | 11→13 | 5 | 41 | [md](routes/register.md) |
| `/reports` | C | 171→144 | 61→17 | 2 | 58 | 5 | 57→31 | 7→4 | 3 | 45 | [md](routes/reports.md) |
| `/reset-password` | C | 140→140 | 44→18 | 3 | 40 | 1 | 56→27 | 5→13 | 3 | 23 | [md](routes/reset-password.md) |
| `/search` | C | 156→145 | 146→20 | 2 | 137 | 1 | 71→32 | 13→4 | 10 | 49 | [md](routes/search.md) |
| `/settings` | C | 199→164 | 390→150 | 6 | 347 | 2 | 156→114 | 46→37 | 23 | 39 | [md](routes/settings.md) |
| `/settings/legal/[slug]` | C | 152→139 | 21→18 | 0 | 21 | 0 | 4→37 | 2→2 | 2 | 3 | [md](routes/settings-legal-slug-.md) |
| `/settings/reviewer-criteria` | C | 146→145 | 62→45 | 4 | 54 | 2 | 31→55 | 5→5 | 1 | 12 | [md](routes/settings-reviewer-criteria.md) |
| `/share/[id]` | C | 139→152 | 40→110 | 2 | 38 | 1 | 42→85 | 4→5 | 3 | 17 | [md](routes/share-id-.md) |
| `/subprocessors` | A | 1→139 | 0→18 | 0 | 0 | 0 | 0→37 | 0→2 | 0 | 0 | [md](routes/subprocessors.md) |
| `/support` | C | 139→139 | 96→17 | 2 | 93 | 1 | 42→30 | 4→2 | 4 | 17 | [md](routes/support.md) |
| `/teams/[id]` | C | 182→147 | 280→64 | 7 | 249 | 5 | 152→68 | 26→4 | 22 | 60 | [md](routes/teams-id-.md) |
| `/terms` | A | 1→139 | 0→18 | 0 | 0 | 0 | 0→37 | 0→2 | 0 | 0 | [md](routes/terms.md) |
| `/trust` | C | 146→144 | 72→22 | 2 | 67 | 1 | 42→29 | 7→5 | 4 | 17 | [md](routes/trust.md) |
| `/trust-center` | A | 1→144 | 0→22 | 0 | 0 | 0 | 0→29 | 0→5 | 0 | 0 | [md](routes/trust-center.md) |
| `/trust-center/ai-disclosure` | C | 153→144 | 49→22 | 0 | 48 | 0 | 8→29 | 6→5 | 4 | 7 | [md](routes/trust-center-ai-disclosure.md) |
| `/trust-center/methodology` | C | 152→144 | 40→22 | 0 | 39 | 0 | 8→29 | 5→5 | 3 | 0 | [md](routes/trust-center-methodology.md) |
| `/trust-center/security` | C | 152→144 | 35→22 | 0 | 34 | 0 | 8→29 | 5→5 | 3 | 0 | [md](routes/trust-center-security.md) |
| `/trust-center/status` | C | 148→144 | 49→22 | 1 | 48 | 0 | 6→29 | 3→5 | 3 | 0 | [md](routes/trust-center-status.md) |
| `/trust-center/subprocessors` | C | 150→144 | 44→22 | 0 | 43 | 0 | 10→29 | 6→5 | 5 | 3 | [md](routes/trust-center-subprocessors.md) |
| `/verify` | C | 147→146 | 59→24 | 2 | 57 | 1 | 46→29 | 4→3 | 4 | 17 | [md](routes/verify.md) |
| `/verify/[token]` | C | 147→146 | 175→24 | 4 | 170 | 3 | 47→29 | 7→3 | 4 | 15 | [md](routes/verify-token-.md) |
| `/workspaces` ᴮ | C | 153→143 | 127→23 | 0 | 125 | 1 | 9→35 | 4→3 | 2 | 12 | [md](routes/workspaces.md) |

**Legend** — C = COMPARED · A = ALIAS_REDIRECT (web page is a `redirect()` shim; compared at its target) · **X** = NO_NATIVE_SCREEN · ᴮ = borderline (Enterprise-gated, excluded from gap counts).

`role-absent` is the strongest verdict: the native counterpart screen holds no element of that role at all. See [M-ABSENT-CONTROLS.md](M-ABSENT-CONTROLS.md), where the 101 occurrences deduplicate to 63 distinct controls.