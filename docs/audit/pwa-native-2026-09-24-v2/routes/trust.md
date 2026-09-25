# Route register — `/trust`

**Frozen SHA:** `71e148f34410c7c231f8930d1387d8924b10b4e5` · **Disposition:** `COMPARED`
**Surface tier:** UNMATCHED(default CORE) / allow(default)
**Ledger claim:** `CODE_PARITY` · **physicallyAccepted:** `false`

## L1–L3 · Route, shell and component trees

| | PWA | Native |
|---|---|---|
| Entry | `apps/web/app/trust/page.tsx` | `apps/mobile/app/(stack)/trust-center.tsx` |
| Files in recursive tree | 146 | 144 |
| Max import depth | 8 | 9 |
| **Unresolved imports** | **0** | **0** |
| JSX elements | 441 | 168 |

## L4 · Content and element correspondence

| | Count |
|---|---:|
| Labelled web elements | 72 |
| Labelled native elements | 22 |
| Paired exactly (same role + same literal) | 2 |
| Paired, role differs | 3 |
| Unpaired web labels | 67 |
| — of which the native screen has NO element of that role | **1** |
| Extra in native | 17 |
| Web elements carrying no literal label | 428 |

### Adjudication of the unpaired web labels

| Verdict | Count |
|---|---:|
| `COPY_OR_COMPOSITION_DIFF` | 46 |
| `NOT_APPLICABLE_SHELL` | 15 |
| `PRESENT_ELSEWHERE_IN_APP` | 5 |
| `ROLE_ABSENT_ON_SCREEN` | 1 |

#### `ROLE_ABSENT_ON_SCREEN` — 1 (the native screen has no control of this kind)

| Role | Literal | PWA source |
|---|---|---|
| TABLE | "Actions" | `apps/web/components/ui/DataTable.tsx:182` |

## L5 · Resolved style properties and colour

| | PWA | Native |
|---|---:|---:|
| Style properties resolved to literals | 464 | 231 |
| Distinct colours actually used by this route's elements | **18** | **19** |
| — shared between the two | 1 | 1 |
| — **PWA-only (no native counterpart value)** | **17** | — |
| Classes with no matching CSS rule (UNRESOLVED) | 598 (222 distinct) | — |
| className built from a runtime expression (UNRESOLVED) | 30 | — |
| Competing rules for one class (cascade decides at runtime) | 10 | — |
| Native theme tokens not resolvable to a literal | — | 85 |

**PWA-only colours on this route (first 17):** `rgba(15, 23, 42, 0.035)` `rgba(255, 255, 255, 0.28)` `rgba(0, 0, 0, 0.7)` `#102126` `#1b3136` `rgba(158, 216, 207, 0.2)` `rgba(158, 216, 207, 0.1)` `rgba(0, 0, 0, 0.4)` `rgba(158, 216, 207, 0.15)` `#e2e8f0` `#cbd5e1` `#f0f4f8` `#64748b` `#0f1d36` `#d64545` `rgba(107, 91, 255, 0.28)` `#f1f4f9`

## L6 · Conditional states

| | PWA | Native |
|---|---:|---:|
| Conditional branches (ternary / && / .map) | 1138 | 1072 |
| Declared state roles present | — | STATE_LOADING |

## L7 · Interactions

| | PWA | Native |
|---|---:|---:|
| Handler bindings | 42 | 29 |

## L8 · Data dependencies

| | Count |
|---|---:|
| Distinct `/v1` endpoints the PWA route reaches | 7 |
| Distinct `/v1` endpoints the native screen reaches | 5 |
| Shared | 3 |
| **Called by PWA, never by native** | **4** |
| Called by native only | 2 |

**Endpoints the PWA route calls that this native screen never calls:**

- `/v1/users/me` — `apps/web/app/providers.tsx:93`
- `/v1/auth/me` — `apps/web/app/providers.tsx:97`
- `/v1/users/cookie-consent` — `apps/web/app/providers.tsx:252`
- `/v1/` — `apps/web/lib/privacy/redact.ts:227`

## Unresolved for this route

- `COPY_OR_COMPOSITION_DIFF`: **46** — needs a per-element read.
- Web classes with no CSS rule: **598**.
- Runtime-built `className`: **30**.
- Which CSS declaration wins: **unresolvable by construction** (cascade + specificity + conditional class application are runtime facts). Competing rules found: 10.

> Nothing in this register is a rendered claim. No screenshot, simulator or device was used.