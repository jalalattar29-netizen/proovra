# Route register — `/trust-center/methodology`

**Frozen SHA:** `71e148f34410c7c231f8930d1387d8924b10b4e5` · **Disposition:** `COMPARED`
**Surface tier:** CORE / allow
**Ledger claim:** `CODE_PARITY` · **physicallyAccepted:** `false`

## L1–L3 · Route, shell and component trees

| | PWA | Native |
|---|---|---|
| Entry | `apps/web/app/(app)/trust-center/methodology/page.tsx` | `apps/mobile/app/(stack)/trust-center.tsx` |
| Files in recursive tree | 152 | 144 |
| Max import depth | 8 | 9 |
| **Unresolved imports** | **0** | **0** |
| JSX elements | 214 | 168 |

## L4 · Content and element correspondence

| | Count |
|---|---:|
| Labelled web elements | 40 |
| Labelled native elements | 22 |
| Paired exactly (same role + same literal) | 0 |
| Paired, role differs | 0 |
| Unpaired web labels | 39 |
| — of which the native screen has NO element of that role | **0** |
| Extra in native | 22 |
| Web elements carrying no literal label | 206 |

### Adjudication of the unpaired web labels

| Verdict | Count |
|---|---:|
| `COPY_OR_COMPOSITION_DIFF` | 32 |
| `PRESENT_ELSEWHERE_IN_APP` | 7 |

## L5 · Resolved style properties and colour

| | PWA | Native |
|---|---:|---:|
| Style properties resolved to literals | 76 | 231 |
| Distinct colours actually used by this route's elements | **0** | **19** |
| — shared between the two | 0 | 0 |
| — **PWA-only (no native counterpart value)** | **0** | — |
| Classes with no matching CSS rule (UNRESOLVED) | 158 (93 distinct) | — |
| className built from a runtime expression (UNRESOLVED) | 9 | — |
| Competing rules for one class (cascade decides at runtime) | 0 | — |
| Native theme tokens not resolvable to a literal | — | 85 |

## L6 · Conditional states

| | PWA | Native |
|---|---:|---:|
| Conditional branches (ternary / && / .map) | 1148 | 1072 |
| Declared state roles present | STATE_LOADING | STATE_LOADING |

## L7 · Interactions

| | PWA | Native |
|---|---:|---:|
| Handler bindings | 8 | 29 |

## L8 · Data dependencies

| | Count |
|---|---:|
| Distinct `/v1` endpoints the PWA route reaches | 5 |
| Distinct `/v1` endpoints the native screen reaches | 5 |
| Shared | 2 |
| **Called by PWA, never by native** | **3** |
| Called by native only | 3 |

**Endpoints the PWA route calls that this native screen never calls:**

- `/v1/trust/subprocessors/${…}` — `apps/web/app/(app)/trust-center/_version-history.tsx:203`
- `/v1/platform/context` — `apps/web/lib/platform-context/PlatformContextProvider.tsx:414`
- `/v1/platform/context/switch-workspace` — `apps/web/lib/platform-context/PlatformContextProvider.tsx:476`

## Unresolved for this route

- `COPY_OR_COMPOSITION_DIFF`: **32** — needs a per-element read.
- Web classes with no CSS rule: **158**.
- Runtime-built `className`: **9**.
- Which CSS declaration wins: **unresolvable by construction** (cascade + specificity + conditional class application are runtime facts). Competing rules found: 0.

> Nothing in this register is a rendered claim. No screenshot, simulator or device was used.