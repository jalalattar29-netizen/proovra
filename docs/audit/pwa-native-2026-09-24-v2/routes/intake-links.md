# Route register — `/intake-links`

**Frozen SHA:** `71e148f34410c7c231f8930d1387d8924b10b4e5` · **Disposition:** `COMPARED`
**Surface tier:** PROFESSIONAL / redirect
**Ledger claim:** `CODE_PARITY` · **physicallyAccepted:** `false`

## L1–L3 · Route, shell and component trees

| | PWA | Native |
|---|---|---|
| Entry | `apps/web/app/(app)/intake-links/page.tsx` | `apps/mobile/app/(stack)/intake-links.tsx` |
| Files in recursive tree | 184 | 146 |
| Max import depth | 9 | 9 |
| **Unresolved imports** | **0** | **0** |
| JSX elements | 820 | 166 |

## L4 · Content and element correspondence

| | Count |
|---|---:|
| Labelled web elements | 190 |
| Labelled native elements | 26 |
| Paired exactly (same role + same literal) | 4 |
| Paired, role differs | 5 |
| Unpaired web labels | 181 |
| — of which the native screen has NO element of that role | **3** |
| Extra in native | 17 |
| Web elements carrying no literal label | 774 |

### Adjudication of the unpaired web labels

| Verdict | Count |
|---|---:|
| `COPY_OR_COMPOSITION_DIFF` | 119 |
| `PRESENT_ELSEWHERE_IN_APP` | 59 |
| `ROLE_ABSENT_ON_SCREEN` | 3 |

#### `ROLE_ABSENT_ON_SCREEN` — 3 (the native screen has no control of this kind)

| Role | Literal | PWA source |
|---|---|---|
| SELECT | "What are you asking for?" | `apps/web/app/(app)/intake-links/_components/wizard/steps.tsx:166` |
| SELECT | "Link expires in" | `apps/web/app/(app)/intake-links/_components/wizard/steps.tsx:490` |
| TABLE | "Actions" | `apps/web/components/ui/DataTable.tsx:182` |

## L5 · Resolved style properties and colour

| | PWA | Native |
|---|---:|---:|
| Style properties resolved to literals | 2726 | 232 |
| Distinct colours actually used by this route's elements | **81** | **19** |
| — shared between the two | 7 | 7 |
| — **PWA-only (no native counterpart value)** | **74** | — |
| Classes with no matching CSS rule (UNRESOLVED) | 8 (5 distinct) | — |
| className built from a runtime expression (UNRESOLVED) | 17 | — |
| Competing rules for one class (cascade decides at runtime) | 130 | — |
| Native theme tokens not resolvable to a literal | — | 79 |

**PWA-only colours on this route (first 30):** `rgba(124, 58, 237, 0.10)` `rgba(73, 184, 255, 0.08)` `rgba(124, 58, 237, 0.16)` `rgba(255, 255, 255, 0.8)` `#172033` `#5f6878` `#667085` `rgba(109, 40, 217, 0.5)` `rgba(15, 23, 42, 0.12)` `rgba(255, 255, 255, 0.97)` `rgba(15, 23, 42, 0.08)` `rgba(15, 23, 42, 0.22)` `#344054` `rgba(124, 58, 237, 0.22)` `#fff` `rgba(100, 116, 139, 0.34)` `rgba(255, 255, 255, 0.70)` `rgba(178, 52, 66, 0.24)` `rgba(168, 102, 18, 0.24)` `rgba(124, 58, 237, 0.28)` `rgba(124, 58, 237, 0.24)` `rgba(124, 58, 237, 0.08)` `rgba(124, 58, 237, 0.14)` `rgba(100, 116, 139, 0.22)` `rgba(255, 255, 255, 0.92)` `#263247` `#8b7cf6` `rgba(255, 255, 255, 0.7)` `rgba(15, 23, 42, 0.07)` `rgba(248, 250, 253, 0.8)`

## L6 · Conditional states

| | PWA | Native |
|---|---:|---:|
| Conditional branches (ternary / && / .map) | 1561 | 1089 |
| Declared state roles present | STATE_EMPTY, STATE_LOADING, STATE_ERROR | STATE_EMPTY, STATE_LOADING, STATE_ERROR |

## L7 · Interactions

| | PWA | Native |
|---|---:|---:|
| Handler bindings | 122 | 34 |

## L8 · Data dependencies

| | Count |
|---|---:|
| Distinct `/v1` endpoints the PWA route reaches | 9 |
| Distinct `/v1` endpoints the native screen reaches | 4 |
| Shared | 4 |
| **Called by PWA, never by native** | **5** |
| Called by native only | 1 |

**Endpoints the PWA route calls that this native screen never calls:**

- `/v1/workflow/templates?teamId=${…}` — `apps/web/app/(app)/intake-links/page.tsx:193`
- `/v1/workflow/intake-links/sender-identity?teamId=${…}` — `apps/web/app/(app)/intake-links/_components/wizard/CreateLinkWizard.tsx:135`
- `/v1/communications/messages?teamId=${…}` — `apps/web/app/(app)/intake-links/_components/DeliveryHistoryDrawer.tsx:47`
- `/v1/communications/messages/${…}` — `apps/web/app/(app)/intake-links/_components/DeliveryHistoryDrawer.tsx:71`
- `/v1/platform/context/switch-workspace` — `apps/web/lib/platform-context/PlatformContextProvider.tsx:476`

## Unresolved for this route

- `COPY_OR_COMPOSITION_DIFF`: **119** — needs a per-element read.
- Web classes with no CSS rule: **8**.
- Runtime-built `className`: **17**.
- Which CSS declaration wins: **unresolvable by construction** (cascade + specificity + conditional class application are runtime facts). Competing rules found: 130.

> Nothing in this register is a rendered claim. No screenshot, simulator or device was used.