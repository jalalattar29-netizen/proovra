# Route register — `/reports`

**Frozen SHA:** `71e148f34410c7c231f8930d1387d8924b10b4e5` · **Disposition:** `COMPARED`
**Surface tier:** CORE / allow
**Ledger claim:** `CODE_PARITY` · **physicallyAccepted:** `false`

## L1–L3 · Route, shell and component trees

| | PWA | Native |
|---|---|---|
| Entry | `apps/web/app/(app)/reports/page.tsx` | `apps/mobile/app/(stack)/reports.tsx` |
| Files in recursive tree | 171 | 144 |
| Max import depth | 7 | 9 |
| **Unresolved imports** | **0** | **0** |
| JSX elements | 384 | 151 |

## L4 · Content and element correspondence

| | Count |
|---|---:|
| Labelled web elements | 61 |
| Labelled native elements | 17 |
| Paired exactly (same role + same literal) | 2 |
| Paired, role differs | 1 |
| Unpaired web labels | 58 |
| — of which the native screen has NO element of that role | **5** |
| Extra in native | 12 |
| Web elements carrying no literal label | 361 |

### Adjudication of the unpaired web labels

| Verdict | Count |
|---|---:|
| `COPY_OR_COMPOSITION_DIFF` | 30 |
| `PRESENT_ELSEWHERE_IN_APP` | 23 |
| `ROLE_ABSENT_ON_SCREEN` | 5 |

#### `ROLE_ABSENT_ON_SCREEN` — 5 (the native screen has no control of this kind)

| Role | Literal | PWA source |
|---|---|---|
| SECTION | "Operational summary" | `apps/web/components/reports-experience/ReportsIndex.tsx:632` |
| SECTION | "Operational summary" | `apps/web/components/reports-experience/ReportsIndex.tsx:656` |
| SECTION | "Filters" | `apps/web/components/reports-experience/ReportsIndex.tsx:671` |
| STATE_EMPTY | "Reports & Artifacts couldn't load" | `apps/web/components/reports-experience/ReportsIndex.tsx:1543` |
| TABLE | "Actions" | `apps/web/components/ui/DataTable.tsx:182` |

## L5 · Resolved style properties and colour

| | PWA | Native |
|---|---:|---:|
| Style properties resolved to literals | 643 | 231 |
| Distinct colours actually used by this route's elements | **51** | **19** |
| — shared between the two | 6 | 6 |
| — **PWA-only (no native counterpart value)** | **45** | — |
| Classes with no matching CSS rule (UNRESOLVED) | 3 (1 distinct) | — |
| className built from a runtime expression (UNRESOLVED) | 20 | — |
| Competing rules for one class (cascade decides at runtime) | 42 | — |
| Native theme tokens not resolvable to a literal | — | 74 |

**PWA-only colours on this route (first 30):** `rgba(91, 79, 233, 0.1)` `rgba(73, 184, 255, 0.08)` `rgba(91, 79, 233, 0.16)` `rgba(255, 255, 255, 0.8)` `rgba(255, 255, 255, 0.5)` `rgba(255, 255, 255, 0.6)` `rgba(15, 23, 42, 0.03)` `rgba(15, 23, 42, 0.08)` `#172033` `#344054` `rgba(124, 58, 237, 0.28)` `rgba(124, 58, 237, 0.24)` `rgba(15, 23, 42, 0.04)` `#2563eb` `rgba(109, 40, 217, 0.5)` `rgba(15, 23, 42, 0.12)` `#ea580c` `rgba(22, 122, 91, 0.16)` `rgba(100, 116, 139, 0.22)` `rgba(255, 255, 255, 0.92)` `#263247` `#8b7cf6` `rgba(124, 58, 237, 0.14)` `rgba(255, 255, 255, 0.98)` `rgba(15, 23, 42, 0.1)` `rgba(15, 23, 42, 0.16)` `#667085` `rgba(99, 91, 255, 0.08)` `rgba(100, 116, 139, 0.36)` `#8793a6`

## L6 · Conditional states

| | PWA | Native |
|---|---:|---:|
| Conditional branches (ternary / && / .map) | 1398 | 1076 |
| Declared state roles present | STATE_EMPTY, STATE_LOADING, STATE_ERROR | STATE_LOADING |

## L7 · Interactions

| | PWA | Native |
|---|---:|---:|
| Handler bindings | 57 | 31 |

## L8 · Data dependencies

| | Count |
|---|---:|
| Distinct `/v1` endpoints the PWA route reaches | 7 |
| Distinct `/v1` endpoints the native screen reaches | 4 |
| Shared | 4 |
| **Called by PWA, never by native** | **3** |
| Called by native only | 1 |

**Endpoints the PWA route calls that this native screen never calls:**

- `/v1/reports` — `apps/web/components/reports-experience/ReportsIndex.tsx:221`
- `/v1/governance/export-eligibility?teamId=${…}` — `apps/web/components/governance/GovernedExportAction.tsx:124`
- `/v1/platform/context/switch-workspace` — `apps/web/lib/platform-context/PlatformContextProvider.tsx:476`

## Unresolved for this route

- `COPY_OR_COMPOSITION_DIFF`: **30** — needs a per-element read.
- Web classes with no CSS rule: **3**.
- Runtime-built `className`: **20**.
- Which CSS declaration wins: **unresolvable by construction** (cascade + specificity + conditional class application are runtime facts). Competing rules found: 42.

> Nothing in this register is a rendered claim. No screenshot, simulator or device was used.