# Route register — `/settings/legal/[slug]`

**Frozen SHA:** `71e148f34410c7c231f8930d1387d8924b10b4e5` · **Disposition:** `COMPARED`
**Surface tier:** CORE / allow
**Ledger claim:** `CODE_PARITY` · **physicallyAccepted:** `false`

## L1–L3 · Route, shell and component trees

| | PWA | Native |
|---|---|---|
| Entry | `apps/web/app/(app)/settings/legal/[slug]/page.tsx` | `apps/mobile/app/(stack)/legal/[slug].tsx` |
| Files in recursive tree | 152 | 139 |
| Max import depth | 6 | 10 |
| **Unresolved imports** | **0** | **0** |
| JSX elements | 221 | 177 |

## L4 · Content and element correspondence

| | Count |
|---|---:|
| Labelled web elements | 21 |
| Labelled native elements | 18 |
| Paired exactly (same role + same literal) | 0 |
| Paired, role differs | 0 |
| Unpaired web labels | 21 |
| — of which the native screen has NO element of that role | **0** |
| Extra in native | 18 |
| Web elements carrying no literal label | 215 |

### Adjudication of the unpaired web labels

| Verdict | Count |
|---|---:|
| `COPY_OR_COMPOSITION_DIFF` | 18 |
| `PRESENT_ELSEWHERE_IN_APP` | 3 |

## L5 · Resolved style properties and colour

| | PWA | Native |
|---|---:|---:|
| Style properties resolved to literals | 105 | 231 |
| Distinct colours actually used by this route's elements | **4** | **20** |
| — shared between the two | 1 | 1 |
| — **PWA-only (no native counterpart value)** | **3** | — |
| Classes with no matching CSS rule (UNRESOLVED) | 175 (100 distinct) | — |
| className built from a runtime expression (UNRESOLVED) | 7 | — |
| Competing rules for one class (cascade decides at runtime) | 2 | — |
| Native theme tokens not resolvable to a literal | — | 81 |

**PWA-only colours on this route (first 3):** `#e2e8f0` `rgba(15, 23, 42, 0.04)` `#cbd5e1`

## L6 · Conditional states

| | PWA | Native |
|---|---:|---:|
| Conditional branches (ternary / && / .map) | 1147 | 1033 |
| Declared state roles present | — | STATE_LOADING, STATE_ERROR |

## L7 · Interactions

| | PWA | Native |
|---|---:|---:|
| Handler bindings | 4 | 37 |

## L8 · Data dependencies

| | Count |
|---|---:|
| Distinct `/v1` endpoints the PWA route reaches | 2 |
| Distinct `/v1` endpoints the native screen reaches | 2 |
| Shared | 0 |
| **Called by PWA, never by native** | **2** |
| Called by native only | 2 |

**Endpoints the PWA route calls that this native screen never calls:**

- `/v1/platform/context` — `apps/web/lib/platform-context/PlatformContextProvider.tsx:414`
- `/v1/platform/context/switch-workspace` — `apps/web/lib/platform-context/PlatformContextProvider.tsx:476`

## Unresolved for this route

- `COPY_OR_COMPOSITION_DIFF`: **18** — needs a per-element read.
- Web classes with no CSS rule: **175**.
- Runtime-built `className`: **7**.
- Which CSS declaration wins: **unresolvable by construction** (cascade + specificity + conditional class application are runtime facts). Competing rules found: 2.

> Nothing in this register is a rendered claim. No screenshot, simulator or device was used.