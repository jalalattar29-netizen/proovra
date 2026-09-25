# Route register — `/evidence`

**Frozen SHA:** `71e148f34410c7c231f8930d1387d8924b10b4e5` · **Disposition:** `COMPARED`
**Surface tier:** CORE / allow
**Ledger claim:** `CODE_PARITY` · **physicallyAccepted:** `false`

## L1–L3 · Route, shell and component trees

| | PWA | Native |
|---|---|---|
| Entry | `apps/web/app/(app)/evidence/page.tsx` | `apps/mobile/app/(tabs)/evidence.tsx` |
| Files in recursive tree | 182 | 141 |
| Max import depth | 7 | 6 |
| **Unresolved imports** | **0** | **0** |
| JSX elements | 513 | 261 |

## L4 · Content and element correspondence

| | Count |
|---|---:|
| Labelled web elements | 108 |
| Labelled native elements | 67 |
| Paired exactly (same role + same literal) | 8 |
| Paired, role differs | 15 |
| Unpaired web labels | 85 |
| — of which the native screen has NO element of that role | **3** |
| Extra in native | 49 |
| Web elements carrying no literal label | 478 |

### Adjudication of the unpaired web labels

| Verdict | Count |
|---|---:|
| `COPY_OR_COMPOSITION_DIFF` | 58 |
| `PRESENT_ELSEWHERE_IN_APP` | 24 |
| `ROLE_ABSENT_ON_SCREEN` | 3 |

#### `ROLE_ABSENT_ON_SCREEN` — 3 (the native screen has no control of this kind)

| Role | Literal | PWA source |
|---|---|---|
| SELECT | "Bulk action" | `apps/web/app/(app)/evidence/components/BulkActionsToolbar.tsx:300` |
| SELECT | "Target case" | `apps/web/app/(app)/evidence/components/BulkActionsToolbar.tsx:307` |
| TABLE | "Actions" | `apps/web/components/ui/DataTable.tsx:182` |

## L5 · Resolved style properties and colour

| | PWA | Native |
|---|---:|---:|
| Style properties resolved to literals | 2195 | 313 |
| Distinct colours actually used by this route's elements | **86** | **20** |
| — shared between the two | 9 | 9 |
| — **PWA-only (no native counterpart value)** | **77** | — |
| Classes with no matching CSS rule (UNRESOLVED) | 0 (0 distinct) | — |
| className built from a runtime expression (UNRESOLVED) | 18 | — |
| Competing rules for one class (cascade decides at runtime) | 153 | — |
| Native theme tokens not resolvable to a literal | — | 95 |

**PWA-only colours on this route (first 30):** `rgba(15, 23, 42, 0.10)` `rgba(255, 255, 255, 0.70)` `#667085` `rgba(124, 58, 237, 0.4)` `rgba(100, 116, 139, 0.22)` `rgba(255, 255, 255, 0.92)` `#263247` `#8b7cf6` `rgba(124, 58, 237, 0.14)` `rgba(255, 255, 255, 0.98)` `rgba(15, 23, 42, 0.1)` `rgba(15, 23, 42, 0.16)` `rgba(99, 91, 255, 0.08)` `#172033` `rgba(100, 116, 139, 0.36)` `#8793a6` `rgba(15, 23, 42, 0.12)` `rgba(124, 58, 237, 0.28)` `rgba(124, 58, 237, 0.24)` `rgba(15, 23, 42, 0.08)` `rgba(168, 102, 18, 0.24)` `rgba(35, 55, 59, 0.74)` `#344054` `rgba(178, 52, 66, 0.24)` `rgba(255, 255, 255, 0.97)` `rgba(15, 23, 42, 0.22)` `rgba(124, 58, 237, 0.22)` `rgba(58, 93, 97, 0.08)` `rgba(248, 250, 249, 0.92)` `rgba(168, 102, 18, 0.28)`

## L6 · Conditional states

| | PWA | Native |
|---|---:|---:|
| Conditional branches (ternary / && / .map) | 1586 | 1232 |
| Declared state roles present | STATE_EMPTY | STATE_EMPTY, STATE_LOADING, STATE_ERROR |

## L7 · Interactions

| | PWA | Native |
|---|---:|---:|
| Handler bindings | 126 | 80 |

## L8 · Data dependencies

| | Count |
|---|---:|
| Distinct `/v1` endpoints the PWA route reaches | 10 |
| Distinct `/v1` endpoints the native screen reaches | 7 |
| Shared | 7 |
| **Called by PWA, never by native** | **3** |
| Called by native only | 0 |

**Endpoints the PWA route calls that this native screen never calls:**

- `/v1/` — `apps/web/lib/privacy/redact.ts:227`
- `/v1/platform/context` — `apps/web/lib/platform-context/PlatformContextProvider.tsx:414`
- `/v1/platform/context/switch-workspace` — `apps/web/lib/platform-context/PlatformContextProvider.tsx:476`

## Unresolved for this route

- `COPY_OR_COMPOSITION_DIFF`: **58** — needs a per-element read.
- Web classes with no CSS rule: **0**.
- Runtime-built `className`: **18**.
- Which CSS declaration wins: **unresolvable by construction** (cascade + specificity + conditional class application are runtime facts). Competing rules found: 153.

> Nothing in this register is a rendered claim. No screenshot, simulator or device was used.