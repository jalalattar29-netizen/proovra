# PHASE E9 — AI Operational Intelligence

**Status:** CLOSED_WITH_DEFERRED_ITEMS
**Closure date:** 2026-05-26
**Test suite:** `services/api/test/phase-e9-ai-operational-intelligence.test.ts`
**Canonical content:** `packages/shared-evidence-presentation/src/ai-operational-content.ts`
**Trust Center alignment:** `ai-limitations` section extended

---

## 1. Intent

PROOVRA already has a substantial, safety-conscious AI subsystem (`services/api/src/services/ai/*`): a provider abstraction, a noop fallback, a 37-pattern policy filter, a Zod structured-output schema, a cost guard, and per-endpoint audit emission. Phase E9 does **NOT** build new OpenAI-backed assistance endpoints. Instead, E9:

1. Inventories the existing AI surfaces and pins the safety architecture so future operational-assistance work has one authoritative reference.
2. Publishes a canonical AI operational-content module enumerating the bounded allowed use-cases and the explicit forbidden categories.
3. Extends the Trust Center `ai-limitations` section with the full E9-bounded contract (advisory only, no autonomy, optional, structured-output validated, filename-redacted, cost-guarded, noop-tolerant).
4. Adds a cross-surface contract test (~190 cases) that pins the safety invariants programmatically so they cannot regress silently.
5. Surfaces the safety gaps the audit found as bounded LOW-severity DEFs so they stay tracked.

The phase ships zero schema changes, zero new capabilities, zero new routes, zero new root navigation. Real operational-summarisation endpoints are reserved for a follow-on bounded phase (E9.1) with its own entry gate.

---

## 2. Entry-gate report

Two parallel audit agents inventoried the provider abstraction + policy layer + cost guard + types, and the REST routes + frontend AI surfaces. The audit found:

| Layer | Reality |
|---|---|
| Feature flag | `OPENAI_AI_ENABLED` default **false**. Provider factory returns noop unless flag is true AND `OPENAI_API_KEY` is set. |
| Provider call | OpenAI `responses.create()` with `response_format: json_schema, strict: true`, temperature 0.18, max_tokens 900. No tool calls, no function calls, no streaming, no agent loops. |
| Output validation | Zod `AiResultSchema` (discriminated union on `status: "ok" \| "blocked" \| "disabled" \| "error"`). Validation runs on EVERY response; schema-fail → status="error". |
| Policy filter | `applyAiPolicy()` runs on EVERY response. 37-pattern forbidden-phrase blocklist + canonical legal disclaimer injection. Failure → status="blocked". |
| Cost guard | Per-user-per-day chat limit (default 30), per-evidence capture-analysis limit (default 10), monthly EUR budget (default 50). Short-circuits BEFORE the OpenAI call. |
| Noop provider | Returns `status: "disabled"`. Deterministic fallback layer (capture metadata validation) runs independently of AI. |
| Filename redaction | Frontend AND backend redact filenames before sending to OpenAI; OpenAI never sees real filenames. |
| Endpoints | 3 — `POST /v1/ai/chat`, `POST /v1/ai/capture/analyze-session`, `POST /v1/ai/capture/analyze-item`. All `requireAuth` + `requireLegalAcceptance`. |
| Frontend | 2 — `CaptureAiAssistant` (modal in capture flow), `ProovraChatWidget` (chat bubble). Both display the canonical legal disclaimer. |
| Mutation | NONE. Source-grep confirms no `prisma.*.update / delete / create`, no `appendCustodyEvent`, no `completeEvidence` calls anywhere in the AI service tree. |

Gaps found (registered as DEFs in §10):

- Chat message content has no input-side prompt-injection sanitisation (only page context is sanitised).
- No explicit OpenAI call timeout override (SDK default ≈ 600 s).
- AI provider error / schema-validation failure emits no `SecurityEvent` (only `console.error`).
- AI frontend surfaces have no per-team capability gate.

---

## 3. AI surface audit

