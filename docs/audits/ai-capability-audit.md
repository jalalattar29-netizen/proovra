# PROOVRA AI capability audit

**Date:** 2026-09-04
**Scope:** every AI surface in the product — frontend, API, worker, configuration, tests
**Method:** code read, then executed. Every claim below that says PROVEN was
produced by running the code against a live local fixture API and recording the
response, not by reading the source and inferring what it would do.

---

## 1. The reported failure, and its exact cause

**Symptom.** A logged-in user asked the assistant *"How I can capture evidence"*
and received:

> AI assistant currently unavailable. Continue without AI.

**Cause — PROVEN, not inferred.** Reproduced against a local fixture API
(`services/api/scripts/dev-admin-fixture-api.mjs`, fixture Postgres on 55533),
authenticated as a seeded account, sending the exact request the widget sends:

```
POST /v1/ai/chat
{"messages":[{"role":"user","content":"How I can capture evidence"}],
 "pageContext":{"path":"/home","routeClass":"app"}}

HTTP 403
{"code":"AI_WORKSPACE_POLICY_DENIED",
 "message":"AI is disabled at the platform level.",
 "decision":"GLOBAL_DISABLED"}
```

The chain stops at **`evaluateWorkspaceAiPolicy`, step 1 — the global platform
gate**. `isPlatformAiGloballyEnabled()` is
`OPENAI_AI_ENABLED === "true" && Boolean(getSecret("OPENAI_API_KEY"))`. The API's
own startup log states the same fact independently:

```
"ai":{"configured":false,"reason":"OPENAI_AI_ENABLED_off"}
```

The request never reached the provider, the cost guard, or the budget ledger.

**Why the message said "unavailable".** `ProovraChatWidget.tsx` classified
failures like this:

```ts
const unavailableReason =
  apiError?.code === "AI_DISABLED" ||
  apiError?.statusCode === 404 || 503 || 502 || 504;
if (unavailableReason) setError("AI assistant unavailable.");
else setError("AI assistant currently unavailable. Continue without AI.");
```

`403` is not in that list, so a policy decision fell to the `else`. Two
independent defects meet here:

1. **`AI_DISABLED` is a code no route emits.** It appears nowhere in
   `services/api/src` or `packages/`. The single branch meant to recognise a
   deliberate shutdown could never match.
2. **The `else` claimed unavailability for everything unrecognised** — a
   workspace opt-out, a plan entitlement, a role restriction, a rate limit, a
   spent budget, an expired session. Each is a working system saying no, and
   each was reported as a malfunction.

**Layer-by-layer result for the reported request:**

