# C — FINAL PER-ROUTE DEFECT MATRIX

**Frozen SHA:** `71e148f34410c7c231f8930d1387d8924b10b4e5` · SOURCE-ONLY · nothing rendered

Every applicable route with its confirmed differences. Shared root causes are
referenced by ID (see `FINAL-ROOT-CAUSE-REGISTER.md`) and **not** repeated per row.

**Applies to EVERY row below:** RC-04 (no font loaded), RC-07 (primitive shape divergence), RC-08 (web bypasses tokens), RC-10 (no app header → no global search, no workspace switcher, no account menu, no bell).

| Route | Disp | web→nat files | elements absent | role-absent | handlers | API gap | unreachable-in-native | Route root causes |
|---|---|---|---:|---:|---|---:|---:|---|
| `/abuse-reporting` | A | 1→139 | 0 | 0 | 0→37 | 0 | 0 | — |
| `/auth` | A | 1→144 | 0 | 0 | 0→33 | 0 | 0 | — |
| `/auth/callback/ui` | C | 135→144 | 10 | 1 | 29→33 | 3 | 1 | — |
| `/auth/mfa-challenge` | C | 130→146 | 29 | 1 | 42→32 | 2 | 5 | — |
| `/auth/mfa-recovery/verify` | C | 2→137 | 4 | 0 | 0→26 | 0 | 1 | — |
| `/auth/verify-email` | C | 141→143 | 21 | 1 | 55→25 | 4 | 3 | — |
| `/billing` | C | 179→141 | 67 | 4 | 98→32 | 10 | 15 | RC-16 (8 billing endpoints incl. checkout) |
| `/capture` | C | 207→161 | 169 | 1 | 111→85 | 7 | 25 | RC-18, RC-19 |
| `/cases` | C | 172→144 | 57 | 3 | 99→33 | 3 | 21 | RC-13 (Risk level, Bulk action) |
| `/cases/[id]` | C | 193→141 | 359 | 6 | 180→47 | 22 | 52 | RC-13 (Priority, Assignee, Team) |
| `/collaboration-teams` | C | 163→140 | 61 | 6 | 66→33 | 3 | 11 | RC-13 (5 filters) |
| `/collaboration-teams/[teamId]` | C | 174→145 | 123 | 8 | 146→64 | 3 | 10 | RC-13 (Assignee, Priority) |
| `/collaboration-teams/[teamId]/collaboration` | C | 1→145 | 1 | 0 | 0→64 | 0 | 0 | — |
| `/collaboration-teams/invites/[token]/accept` | C | 154→138 | 28 | 3 | 31→28 | 3 | 2 | — |
| `/data-retention` | A | 1→139 | 0 | 0 | 0→37 | 0 | 0 | — |
| `/evidence` | C | 182→141 | 58 | 3 | 126→80 | 3 | 3 | RC-13 (Target case) |
| `/evidence-requests/[id]` | C | 161→141 | 89 | 2 | 46→38 | 10 | 4 | — |
| `/evidence/[id]` | C | 262→152 | 507 | 14 | 341→85 | 32 | 36 | RC-13 (Select case, Assigned reviewer) |
| `/forgot-password` | A | 1→139 | 0 | 0 | 0→28 | 0 | 0 | — |
| `/home` | C | 202→147 | 422 | 5 | 89→32 | 15 | 18 | RC-14 (6 Home modules absent) |
| `/inbox` | C | 166→146 | 29 | 1 | 66→44 | 1 | 8 | — |
| `/intake-links` | C | 184→146 | 119 | 3 | 122→34 | 5 | 37 | RC-20 |
| `/intake/[token]` | C | 121→138 | 50 | 0 | 13→31 | 0 | 3 | — |
| `/intake/[token]/capture` | C | 1→138 | 4 | 0 | 0→28 | 0 | 0 | — |
| `/invite/[token]` | C | 143→138 | 12 | 1 | 43→28 | 6 | 3 | — |
| `/legal/[slug]` | C | 146→139 | 11 | 1 | 42→37 | 4 | 0 | — |
| `/login` | C | 148→144 | 25 | 1 | 61→33 | 4 | 3 | RC-05, RC-11(sibling), RC-01, RC-03 |
| `/notifications` | C | 167→146 | 29 | 1 | 66→44 | 1 | 8 | — |
| `/operations` | **X** | 178→0 | 189 | 189 | 127→0 | 15 | 0 | **RC-12 — NO NATIVE SCREEN** |
| `/operations/batch-analysis` | C | 161→140 | 22 | 1 | 38→41 | 7 | 0 | — |
| `/operations/health` | **X** | 157→0 | 42 | 42 | 17→0 | 3 | 0 | **RC-12 — NO NATIVE SCREEN** |
| `/operations/quotas` | C | 161→137 | 24 | 1 | 30→27 | 6 | 1 | — |
| `/org-invites/[token]/accept` | C | 145→143 | 15 | 0 | 4→30 | 1 | 4 | — |
| `/organizations` | C | 146→138 | 33 | 0 | 14→27 | 3 | 8 | — |
| `/organizations/[id]` | C | 172→143 | 135 | 5 | 99→51 | 23 | 18 | RC-13 (New owner) |
| `/people` | C | 146→147 | 10 | 0 | 2→68 | 1 | 0 | — |
| `/portal` | C | 121→134 | 8 | 0 | 8→26 | 6 | 0 | — |
| `/portal/[token]` | C | 123→139 | 11 | 0 | 11→28 | 2 | 2 | — |
| `/portal/[token]/work/[workflowId]` | C | 124→139 | 19 | 0 | 23→32 | 2 | 5 | — |
| `/portal/accept/[grantId]` | C | 122→138 | 15 | 0 | 10→25 | 2 | 0 | — |
| `/pricing` | C | 143→141 | 29 | 1 | 42→32 | 4 | 4 | — |
| `/privacy` | A | 1→139 | 0 | 0 | 0→37 | 0 | 0 | — |
| `/register` | C | 147→140 | 29 | 3 | 61→31 | 5 | 6 | **RC-11 (no OAuth sign-up)**, RC-05 |
| `/reports` | C | 171→144 | 30 | 5 | 57→31 | 3 | 6 | — |
| `/reset-password` | C | 140→140 | 20 | 1 | 56→27 | 3 | 5 | — |
| `/search` | C | 156→145 | 93 | 1 | 71→32 | 10 | 33 | RC-10, RC-16 (9 search endpoints) |
| `/settings` | C | 199→164 | 261 | 2 | 156→114 | 23 | 16 | RC-16 (23 endpoints off-screen) |
| `/settings/legal/[slug]` | C | 152→139 | 18 | 0 | 4→37 | 2 | 3 | — |
| `/settings/reviewer-criteria` | C | 146→145 | 46 | 2 | 31→55 | 1 | 6 | — |
| `/share/[id]` | C | 139→152 | 16 | 1 | 42→85 | 3 | 1 | — |
| `/subprocessors` | A | 1→139 | 0 | 0 | 0→37 | 0 | 0 | — |
| `/support` | C | 139→139 | 66 | 1 | 42→30 | 4 | 3 | — |
| `/teams/[id]` | C | 182→147 | 183 | 5 | 152→68 | 22 | 14 | — |
| `/terms` | A | 1→139 | 0 | 0 | 0→37 | 0 | 0 | — |
| `/trust` | C | 146→144 | 46 | 1 | 42→29 | 4 | 1 | — |
| `/trust-center` | A | 1→144 | 0 | 0 | 0→29 | 0 | 0 | — |
| `/trust-center/ai-disclosure` | C | 153→144 | 35 | 0 | 8→29 | 4 | 8 | — |
| `/trust-center/methodology` | C | 152→144 | 32 | 0 | 8→29 | 3 | 4 | — |
| `/trust-center/security` | C | 152→144 | 27 | 0 | 8→29 | 3 | 4 | — |
| `/trust-center/status` | C | 148→144 | 31 | 0 | 6→29 | 3 | 12 | — |
| `/trust-center/subprocessors` | C | 150→144 | 29 | 0 | 10→29 | 5 | 7 | — |
| `/verify` | C | 147→146 | 32 | 1 | 46→29 | 4 | 1 | — |
| `/verify/[token]` | C | 147→146 | 145 | 3 | 47→29 | 4 | 15 | RC-02 (link opens Safari), RC-14 |
| `/workspaces` ᴮ | C | 153→143 | 76 | 1 | 9→35 | 2 | 1 | — |

**Legend** — C = COMPARED · A = ALIAS_REDIRECT (web page is a `redirect()` shim, compared at its target) · **X** = NO NATIVE SCREEN · ᴮ = borderline (Enterprise-gated; excluded from gap counts).

`unreachable-in-native` = strings that exist somewhere in the native app but on a screen **not reachable** from this route (RC-15). The fix is navigation, not copy.

Full element-level detail per route: `routes/<slug>.md` (human) and `routes-v4/<slug>.adjudicated.json` (every verdict with file:line).