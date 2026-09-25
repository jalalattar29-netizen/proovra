# Route register — `/organizations`

**Frozen SHA:** `71e148f34410c7c231f8930d1387d8924b10b4e5` · **Disposition:** `COMPARED`
**Surface tier:** ENTERPRISE / allow
**Ledger claim:** `CODE_PARITY` · **physicallyAccepted:** `false`

## L1–L3 · Route, shell and component trees

| | PWA | Native |
|---|---|---|
| Entry | `apps/web/app/(app)/organizations/page.tsx` | `apps/mobile/app/(stack)/organizations/index.tsx` |
| Files in recursive tree | 146 | 138 |
| Max import depth | 6 | 9 |
| **Unresolved imports** | **0** | **0** |
| JSX elements | 159 | 143 |

## L4 · Content and element correspondence

| | Count |
|---|---:|
| Labelled web elements | 46 |
| Labelled native elements | 14 |
| Paired exactly (same role + same literal) | 1 |
| Paired, role differs | 1 |
| Unpaired web labels | 44 |
| — of which the native screen has NO element of that role | **0** |
| Extra in native | 10 |
| Web elements carrying no literal label | 155 |

### Adjudication of the unpaired web labels

| Verdict | Count |
|---|---:|
| `COPY_OR_COMPOSITION_DIFF` | 33 |
| `PRESENT_ELSEWHERE_IN_APP` | 11 |

## L5 · Resolved style properties and colour

| | PWA | Native |
|---|---:|---:|
| Style properties resolved to literals | 0 | 231 |
| Distinct colours actually used by this route's elements | **0** | **19** |
| — shared between the two | 0 | 0 |
| — **PWA-only (no native counterpart value)** | **0** | — |
| Classes with no matching CSS rule (UNRESOLVED) | 1 (1 distinct) | — |
| className built from a runtime expression (UNRESOLVED) | 1 | — |
| Competing rules for one class (cascade decides at runtime) | 0 | — |
| Native theme tokens not resolvable to a literal | — | 75 |

## L6 · Conditional states

| | PWA | Native |
|---|---:|---:|
| Conditional branches (ternary / && / .map) | 1096 | 1039 |
| Declared state roles present | — | STATE_LOADING, STATE_ERROR |

## L7 · Interactions

| | PWA | Native |
|---|---:|---:|
| Handler bindings | 14 | 27 |

## L8 · Data dependencies

| | Count |
|---|---:|
| Distinct `/v1` endpoints the PWA route reaches | 4 |
| Distinct `/v1` endpoints the native screen reaches | 2 |
| Shared | 1 |
| **Called by PWA, never by native** | **3** |
| Called by native only | 1 |

**Endpoints the PWA route calls that this native screen never calls:**

- `/v1/org-invites/${…}` — `apps/web/app/(app)/organizations/page.tsx:155`
- `/v1/platform/context` — `apps/web/lib/platform-context/PlatformContextProvider.tsx:414`
- `/v1/platform/context/switch-workspace` — `apps/web/lib/platform-context/PlatformContextProvider.tsx:476`

## Unresolved for this route

- `COPY_OR_COMPOSITION_DIFF`: **33** — needs a per-element read.
- Web classes with no CSS rule: **1**.
- Runtime-built `className`: **1**.
- Which CSS declaration wins: **unresolvable by construction** (cascade + specificity + conditional class application are runtime facts). Competing rules found: 0.

> Nothing in this register is a rendered claim. No screenshot, simulator or device was used.