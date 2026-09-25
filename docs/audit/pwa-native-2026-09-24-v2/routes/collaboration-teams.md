# Route register — `/collaboration-teams`

**Frozen SHA:** `71e148f34410c7c231f8930d1387d8924b10b4e5` · **Disposition:** `COMPARED`
**Surface tier:** UNMATCHED(default CORE) / allow(default)
**Ledger claim:** `CODE_PARITY` · **physicallyAccepted:** `false`

## L1–L3 · Route, shell and component trees

| | PWA | Native |
|---|---|---|
| Entry | `apps/web/app/(app)/collaboration-teams/page.tsx` | `apps/mobile/app/(tabs)/teams.tsx` |
| Files in recursive tree | 163 | 140 |
| Max import depth | 5 | 9 |
| **Unresolved imports** | **0** | **0** |
| JSX elements | 436 | 153 |

## L4 · Content and element correspondence

| | Count |
|---|---:|
| Labelled web elements | 94 |
| Labelled native elements | 22 |
| Paired exactly (same role + same literal) | 2 |
| Paired, role differs | 4 |
| Unpaired web labels | 88 |
| — of which the native screen has NO element of that role | **6** |
| Extra in native | 14 |
| Web elements carrying no literal label | 414 |

### Adjudication of the unpaired web labels

| Verdict | Count |
|---|---:|
| `COPY_OR_COMPOSITION_DIFF` | 61 |
| `PRESENT_ELSEWHERE_IN_APP` | 20 |
| `ROLE_ABSENT_ON_SCREEN` | 6 |
| `EXTRACTOR_ARTIFACT` | 1 |

#### `ROLE_ABSENT_ON_SCREEN` — 6 (the native screen has no control of this kind)

| Role | Literal | PWA source |
|---|---|---|
| SELECT | "Which teams to show" | `apps/web/app/(app)/collaboration-teams/page.tsx:738` |
| SELECT | "Filter by status" | `apps/web/app/(app)/collaboration-teams/page.tsx:750` |
| SELECT | "Filter by team type" | `apps/web/app/(app)/collaboration-teams/page.tsx:758` |
| SELECT | "Sort teams" | `apps/web/app/(app)/collaboration-teams/page.tsx:766` |
| SELECT | "Team template" | `apps/web/app/(app)/collaboration-teams/page.tsx:1560` |
| TABLE | "Actions" | `apps/web/components/ui/DataTable.tsx:182` |

## L5 · Resolved style properties and colour

| | PWA | Native |
|---|---:|---:|
| Style properties resolved to literals | 1227 | 232 |
| Distinct colours actually used by this route's elements | **59** | **19** |
| — shared between the two | 5 | 5 |
| — **PWA-only (no native counterpart value)** | **54** | — |
| Classes with no matching CSS rule (UNRESOLVED) | 2 (2 distinct) | — |
| className built from a runtime expression (UNRESOLVED) | 15 | — |
| Competing rules for one class (cascade decides at runtime) | 68 | — |
| Native theme tokens not resolvable to a literal | — | 74 |

**PWA-only colours on this route (first 30):** `rgba(124, 58, 237, 0.10)` `rgba(73, 184, 255, 0.08)` `rgba(124, 58, 237, 0.16)` `rgba(255, 255, 255, 0.8)` `#172033` `#5f6878` `rgba(109, 40, 217, 0.5)` `rgba(15, 23, 42, 0.12)` `rgba(255, 255, 255, 0.5)` `rgba(255, 255, 255, 0.6)` `rgba(15, 23, 42, 0.03)` `rgba(15, 23, 42, 0.08)` `#344054` `#667085` `rgba(124, 58, 237, 0.28)` `rgba(124, 58, 237, 0.24)` `#8793a6` `rgba(255, 255, 255, 0.68)` `#beb4ff` `rgba(124, 58, 237, 0.12)` `rgba(255, 255, 255, 0.42)` `rgba(255, 255, 255, 0.58)` `rgba(15, 23, 42, 0.04)` `rgba(248, 250, 253, 0.7)` `rgba(15, 23, 42, 0.07)` `rgba(124, 58, 237, 0.22)` `rgba(255, 255, 255, 0.98)` `rgba(15, 23, 42, 0.1)` `rgba(15, 23, 42, 0.16)` `rgba(15, 23, 42, 0.05)`

## L6 · Conditional states

| | PWA | Native |
|---|---:|---:|
| Conditional branches (ternary / && / .map) | 1320 | 1110 |
| Declared state roles present | STATE_EMPTY, STATE_LOADING, STATE_ERROR | STATE_EMPTY, STATE_LOADING, STATE_ERROR |

## L7 · Interactions

| | PWA | Native |
|---|---:|---:|
| Handler bindings | 66 | 33 |

## L8 · Data dependencies

| | Count |
|---|---:|
| Distinct `/v1` endpoints the PWA route reaches | 4 |
| Distinct `/v1` endpoints the native screen reaches | 4 |
| Shared | 1 |
| **Called by PWA, never by native** | **3** |
| Called by native only | 2 |

**Endpoints the PWA route calls that this native screen never calls:**

- `/v1/platform/context` — `apps/web/lib/platform-context/PlatformContextProvider.tsx:414`
- `/v1/platform/context/switch-workspace` — `apps/web/lib/platform-context/PlatformContextProvider.tsx:476`
- `/v1/collaboration-team-invites/accept` — `apps/web/lib/api/collaboration-teams.ts:716`

## Unresolved for this route

- `COPY_OR_COMPOSITION_DIFF`: **61** — needs a per-element read.
- Web classes with no CSS rule: **2**.
- Runtime-built `className`: **15**.
- Which CSS declaration wins: **unresolvable by construction** (cascade + specificity + conditional class application are runtime facts). Competing rules found: 68.

> Nothing in this register is a rendered claim. No screenshot, simulator or device was used.