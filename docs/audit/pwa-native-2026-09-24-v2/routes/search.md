# Route register — `/search`

**Frozen SHA:** `71e148f34410c7c231f8930d1387d8924b10b4e5` · **Disposition:** `COMPARED`
**Surface tier:** CORE / allow
**Ledger claim:** `CODE_PARITY` · **physicallyAccepted:** `false`

## L1–L3 · Route, shell and component trees

| | PWA | Native |
|---|---|---|
| Entry | `apps/web/app/(app)/search/page.tsx` | `apps/mobile/app/(stack)/search.tsx` |
| Files in recursive tree | 156 | 145 |
| Max import depth | 6 | 9 |
| **Unresolved imports** | **0** | **0** |
| JSX elements | 490 | 155 |

## L4 · Content and element correspondence

| | Count |
|---|---:|
| Labelled web elements | 146 |
| Labelled native elements | 20 |
| Paired exactly (same role + same literal) | 2 |
| Paired, role differs | 7 |
| Unpaired web labels | 137 |
| — of which the native screen has NO element of that role | **1** |
| Extra in native | 11 |
| Web elements carrying no literal label | 436 |

### Adjudication of the unpaired web labels

| Verdict | Count |
|---|---:|
| `COPY_OR_COMPOSITION_DIFF` | 93 |
| `PRESENT_ELSEWHERE_IN_APP` | 43 |
| `ROLE_ABSENT_ON_SCREEN` | 1 |

#### `ROLE_ABSENT_ON_SCREEN` — 1 (the native screen has no control of this kind)

| Role | Literal | PWA source |
|---|---|---|
| SELECT | "Sort results" | `apps/web/app/(app)/search/page.tsx:1986` |

## L5 · Resolved style properties and colour

| | PWA | Native |
|---|---:|---:|
| Style properties resolved to literals | 1907 | 237 |
| Distinct colours actually used by this route's elements | **54** | **19** |
| — shared between the two | 5 | 5 |
| — **PWA-only (no native counterpart value)** | **49** | — |
| Classes with no matching CSS rule (UNRESOLVED) | 0 (0 distinct) | — |
| className built from a runtime expression (UNRESOLVED) | 9 | — |
| Competing rules for one class (cascade decides at runtime) | 77 | — |
| Native theme tokens not resolvable to a literal | — | 75 |

**PWA-only colours on this route (first 30):** `rgba(255, 255, 255, 0.42)` `rgba(255, 255, 255, 0.58)` `rgba(15, 23, 42, 0.04)` `#667085` `#172033` `rgba(91, 79, 233, 0.1)` `rgba(73, 184, 255, 0.08)` `rgba(91, 79, 233, 0.16)` `rgba(255, 255, 255, 0.8)` `rgba(15, 23, 42, 0.1)` `rgba(255, 255, 255, 0.72)` `#d9c7fb` `rgba(124, 58, 237, 0.14)` `#98a2b3` `#263247` `rgba(109, 40, 217, 0.5)` `rgba(15, 23, 42, 0.12)` `rgba(37, 99, 235, 0.16)` `#eaf0fd` `#2563eb` `rgba(37, 99, 235, 0.28)` `#344054` `rgba(255, 255, 255, 0.38)` `rgba(15, 23, 42, 0.025)` `rgba(15, 23, 42, 0.08)` `rgba(255, 255, 255, 0.70)` `rgba(178, 52, 66, 0.24)` `rgba(124, 58, 237, 0.28)` `rgba(100, 116, 139, 0.22)` `rgba(255, 255, 255, 0.92)`

## L6 · Conditional states

| | PWA | Native |
|---|---:|---:|
| Conditional branches (ternary / && / .map) | 1480 | 1100 |
| Declared state roles present | — | STATE_EMPTY, STATE_LOADING, STATE_ERROR |

## L7 · Interactions

| | PWA | Native |
|---|---:|---:|
| Handler bindings | 71 | 32 |

## L8 · Data dependencies

| | Count |
|---|---:|
| Distinct `/v1` endpoints the PWA route reaches | 13 |
| Distinct `/v1` endpoints the native screen reaches | 4 |
| Shared | 3 |
| **Called by PWA, never by native** | **10** |
| Called by native only | 1 |

**Endpoints the PWA route calls that this native screen never calls:**

- `/v1/search/saved-views?teamId=${…}` — `apps/web/app/(app)/search/page.tsx:703`
- `/v1/search/semantic/status?teamId=${…}` — `apps/web/app/(app)/search/page.tsx:727`
- `/v1/search/diagnostics?${…}` — `apps/web/app/(app)/search/page.tsx:793`
- `/v1/search/reconcile` — `apps/web/app/(app)/search/page.tsx:940`
- `/v1/search/relationships/${…}` — `apps/web/app/(app)/search/page.tsx:1079`
- `/v1/search/saved-views` — `apps/web/app/(app)/search/page.tsx:1409`
- `/v1/search/saved-views/${…}` — `apps/web/app/(app)/search/page.tsx:1477`
- `/v1/search/semantic/backfill` — `apps/web/app/(app)/search/page.tsx:1570`
- `/v1/search/audit?${…}` — `apps/web/components/search/SearchAuditLogPanel.tsx:84`
- `/v1/platform/context/switch-workspace` — `apps/web/lib/platform-context/PlatformContextProvider.tsx:476`

## Unresolved for this route

- `COPY_OR_COMPOSITION_DIFF`: **93** — needs a per-element read.
- Web classes with no CSS rule: **0**.
- Runtime-built `className`: **9**.
- Which CSS declaration wins: **unresolvable by construction** (cascade + specificity + conditional class application are runtime facts). Competing rules found: 77.

> Nothing in this register is a rendered claim. No screenshot, simulator or device was used.