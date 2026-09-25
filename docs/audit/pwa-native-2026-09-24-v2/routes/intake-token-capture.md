# Route register — `/intake/[token]/capture`

**Frozen SHA:** `71e148f34410c7c231f8930d1387d8924b10b4e5` · **Disposition:** `COMPARED`
**Surface tier:** UNMATCHED(default CORE) / allow(default)
**Ledger claim:** `CODE_PARITY` · **physicallyAccepted:** `false`

## L1–L3 · Route, shell and component trees

| | PWA | Native |
|---|---|---|
| Entry | `apps/web/app/intake/[token]/capture/page.tsx` | `apps/mobile/app/(stack)/intake/capture.tsx` |
| Files in recursive tree | 1 | 138 |
| Max import depth | 0 | 9 |
| **Unresolved imports** | **0** | **0** |
| JSX elements | 4 | 153 |

## L4 · Content and element correspondence

| | Count |
|---|---:|
| Labelled web elements | 4 |
| Labelled native elements | 20 |
| Paired exactly (same role + same literal) | 0 |
| Paired, role differs | 0 |
| Unpaired web labels | 4 |
| — of which the native screen has NO element of that role | **0** |
| Extra in native | 20 |
| Web elements carrying no literal label | 4 |

### Adjudication of the unpaired web labels

| Verdict | Count |
|---|---:|
| `COPY_OR_COMPOSITION_DIFF` | 4 |

## L5 · Resolved style properties and colour

| | PWA | Native |
|---|---:|---:|
| Style properties resolved to literals | 0 | 231 |
| Distinct colours actually used by this route's elements | **0** | **19** |
| — shared between the two | 0 | 0 |
| — **PWA-only (no native counterpart value)** | **0** | — |
| Classes with no matching CSS rule (UNRESOLVED) | 0 (0 distinct) | — |
| className built from a runtime expression (UNRESOLVED) | 0 | — |
| Competing rules for one class (cascade decides at runtime) | 0 | — |
| Native theme tokens not resolvable to a literal | — | 78 |

## L6 · Conditional states

| | PWA | Native |
|---|---:|---:|
| Conditional branches (ternary / && / .map) | 0 | 1032 |
| Declared state roles present | — | STATE_LOADING |

## L7 · Interactions

| | PWA | Native |
|---|---:|---:|
| Handler bindings | 0 | 28 |

## L8 · Data dependencies

| | Count |
|---|---:|
| Distinct `/v1` endpoints the PWA route reaches | 0 |
| Distinct `/v1` endpoints the native screen reaches | 1 |
| Shared | 0 |
| **Called by PWA, never by native** | **0** |
| Called by native only | 1 |

## Unresolved for this route

- `COPY_OR_COMPOSITION_DIFF`: **4** — needs a per-element read.
- Web classes with no CSS rule: **0**.
- Runtime-built `className`: **0**.
- Which CSS declaration wins: **unresolvable by construction** (cascade + specificity + conditional class application are runtime facts). Competing rules found: 0.

> Nothing in this register is a rendered claim. No screenshot, simulator or device was used.