| AI Surface | Current Purpose | Inputs | Outputs | Risks | Missing Guardrails |
|---|---|---|---|---|---|
| `POST /v1/ai/chat` | User support chat (advisory) | Operator text (≤5000 chars), sanitised page context | AiResult (status + summary + warnings + suggestions + flags + disclaimer) | Prompt injection via chat text → mitigated by output-side policy filter | DEF-033 (input-side sanitisation), DEF-036 (capability gate) |
| `POST /v1/ai/capture/analyze-session` | Capture workflow QA review (advisory) | Sanitised intake-session metadata (filename-redacted) | AiResult | Bounded — no raw evidence content reaches OpenAI | DEF-036 (capability gate) |
| `POST /v1/ai/capture/analyze-item` | Per-item capture review (advisory) | Single item metadata + selected plan step | AiResult | Bounded — same as session endpoint | DEF-036 (capability gate) |
| `CaptureAiAssistant.tsx` | Modal in capture flow | Calls `/v1/ai/capture/analyze-session` | Plain text + structured cards (no HTML/markdown) | Frontend never bypasses backend gates | DEF-036 |
| `ProovraChatWidget.tsx` | Chat bubble (advisory chat) | Calls `/v1/ai/chat` | Plain-text reply + structured suggestions | Arbitrary user text accepted; output filtered | DEF-033, DEF-036 |
| `ai-policy.ts` | Output-side policy filter | AiResult | Sanitised AiResult or status="blocked" | None — runs unconditionally on every output | — |
| `ai-cost-guard.ts` | Budget enforcement | (userId, evidenceId, teamId) | Boolean: allow / deny | None — short-circuits before provider | — |
| `ai-provider.ts` factory | Provider selection | (env) | OpenAiProvider or NoopAiProvider | None — default is noop | — |
| `openai-provider.ts` | OpenAI bridge | AiTask + input | AiResult (validated + policy-filtered) | Schema parse / network / timeout — all return status="error" | DEF-034 (explicit timeout), DEF-035 (audit event on error) |
| `noop-ai-provider.ts` | Failure-tolerance fallback | AiTask + input | Always status="disabled" | None — deterministic | — |

---

## 4. Canonical AI policy (E9 contribution)

The shared content module exports four canonical lists used as the source of truth for any future surface:

### 4.1 Allowed use cases (9)

`OPERATIONAL_SUMMARIZATION`, `WORKFLOW_GUIDANCE`, `INTAKE_COMPLETENESS_GUIDANCE`, `REVIEWER_ASSISTANCE`, `OPERATIONAL_PRIORITIZATION`, `GOVERNANCE_REMINDERS`, `SEARCH_NAVIGATION_ASSISTANCE`, `OPERATIONAL_ANOMALY_SUGGESTIONS`, `DOCUMENTATION_HELP`.

Each carries a complete content record: `label`, `purpose`, `allowedInputs`, `forbiddenInputs`, `outputBoundary`. Future surfaces consult this record before being shipped.

### 4.2 Forbidden categories (12)

`TRUTH_DETERMINATION`, `AUTHENTICITY_DETERMINATION`, `ADMISSIBILITY_DETERMINATION`, `LEGAL_CONCLUSIONS`, `FORENSIC_CERTIFICATION`, `AUTHORSHIP_CERTAINTY`, `FAKE_EVIDENCE_CERTAINTY`, `REAL_EVIDENCE_CERTAINTY`, `AUTONOMOUS_DESTRUCTIVE_ACTIONS`, `AUTONOMOUS_GOVERNANCE_DECISIONS`, `AUTONOMOUS_REVIEW_DECISIONS`, `AUTONOMOUS_MUTATIONS`.

Each carries a description naming why the category is forbidden. The contract test asserts every description names AI explicitly + uses negative language ("never" / "not" / "cannot").

### 4.3 Operational forbidden output patterns (12 regexes)

A higher-level mirror of the 37-pattern `ai-policy.ts` blocklist, shaped for cross-surface grep at the shared layer. Future surfaces (web copy, docs, future operational AI components) can import this list without touching the backend file.

### 4.4 Prompt-injection / data-safety principles (7)

