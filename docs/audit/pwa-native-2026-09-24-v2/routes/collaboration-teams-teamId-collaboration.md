# Route register — `/collaboration-teams/[teamId]/collaboration`

**Frozen SHA:** `71e148f34410c7c231f8930d1387d8924b10b4e5` · **Disposition:** `COMPARED`
**Surface tier:** UNMATCHED(default CORE) / allow(default)
**Ledger claim:** `CODE_PARITY` · **physicallyAccepted:** `false`

## L1–L3 · Route, shell and component trees

| | PWA | Native |
|---|---|---|
| Entry | `apps/web/app/(app)/collaboration-teams/[teamId]/collaboration/page.tsx` | `apps/mobile/app/(stack)/collaboration-team/[id].tsx` |
| Files in recursive tree | 1 | 145 |
| Max import depth | 0 | 10 |
| **Unresolved imports** | **0** | **0** |
| JSX elements | 2 | 250 |

## L4 · Content and element correspondence

| | Count |
|---|---:|
| Labelled web elements | 1 |
| Labelled native elements | 61 |
| Paired exactly (same role + same literal) | 0 |
| Paired, role differs | 0 |
| Unpaired web labels | 1 |
| — of which the native screen has NO element of that role | **0** |
| Extra in native | 61 |
| Web elements carrying no literal label | 2 |

### Adjudication of the unpaired web labels

| Verdict | Count |
|---|---:|
| `COPY_OR_COMPOSITION_DIFF` | 1 |

## L5 · Resolved style properties and colour

| | PWA | Native |
|---|---:|---:|
| Style properties resolved to literals | 3 | 241 |
| Distinct colours actually used by this route's elements | **0** | **19** |
| — shared between the two | 0 | 0 |
| — **PWA-only (no native counterpart value)** | **0** | — |
| Classes with no matching CSS rule (UNRESOLVED) | 1 (1 distinct) | — |
| className built from a runtime expression (UNRESOLVED) | 0 | — |
| Competing rules for one class (cascade decides at runtime) | 0 | — |
| Native theme tokens not resolvable to a literal | — | 90 |

## L6 · Conditional states

| | PWA | Native |
|---|---:|---:|
| Conditional branches (ternary / && / .map) | 1 | 1232 |
| Declared state roles present | — | STATE_EMPTY, STATE_LOADING, STATE_ERROR |

## L7 · Interactions

| | PWA | Native |
|---|---:|---:|
| Handler bindings | 0 | 64 |

## L8 · Data dependencies

| | Count |
|---|---:|
| Distinct `/v1` endpoints the PWA route reaches | 0 |
| Distinct `/v1` endpoints the native screen reaches | 5 |
| Shared | 0 |
| **Called by PWA, never by native** | **0** |
| Called by native only | 5 |

## Unresolved for this route

- `COPY_OR_COMPOSITION_DIFF`: **1** — needs a per-element read.
- Web classes with no CSS rule: **1**.
- Runtime-built `className`: **0**.
- Which CSS declaration wins: **unresolvable by construction** (cascade + specificity + conditional class application are runtime facts). Competing rules found: 0.

> Nothing in this register is a rendered claim. No screenshot, simulator or device was used.