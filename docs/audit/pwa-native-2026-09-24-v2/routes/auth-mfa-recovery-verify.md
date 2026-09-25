# Route register — `/auth/mfa-recovery/verify`

**Frozen SHA:** `71e148f34410c7c231f8930d1387d8924b10b4e5` · **Disposition:** `COMPARED`
**Surface tier:** UNMATCHED(default CORE) / allow(default)
**Ledger claim:** `CODE_PARITY` · **physicallyAccepted:** `false`

## L1–L3 · Route, shell and component trees

| | PWA | Native |
|---|---|---|
| Entry | `apps/web/app/auth/mfa-recovery/verify/page.tsx` | `apps/mobile/app/(stack)/mfa-recovery-verify.tsx` |
| Files in recursive tree | 2 | 137 |
| Max import depth | 1 | 9 |
| **Unresolved imports** | **0** | **0** |
| JSX elements | 18 | 144 |

## L4 · Content and element correspondence

| | Count |
|---|---:|
| Labelled web elements | 11 |
| Labelled native elements | 14 |
| Paired exactly (same role + same literal) | 1 |
| Paired, role differs | 2 |
| Unpaired web labels | 8 |
| — of which the native screen has NO element of that role | **0** |
| Extra in native | 12 |
| Web elements carrying no literal label | 16 |

### Adjudication of the unpaired web labels

| Verdict | Count |
|---|---:|
| `PRESENT_ELSEWHERE_IN_APP` | 4 |
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
| Native theme tokens not resolvable to a literal | — | 76 |

## L6 · Conditional states

| | PWA | Native |
|---|---:|---:|
| Conditional branches (ternary / && / .map) | 52 | 1004 |
| Declared state roles present | — | STATE_LOADING |

## L7 · Interactions

| | PWA | Native |
|---|---:|---:|
| Handler bindings | 0 | 26 |

## L8 · Data dependencies

| | Count |
|---|---:|
| Distinct `/v1` endpoints the PWA route reaches | 3 |
| Distinct `/v1` endpoints the native screen reaches | 4 |
| Shared | 3 |
| **Called by PWA, never by native** | **0** |
| Called by native only | 1 |

## Unresolved for this route

- `COPY_OR_COMPOSITION_DIFF`: **4** — needs a per-element read.
- Web classes with no CSS rule: **0**.
- Runtime-built `className`: **0**.
- Which CSS declaration wins: **unresolvable by construction** (cascade + specificity + conditional class application are runtime facts). Competing rules found: 0.

> Nothing in this register is a rendered claim. No screenshot, simulator or device was used.