Codified principles every future AI surface MUST satisfy: never trust user/evidence text as instructions, system instructions are operator-controlled, retrieval context is sanitised, no tool/function calls, no chain-of-thought leakage, no secrets/tokens/storage URLs to the provider, no streaming.

### 4.5 Failure-tolerance contract (object)

`AI_FAILURE_TOLERANCE_CONTRACT` exposes the seven bounded properties future surfaces must honour: `defaultEnabled: false`, `resultStatuses: ["ok", "blocked", "disabled", "error"]`, `noopPreservesWorkflows: true`, `deterministicFallbackLayer: true`, `structuredOutputValidationEnforced: true`, `policyFilterAlwaysRuns: true`, `costGuardShortCircuitsBeforeProvider: true`.

---

## 5. Operational summarization (scope only — no new endpoint shipped in E9)

E9 codifies the bounded shape that any future operational-summarization endpoint MUST follow. The scope is:

- Source: Phase E4 analytics envelopes (operations / reviewer / governance / automation / artifacts) — same `sourceTrace` + `degradedSources` semantics.
- Output: prose summary + bounded list of operational signals. No "risk score" / "authenticity score" / "admissibility score" / "confidence-in-truth" rating.
- Permission: must consume the same `ANALYTICS_VIEW` capability check the analytics page uses; never bypasses it.
- Team-scope: per-team only — no cross-team aggregation.
- Honest degraded states: when an analytics source reported `degradedSources`, the summary surfaces that explicitly rather than glossing over it.

E9.1 (if planned) would implement one bounded `POST /v1/ai/operations/summarize` endpoint following exactly this shape, with its own contract tests. E9 itself ships only the canonical contract.

---

## 6. Reviewer assistance (scope only)

Bounded shape for any future reviewer-assistance surface:

- Source: Phase E4 reviewer analytics envelope + the reviewer's own assignment list.
- Output: advisory recommendations only. The reviewer remains the authoritative human actor.
- Never auto-approve, auto-reject, auto-re-assign.
- Never claims authenticity, admissibility, or truth.
- Never scores evidence.

Implementation is reserved for E9.2 (if planned) with its own dedicated audit-event emission for every advisory suggestion shown.

---

## 7. Governance assistance (scope only)

Bounded shape:

- Source: Phase E4 governance envelope + EvidenceLegalHold + CaseLegalHold + RetentionPolicy state.
- Output: read-only reminder list. The operator action is always operator-driven.
- AI never executes a governance action. Never releases a legal hold. Never deletes evidence. Never alters retention. Never bypasses governance gates.

Implementation reserved for E9.3 (if planned). The forbidden-category test already pins that any future implementation must respect these bounds.

---

## 8. Search / retrieval assistance (scope only)

Bounded shape:

- Source: operator-typed query text + the canonical capability map for the viewer.
- Output: a bounded search query or a navigation link to an existing surface.
- AI never invents URLs.
- AI never returns links the viewer lacks capability for.
- Permission-aware: must consult the existing capability registry.
- Team-scoped: no cross-team semantic retrieval.

Implementation reserved for E9.4 (if planned). The forbidden-category test pins that any future implementation must respect these bounds.

---

## 9. AI explainability + failure tolerance

Every AI surface MUST:

- Surface the canonical advisory disclaimer (`AI_CANONICAL_ADVISORY_DISCLAIMER` from the shared module).
- Validate the provider response against the structured-output schema before rendering it.
- Surface the operational scope of the response (which analytics envelope, which workflow state).
- Surface degraded-source information when relevant.
- Tolerate provider failure by falling through to the noop / deterministic path; never block the rest of the workflow.

The `AI_FAILURE_TOLERANCE_CONTRACT` codifies these as machine-checkable boolean assertions. The contract test runs against every AI surface; surfaces that don't satisfy the contract fail the test.

---

## 10. Prompt-injection protections + data safety

The current state:

