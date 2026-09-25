# Route register — `/operations/health`

**Frozen SHA:** `71e148f34410c7c231f8930d1387d8924b10b4e5` · **Disposition:** `NO_NATIVE_SCREEN`
**Surface tier:** CORE / allow
**Ledger claim:** `(absent from ledger)` · **physicallyAccepted:** `false`

## L1–L3 · Route, shell and component trees

| | PWA | Native |
|---|---|---|
| Entry | `apps/web/app/(app)/operations/health/page.tsx` | **none** |
| Files in recursive tree | 157 | 0 |
| Max import depth | 5 | 0 |
| **Unresolved imports** | **0** | **0** |
| JSX elements | 199 | 0 |

## L4 · Content and element correspondence

| | Count |
|---|---:|
| Labelled web elements | 42 |
| Labelled native elements | 0 |
| Paired exactly (same role + same literal) | 0 |
| Paired, role differs | 0 |
| Unpaired web labels | 42 |
| — of which the native screen has NO element of that role | **42** |
| Extra in native | 0 |
| Web elements carrying no literal label | 194 |

### Adjudication of the unpaired web labels

| Verdict | Count |
|---|---:|
| `SUBSUMED_BY_MISSING_SCREEN` | 42 |

## L5 · Resolved style properties and colour

| | PWA | Native |
|---|---:|---:|
| Style properties resolved to literals | 452 | 0 |
| Distinct colours actually used by this route's elements | **28** | **0** |
| — shared between the two | 0 | 0 |
| — **PWA-only (no native counterpart value)** | **28** | — |
| Classes with no matching CSS rule (UNRESOLVED) | 1 (1 distinct) | — |
| className built from a runtime expression (UNRESOLVED) | 5 | — |
| Competing rules for one class (cascade decides at runtime) | 28 | — |
| Native theme tokens not resolvable to a literal | — | 0 |

**PWA-only colours on this route (first 28):** `#475569` `#172033` `#5f6878` `rgba(124, 58, 237, 0.28)` `rgba(124, 58, 237, 0.24)` `rgba(255, 255, 255, 0.42)` `rgba(255, 255, 255, 0.58)` `rgba(15, 23, 42, 0.04)` `rgba(15, 23, 42, 0.06)` `rgba(15, 23, 42, 0.09)` `#f1f4f9` `#94a3b8` `#344054` `rgba(248, 250, 253, 0.7)` `rgba(15, 23, 42, 0.07)` `#667085` `rgba(100, 116, 139, 0.22)` `rgba(255, 255, 255, 0.92)` `#263247` `#8b7cf6` `rgba(124, 58, 237, 0.14)` `rgba(255, 255, 255, 0.98)` `rgba(15, 23, 42, 0.1)` `rgba(15, 23, 42, 0.16)` `rgba(99, 91, 255, 0.08)` `rgba(100, 116, 139, 0.36)` `#8793a6` `#6d28d9`

## L6 · Conditional states

| | PWA | Native |
|---|---:|---:|
| Conditional branches (ternary / && / .map) | 1157 | 0 |
| Declared state roles present | — | — |

## L7 · Interactions

| | PWA | Native |
|---|---:|---:|
| Handler bindings | 17 | 0 |

## L8 · Data dependencies

| | Count |
|---|---:|
| Distinct `/v1` endpoints the PWA route reaches | 3 |
| Distinct `/v1` endpoints the native screen reaches | 0 |
| Shared | 0 |
| **Called by PWA, never by native** | **3** |
| Called by native only | 0 |

**Endpoints the PWA route calls that this native screen never calls:**

- `/v1/teams/${…}` — `apps/web/app/(app)/operations/health/page.tsx:211`
- `/v1/platform/context` — `apps/web/lib/platform-context/PlatformContextProvider.tsx:414`
- `/v1/platform/context/switch-workspace` — `apps/web/lib/platform-context/PlatformContextProvider.tsx:476`

## Unresolved for this route

- `COPY_OR_COMPOSITION_DIFF`: **0** — needs a per-element read.
- Web classes with no CSS rule: **1**.
- Runtime-built `className`: **5**.
- Which CSS declaration wins: **unresolvable by construction** (cascade + specificity + conditional class application are runtime facts). Competing rules found: 28.

> Nothing in this register is a rendered claim. No screenshot, simulator or device was used.