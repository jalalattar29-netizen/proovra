# Route register — `/portal`

**Frozen SHA:** `71e148f34410c7c231f8930d1387d8924b10b4e5` · **Disposition:** `COMPARED`
**Surface tier:** UNMATCHED(default CORE) / allow(default)
**Ledger claim:** `CODE_PARITY` · **physicallyAccepted:** `false`

## L1–L3 · Route, shell and component trees

| | PWA | Native |
|---|---|---|
| Entry | `apps/web/app/portal/page.tsx` | `apps/mobile/app/(stack)/portal/index.tsx` |
| Files in recursive tree | 121 | 134 |
| Max import depth | 6 | 9 |
| **Unresolved imports** | **0** | **0** |
| JSX elements | 27 | 140 |

## L4 · Content and element correspondence

| | Count |
|---|---:|
| Labelled web elements | 8 |
| Labelled native elements | 15 |
| Paired exactly (same role + same literal) | 0 |
| Paired, role differs | 0 |
| Unpaired web labels | 8 |
| — of which the native screen has NO element of that role | **0** |
| Extra in native | 15 |
| Web elements carrying no literal label | 26 |

### Adjudication of the unpaired web labels

| Verdict | Count |
|---|---:|
| `COPY_OR_COMPOSITION_DIFF` | 8 |

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
| Conditional branches (ternary / && / .map) | 964 | 947 |
| Declared state roles present | STATE_LOADING | STATE_LOADING |

## L7 · Interactions

| | PWA | Native |
|---|---:|---:|
| Handler bindings | 8 | 26 |

## L8 · Data dependencies

| | Count |
|---|---:|
| Distinct `/v1` endpoints the PWA route reaches | 6 |
| Distinct `/v1` endpoints the native screen reaches | 0 |
| Shared | 0 |
| **Called by PWA, never by native** | **6** |
| Called by native only | 0 |

**Endpoints the PWA route calls that this native screen never calls:**

- `/v1/portal/auth` — `apps/web/lib/external-portal/portal-client.ts:182`
- `/v1/portal/logout` — `apps/web/lib/external-portal/portal-client.ts:196`
- `/v1/portal/dashboard` — `apps/web/lib/external-portal/portal-client.ts:206`
- `/v1/portal/work/${…}` — `apps/web/lib/external-portal/portal-client.ts:289`
- `/v1/portal/sso/start/${…}` — `apps/web/lib/external-portal/portal-client.ts:340`
- `/v1/portal/activity` — `apps/web/lib/external-portal/portal-client.ts:362`

## Unresolved for this route

- `COPY_OR_COMPOSITION_DIFF`: **8** — needs a per-element read.
- Web classes with no CSS rule: **0**.
- Runtime-built `className`: **1**.
- Which CSS declaration wins: **unresolvable by construction** (cascade + specificity + conditional class application are runtime facts). Competing rules found: 0.

> Nothing in this register is a rendered claim. No screenshot, simulator or device was used.