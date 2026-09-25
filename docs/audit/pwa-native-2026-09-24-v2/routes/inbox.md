# Route register — `/inbox`

**Frozen SHA:** `71e148f34410c7c231f8930d1387d8924b10b4e5` · **Disposition:** `COMPARED`
**Surface tier:** CORE / allow
**Ledger claim:** `CODE_PARITY` · **physicallyAccepted:** `false`

## L1–L3 · Route, shell and component trees

| | PWA | Native |
|---|---|---|
| Entry | `apps/web/app/(app)/inbox/page.tsx` | `apps/mobile/app/(tabs)/notifications.tsx` |
| Files in recursive tree | 166 | 146 |
| Max import depth | 7 | 9 |
| **Unresolved imports** | **0** | **0** |
| JSX elements | 362 | 196 |

## L4 · Content and element correspondence

| | Count |
|---|---:|
| Labelled web elements | 54 |
| Labelled native elements | 30 |
| Paired exactly (same role + same literal) | 3 |
| Paired, role differs | 2 |
| Unpaired web labels | 49 |
| — of which the native screen has NO element of that role | **1** |
| Extra in native | 22 |
| Web elements carrying no literal label | 347 |

### Adjudication of the unpaired web labels

| Verdict | Count |
|---|---:|
| `COPY_OR_COMPOSITION_DIFF` | 29 |
| `PRESENT_ELSEWHERE_IN_APP` | 19 |
| `ROLE_ABSENT_ON_SCREEN` | 1 |

#### `ROLE_ABSENT_ON_SCREEN` — 1 (the native screen has no control of this kind)

| Role | Literal | PWA source |
|---|---|---|
| TABLE | "Actions" | `apps/web/components/ui/DataTable.tsx:182` |

## L5 · Resolved style properties and colour

| | PWA | Native |
|---|---:|---:|
| Style properties resolved to literals | 933 | 270 |
| Distinct colours actually used by this route's elements | **55** | **19** |
| — shared between the two | 10 | 10 |
| — **PWA-only (no native counterpart value)** | **45** | — |
| Classes with no matching CSS rule (UNRESOLVED) | 1 (1 distinct) | — |
| className built from a runtime expression (UNRESOLVED) | 19 | — |
| Competing rules for one class (cascade decides at runtime) | 55 | — |
| Native theme tokens not resolvable to a literal | — | 80 |

**PWA-only colours on this route (first 30):** `rgba(91, 79, 233, 0.1)` `rgba(73, 184, 255, 0.08)` `rgba(91, 79, 233, 0.16)` `rgba(255, 255, 255, 0.8)` `rgba(109, 40, 217, 0.5)` `rgba(15, 23, 42, 0.12)` `rgba(255, 255, 255, 0.5)` `rgba(255, 255, 255, 0.6)` `rgba(15, 23, 42, 0.03)` `rgba(15, 23, 42, 0.08)` `#172033` `#344054` `#667085` `rgba(15, 23, 42, 0.10)` `rgba(255, 255, 255, 0.70)` `#d9c7fb` `rgba(107, 91, 255, 0.28)` `rgba(124, 58, 237, 0.28)` `rgba(124, 58, 237, 0.24)` `rgba(255, 255, 255, 0.98)` `rgba(15, 23, 42, 0.1)` `rgba(15, 23, 42, 0.16)` `#f1f4f9` `rgba(15, 23, 42, 0.04)` `rgba(100, 116, 139, 0.22)` `rgba(255, 255, 255, 0.92)` `#263247` `#8b7cf6` `rgba(124, 58, 237, 0.14)` `rgba(99, 91, 255, 0.08)`

## L6 · Conditional states

| | PWA | Native |
|---|---:|---:|
| Conditional branches (ternary / && / .map) | 1410 | 1137 |
| Declared state roles present | STATE_EMPTY, STATE_LOADING | STATE_EMPTY, STATE_LOADING, STATE_ERROR |

## L7 · Interactions

| | PWA | Native |
|---|---:|---:|
| Handler bindings | 66 | 44 |

## L8 · Data dependencies

| | Count |
|---|---:|
| Distinct `/v1` endpoints the PWA route reaches | 5 |
| Distinct `/v1` endpoints the native screen reaches | 9 |
| Shared | 4 |
| **Called by PWA, never by native** | **1** |
| Called by native only | 6 |

**Endpoints the PWA route calls that this native screen never calls:**

- `/v1/platform/context/switch-workspace` — `apps/web/lib/platform-context/PlatformContextProvider.tsx:476`

## Unresolved for this route

- `COPY_OR_COMPOSITION_DIFF`: **29** — needs a per-element read.
- Web classes with no CSS rule: **1**.
- Runtime-built `className`: **19**.
- Which CSS declaration wins: **unresolvable by construction** (cascade + specificity + conditional class application are runtime facts). Competing rules found: 55.

> Nothing in this register is a rendered claim. No screenshot, simulator or device was used.