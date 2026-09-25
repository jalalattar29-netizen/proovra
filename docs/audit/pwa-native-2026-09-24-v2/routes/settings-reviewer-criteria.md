# Route register — `/settings/reviewer-criteria`

**Frozen SHA:** `71e148f34410c7c231f8930d1387d8924b10b4e5` · **Disposition:** `COMPARED`
**Surface tier:** CORE / allow
**Ledger claim:** `CODE_PARITY` · **physicallyAccepted:** `false`

## L1–L3 · Route, shell and component trees

| | PWA | Native |
|---|---|---|
| Entry | `apps/web/app/(app)/settings/reviewer-criteria/page.tsx` | `apps/mobile/app/(stack)/settings/reviewer-criteria.tsx` |
| Files in recursive tree | 146 | 145 |
| Max import depth | 6 | 10 |
| **Unresolved imports** | **0** | **0** |
| JSX elements | 183 | 212 |

## L4 · Content and element correspondence

| | Count |
|---|---:|
| Labelled web elements | 62 |
| Labelled native elements | 45 |
| Paired exactly (same role + same literal) | 4 |
| Paired, role differs | 4 |
| Unpaired web labels | 54 |
| — of which the native screen has NO element of that role | **2** |
| Extra in native | 36 |
| Web elements carrying no literal label | 170 |

### Adjudication of the unpaired web labels

| Verdict | Count |
|---|---:|
| `COPY_OR_COMPOSITION_DIFF` | 46 |
| `PRESENT_ELSEWHERE_IN_APP` | 6 |
| `ROLE_ABSENT_ON_SCREEN` | 2 |

#### `ROLE_ABSENT_ON_SCREEN` — 2 (the native screen has no control of this kind)

| Role | Literal | PWA source |
|---|---|---|
| SELECT | "Compare from version" | `apps/web/app/(app)/settings/reviewer-criteria/page.tsx:199` |
| SELECT | "Compare to version" | `apps/web/app/(app)/settings/reviewer-criteria/page.tsx:203` |

## L5 · Resolved style properties and colour

| | PWA | Native |
|---|---:|---:|
| Style properties resolved to literals | 541 | 261 |
| Distinct colours actually used by this route's elements | **15** | **19** |
| — shared between the two | 3 | 3 |
| — **PWA-only (no native counterpart value)** | **12** | — |
| Classes with no matching CSS rule (UNRESOLVED) | 0 (0 distinct) | — |
| className built from a runtime expression (UNRESOLVED) | 3 | — |
| Competing rules for one class (cascade decides at runtime) | 20 | — |
| Native theme tokens not resolvable to a literal | — | 85 |

**PWA-only colours on this route (first 12):** `rgba(109, 40, 217, 0.5)` `rgba(15, 23, 42, 0.12)` `rgba(15, 23, 42, 0.08)` `rgba(255, 255, 255, 0.70)` `#667085` `rgba(168, 102, 18, 0.24)` `rgba(255, 255, 255, 0.42)` `rgba(255, 255, 255, 0.58)` `rgba(15, 23, 42, 0.04)` `rgba(124, 58, 237, 0.28)` `rgba(124, 58, 237, 0.24)` `rgba(15, 23, 42, 0.05)`

## L6 · Conditional states

| | PWA | Native |
|---|---:|---:|
| Conditional branches (ternary / && / .map) | 1165 | 1132 |
| Declared state roles present | — | STATE_LOADING, STATE_ERROR |

## L7 · Interactions

| | PWA | Native |
|---|---:|---:|
| Handler bindings | 31 | 55 |

## L8 · Data dependencies

| | Count |
|---|---:|
| Distinct `/v1` endpoints the PWA route reaches | 5 |
| Distinct `/v1` endpoints the native screen reaches | 5 |
| Shared | 4 |
| **Called by PWA, never by native** | **1** |
| Called by native only | 1 |

**Endpoints the PWA route calls that this native screen never calls:**

- `/v1/platform/context/switch-workspace` — `apps/web/lib/platform-context/PlatformContextProvider.tsx:476`

## Unresolved for this route

- `COPY_OR_COMPOSITION_DIFF`: **46** — needs a per-element read.
- Web classes with no CSS rule: **0**.
- Runtime-built `className`: **3**.
- Which CSS declaration wins: **unresolvable by construction** (cascade + specificity + conditional class application are runtime facts). Competing rules found: 20.

> Nothing in this register is a rendered claim. No screenshot, simulator or device was used.