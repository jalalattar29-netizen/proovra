# Route register — `/collaboration-teams/invites/[token]/accept`

**Frozen SHA:** `71e148f34410c7c231f8930d1387d8924b10b4e5` · **Disposition:** `COMPARED`
**Surface tier:** UNMATCHED(default CORE) / allow(default)
**Ledger claim:** `CODE_PARITY` · **physicallyAccepted:** `false`

## L1–L3 · Route, shell and component trees

| | PWA | Native |
|---|---|---|
| Entry | `apps/web/app/(app)/collaboration-teams/invites/[token]/accept/page.tsx` | `apps/mobile/app/(stack)/invite/[token].tsx` |
| Files in recursive tree | 154 | 138 |
| Max import depth | 5 | 9 |
| **Unresolved imports** | **0** | **0** |
| JSX elements | 241 | 147 |

## L4 · Content and element correspondence

| | Count |
|---|---:|
| Labelled web elements | 40 |
| Labelled native elements | 16 |
| Paired exactly (same role + same literal) | 2 |
| Paired, role differs | 0 |
| Unpaired web labels | 38 |
| — of which the native screen has NO element of that role | **3** |
| Extra in native | 12 |
| Web elements carrying no literal label | 220 |

### Adjudication of the unpaired web labels

| Verdict | Count |
|---|---:|
| `COPY_OR_COMPOSITION_DIFF` | 28 |
| `PRESENT_ELSEWHERE_IN_APP` | 7 |
| `ROLE_ABSENT_ON_SCREEN` | 3 |

#### `ROLE_ABSENT_ON_SCREEN` — 3 (the native screen has no control of this kind)

| Role | Literal | PWA source |
|---|---|---|
| LINK | "Owner can upgrade to add more seats" | `apps/web/app/(app)/collaboration-teams/invites/[token]/accept/page.tsx:405` |
| LINK | "View billing and upgrade options" | `apps/web/app/(app)/collaboration-teams/invites/[token]/accept/page.tsx:440` |
| TABLE | "Actions" | `apps/web/components/ui/DataTable.tsx:182` |

## L5 · Resolved style properties and colour

| | PWA | Native |
|---|---:|---:|
| Style properties resolved to literals | 333 | 233 |
| Distinct colours actually used by this route's elements | **25** | **19** |
| — shared between the two | 3 | 3 |
| — **PWA-only (no native counterpart value)** | **22** | — |
| Classes with no matching CSS rule (UNRESOLVED) | 0 (0 distinct) | — |
| className built from a runtime expression (UNRESOLVED) | 10 | — |
| Competing rules for one class (cascade decides at runtime) | 16 | — |
| Native theme tokens not resolvable to a literal | — | 73 |

**PWA-only colours on this route (first 22):** `rgba(109, 40, 217, 0.5)` `rgba(15, 23, 42, 0.12)` `rgba(124, 58, 237, 0.28)` `rgba(124, 58, 237, 0.24)` `rgba(255, 255, 255, 0.42)` `rgba(255, 255, 255, 0.58)` `rgba(15, 23, 42, 0.04)` `rgba(0, 0, 0, 0.7)` `#102126` `#1b3136` `rgba(158, 216, 207, 0.2)` `rgba(158, 216, 207, 0.1)` `rgba(0, 0, 0, 0.4)` `rgba(158, 216, 207, 0.15)` `#e2e8f0` `#cbd5e1` `#f0f4f8` `#64748b` `#0f1d36` `#d64545` `rgba(107, 91, 255, 0.28)` `#f1f4f9`

## L6 · Conditional states

| | PWA | Native |
|---|---:|---:|
| Conditional branches (ternary / && / .map) | 1193 | 1028 |
| Declared state roles present | — | STATE_EMPTY, STATE_LOADING, STATE_ERROR |

## L7 · Interactions

| | PWA | Native |
|---|---:|---:|
| Handler bindings | 31 | 28 |

## L8 · Data dependencies

| | Count |
|---|---:|
| Distinct `/v1` endpoints the PWA route reaches | 4 |
| Distinct `/v1` endpoints the native screen reaches | 1 |
| Shared | 1 |
| **Called by PWA, never by native** | **3** |
| Called by native only | 0 |

**Endpoints the PWA route calls that this native screen never calls:**

- `/v1/collaboration-teams` — `apps/web/lib/api/collaboration-teams.ts:277`
- `/v1/platform/context` — `apps/web/lib/platform-context/PlatformContextProvider.tsx:414`
- `/v1/platform/context/switch-workspace` — `apps/web/lib/platform-context/PlatformContextProvider.tsx:476`

## Unresolved for this route

- `COPY_OR_COMPOSITION_DIFF`: **28** — needs a per-element read.
- Web classes with no CSS rule: **0**.
- Runtime-built `className`: **10**.
- Which CSS declaration wins: **unresolvable by construction** (cascade + specificity + conditional class application are runtime facts). Competing rules found: 16.

> Nothing in this register is a rendered claim. No screenshot, simulator or device was used.