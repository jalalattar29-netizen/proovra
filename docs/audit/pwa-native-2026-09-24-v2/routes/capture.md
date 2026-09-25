# Route register — `/capture`

**Frozen SHA:** `71e148f34410c7c231f8930d1387d8924b10b4e5` · **Disposition:** `COMPARED`
**Surface tier:** CORE / allow
**Ledger claim:** `CODE_PARITY` · **physicallyAccepted:** `false`

## L1–L3 · Route, shell and component trees

| | PWA | Native |
|---|---|---|
| Entry | `apps/web/app/(app)/capture/page.tsx` | `apps/mobile/app/(stack)/capture.tsx` |
| Files in recursive tree | 207 | 161 |
| Max import depth | 9 | 9 |
| **Unresolved imports** | **0** | **0** |
| JSX elements | 794 | 345 |

## L4 · Content and element correspondence

| | Count |
|---|---:|
| Labelled web elements | 242 |
| Labelled native elements | 102 |
| Paired exactly (same role + same literal) | 10 |
| Paired, role differs | 5 |
| Unpaired web labels | 227 |
| — of which the native screen has NO element of that role | **1** |
| Extra in native | 87 |
| Web elements carrying no literal label | 756 |

### Adjudication of the unpaired web labels

| Verdict | Count |
|---|---:|
| `COPY_OR_COMPOSITION_DIFF` | 169 |
| `PRESENT_ELSEWHERE_IN_APP` | 57 |
| `ROLE_ABSENT_ON_SCREEN` | 1 |

#### `ROLE_ABSENT_ON_SCREEN` — 1 (the native screen has no control of this kind)

| Role | Literal | PWA source |
|---|---|---|
| TABLE | "Actions" | `apps/web/components/ui/DataTable.tsx:182` |

## L5 · Resolved style properties and colour

| | PWA | Native |
|---|---:|---:|
| Style properties resolved to literals | 2782 | 384 |
| Distinct colours actually used by this route's elements | **175** | **21** |
| — shared between the two | 12 | 12 |
| — **PWA-only (no native counterpart value)** | **163** | — |
| Classes with no matching CSS rule (UNRESOLVED) | 33 (30 distinct) | — |
| className built from a runtime expression (UNRESOLVED) | 38 | — |
| Competing rules for one class (cascade decides at runtime) | 221 | — |
| Native theme tokens not resolvable to a literal | — | 128 |

**PWA-only colours on this route (first 30):** `rgba(35, 139, 132, 0.32)` `#e2e8f0` `rgba(124, 58, 237, 0.18)` `rgba(124, 58, 237, 0.08)` `#0b5f56` `#344054` `rgba(7, 16, 18, 0.48)` `rgba(255, 255, 255, 0.96)` `rgba(15, 23, 42, 0.1)` `rgba(15, 23, 42, 0.22)` `#101828` `rgba(15, 23, 42, 0.08)` `rgba(248, 250, 252, 0.72)` `#cbd5e1` `rgba(255, 255, 255, 0.34)` `rgba(255, 255, 255, 0.42)` `rgba(15, 23, 42, 0.035)` `rgba(255, 255, 255, 0.28)` `rgba(16, 24, 40, 0.07)` `rgba(16, 24, 40, 0.04)` `rgba(15, 23, 42, 0.03)` `#111827` `#8b5cf6` `rgba(109, 40, 217, 0.18)` `rgba(124, 58, 237, 0.34)` `rgba(124, 58, 237, 0.16)` `rgba(255, 255, 255, 0.62)` `#5b21b6` `rgba(124, 58, 237, 0.28)` `rgba(240, 68, 56, 0.14)`

## L6 · Conditional states

| | PWA | Native |
|---|---:|---:|
| Conditional branches (ternary / && / .map) | 1746 | 1318 |
| Declared state roles present | — | STATE_EMPTY, STATE_LOADING |

## L7 · Interactions

| | PWA | Native |
|---|---:|---:|
| Handler bindings | 111 | 85 |

## L8 · Data dependencies

| | Count |
|---|---:|
| Distinct `/v1` endpoints the PWA route reaches | 14 |
| Distinct `/v1` endpoints the native screen reaches | 9 |
| Shared | 7 |
| **Called by PWA, never by native** | **7** |
| Called by native only | 3 |

**Endpoints the PWA route calls that this native screen never calls:**

- `/v1/uploads/sessions` — `apps/web/app/(app)/capture/_hooks/useCaptureSessionOrchestration.ts:88`
- `/v1/uploads/sessions/${…}` — `apps/web/lib/uploads/multipart-uploader.ts:526`
- `/v1/` — `apps/web/lib/privacy/redact.ts:227`
- `/v1/ops/upload-telemetry` — `apps/web/lib/uploads/telemetry.ts:75`
- `/v1/platform/context/switch-workspace` — `apps/web/lib/platform-context/PlatformContextProvider.tsx:476`
- `/v1/workflow/templates` — `apps/web/app/(app)/capture/_hooks/useWorkflowTemplates.ts:77`
- `/v1/ai/capture/analyze-session` — `apps/web/components/ai/CaptureAiAssistant.tsx:117`

## Unresolved for this route

- `COPY_OR_COMPOSITION_DIFF`: **169** — needs a per-element read.
- Web classes with no CSS rule: **33**.
- Runtime-built `className`: **38**.
- Which CSS declaration wins: **unresolvable by construction** (cascade + specificity + conditional class application are runtime facts). Competing rules found: 221.

> Nothing in this register is a rendered claim. No screenshot, simulator or device was used.