| # | Stage | Result |
|---|---|---|
| 1 | `requireAuthAndLegal` | PASS |
| 2 | Per-user rate limit | PASS |
| 3 | Per-IP rate limit | PASS |
| 4 | Zod `ChatRequestBody` | PASS (non-strict; the widget's extra `routeClass` is stripped, not rejected) |
| 5 | `resolveCommercialContext` | PASS |
| 6 | `assertWorkspaceAllowsAiOperation` | PASS |
| 7 | **`evaluateWorkspaceAiPolicy`** | **DENY — `GLOBAL_DISABLED` → HTTP 403** |
| 8 | `aiChatService.preflight` (product knowledge) | NOT REACHED |
| 9 | Budget reserve | NOT REACHED |
| 10 | Provider call | NOT REACHED |

Hypotheses eliminated by execution, not by guessing:

- **Not the Noop provider.** `NoopAiProvider` returns HTTP **200** with
  `status: "disabled"`, so an unconfigured provider cannot produce this error.
  (It has its own defect — see §4.)
- **Not a provider outage or a bad model name.** `OpenAiProvider.runInner`
  catches everything and returns HTTP 200 with `status: "error"`.
- **Not a 400.** `ChatRequestBody` is non-strict and `getSafePageContext`
  always returns a string path.

---

## 2. The second failure, which the first was hiding

Even with the provider fully enabled, **none of the questions the assistant
advertises were answered deterministically.** `answerProductKnowledge` returned
`null` unless the question matched `isPricingQuestion`.

Executed before the change:

```
ALLOW  scope=CAPTURE_OPERATIONS   knowledge=none  "How I can capture evidence"
ALLOW  scope=CASE_OPERATIONS      knowledge=none  "How do I create a case?"
ALLOW  scope=CUSTODY_VERIFICATION knowledge=none  "What is a verification package?"
ALLOW  scope=CUSTODY_VERIFICATION knowledge=none  "What does TSA failed mean?"
ALLOW  scope=PROOVRA_PRODUCT_HELP knowledge=none  "Where can I manage notifications?"
ALLOW  scope=PROOVRA_PRODUCT_HELP knowledge=none  "What can AI do in PROOVRA?"
```

Every one passes the safety classifier — they are in scope — and every one
required a live OpenAI call to answer, despite the answers being fixed
properties of the product already compiled into
`proovra-product-knowledge.ts`.

---

## 3. Why the tests did not catch any of this

Every AI-chat test in `services/api/test` reads its route file **as a string**
and asserts on substrings and their relative index:

```ts
expect(AI_ROUTES).toContain("AI_CHAT_LIMITS");
expect(userRateIdx).toBeLessThan(analyzeIdx);
```

A string assertion cannot notice that a branch is unreachable, that a code is
never emitted, or that a 403 renders as an outage. One of them,
`phase-a3-backend-hardening`, sliced a fixed 5,000 characters of source and
searched inside it — so adding a comment to the handler failed it while a
genuine reordering within 5,000 characters would have passed. It is now bounded
by the handler rather than by a byte count.

---

## 4. Capability matrix

`IMPLEMENTED` · `PARTIAL` · `CONFIGURED-NOT-REACHABLE` · `PLACEHOLDER` ·
`PLANNED` · `UNSUPPORTED` · `OVERCLAIMED`

### Backend AI surfaces

| Surface | Route / module | Status | Notes |
|---|---|---|---|
| Support chat | `POST /v1/ai/chat` | IMPLEMENTED | Full gate chain; provider + deterministic paths |
| Availability | `GET /v1/ai/availability` | IMPLEMENTED | **Added by this pass** — see §5 |
| Capture assistance | `POST /v1/ai/capture/analyze-session` | IMPLEMENTED | Own guard, dedup, budget |
| Evidence categorisation | `AiTask.EVIDENCE_METADATA_CATEGORIZATION` | IMPLEMENTED | Metadata only |
| QC samples | `POST /v1/ai/qc/samples` | IMPLEMENTED | |
| Semantic search | `POST /v1/ai/search/nl` | CONFIGURED-NOT-REACHABLE | Gated on `SEMANTIC_SEARCH_ENABLED`, absent from config |
| Reviewer copilot | `ReviewerCopilotPanel` + `REVIEWER_COPILOT` | CONFIGURED-NOT-REACHABLE | Wired at `/reviewer-ops/[reviewId]`; `reviewerCopilotEnabled` defaults **false** |
| Case copilot | `CaseCopilotPanel` + `CASE_COPILOT` | CONFIGURED-NOT-REACHABLE | Same — defaults **false** |
| Content intelligence | `CONTENT_INTELLIGENCE` | CONFIGURED-NOT-REACHABLE | Defaults **false** |

### Governance and safety

| Control | Module | Status |
|---|---|---|
| Workspace AI policy (8 ordered gates) | `workspace-ai-policy.service.ts` | IMPLEMENTED |
| Scope classifier / default-deny | `chat-scope-classifier.service.ts` | IMPLEMENTED — verified by execution |
| Prompt-injection detection | `detectInjectionSignals` | IMPLEMENTED — refuses override/probe/hijack |
| Prohibited-claims engine | `prohibited-claims-engine.service.ts` | IMPLEMENTED |
| Prompt-context sanitiser | `prompt-context-sanitizer.service.ts` | IMPLEMENTED |
| Provider privacy validation | `provider-privacy.service.ts` | IMPLEMENTED |
| Cost guard / budget ledger | `tryReserveAiBudget` etc. | IMPLEMENTED |
| Rate limiting (user + IP) | `enforceRateLimit` | IMPLEMENTED |
| Audit logging | `auditAiAction` | IMPLEMENTED |
| AI never mutates platform state | E9 Test 6 | IMPLEMENTED — enforced by test |

### User-visible claims

| Claim | Location | Status | Action |
|---|---|---|---|
| "AI-powered verification & real-time integrity checks" | `HeroSection.tsx` VERIFY rail | **OVERCLAIMED** | **Corrected** → "Cryptographic signatures & hash-linked integrity checks" |
| "Share or verify authenticity instantly, anywhere" | `HeroSection.tsx` PROVE rail | **OVERCLAIMED** | **Corrected** → "Share a package anyone can check, instantly" |
| "AI Review — AI-powered insights and guidance" | `EvidenceOperations.tsx` | PARTIAL | Accurate in kind (advisory); the feature is off by default |
| "AI can / AI does not" section | `technology/page.tsx` | IMPLEMENTED | Honest; matches the code's boundaries |
| "AI cannot determine truth, authenticity, or admissibility" | Copilot panels | IMPLEMENTED | Matches `PROOVRA_PRODUCT_FACTS.boundaries` |
| "Advisory support only. Not legal or factual determination." | Assistant header | IMPLEMENTED | Reworded, boundary unchanged — see §5 |

The two corrected claims contradicted the product's own stated boundary, which
is compiled into the codebase:

> PROOVRA records integrity state and technical provenance. It does **NOT**
> determine factual truth, authenticity, authorship, identity, intent,
> liability, fraud, or legal admissibility.

A homepage promising *AI-powered verification* promised precisely the thing the
system refuses to do.

**Locales.** The shared dictionary (`packages/shared/src/i18n.ts`, 7 locales:
en, ar, de, fr, es, tr, ru) contains **no AI claims** — it covers auth screens
only. All AI copy is literal English in components, so the corrections above are
the complete set; there is no translated copy carrying the same overclaim.

### Configuration

| Variable | Effect | Present locally |
|---|---|---|
| `OPENAI_AI_ENABLED` | Global gate, step 1 | fixture: `false` |
| `OPENAI_API_KEY` | Global gate, step 1 | fixture: absent |
| `OPENAI_CHAT_MODEL` / `OPENAI_MODEL` | Chat model | default `gpt-4.1-mini` |
| `OPENAI_CAPTURE_MODEL`, `OPENAI_EVIDENCE_CATEGORIZATION_MODEL`, `OPENAI_CASE_COPILOT_MODEL`, `OPENAI_EVIDENCE_COPILOT_MODEL` | Per-task models | |
| `SEMANTIC_SEARCH_ENABLED` | Gates semantic search | absent |
| `AI_REQUIRE_PROVIDER_PRIVACY` | Blocks on privacy config failure | absent |
| `AI_MONTHLY_BUDGET_EUR`, `AI_MAX_CHAT_MESSAGES_PER_USER_PER_DAY`, `AI_MAX_CAPTURE_ANALYSES_PER_EVIDENCE` | Cost guards | |
| `OPENAI_DATA_REGION`, `OPENAI_DATA_USE_MODE`, `OPENAI_ORG` | Provider privacy posture | |

---

## 5. What this pass changed

**Backend**

- `proovra-product-knowledge.ts` — `answerProductKnowledge` now routes 14
  grounded topics instead of pricing alone. The topics carry **routing only**;
  their prose is composed from `PROOVRA_PRODUCT_FACTS`, so there is still one
  description of custody, one of the lifecycle, one of verification. Version
  bumped `1.0.0` → `1.1.0`.
- `ai.routes.ts` — a denial now distinguishes what the **operator** has not
  configured from what the **customer** has decided. `GLOBAL_DISABLED` and
  `PROVIDER_NOT_CONFIGURED` still serve grounded answers, which call no model
  and send nothing outbound. **Every workspace, plan, role and data-class
  denial is honoured exactly as before** — no consolation answer, no partial
  override of an opt-out.
- `workspace-ai-policy.service.ts` — that rule is the named predicate
  `isOperatorCapabilityGap`, so it can be tested and so its two call sites
  cannot drift.
- `GET /v1/ai/availability` — the panel can now ask what is possible instead of
  discovering it by failing.
- The policy denial repeats `decision` inside `details`, the only part of a flat
  error body the web transport preserves.

**Frontend**

- `lib/ai/assistant-state.ts` — new pure module mapping an error or a result
  status to one of 15 bounded states, each with its own copy and its own answer
  to "can the user try again". Pure, so every branch is one assertion.
- `ProovraChatWidget.tsx` — rebuilt. One state instead of two that could
  contradict each other on screen; availability probed on open; result status
  classified (a 200 carrying `status: "error"` is no longer rendered as advice);
  opening prompts are four real questions that work with AI switched off.
- `assistant.css` — the panel moved off its private teal palette
  (`#3a5d61`, `#243f44`, `#8f745c`, `#e6c9ae`) onto the canonical `app-*`
  tokens, plus a phone bottom-sheet layout.

**Claims** — the two corrected hero strings above.

**Tests** — 12 API tests (`ai-grounded-answers.test.ts`) and 12 web tests
(`assistant-state.test.ts`) that **call the code** rather than reading it.

---

## 6. Verified after the change

Same fixture, same disabled-AI configuration, same request:

```
GET /v1/ai/availability → 200
{"available":false,"decision":"GLOBAL_DISABLED",
 "groundedAnswersAvailable":true,
 "groundedTopics":["pricing","capture","case","verification_package","tsa",
   "ots","custody","lifecycle_status","notifications","roles",
   "ai_capability","boundaries","verify_public","trust_center"]}

POST /v1/ai/chat  "How I can capture evidence" → 200
"Capture is where a new record starts. Capture stages an item, then Review &
 Sign finalizes it. On finalization the file SHA-256 is recorded, an Ed25519
 fingerprint signature is created, and a Verification Package + Report PDF are
 generated by the worker. Until it is finalized the item is staged, so you can
 check what was captured before anything is signed."
```

---

## 7. Open items — not fixed by this pass

1. **`NoopAiProvider` leaks operator instructions to end users.** Its summary
   reads *"Configure OPENAI_AI_ENABLED=true and provide OPENAI_API_KEY to enable
   this feature."* That is an instruction for an operator, returned in a 200 to
   whoever is typing. The new UI never displays it — a `disabled` status is
   classified and replaced with the panel's own copy — but the string is still
   emitted by the API and would reach any other client.
2. **`POST /v1/auth/email/login` returns the user's `passwordHash`** in the
   success body. Observed directly during this audit. Out of scope here, but it
   should not wait.
3. **The scope classifier scores pricing questions `AMBIGUOUS_REQUEST`.** Harmless
   today only because `answerProductKnowledge` runs first; a reordering would
   start refusing "how much does Pro cost?".
4. **Copilot and semantic-search features default to off** and have no UI that
   explains why they are absent.
5. **The production decision code is not established here.** The mechanism is
   proven and identical for every denial, but which decision fires in production
   depends on the deployed environment, which this audit did not touch. The new
   availability endpoint reports it directly.
