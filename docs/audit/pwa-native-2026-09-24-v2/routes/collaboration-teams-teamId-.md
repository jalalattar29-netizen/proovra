# Route register — `/collaboration-teams/[teamId]`

**Frozen SHA:** `71e148f34410c7c231f8930d1387d8924b10b4e5` · **Disposition:** `COMPARED`
**Surface tier:** UNMATCHED(default CORE) / allow(default)
**Ledger claim:** `CODE_PARITY` · **physicallyAccepted:** `false`

## L1–L3 · Route, shell and component trees

| | PWA | Native |
|---|---|---|
| Entry | `apps/web/app/(app)/collaboration-teams/[teamId]/page.tsx` | `apps/mobile/app/(stack)/collaboration-team/[id].tsx` |
| Files in recursive tree | 174 | 145 |
| Max import depth | 8 | 10 |
| **Unresolved imports** | **0** | **0** |
| JSX elements | 870 | 250 |

## L4 · Content and element correspondence

| | Count |
|---|---:|
| Labelled web elements | 230 |
| Labelled native elements | 61 |
| Paired exactly (same role + same literal) | 9 |
| Paired, role differs | 8 |
| Unpaired web labels | 186 |
| — of which the native screen has NO element of that role | **8** |
| Extra in native | 48 |
| Web elements carrying no literal label | 828 |

### Adjudication of the unpaired web labels

| Verdict | Count |
|---|---:|
| `COPY_OR_COMPOSITION_DIFF` | 123 |
| `PRESENT_ELSEWHERE_IN_APP` | 54 |
| `ROLE_ABSENT_ON_SCREEN` | 8 |
| `EXTRACTOR_ARTIFACT` | 1 |

#### `ROLE_ABSENT_ON_SCREEN` — 8 (the native screen has no control of this kind)

| Role | Literal | PWA source |
|---|---|---|
| LINK | "Invite and manage external reviewers via the External Review console" | `apps/web/app/(app)/collaboration-teams/[teamId]/page.tsx:794` |
| TABLE | "Actions" | `apps/web/components/ui/DataTable.tsx:182` |
| SELECT | "Filter by status" | `apps/web/app/(app)/collaboration-teams/[teamId]/_tabs/AssignmentsTab.tsx:363` |
| SELECT | "Filter by assignee" | `apps/web/app/(app)/collaboration-teams/[teamId]/_tabs/AssignmentsTab.tsx:375` |
| SELECT | "Filter by priority" | `apps/web/app/(app)/collaboration-teams/[teamId]/_tabs/AssignmentsTab.tsx:385` |
| SELECT | "Filter by work type" | `apps/web/app/(app)/collaboration-teams/[teamId]/_tabs/AssignmentsTab.tsx:396` |
| SELECT | "Assignee" | `apps/web/app/(app)/collaboration-teams/[teamId]/_tabs/AssignmentsTab.tsx:964` |
| SELECT | "Role in this team" | `apps/web/app/(app)/collaboration-teams/[teamId]/_tabs/MembersTab.tsx:1031` |

## L5 · Resolved style properties and colour

| | PWA | Native |
|---|---:|---:|
| Style properties resolved to literals | 3165 | 241 |
| Distinct colours actually used by this route's elements | **79** | **19** |
| — shared between the two | 7 | 7 |
| — **PWA-only (no native counterpart value)** | **72** | — |
| Classes with no matching CSS rule (UNRESOLVED) | 18 (18 distinct) | — |
| className built from a runtime expression (UNRESOLVED) | 16 | — |
| Competing rules for one class (cascade decides at runtime) | 173 | — |
| Native theme tokens not resolvable to a literal | — | 90 |

**PWA-only colours on this route (first 30):** `rgba(124, 58, 237, 0.10)` `rgba(73, 184, 255, 0.08)` `rgba(124, 58, 237, 0.16)` `rgba(255, 255, 255, 0.8)` `#172033` `#5f6878` `rgba(255, 255, 255, 0.42)` `rgba(255, 255, 255, 0.58)` `rgba(15, 23, 42, 0.04)` `rgba(15, 23, 42, 0.05)` `rgba(255, 255, 255, 0.5)` `rgba(124, 58, 237, 0.28)` `rgba(124, 58, 237, 0.24)` `rgba(255, 255, 255, 0.06)` `#0b1024` `rgba(13, 18, 42, 0.55)` `rgba(16, 20, 46, 0.15)` `rgba(8, 11, 26, 0.2)` `rgba(8, 11, 26, 0.28)` `rgba(109, 40, 217, 0.5)` `rgba(15, 23, 42, 0.12)` `rgba(255, 255, 255, 0.38)` `rgba(15, 23, 42, 0.025)` `rgba(124, 58, 237, 0.1)` `#667085` `rgba(15, 23, 42, 0.08)` `rgba(255, 255, 255, 0.70)` `rgba(168, 102, 18, 0.24)` `rgba(255, 255, 255, 0.97)` `rgba(15, 23, 42, 0.22)`

## L6 · Conditional states

| | PWA | Native |
|---|---:|---:|
| Conditional branches (ternary / && / .map) | 1561 | 1232 |
| Declared state roles present | — | STATE_EMPTY, STATE_LOADING, STATE_ERROR |

## L7 · Interactions

| | PWA | Native |
|---|---:|---:|
| Handler bindings | 146 | 64 |

## L8 · Data dependencies

| | Count |
|---|---:|
| Distinct `/v1` endpoints the PWA route reaches | 4 |
| Distinct `/v1` endpoints the native screen reaches | 5 |
| Shared | 1 |
| **Called by PWA, never by native** | **3** |
| Called by native only | 4 |

**Endpoints the PWA route calls that this native screen never calls:**

- `/v1/collaboration-team-invites/accept` — `apps/web/lib/api/collaboration-teams.ts:716`
- `/v1/platform/context` — `apps/web/lib/platform-context/PlatformContextProvider.tsx:414`
- `/v1/platform/context/switch-workspace` — `apps/web/lib/platform-context/PlatformContextProvider.tsx:476`

## Unresolved for this route

- `COPY_OR_COMPOSITION_DIFF`: **123** — needs a per-element read.
- Web classes with no CSS rule: **18**.
- Runtime-built `className`: **16**.
- Which CSS declaration wins: **unresolvable by construction** (cascade + specificity + conditional class application are runtime facts). Competing rules found: 173.

> Nothing in this register is a rendered claim. No screenshot, simulator or device was used.