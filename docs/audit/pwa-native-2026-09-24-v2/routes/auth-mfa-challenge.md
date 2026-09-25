# Route register — `/auth/mfa-challenge`

**Frozen SHA:** `71e148f34410c7c231f8930d1387d8924b10b4e5` · **Disposition:** `COMPARED`
**Surface tier:** UNMATCHED(default CORE) / allow(default)
**Ledger claim:** `CODE_PARITY` · **physicallyAccepted:** `false`

## L1–L3 · Route, shell and component trees

| | PWA | Native |
|---|---|---|
| Entry | `apps/web/app/auth/mfa-challenge/page.tsx` | `apps/mobile/app/(stack)/mfa.tsx` |
| Files in recursive tree | 130 | 146 |
| Max import depth | 7 | 10 |
| **Unresolved imports** | **0** | **0** |
| JSX elements | 200 | 161 |

## L4 · Content and element correspondence

| | Count |
|---|---:|
| Labelled web elements | 46 |
| Labelled native elements | 21 |
| Paired exactly (same role + same literal) | 2 |
| Paired, role differs | 3 |
| Unpaired web labels | 41 |
| — of which the native screen has NO element of that role | **1** |
| Extra in native | 13 |
| Web elements carrying no literal label | 190 |

### Adjudication of the unpaired web labels

| Verdict | Count |
|---|---:|
| `COPY_OR_COMPOSITION_DIFF` | 29 |
| `PRESENT_ELSEWHERE_IN_APP` | 11 |
| `ROLE_ABSENT_ON_SCREEN` | 1 |

#### `ROLE_ABSENT_ON_SCREEN` — 1 (the native screen has no control of this kind)

| Role | Literal | PWA source |
|---|---|---|
| TABLE | "Actions" | `apps/web/components/ui/DataTable.tsx:182` |

## L5 · Resolved style properties and colour

| | PWA | Native |
|---|---:|---:|
| Style properties resolved to literals | 103 | 241 |
| Distinct colours actually used by this route's elements | **16** | **19** |
| — shared between the two | 1 | 1 |
| — **PWA-only (no native counterpart value)** | **15** | — |
| Classes with no matching CSS rule (UNRESOLVED) | 0 (0 distinct) | — |
| className built from a runtime expression (UNRESOLVED) | 9 | — |
| Competing rules for one class (cascade decides at runtime) | 8 | — |
| Native theme tokens not resolvable to a literal | — | 82 |

**PWA-only colours on this route (first 15):** `rgba(0, 0, 0, 0.7)` `#102126` `#1b3136` `rgba(158, 216, 207, 0.2)` `rgba(158, 216, 207, 0.1)` `rgba(0, 0, 0, 0.4)` `rgba(158, 216, 207, 0.15)` `#e2e8f0` `#cbd5e1` `#f0f4f8` `#64748b` `#0f1d36` `#d64545` `rgba(107, 91, 255, 0.28)` `#f1f4f9`

## L6 · Conditional states

| | PWA | Native |
|---|---:|---:|
| Conditional branches (ternary / && / .map) | 1100 | 1092 |
| Declared state roles present | — | STATE_LOADING |

## L7 · Interactions

| | PWA | Native |
|---|---:|---:|
| Handler bindings | 42 | 32 |

## L8 · Data dependencies

| | Count |
|---|---:|
| Distinct `/v1` endpoints the PWA route reaches | 7 |
| Distinct `/v1` endpoints the native screen reaches | 17 |
| Shared | 5 |
| **Called by PWA, never by native** | **2** |
| Called by native only | 12 |

**Endpoints the PWA route calls that this native screen never calls:**

- `/v1/identity/mfa-admin/recovery-requests/detail/${…}` — `apps/web/components/mfa-recovery/MfaRecoveryRequestPanel.tsx:178`
- `/v1/teams` — `apps/web/components/mfa-recovery/MfaRecoveryRequestPanel.tsx:355`

## Unresolved for this route

- `COPY_OR_COMPOSITION_DIFF`: **29** — needs a per-element read.
- Web classes with no CSS rule: **0**.
- Runtime-built `className`: **9**.
- Which CSS declaration wins: **unresolvable by construction** (cascade + specificity + conditional class application are runtime facts). Competing rules found: 8.

> Nothing in this register is a rendered claim. No screenshot, simulator or device was used.