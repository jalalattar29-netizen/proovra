# Route register — `/cases`

**Frozen SHA:** `71e148f34410c7c231f8930d1387d8924b10b4e5` · **Disposition:** `COMPARED`
**Surface tier:** CORE / allow
**Ledger claim:** `CODE_PARITY` · **physicallyAccepted:** `false`

## L1–L3 · Route, shell and component trees

| | PWA | Native |
|---|---|---|
| Entry | `apps/web/app/(app)/cases/page.tsx` | `apps/mobile/app/(tabs)/cases.tsx` |
| Files in recursive tree | 172 | 144 |
| Max import depth | 7 | 8 |
| **Unresolved imports** | **0** | **0** |
| JSX elements | 489 | 156 |

## L4 · Content and element correspondence

| | Count |
|---|---:|
| Labelled web elements | 105 |
| Labelled native elements | 18 |
| Paired exactly (same role + same literal) | 4 |
| Paired, role differs | 5 |
| Unpaired web labels | 96 |
| — of which the native screen has NO element of that role | **3** |
| Extra in native | 10 |
| Web elements carrying no literal label | 454 |

### Adjudication of the unpaired web labels

| Verdict | Count |
|---|---:|
| `COPY_OR_COMPOSITION_DIFF` | 57 |
| `PRESENT_ELSEWHERE_IN_APP` | 35 |
| `ROLE_ABSENT_ON_SCREEN` | 3 |
| `EXTRACTOR_ARTIFACT` | 1 |

#### `ROLE_ABSENT_ON_SCREEN` — 3 (the native screen has no control of this kind)

| Role | Literal | PWA source |
|---|---|---|
| SELECT | "Risk level" | `apps/web/components/cases-experience/CasesIndex.tsx:667` |
| SELECT | "Bulk action" | `apps/web/components/cases-experience/CasesIndex.tsx:1033` |
| TABLE | "Actions" | `apps/web/components/ui/DataTable.tsx:182` |

## L5 · Resolved style properties and colour

| | PWA | Native |
|---|---:|---:|
| Style properties resolved to literals | 1142 | 243 |
| Distinct colours actually used by this route's elements | **66** | **19** |
| — shared between the two | 7 | 7 |
| — **PWA-only (no native counterpart value)** | **59** | — |
| Classes with no matching CSS rule (UNRESOLVED) | 24 (13 distinct) | — |
| className built from a runtime expression (UNRESOLVED) | 19 | — |
| Competing rules for one class (cascade decides at runtime) | 72 | — |
| Native theme tokens not resolvable to a literal | — | 78 |

**PWA-only colours on this route (first 30):** `#172033` `rgba(91, 79, 233, 0.1)` `rgba(73, 184, 255, 0.08)` `rgba(91, 79, 233, 0.16)` `rgba(255, 255, 255, 0.8)` `rgba(109, 40, 217, 0.5)` `rgba(15, 23, 42, 0.12)` `rgba(255, 255, 255, 0.42)` `#5f6878` `#d9c7fb` `rgba(124, 58, 237, 0.08)` `#8793a6` `rgba(15, 23, 42, 0.08)` `rgba(255, 255, 255, 0.68)` `#beb4ff` `rgba(124, 58, 237, 0.12)` `rgba(15, 23, 42, 0.045)` `rgba(255, 255, 255, 0.5)` `rgba(255, 255, 255, 0.58)` `rgba(15, 23, 42, 0.04)` `#5f6b7d` `rgba(15, 23, 42, 0.05)` `rgba(124, 58, 237, 0.35)` `#ea580c` `rgba(22, 122, 91, 0.16)` `#eef1f6` `rgba(15, 23, 42, 0.10)` `rgba(124, 58, 237, 0.06)` `rgba(100, 116, 139, 0.22)` `rgba(255, 255, 255, 0.92)`

## L6 · Conditional states

| | PWA | Native |
|---|---:|---:|
| Conditional branches (ternary / && / .map) | 1421 | 1094 |
| Declared state roles present | STATE_LOADING, STATE_ERROR | STATE_EMPTY, STATE_LOADING, STATE_ERROR |

## L7 · Interactions

| | PWA | Native |
|---|---:|---:|
| Handler bindings | 99 | 33 |

## L8 · Data dependencies

| | Count |
|---|---:|
| Distinct `/v1` endpoints the PWA route reaches | 6 |
| Distinct `/v1` endpoints the native screen reaches | 5 |
| Shared | 3 |
| **Called by PWA, never by native** | **3** |
| Called by native only | 2 |

**Endpoints the PWA route calls that this native screen never calls:**

- `/v1/cases/matter-queue?${…}` — `apps/web/components/cases-experience/CasesIndex.tsx:238`
- `/v1/cases/bulk` — `apps/web/components/cases-experience/CasesIndex.tsx:842`
- `/v1/platform/context/switch-workspace` — `apps/web/lib/platform-context/PlatformContextProvider.tsx:476`

## Unresolved for this route

- `COPY_OR_COMPOSITION_DIFF`: **57** — needs a per-element read.
- Web classes with no CSS rule: **24**.
- Runtime-built `className`: **19**.
- Which CSS declaration wins: **unresolvable by construction** (cascade + specificity + conditional class application are runtime facts). Competing rules found: 72.

> Nothing in this register is a rendered claim. No screenshot, simulator or device was used.