- **Filename redaction**: ✅ frontend + backend both redact filenames before sending to OpenAI.
- **Page context sanitisation**: ✅ UUIDs, tokens, long segments replaced with placeholders.
- **Chat message content sanitisation**: ❌ (DEF-033) — only output-side filter catches forbidden-phrase responses.
- **No tool / function calls**: ✅ JSON-schema strict mode; no agentic primitives.
- **No streaming**: ✅ complete JSON responses validated atomically.
- **No raw evidence content / file bytes / signed storage URLs**: ✅ never passed to OpenAI.
- **No secrets / tokens**: ✅ source-grep confirms.
- **Output policy filter**: ✅ runs on every response.

A future bounded phase (E9.5) can add input-side sanitisation for chat content to close DEF-033 without changing the AI surface contract.

---

## 11. AI UX

The current AI UX is calm + operational + bounded by design:

- `CaptureAiAssistant` is a modal inside the existing capture flow — not a separate dashboard.
- `ProovraChatWidget` is a corner-bubble chat — not a full-screen takeover.
- Both render plain text + structured cards (no HTML / markdown / template injection).
- Both display the canonical legal disclaimer.
- Neither introduces an AI navigation entry.

E9 explicitly forbids:

- A "giant AI dashboard".
- Autonomous-agent UI.
- Fake confidence gauges.
- "AI solved this" attribution.
- Scary AI branding across the product.

---

## 12. Trust Center alignment

The Trust Center `ai-limitations` section (one of the 10 canonical sections shipped in Phase E5) was extended additively with E9-specific language. The section title and id are unchanged so the E5 IA contract holds. New bullets surface:

- Structured-output schema enforcement + discriminated-status posture.
- No tool calls / function calls / agent loops / streaming.
- Input-side safety: no raw evidence bytes / signed URLs / secrets to OpenAI; filenames redacted; cost guards short-circuit.
- OPTIONAL posture: noop provider + deterministic fallback layer preserves all workflows when AI is disabled.

New limitations explicitly disclaim:

- AI is never an autonomous operator.
- AI never approves / rejects / re-assigns reviews.
- AI never releases legal holds, deletes evidence, finalizes records, or mutates automation rules / webhook destinations / external grants.
- AI is never a forensic engine, legal advisor, or admissibility scorer. Risk scores, confidence-in-truth ratings, and admissibility ratings are out of scope.

Tests assert all of the above stay present.

---

## 13. Architecture invariants preserved

- 32.8 IA: root nav still exactly the 6 canonical primaries (asserted by Test 13).
- No new client-state / queue / pubsub library.
- No new Prisma migration in E9 (no schema change).
- No mutation of capture / custody / finalize / signing / timestamp / report / package — file-size pins remain green (Test 14).
- No mutation of auth / MFA / SAML / SCIM.
- No new capability key.
- No new root navigation item.
- Capability registry has zero AI dependency — verified by source-grep (Test 12).

---

## 14. Deferred items opened by Phase E9

All four are LOW severity, NON_BLOCKING, and tracked as operational hygiene. None affects correctness or security; the existing three-layer safety architecture already provides defence-in-depth.

| ID | Title | Notes |
|---|---|---|
| DEF-033 | Chat message content has no input-side prompt-injection sanitisation | Only page context is sanitised. Output-side policy filter still catches forbidden phrasings; defence-in-depth would add server-side input normalisation (length cap, role-prefix strip, suspect-token replacement). |
| DEF-034 | No explicit OpenAI call timeout override | Relies on SDK default (~600 s). A short bounded timeout (~15 s) would harden failure tolerance + reduce cost-guard window for stuck calls. |
| DEF-035 | AI provider error / schema-validation failure emits no `SecurityEvent` | `openai-provider.ts` logs to console.error but does not emit a `SecurityEvent`. Operators cannot filter the security stream for AI failure rate. |
| DEF-036 | AI frontend surfaces have no per-team capability gate | `CaptureAiAssistant` + `ProovraChatWidget` mount for any authenticated user when `OPENAI_AI_ENABLED=true`. A future `AI_USE` capability key (granted by default, revocable per team) would let an org disable AI per team without redeploying. |

