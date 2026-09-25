# Route register — `/organizations/[id]`

**Frozen SHA:** `71e148f34410c7c231f8930d1387d8924b10b4e5` · **Disposition:** `COMPARED`
**Surface tier:** ENTERPRISE / allow
**Ledger claim:** `CODE_PARITY` · **physicallyAccepted:** `false`

## L1–L3 · Route, shell and component trees

| | PWA | Native |
|---|---|---|
| Entry | `apps/web/app/(app)/organizations/[id]/page.tsx` | `apps/mobile/app/(stack)/organizations/[id].tsx` |
| Files in recursive tree | 172 | 143 |
| Max import depth | 9 | 9 |
| **Unresolved imports** | **0** | **0** |
| JSX elements | 637 | 207 |

## L4 · Content and element correspondence

| | Count |
|---|---:|
| Labelled web elements | 217 |
| Labelled native elements | 45 |
| Paired exactly (same role + same literal) | 6 |
| Paired, role differs | 7 |
| Unpaired web labels | 204 |
| — of which the native screen has NO element of that role | **5** |
| Extra in native | 34 |
| Web elements carrying no literal label | 606 |

### Adjudication of the unpaired web labels

| Verdict | Count |
|---|---:|
| `COPY_OR_COMPOSITION_DIFF` | 135 |
| `PRESENT_ELSEWHERE_IN_APP` | 63 |
| `ROLE_ABSENT_ON_SCREEN` | 5 |
| `EXTRACTOR_ARTIFACT` | 1 |

#### `ROLE_ABSENT_ON_SCREEN` — 5 (the native screen has no control of this kind)

| Role | Literal | PWA source |
|---|---|---|
| STATE_EMPTY | "No workspaces bound to this organization." | `apps/web/app/(app)/organizations/[id]/page.tsx:1016` |
| SELECT | "New owner" | `apps/web/app/(app)/organizations/[id]/page.tsx:1472` |
| STATE_EMPTY | "Session inventory unavailable" | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:1848` |
| STATE_EMPTY | "No security events in the recent window" | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:2008` |
| TABLE | "Actions" | `apps/web/components/ui/DataTable.tsx:182` |

## L5 · Resolved style properties and colour

| | PWA | Native |
|---|---:|---:|
| Style properties resolved to literals | 218 | 261 |
| Distinct colours actually used by this route's elements | **18** | **19** |
| — shared between the two | 1 | 1 |
| — **PWA-only (no native counterpart value)** | **17** | — |
| Classes with no matching CSS rule (UNRESOLVED) | 0 (0 distinct) | — |
| className built from a runtime expression (UNRESOLVED) | 18 | — |
| Competing rules for one class (cascade decides at runtime) | 13 | — |
| Native theme tokens not resolvable to a literal | — | 86 |

**PWA-only colours on this route (first 17):** `rgba(124, 58, 237, 0.28)` `rgba(124, 58, 237, 0.24)` `rgba(0, 0, 0, 0.7)` `#102126` `#1b3136` `rgba(158, 216, 207, 0.2)` `rgba(158, 216, 207, 0.1)` `rgba(0, 0, 0, 0.4)` `rgba(158, 216, 207, 0.15)` `#e2e8f0` `#cbd5e1` `#f0f4f8` `#64748b` `#0f1d36` `#d64545` `rgba(107, 91, 255, 0.28)` `#f1f4f9`

## L6 · Conditional states

| | PWA | Native |
|---|---:|---:|
| Conditional branches (ternary / && / .map) | 1683 | 1157 |
| Declared state roles present | STATE_EMPTY, STATE_LOADING, STATE_ERROR | STATE_LOADING, STATE_ERROR |

## L7 · Interactions

| | PWA | Native |
|---|---:|---:|
| Handler bindings | 99 | 51 |

## L8 · Data dependencies

| | Count |
|---|---:|
| Distinct `/v1` endpoints the PWA route reaches | 24 |
| Distinct `/v1` endpoints the native screen reaches | 2 |
| Shared | 1 |
| **Called by PWA, never by native** | **23** |
| Called by native only | 1 |

**Endpoints the PWA route calls that this native screen never calls:**

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
- `/v1/platform/context` — `apps/web/lib/platform-context/PlatformContextProvider.tsx:414`
- `/v1/platform/context/switch-workspace` — `apps/web/lib/platform-context/PlatformContextProvider.tsx:476`
- `/v1/users/me` — `apps/web/app/providers.tsx:93`
- `/v1/auth/me` — `apps/web/app/providers.tsx:97`
- `/v1/users/cookie-consent` — `apps/web/app/providers.tsx:252`
- `/v1/` — `apps/web/lib/privacy/redact.ts:227`

## Unresolved for this route

- `COPY_OR_COMPOSITION_DIFF`: **135** — needs a per-element read.
- Web classes with no CSS rule: **0**.
- Runtime-built `className`: **18**.
- Which CSS declaration wins: **unresolvable by construction** (cascade + specificity + conditional class application are runtime facts). Competing rules found: 13.

> Nothing in this register is a rendered claim. No screenshot, simulator or device was used.