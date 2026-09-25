# Route register — `/settings`

**Frozen SHA:** `71e148f34410c7c231f8930d1387d8924b10b4e5` · **Disposition:** `COMPARED`
**Surface tier:** CORE / allow
**Ledger claim:** `CODE_PARITY` · **physicallyAccepted:** `false`

## L1–L3 · Route, shell and component trees

| | PWA | Native |
|---|---|---|
| Entry | `apps/web/app/(app)/settings/page.tsx` | `apps/mobile/app/(tabs)/settings.tsx` |
| Files in recursive tree | 199 | 164 |
| Max import depth | 10 | 9 |
| **Unresolved imports** | **0** | **0** |
| JSX elements | 1155 | 413 |

## L4 · Content and element correspondence

| | Count |
|---|---:|
| Labelled web elements | 390 |
| Labelled native elements | 150 |
| Paired exactly (same role + same literal) | 6 |
| Paired, role differs | 37 |
| Unpaired web labels | 347 |
| — of which the native screen has NO element of that role | **2** |
| Extra in native | 111 |
| Web elements carrying no literal label | 1108 |

### Adjudication of the unpaired web labels

| Verdict | Count |
|---|---:|
| `COPY_OR_COMPOSITION_DIFF` | 261 |
| `PRESENT_ELSEWHERE_IN_APP` | 83 |
| `ROLE_ABSENT_ON_SCREEN` | 2 |
| `EXTRACTOR_ARTIFACT` | 1 |

#### `ROLE_ABSENT_ON_SCREEN` — 2 (the native screen has no control of this kind)

| Role | Literal | PWA source |
|---|---|---|
| SELECT | "UI language" | `apps/web/app/(app)/settings/_sections/PreferencesSection.tsx:171` |
| TABLE | "Actions" | `apps/web/components/ui/DataTable.tsx:182` |

## L5 · Resolved style properties and colour

| | PWA | Native |
|---|---:|---:|
| Style properties resolved to literals | 2314 | 304 |
| Distinct colours actually used by this route's elements | **47** | **20** |
| — shared between the two | 8 | 8 |
| — **PWA-only (no native counterpart value)** | **39** | — |
| Classes with no matching CSS rule (UNRESOLVED) | 54 (24 distinct) | — |
| className built from a runtime expression (UNRESOLVED) | 22 | — |
| Competing rules for one class (cascade decides at runtime) | 172 | — |
| Native theme tokens not resolvable to a literal | — | 135 |

**PWA-only colours on this route (first 30):** `rgba(109, 40, 217, 0.34)` `rgba(124, 58, 237, 0.28)` `rgba(124, 58, 237, 0.24)` `rgba(0, 0, 0, 0.7)` `#102126` `#1b3136` `rgba(158, 216, 207, 0.2)` `rgba(158, 216, 207, 0.1)` `rgba(0, 0, 0, 0.4)` `rgba(158, 216, 207, 0.15)` `#e2e8f0` `#cbd5e1` `#f0f4f8` `#64748b` `#0f1d36` `#d64545` `rgba(107, 91, 255, 0.28)` `#f1f4f9` `#172033` `rgba(100, 116, 139, 0.36)` `#8793a6` `rgba(255, 255, 255, 0.98)` `rgba(15, 23, 42, 0.1)` `rgba(15, 23, 42, 0.16)` `#263247` `rgba(99, 91, 255, 0.08)` `#667085` `rgba(100, 116, 139, 0.22)` `rgba(255, 255, 255, 0.92)` `#8b7cf6`

## L6 · Conditional states

| | PWA | Native |
|---|---:|---:|
| Conditional branches (ternary / && / .map) | 2027 | 1394 |
| Declared state roles present | STATE_EMPTY, STATE_LOADING | STATE_EMPTY, STATE_LOADING, STATE_ERROR |

## L7 · Interactions

| | PWA | Native |
|---|---:|---:|
| Handler bindings | 156 | 114 |

## L8 · Data dependencies

| | Count |
|---|---:|
| Distinct `/v1` endpoints the PWA route reaches | 46 |
| Distinct `/v1` endpoints the native screen reaches | 37 |
| Shared | 23 |
| **Called by PWA, never by native** | **23** |
| Called by native only | 14 |

**Endpoints the PWA route calls that this native screen never calls:**

- `/v1/platform/context/switch-workspace` — `apps/web/lib/platform-context/PlatformContextProvider.tsx:476`
- `/v1/users/cookie-consent` — `apps/web/app/providers.tsx:252`
- `/v1/` — `apps/web/lib/privacy/redact.ts:227`
- `/v1/platform/rbac/matrix` — `apps/web/app/(app)/settings/_sections/RolesSection.tsx:109`
- `/v1/billing/accounts` — `apps/web/app/(app)/settings/_sections/BillingSection.tsx:73`
- `/v1/billing/accounts/${…}` — `apps/web/app/(app)/settings/_sections/BillingSection.tsx:85`
- `/v1/identity/data-export/${…}` — `apps/web/app/(app)/settings/_sections/PrivacySection.tsx:212`
- `/v1/identity/account-closure/${…}` — `apps/web/app/(app)/settings/_sections/PrivacySection.tsx:526`
- `/v1/users/cookie-consent/latest` — `apps/web/app/(app)/settings/_sections/PrivacySection.tsx:876`
- `/v1/identity/links/${…}` — `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:872`
- `/v1/identity/password` — `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:834`
- `/v1/identity-security/contact-factors` — `apps/web/components/identity-security/ContactFactorEnrollmentPanel.tsx:230`
- `/v1/identity-security/contact-factors/enroll/start` — `apps/web/components/identity-security/ContactFactorEnrollmentPanel.tsx:347`
- `/v1/identity-security/contact-factors/enroll/verify` — `apps/web/components/identity-security/ContactFactorEnrollmentPanel.tsx:451`
- `/v1/identity-security/contact-factors/${…}` — `apps/web/components/identity-security/ContactFactorEnrollmentPanel.tsx:518`
- `/v1/workspaces/ai-policy?teamId=${…}` — `apps/web/components/ai-copilot/AiCapabilityStatusTable.tsx:74`
- `/v1/workspaces/ai-usage?teamId=${…}` — `apps/web/app/(app)/settings/_sections/AiSection.tsx:212`
- `/v1/workspaces/ai-policy` — `apps/web/app/(app)/settings/_sections/AiSection.tsx:256`
- `/v1/communications/verify/start` — `apps/web/components/notifications/ContactChannelVerificationCard.tsx:138`
- `/v1/communications/verify/check` — `apps/web/components/notifications/ContactChannelVerificationCard.tsx:197`
- `/v1/communications/preferences` — `apps/web/components/notifications/ContactChannelVerificationCard.tsx:270`
- `/v1/me/inbox?pageSize=1` — `apps/web/components/notifications/NotificationPreferencesPanel.tsx:239`
- `/v1/orgs/${…}` — `apps/web/components/notifications/NotificationPreferencesPanel.tsx:589`

## Unresolved for this route

- `COPY_OR_COMPOSITION_DIFF`: **261** — needs a per-element read.
- Web classes with no CSS rule: **54**.
- Runtime-built `className`: **22**.
- Which CSS declaration wins: **unresolvable by construction** (cascade + specificity + conditional class application are runtime facts). Competing rules found: 172.

> Nothing in this register is a rendered claim. No screenshot, simulator or device was used.