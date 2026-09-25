# Route register — `/reset-password`

**Frozen SHA:** `71e148f34410c7c231f8930d1387d8924b10b4e5` · **Disposition:** `COMPARED`
**Surface tier:** UNMATCHED(default CORE) / allow(default)
**Ledger claim:** `CODE_PARITY` · **physicallyAccepted:** `false`

## L1–L3 · Route, shell and component trees

| | PWA | Native |
|---|---|---|
| Entry | `apps/web/app/reset-password/page.tsx` | `apps/mobile/app/(stack)/reset-password.tsx` |
| Files in recursive tree | 140 | 140 |
| Max import depth | 8 | 10 |
| **Unresolved imports** | **0** | **0** |
| JSX elements | 290 | 153 |

## L4 · Content and element correspondence

| | Count |
|---|---:|
| Labelled web elements | 44 |
| Labelled native elements | 18 |
| Paired exactly (same role + same literal) | 3 |
| Paired, role differs | 1 |
| Unpaired web labels | 40 |
| — of which the native screen has NO element of that role | **1** |
| Extra in native | 12 |
| Web elements carrying no literal label | 275 |

### Adjudication of the unpaired web labels

| Verdict | Count |
|---|---:|
| `COPY_OR_COMPOSITION_DIFF` | 20 |
| `PRESENT_ELSEWHERE_IN_APP` | 10 |
| `NOT_APPLICABLE_SHELL` | 9 |
| `ROLE_ABSENT_ON_SCREEN` | 1 |

#### `ROLE_ABSENT_ON_SCREEN` — 1 (the native screen has no control of this kind)

| Role | Literal | PWA source |
|---|---|---|
| TABLE | "Actions" | `apps/web/components/ui/DataTable.tsx:182` |

## L5 · Resolved style properties and colour

| | PWA | Native |
|---|---:|---:|
| Style properties resolved to literals | 319 | 240 |
| Distinct colours actually used by this route's elements | **24** | **20** |
| — shared between the two | 1 | 1 |
| — **PWA-only (no native counterpart value)** | **23** | — |
| Classes with no matching CSS rule (UNRESOLVED) | 175 (97 distinct) | — |
| className built from a runtime expression (UNRESOLVED) | 21 | — |
| Competing rules for one class (cascade decides at runtime) | 16 | — |
| Native theme tokens not resolvable to a literal | — | 78 |

**PWA-only colours on this route (first 23):** `#446166` `rgba(255, 255, 255, 0.92)` `rgba(79, 112, 107, 0.16)` `rgba(6, 16, 22, 0.08)` `#102126` `rgba(79, 112, 107, 0.34)` `#45656a` `rgba(15, 23, 42, 0.035)` `rgba(255, 255, 255, 0.28)` `rgba(0, 0, 0, 0.7)` `#1b3136` `rgba(158, 216, 207, 0.2)` `rgba(158, 216, 207, 0.1)` `rgba(0, 0, 0, 0.4)` `rgba(158, 216, 207, 0.15)` `#e2e8f0` `#cbd5e1` `#f0f4f8` `#64748b` `#0f1d36` `#d64545` `rgba(107, 91, 255, 0.28)` `#f1f4f9`

## L6 · Conditional states

| | PWA | Native |
|---|---:|---:|
| Conditional branches (ternary / && / .map) | 1112 | 1046 |
| Declared state roles present | — | STATE_LOADING |

## L7 · Interactions

| | PWA | Native |
|---|---:|---:|
| Handler bindings | 56 | 27 |

## L8 · Data dependencies

| | Count |
|---|---:|
| Distinct `/v1` endpoints the PWA route reaches | 5 |
| Distinct `/v1` endpoints the native screen reaches | 13 |
| Shared | 2 |
| **Called by PWA, never by native** | **3** |
| Called by native only | 11 |

**Endpoints the PWA route calls that this native screen never calls:**

- `/v1/users/me` — `apps/web/app/providers.tsx:93`
- `/v1/users/cookie-consent` — `apps/web/app/providers.tsx:252`
- `/v1/` — `apps/web/lib/privacy/redact.ts:227`

## Unresolved for this route

- `COPY_OR_COMPOSITION_DIFF`: **20** — needs a per-element read.
- Web classes with no CSS rule: **175**.
- Runtime-built `className`: **21**.
- Which CSS declaration wins: **unresolvable by construction** (cascade + specificity + conditional class application are runtime facts). Competing rules found: 16.

> Nothing in this register is a rendered claim. No screenshot, simulator or device was used.