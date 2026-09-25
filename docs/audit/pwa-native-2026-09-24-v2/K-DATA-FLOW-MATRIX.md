# K — CROSS-SCREEN DATA-FLOW MATRIX

**Frozen SHA:** `71e148f34410c7c231f8930d1387d8924b10b4e5` · source-only · nothing rendered

Answers mandate §10: *why does virtually every Native page show missing or
incorrect information?* Every applicable data-bearing screen was compared on the
complete path — env resolution, auth, workspace scope, endpoint, parameters,
mapping, states.

---

## K.1 Shared foundations — compared, and NOT the cause

| Dimension | PWA | Native | Verdict |
|---|---|---|---|
| API base | `NEXT_PUBLIC_API_BASE`; never a relative `/v1` (the rewrite does not exist) | `EXPO_PUBLIC_API_BASE` (`eas.json` → `https://api.proovra.com`; local `.env` present) | **MATCH** |
| Auth transport | bearer token from the auth provider | `apiFetch` + `src/auth-context.tsx`, `GET /v1/auth/me` | **MATCH** |
| Workspace id resolution | canonical `useActiveWorkspaceId` → `workspace.id` ↦ `personalSpace.id` | `projectPlatformContext` → `activeSpace.id`, which the **server** already derives as `workspace.id ?? personalSpace.id` (`platform-context.service.ts:1137-1167`) | **MATCH — native is *more* correct than the deprecated `useWorkspaceId()` the web's own `/search` still uses** |
| Workspace scoping of list reads | server-derived from the session; the web does **not** send `teamId` to e.g. `library-summary` | same | **MATCH** |

### A hypothesis raised and falsified

18 native screens call `apiFetch` with no `teamId`/`usePlatformContext` reference
(`(tabs)/evidence.tsx` 15 calls, `(stack)/case/[id].tsx` 12,
`(stack)/organizations/[id].tsx` 11, `(tabs)/teams.tsx` 3, `(stack)/billing.tsx` 3 …).
That looked like an unscoped-read defect.

**It is not.** Verified on the four largest cases:

* `/evidence` — the **web** also sends no `teamId` to `/v1/evidence/library-summary`; scope is server-derived from the session on both sides.
* `/billing` — neither side references `teamId`.
* `/notifications` — both read the account-scoped `/v1/me/inbox`.
* `/collaboration-teams` — the web's 9 `teamId` references are **row-level collaboration-team ids** (`page.tsx:963,1085,1109`), not workspace scope.

**Recorded as a negative result.** "Wrong workspace" is ruled out as the cause of
missing data on these screens, which redirects the investigation to K.2 and K.3.

---

## K.2 The real data gap — 111 endpoints no native file calls

Across the 63 applicable routes the PWA reaches **478** distinct `/v1` endpoints;
native reaches **359**. Splitting the difference into two different facts:

| | Count | Meaning |
|---|---:|---|
| **`ABSENT_FROM_APP`** | **111 endpoints** | no file anywhere in `apps/mobile` calls it |
| `NOT_ON_THIS_SCREEN` | 33 endpoints | native calls it somewhere, not on this route's counterpart |

(`/v1/` bare was dropped — it is an API-base constant, not an endpoint, and was
inflating the first pass by 22 routes.)

### `ABSENT_FROM_APP` by family

| Family | Endpoints | Applicable routes touched | Note |
|---|---:|---:|---|
| `/v1/ops` | **17** | 4 | the Operations surface — consistent with V2-007 (no native screen) |
| `/v1/search` | **9** | 1 | `/search` index-health, activity log, saved searches |
| `/v1/billing` | **8** | 2 | checkout (stripe/paypal), plan change, storage add-ons |
| `/v1/identity-security` | 7 | 6 | step-up, contact factors |
| `/v1/identity` | 6 | 6 | password, links, MFA admin |
| `/v1/communications` | 6 | 3 | Enterprise-tier surface |
| `/v1/siu` | 6 | 1 | insurance SIU — Enterprise |
| `/v1/trust` | 4 | 5 | subprocessor detail |
| `/v1/workflow` | 4 | 3 | intake-link creation (K.4) |
| `/v1/users/cookie-consent` | 1 | **18** | **VALID ADAPTATION** — no cookie banner in an installed app |
| 28 further families | 1–3 each | 1–4 | see `completion-manifest.json → apiGaps` |

