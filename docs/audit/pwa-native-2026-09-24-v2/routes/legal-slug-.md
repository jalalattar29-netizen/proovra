# Route register — `/legal/[slug]`

**Frozen SHA:** `71e148f34410c7c231f8930d1387d8924b10b4e5` · **Disposition:** `COMPARED`
**Surface tier:** UNMATCHED(default CORE) / allow(default)
**Ledger claim:** `CODE_PARITY` · **physicallyAccepted:** `false`

## L1–L3 · Route, shell and component trees

| | PWA | Native |
|---|---|---|
| Entry | `apps/web/app/legal/[slug]/page.tsx` | `apps/mobile/app/(stack)/legal/[slug].tsx` |
| Files in recursive tree | 146 | 139 |
| Max import depth | 9 | 10 |
| **Unresolved imports** | **0** | **0** |
| JSX elements | 306 | 177 |

## L4 · Content and element correspondence

| | Count |
|---|---:|
| Labelled web elements | 34 |
| Labelled native elements | 18 |
| Paired exactly (same role + same literal) | 2 |
| Paired, role differs | 0 |
| Unpaired web labels | 32 |
| — of which the native screen has NO element of that role | **1** |
| Extra in native | 14 |
| Web elements carrying no literal label | 293 |

### Adjudication of the unpaired web labels

| Verdict | Count |
|---|---:|
| `NOT_APPLICABLE_SHELL` | 16 |
| `COPY_OR_COMPOSITION_DIFF` | 11 |
| `PRESENT_ELSEWHERE_IN_APP` | 4 |
| `ROLE_ABSENT_ON_SCREEN` | 1 |

#### `ROLE_ABSENT_ON_SCREEN` — 1 (the native screen has no control of this kind)

| Role | Literal | PWA source |
|---|---|---|
| TABLE | "Actions" | `apps/web/components/ui/DataTable.tsx:182` |

## L5 · Resolved style properties and colour

| | PWA | Native |
|---|---:|---:|
| Style properties resolved to literals | 279 | 231 |
| Distinct colours actually used by this route's elements | **20** | **20** |
| — shared between the two | 3 | 3 |
| — **PWA-only (no native counterpart value)** | **17** | — |
| Classes with no matching CSS rule (UNRESOLVED) | 279 (155 distinct) | — |
| className built from a runtime expression (UNRESOLVED) | 24 | — |
| Competing rules for one class (cascade decides at runtime) | 12 | — |
| Native theme tokens not resolvable to a literal | — | 81 |

**PWA-only colours on this route (first 17):** `#e2e8f0` `rgba(15, 23, 42, 0.04)` `#cbd5e1` `rgba(15, 23, 42, 0.035)` `rgba(255, 255, 255, 0.28)` `rgba(0, 0, 0, 0.7)` `#102126` `#1b3136` `rgba(158, 216, 207, 0.2)` `rgba(158, 216, 207, 0.1)` `rgba(0, 0, 0, 0.4)` `rgba(158, 216, 207, 0.15)` `#f0f4f8` `#64748b` `#0f1d36` `#d64545` `rgba(107, 91, 255, 0.28)`

## L6 · Conditional states

| | PWA | Native |
|---|---:|---:|
| Conditional branches (ternary / && / .map) | 1130 | 1033 |
| Declared state roles present | — | STATE_LOADING, STATE_ERROR |

## L7 · Interactions

| | PWA | Native |
|---|---:|---:|
| Handler bindings | 42 | 37 |

## L8 · Data dependencies

| | Count |
|---|---:|
| Distinct `/v1` endpoints the PWA route reaches | 4 |
| Distinct `/v1` endpoints the native screen reaches | 2 |
| Shared | 0 |
| **Called by PWA, never by native** | **4** |
| Called by native only | 2 |

**Endpoints the PWA route calls that this native screen never calls:**

- `/v1/users/me` — `apps/web/app/providers.tsx:93`
- `/v1/auth/me` — `apps/web/app/providers.tsx:97`
- `/v1/users/cookie-consent` — `apps/web/app/providers.tsx:252`
- `/v1/` — `apps/web/lib/privacy/redact.ts:227`

## Unresolved for this route

- `COPY_OR_COMPOSITION_DIFF`: **11** — needs a per-element read.
- Web classes with no CSS rule: **279**.
- Runtime-built `className`: **24**.
- Which CSS declaration wins: **unresolvable by construction** (cascade + specificity + conditional class application are runtime facts). Competing rules found: 12.

> Nothing in this register is a rendered claim. No screenshot, simulator or device was used.