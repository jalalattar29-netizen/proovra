# Route register — `/portal/[token]/work/[workflowId]`

**Frozen SHA:** `71e148f34410c7c231f8930d1387d8924b10b4e5` · **Disposition:** `COMPARED`
**Surface tier:** UNMATCHED(default CORE) / allow(default)
**Ledger claim:** `CODE_PARITY` · **physicallyAccepted:** `false`

## L1–L3 · Route, shell and component trees

| | PWA | Native |
|---|---|---|
| Entry | `apps/web/app/portal/[token]/work/[workflowId]/page.tsx` | `apps/mobile/app/(stack)/portal/work/[workflowId].tsx` |
| Files in recursive tree | 124 | 139 |
| Max import depth | 6 | 9 |
| **Unresolved imports** | **0** | **0** |
| JSX elements | 80 | 159 |

## L4 · Content and element correspondence

| | Count |
|---|---:|
| Labelled web elements | 28 |
| Labelled native elements | 24 |
| Paired exactly (same role + same literal) | 0 |
| Paired, role differs | 0 |
| Unpaired web labels | 28 |
| — of which the native screen has NO element of that role | **0** |
| Extra in native | 24 |
| Web elements carrying no literal label | 76 |

### Adjudication of the unpaired web labels

| Verdict | Count |
|---|---:|
| `COPY_OR_COMPOSITION_DIFF` | 19 |
| `PRESENT_ELSEWHERE_IN_APP` | 9 |

## L5 · Resolved style properties and colour

| | PWA | Native |
|---|---:|---:|
| Style properties resolved to literals | 0 | 231 |
| Distinct colours actually used by this route's elements | **0** | **19** |
| — shared between the two | 0 | 0 |
| — **PWA-only (no native counterpart value)** | **0** | — |
| Classes with no matching CSS rule (UNRESOLVED) | 0 (0 distinct) | — |
| className built from a runtime expression (UNRESOLVED) | 1 | — |
| Competing rules for one class (cascade decides at runtime) | 0 | — |
| Native theme tokens not resolvable to a literal | — | 74 |

## L6 · Conditional states

| | PWA | Native |
|---|---:|---:|
| Conditional branches (ternary / && / .map) | 1021 | 1033 |
| Declared state roles present | STATE_LOADING | STATE_LOADING |

## L7 · Interactions

| | PWA | Native |
|---|---:|---:|
| Handler bindings | 23 | 32 |

## L8 · Data dependencies

| | Count |
|---|---:|
| Distinct `/v1` endpoints the PWA route reaches | 6 |
| Distinct `/v1` endpoints the native screen reaches | 5 |
| Shared | 4 |
| **Called by PWA, never by native** | **2** |
| Called by native only | 1 |

**Endpoints the PWA route calls that this native screen never calls:**

- `/v1/portal/sso/start/${…}` — `apps/web/lib/external-portal/portal-client.ts:340`
- `/v1/portal/activity` — `apps/web/lib/external-portal/portal-client.ts:362`

## Unresolved for this route

- `COPY_OR_COMPOSITION_DIFF`: **19** — needs a per-element read.
- Web classes with no CSS rule: **0**.
- Runtime-built `className`: **1**.
- Which CSS declaration wins: **unresolvable by construction** (cascade + specificity + conditional class application are runtime facts). Competing rules found: 0.

> Nothing in this register is a rendered claim. No screenshot, simulator or device was used.