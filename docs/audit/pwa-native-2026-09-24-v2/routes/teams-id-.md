# Route register — `/teams/[id]`

**Frozen SHA:** `71e148f34410c7c231f8930d1387d8924b10b4e5` · **Disposition:** `COMPARED`
**Surface tier:** PROFESSIONAL / redirect
**Ledger claim:** `CODE_PARITY` · **physicallyAccepted:** `false`

## L1–L3 · Route, shell and component trees

| | PWA | Native |
|---|---|---|
| Entry | `apps/web/app/(app)/teams/[id]/page.tsx` | `apps/mobile/app/(stack)/workspace-people.tsx` |
| Files in recursive tree | 182 | 147 |
| Max import depth | 6 | 10 |
| **Unresolved imports** | **0** | **0** |
| JSX elements | 954 | 236 |

## L4 · Content and element correspondence

| | Count |
|---|---:|
| Labelled web elements | 280 |
| Labelled native elements | 64 |
| Paired exactly (same role + same literal) | 7 |
| Paired, role differs | 24 |
| Unpaired web labels | 249 |
| — of which the native screen has NO element of that role | **5** |
| Extra in native | 43 |
| Web elements carrying no literal label | 917 |

### Adjudication of the unpaired web labels

| Verdict | Count |
|---|---:|
| `COPY_OR_COMPOSITION_DIFF` | 183 |
| `PRESENT_ELSEWHERE_IN_APP` | 60 |
| `ROLE_ABSENT_ON_SCREEN` | 5 |
| `EXTRACTOR_ARTIFACT` | 1 |

#### `ROLE_ABSENT_ON_SCREEN` — 5 (the native screen has no control of this kind)

| Role | Literal | PWA source |
|---|---|---|
| SELECT | "Workspace role" | `apps/web/app/(app)/teams/[id]/page.tsx:2235` |
| SELECT | "Filter members by status" | `apps/web/app/(app)/teams/[id]/components/WorkspaceMembersPanel.tsx:326` |
| STATE_EMPTY | "Session inventory unavailable" | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:1848` |
| STATE_EMPTY | "No security events in the recent window" | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:2008` |
| TABLE | "Actions" | `apps/web/components/ui/DataTable.tsx:182` |

## L5 · Resolved style properties and colour

| | PWA | Native |
|---|---:|---:|
| Style properties resolved to literals | 2566 | 261 |
| Distinct colours actually used by this route's elements | **66** | **19** |
| — shared between the two | 6 | 6 |
| — **PWA-only (no native counterpart value)** | **60** | — |
| Classes with no matching CSS rule (UNRESOLVED) | 35 (17 distinct) | — |
| className built from a runtime expression (UNRESOLVED) | 21 | — |
| Competing rules for one class (cascade decides at runtime) | 157 | — |
| Native theme tokens not resolvable to a literal | — | 88 |

**PWA-only colours on this route (first 30):** `rgba(124, 58, 237, 0.10)` `rgba(73, 184, 255, 0.08)` `rgba(124, 58, 237, 0.16)` `rgba(255, 255, 255, 0.8)` `#172033` `#5f6878` `rgba(255, 255, 255, 0.5)` `rgba(255, 255, 255, 0.6)` `rgba(15, 23, 42, 0.03)` `rgba(15, 23, 42, 0.05)` `rgba(255, 255, 255, 0.42)` `rgba(255, 255, 255, 0.58)` `rgba(15, 23, 42, 0.04)` `rgba(109, 40, 217, 0.5)` `rgba(15, 23, 42, 0.12)` `rgba(124, 58, 237, 0.28)` `rgba(124, 58, 237, 0.24)` `rgba(15, 23, 42, 0.08)` `#344054` `#667085` `rgba(255, 255, 255, 0.70)` `rgba(178, 52, 66, 0.24)` `rgba(248, 250, 253, 0.7)` `rgba(15, 23, 42, 0.07)` `rgba(100, 116, 139, 0.22)` `rgba(255, 255, 255, 0.92)` `#263247` `#8b7cf6` `rgba(124, 58, 237, 0.14)` `#8793a6`

## L6 · Conditional states

| | PWA | Native |
|---|---:|---:|
| Conditional branches (ternary / && / .map) | 1879 | 1187 |
| Declared state roles present | STATE_EMPTY, STATE_LOADING | STATE_LOADING, STATE_ERROR |

## L7 · Interactions

| | PWA | Native |
|---|---:|---:|
| Handler bindings | 152 | 68 |

## L8 · Data dependencies

| | Count |
|---|---:|
| Distinct `/v1` endpoints the PWA route reaches | 26 |
| Distinct `/v1` endpoints the native screen reaches | 4 |
| Shared | 4 |
| **Called by PWA, never by native** | **22** |
| Called by native only | 0 |

**Endpoints the PWA route calls that this native screen never calls:**

- `/v1/platform/context/switch-workspace` — `apps/web/lib/platform-context/PlatformContextProvider.tsx:476`
- `/v1/identity/links` — `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:177`
- `/v1/identity/mfa/factors` — `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:192`
- `/v1/identity-security/my-sessions` — `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:211`
- `/v1/identity-security/password` — `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:380`
- `/v1/identity/links/${…}` — `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:872`
- `/v1/identity/password` — `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:834`
- `/v1/identity/mfa/enroll/start` — `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:1152`
- `/v1/identity/mfa/enroll/verify` — `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:1178`
- `/v1/identity/mfa/factors/${…}` — `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:1296`
- `/v1/identity/mfa/recovery-codes/regenerate` — `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:1245`
- `/v1/identity-security/my-sessions/revoke-others` — `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:1650`
- `/v1/identity-security/my-sessions/${…}` — `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:1695`
- `/v1/identity-security/security-events?limit=50` — `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:1980`
- `/v1/identity-security/contact-factors` — `apps/web/components/identity-security/ContactFactorEnrollmentPanel.tsx:230`
- `/v1/identity-security/contact-factors/enroll/start` — `apps/web/components/identity-security/ContactFactorEnrollmentPanel.tsx:347`
- `/v1/identity-security/contact-factors/enroll/verify` — `apps/web/components/identity-security/ContactFactorEnrollmentPanel.tsx:451`
- `/v1/identity-security/contact-factors/${…}` — `apps/web/components/identity-security/ContactFactorEnrollmentPanel.tsx:518`
- `/v1/users/me` — `apps/web/app/providers.tsx:93`
- `/v1/users/cookie-consent` — `apps/web/app/providers.tsx:252`
- `/v1/` — `apps/web/lib/privacy/redact.ts:227`
- `/v1/platform/rbac/matrix` — `apps/web/app/(app)/teams/[id]/components/TeamPermissionMatrix.tsx:175`

## Unresolved for this route

- `COPY_OR_COMPOSITION_DIFF`: **183** — needs a per-element read.
- Web classes with no CSS rule: **35**.
- Runtime-built `className`: **21**.
- Which CSS declaration wins: **unresolvable by construction** (cascade + specificity + conditional class application are runtime facts). Competing rules found: 157.

> Nothing in this register is a rendered claim. No screenshot, simulator or device was used.