### `NOT_ON_THIS_SCREEN` — dominated by the absent app shell

| Endpoint | Routes | Why |
|---|---:|---|
| `/v1/platform/context/switch-workspace` | **33** | native defines it (`src/product/spaces.ts:47`) but only `/spaces` uses it. The web offers the switcher in the header on **every** page; native offers it on one screen reached through Settings. **This is V2-005 measured.** |
| `/v1/platform/context` | **19** | only 14 native screens call `usePlatformContext`; the web reads the envelope in the shell, so every page has it |
| `/v1/users/me` | 17 | native reads **one** endpoint where the web reads 26 for the same pane (`src/product/account-security.ts:6-7`, the module's own words) |
| `/v1/auth/me` | 10 | native's session check; not wired into these screens |

---

## K.3 Request-parameter gaps — same endpoint, less data

A shared endpoint is not a shared request. Example, fully traced:

**`GET /v1/evidence/library-summary`**

| | Parameters sent |
|---|---|
| PWA (`app/(app)/evidence/page.tsx:81-106`) | `scope`, `search`, `status`, `type`, `caseAssignment`, `caseId`, `reportReady`, `tsaStatus`, `otsStatus`, `publicVerifyState`, `verificationStatus`, `acquisition` — **12** |
| Native (`app/(tabs)/evidence.tsx`) | `scope` — **1** |

Both reach the same endpoint and both are correctly workspace-scoped, so an
endpoint-level comparison scores this a MATCH. **It is not one.** Eleven filter
dimensions the web user can apply have no native control, which is visible to a
user as "the list shows different things than the web".

This class is why the per-route registers record parameters, not just endpoints.

---

## K.4 Functionality the native app declines in product copy

`app/(stack)/intake-links.tsx:339` renders, to the user:

> "Intake links are delivered securely to recipients. **Creating a new link, and
> resending one, stay in the PROOVRA web app**: a resend needs the link's raw
> token, which the API never persists, so it can only be sent from the session
> that created it."

Honest disclosure, and the stated reason is sound **for resend**. It does not
explain why **creation** is web-only — nothing about creating a link requires a
previously-issued raw token. Recorded as a **partially-justified functional gap**,
not as a valid adaptation.

---

## K.5 Answering the three questions the mandate asks

**Why might Native show zero records / blank KPIs / empty lists?**

| Candidate | Verdict |
|---|---|
| Wrong workspace | **RULED OUT** by source (K.1) |
| Failed request read as "no records" | **RULED OUT for Home** — every KPI degrades to `"Not available"`, never `0` (`src/product/home-dashboard.ts:127`). Native's honesty posture here is better than a naive port |
| Data genuinely not fetched | **CONFIRMED** — 111 endpoints absent from the app (K.2) |
| Data fetched but unfiltered/unsorted differently | **CONFIRMED** — K.3 |
| Surface absent entirely | **CONFIRMED** — `/operations`, `/operations/health` (V2-007) |

**Not one cause. At least four, with different fixes.**

### A / Proven by source
K.2 (111 absent endpoints), K.3 (parameter gaps), K.4 (intake creation),
V2-007 (absent screens), V2-005 (absent shell ⇒ switch-workspace on 33 routes).

### B / Supported hypothesis
V2-001 — the OAuth audience allow-list. If sign-in degrades to a partially
authorized session, *every* screen under-reads. One `printenv` settles it.

### C / Requires runtime evidence
Whether any specific empty screen on the user's iPad was an authorization denial
rather than an absent call. **Minimal safe diagnostic:** for one affected screen,
the HTTP **status code** and the sanitized **path** of each request (no bodies, no
tokens, no headers), plus the `activeSpace.id` shown by `/v1/platform/context`
compared with the workspace the web session reports. That is sufficient and
exposes no secret.
