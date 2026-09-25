# Route register — `/intake/[token]`

**Frozen SHA:** `71e148f34410c7c231f8930d1387d8924b10b4e5` · **Disposition:** `COMPARED`
**Surface tier:** UNMATCHED(default CORE) / allow(default)
**Ledger claim:** `CODE_PARITY` · **physicallyAccepted:** `false`

## L1–L3 · Route, shell and component trees

| | PWA | Native |
|---|---|---|
| Entry | `apps/web/app/intake/[token]/page.tsx` | `apps/mobile/app/(stack)/intake/[token].tsx` |
| Files in recursive tree | 121 | 138 |
| Max import depth | 6 | 9 |
| **Unresolved imports** | **0** | **0** |
| JSX elements | 171 | 163 |

## L4 · Content and element correspondence

| | Count |
|---|---:|
| Labelled web elements | 63 |
| Labelled native elements | 27 |
| Paired exactly (same role + same literal) | 0 |
| Paired, role differs | 2 |
| Unpaired web labels | 61 |
| — of which the native screen has NO element of that role | **0** |
| Extra in native | 25 |
| Web elements carrying no literal label | 170 |

### Adjudication of the unpaired web labels

| Verdict | Count |
|---|---:|
| `COPY_OR_COMPOSITION_DIFF` | 50 |
| `PRESENT_ELSEWHERE_IN_APP` | 11 |

## L5 · Resolved style properties and colour

| | PWA | Native |
|---|---:|---:|
| Style properties resolved to literals | 642 | 231 |
| Distinct colours actually used by this route's elements | **36** | **19** |
| — shared between the two | 7 | 7 |
| — **PWA-only (no native counterpart value)** | **29** | — |
| Classes with no matching CSS rule (UNRESOLVED) | 0 (0 distinct) | — |
| className built from a runtime expression (UNRESOLVED) | 2 | — |
| Competing rules for one class (cascade decides at runtime) | 25 | — |
| Native theme tokens not resolvable to a literal | — | 77 |

**PWA-only colours on this route (first 29):** `#fff` `rgba(255, 255, 255, 0.8)` `rgba(124, 58, 237, 0.28)` `rgba(15, 23, 42, 0.05)` `#fff6e5` `#a86612` `#334155` `#eaf7f1` `#167a5b` `#344054` `rgba(100, 116, 139, 0.22)` `rgba(255, 255, 255, 0.92)` `#263247` `#8b7cf6` `rgba(124, 58, 237, 0.14)` `rgba(242, 236, 254, 0.6)` `rgba(100, 116, 139, 0.5)` `rgba(109, 40, 217, 0.5)` `rgba(15, 23, 42, 0.12)` `#475467` `rgba(124, 58, 237, 0.32)` `rgba(242, 236, 254, 0.5)` `rgba(124, 58, 237, 0.3)` `#15803d` `#fff1f2` `#b23442` `#f1f5f9` `rgba(255, 255, 255, 0.7)` `rgba(124, 58, 237, 0.24)`

## L6 · Conditional states

| | PWA | Native |
|---|---:|---:|
| Conditional branches (ternary / && / .map) | 1031 | 1040 |
| Declared state roles present | — | STATE_LOADING |

## L7 · Interactions

| | PWA | Native |
|---|---:|---:|
| Handler bindings | 13 | 31 |

## L8 · Data dependencies

| | Count |
|---|---:|
| Distinct `/v1` endpoints the PWA route reaches | 1 |
| Distinct `/v1` endpoints the native screen reaches | 1 |
| Shared | 1 |
| **Called by PWA, never by native** | **0** |
| Called by native only | 0 |

## Unresolved for this route

- `COPY_OR_COMPOSITION_DIFF`: **50** — needs a per-element read.
- Web classes with no CSS rule: **0**.
- Runtime-built `className`: **2**.
- Which CSS declaration wins: **unresolvable by construction** (cascade + specificity + conditional class application are runtime facts). Competing rules found: 25.

> Nothing in this register is a rendered claim. No screenshot, simulator or device was used.