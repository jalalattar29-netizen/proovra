# Route register — `/workspaces`

**Frozen SHA:** `71e148f34410c7c231f8930d1387d8924b10b4e5` · **Disposition:** `COMPARED`
**Surface tier:** ENTERPRISE / redirect · **BORDERLINE** (Enterprise-gated; excluded from gap counts)
**Ledger claim:** `CODE_PARITY` · **physicallyAccepted:** `false`

## L1–L3 · Route, shell and component trees

| | PWA | Native |
|---|---|---|
| Entry | `apps/web/app/(app)/workspaces/page.tsx` | `apps/mobile/app/(stack)/spaces.tsx` |
| Files in recursive tree | 153 | 143 |
| Max import depth | 6 | 9 |
| **Unresolved imports** | **0** | **0** |
| JSX elements | 408 | 166 |

## L4 · Content and element correspondence

| | Count |
|---|---:|
| Labelled web elements | 127 |
| Labelled native elements | 23 |
| Paired exactly (same role + same literal) | 0 |
| Paired, role differs | 2 |
| Unpaired web labels | 125 |
| — of which the native screen has NO element of that role | **1** |
| Extra in native | 21 |
| Web elements carrying no literal label | 399 |

### Adjudication of the unpaired web labels

| Verdict | Count |
|---|---:|
| `COPY_OR_COMPOSITION_DIFF` | 76 |
| `PRESENT_ELSEWHERE_IN_APP` | 46 |
| `EXTRACTOR_ARTIFACT` | 2 |
| `ROLE_ABSENT_ON_SCREEN` | 1 |

#### `ROLE_ABSENT_ON_SCREEN` — 1 (the native screen has no control of this kind)

| Role | Literal | PWA source |
|---|---|---|
| SELECT | "Filter by outcome" | `apps/web/components/workspace-admin/WorkspaceAuditTab.tsx:129` |

## L5 · Resolved style properties and colour

| | PWA | Native |
|---|---:|---:|
| Style properties resolved to literals | 314 | 261 |
| Distinct colours actually used by this route's elements | **15** | **19** |
| — shared between the two | 3 | 3 |
| — **PWA-only (no native counterpart value)** | **12** | — |
| Classes with no matching CSS rule (UNRESOLVED) | 159 (23 distinct) | — |
| className built from a runtime expression (UNRESOLVED) | 2 | — |
| Competing rules for one class (cascade decides at runtime) | 15 | — |
| Native theme tokens not resolvable to a literal | — | 75 |

**PWA-only colours on this route (first 12):** `#172033` `rgba(15, 23, 42, 0.05)` `#5f6b7d` `rgba(255, 255, 255, 0.5)` `rgba(255, 255, 255, 0.38)` `rgba(15, 23, 42, 0.025)` `rgba(124, 58, 237, 0.35)` `#e2e8f0` `#f1f5f9` `rgba(15, 23, 42, 0.045)` `rgba(255, 255, 255, 0.64)` `#64748b`

## L6 · Conditional states

| | PWA | Native |
|---|---:|---:|
| Conditional branches (ternary / && / .map) | 1174 | 1070 |
| Declared state roles present | STATE_LOADING, STATE_ERROR | STATE_LOADING, STATE_ERROR |

## L7 · Interactions

| | PWA | Native |
|---|---:|---:|
| Handler bindings | 9 | 35 |

## L8 · Data dependencies

| | Count |
|---|---:|
| Distinct `/v1` endpoints the PWA route reaches | 4 |
| Distinct `/v1` endpoints the native screen reaches | 3 |
| Shared | 2 |
| **Called by PWA, never by native** | **2** |
| Called by native only | 1 |

**Endpoints the PWA route calls that this native screen never calls:**

- `/v1/teams/workspace-admin?teamId=${…}` — `apps/web/components/workspace-admin/WorkspaceAdminPanel.tsx:73`
- `/v1/audit/tenant?${…}` — `apps/web/components/workspace-admin/WorkspaceAuditTab.tsx:54`

## Unresolved for this route

- `COPY_OR_COMPOSITION_DIFF`: **76** — needs a per-element read.
- Web classes with no CSS rule: **159**.
- Runtime-built `className`: **2**.
- Which CSS declaration wins: **unresolvable by construction** (cascade + specificity + conditional class application are runtime facts). Competing rules found: 15.

> Nothing in this register is a rendered claim. No screenshot, simulator or device was used.