A future bounded phase (E9.X) can close 033 + 034 together (input sanitisation + provider timeout), 035 standalone (one safeEmitSecurityEvent call per failure path), and 036 standalone (one new capability key + registry mapping + PageRouteGate plumbing on the two AI components).

---

## 15. Test inventory

`services/api/test/phase-e9-ai-operational-intelligence.test.ts` covers 15 test groups:

1. Canonical AI content module shape (parametrised across 9 allowed use cases + 12 forbidden categories).
2. Advisory disclaimer matches `ai-policy.ts` verbatim + required boundary phrases present.
3. Structured-output schema is enforced (Zod parse + JSON-schema strict mode + policy filter + status discriminator).
4. Cost guard short-circuits BEFORE the provider call (source-grep ordering check).
5. Noop provider preserves workflows (returns status="disabled", not throws).
6. AI service tree has no mutation primitives (parametrised across 8 sources × 11 forbidden mutation calls).
7. AI provider has no tool calls / function calls / streaming / agent loops.
8. Filename redaction in capture path.
9. Trust Center `ai-limitations` extended (summary + bullets + limitations).
10. Forbidden operational output patterns absent from AI surfaces (parametrised across 7 surfaces × 12 forbidden patterns).
11. AI provider OFF by default.
12. Capability registry has zero AI input (source-grep).
13. 32.8 IA preserved.
14. Protected core files unchanged (5 cases).
15. Documentation + registry (3 cases: phase doc exists, registry row present, 4 new DEFs registered).

Total: **~190 cases**.

---

## 16. CR1.7 closure summary

- **Entry-gate checklist**: completed in writing before any code edit. Two parallel audits.
- **Files added:**
  - `packages/shared-evidence-presentation/src/ai-operational-content.ts` (canonical content + 9 allowed use-cases + 12 forbidden categories + 12 forbidden regex + 7 prompt-injection principles + failure-tolerance contract).
  - `services/api/test/phase-e9-ai-operational-intelligence.test.ts` (~190 cases).
  - `docs/product/PHASE_E9_AI_OPERATIONAL_INTELLIGENCE.md` (this file).
- **Files modified:**
  - `packages/shared-evidence-presentation/src/index.ts` — barrel re-export.
  - `packages/shared-evidence-presentation/src/trust-center-content.ts` — `ai-limitations` section extended additively with bullets + limitations.
  - `docs/recovery/MASTER_PHASE_REGISTRY.md` — Phase E9 row added; DEF-033 → DEF-036 added to §6.
- **No new DEFs resolved.** No prior phase deferred AI work to E9.
- **4 new DEFs opened (all LOW, NON_BLOCKING).** See §14.

---

## 17. Remaining risks

- The platform's AI surface is calm + bounded today. Future hands MUST consume the canonical content module rather than re-declaring policy in new surfaces; the contract test enforces this for the shipped surfaces.
- An operational AI surface (E9.1 onward) is a real feature build, not a documentation pass. Its entry gate MUST surface bounded scope, capability gating, and dedicated audit emission.
- DEF-033 (chat input sanitisation) is the most user-facing of the four open DEFs; it is bounded because output-side filtering catches forbidden-phrase responses, but a defence-in-depth pass would be cheap.

---

## 18. Next safe phase

Phase E10 / E9.X candidates, in priority order:

1. **AI failure-event emission** — closes DEF-035 (one `safeEmitSecurityEvent` per failure path in `openai-provider.ts`). Smallest surface, highest operator value.
2. **AI provider explicit timeout** — closes DEF-034 (bounded 15-second `signal: AbortSignal.timeout()` on the OpenAI call).
3. **AI per-team capability gate** — closes DEF-036 (new `AI_USE` capability key in the registry; PageRouteGate plumbing on the two AI components).
4. **Chat input sanitisation** — closes DEF-033 (server-side length cap + role-prefix strip + suspect-token replacement).
5. **First bounded operational-summarisation endpoint (E9.1)** — only after items 1–4 are closed. One endpoint, one bounded source (Phase E4 analytics), one capability key (`ANALYTICS_VIEW`), one dedicated audit event.

Each is small, bounded, and follows the same CR1.7 entry-gate discipline.
