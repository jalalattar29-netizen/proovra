# PROOVRA AI — final policy and security closure audit

**Date:** 2026-09-04
**Scope:** AI only, end to end — routes, providers, policy, payloads, prompts, output, persistence, public claims
**Method:** nothing below is asserted from a passing suite, a comment, or a
helper's name. Every PROVEN line was produced by running the code — the real
function with real input, or the real service with a spy provider counting
outbound calls. A call count of zero is the only honest proof that nothing left
the platform.

Companion to `ai-capability-audit.md`, which covers the assistant's capability
and the two credential/config leaks closed earlier.

---

## A. The AI architecture, as it actually is

```
UI  →  route (requireAuth / authorizeOrFail)
    →  workspace + org resolution (server-side, never from the client)
    →  evaluateWorkspaceAiPolicy   (8 ordered gates, fail-closed)
    →  rate limit + durable budget reserve
    →  CONTEXT BUILD  ← the metadata boundary lives here
    →  provider
    →  schema validation + prohibited-claims scan
    →  AI-owned persistence only
    →  audit / telemetry (bounded codes, no payload text)
    →  UI (labelled AI-generated, advisory)
```

**There are three independent outbound provider paths, not one.** This is the
most important structural fact in the audit, because a boundary proven on one
says nothing about the others:

| Path | File | Used by |
|---|---|---|
| Advisory provider | `openai-provider.ts` | chat, capture assistance, evidence categorisation |
| Structured copilots | `structured-copilot-provider.ts` | evidence / case / reviewer copilots |
| Embeddings | `search/embedding-provider.ts` | semantic search |

Each was audited separately. All three are metadata-bounded; the mechanisms
differ (see §E).

## B. Every AI endpoint

| Endpoint | Auth | Policy gate | Calls a provider? |
|---|---|---|---|
| `GET /v1/ai/availability` | authenticated | evaluates (reports only) | no |
| `POST /v1/ai/chat` | authenticated | `SUPPORT_CHAT` | only if ungrounded |
| `POST /v1/ai/capture/analyze-session` | authenticated | `CAPTURE_ASSISTANCE` | yes |
| `POST /v1/ai/evidence/:id/copilot` | `authorizeOrFail` | `EVIDENCE_CATEGORIZATION` | yes |
| `POST /v1/ai/case/:caseId/copilot` | `authorizeOrFail` | `CASE_COPILOT` | yes |
| `POST /v1/ai/reviewer/:reviewId/copilot` | `authorizeOrFail` | `REVIEWER_COPILOT` | yes |
| `POST /v1/ai/copilot-runs/:runId/observations` | `authorizeOrFail` | copilot policy | no (human review) |
| `GET /v1/ai/qc/samples` | authenticated | reviewer-ops | no |
| `POST /v1/ai/qc/samples/:runId/decision` | authenticated | reviewer-ops | no |
| `POST /v1/ai/search/nl` | `authorizeOrFail` + `intelligence.read` | none — **correctly** | **no** |
| `GET/POST /v1/evidence/:id/ai-categorization[/run]` | evidence authz | `EVIDENCE_CATEGORIZATION` | yes |

`/v1/ai/search/nl` has no workspace-AI policy check and does not need one: it is
a deterministic parser (`parseNlSearch`) plus tenant-scoped SQL. No model, no
outbound call, nothing leaves. It is named "ai"; it is not AI. Flagging it would
have been a false finding.

## C. Claim → implementation → proof

| # | Claim | Implementation | Status |
|---|---|---|---|
| A | AI is advisory only | no platform mutation anywhere in the AI tree | **IMPLEMENTED — proven** |
| B | Guide collection / detect missing context / prepare reviewers | `missingContext` is a first-class schema field in both copilots | **IMPLEMENTED — on by default; corrected in Appendix §1** |
| C | AI does not determine truth/authorship/identity/admissibility | prohibited-claims engine + schema with no verdict fields | **IMPLEMENTED — one gap found and fixed, §L** |
| D | AI optional, disableable per workspace | `aiEnabled=false` → `WORKSPACE_DISABLED`, fail-closed | **IMPLEMENTED — proven** |
| E | Metadata-first by default | default policy: raw/OCR/transcription/embeddings all `false` | **IMPLEMENTED — proven** |
| F | Raw evidence not sent by default | allow-lists drop every content field | **IMPLEMENTED — proven** |
| G | Requests use operational metadata / structured context | payload inventory §F | **IMPLEMENTED — proven** |
| H | Future content AI requires authorisation + disclosure | `DATA_CLASS_NOT_ALLOWED`; embeddings dual-gated inside the provider | **IMPLEMENTED — proven** |
| I | Evidence content not used to train | content never leaves at all; `store:false` always | **CODE-PROVEN for evidence content; see §R** |
| J | Humans remain decision-makers | AI writes only AI-owned tables | **IMPLEMENTED — proven** |
| K | AI output labelled advisory | "AI-generated / Advisory only / Metadata only" in copilot panels | **IMPLEMENTED** |
| L | Core workflows do not depend on AI | 30s timeout, failures return advisory errors | **IMPLEMENTED** |
| M | Opt-out fail-closed | matrix test, 7 denial rows | **IMPLEMENTED — proven** |
| N | Outages degrade safely | taxonomy separates the three causes | **IMPLEMENTED** |

## D. The three advertised capabilities

| Capability | Verdict |
|---|---|
| Guide evidence collection | **IMPLEMENTED** — `/v1/ai/capture/analyze-session`, `CAPTURE_ASSISTANCE` on by default |
| Detect missing context | **IMPLEMENTED** — `missingContext` bounded list in `ai-copilot-schemas.ts` |
| Prepare reviewers | **IMPLEMENTED** — reviewer copilot emits observations against human-authored criteria |
| Spot missing context before submission | **IMPLEMENTED** — the evidence copilot, governed by `EVIDENCE_CATEGORIZATION` (default **true**) |

None is placeholder or dead code.

> **CORRECTED BY APPENDIX §1.** This section originally concluded that two of
> the four capabilities were "off until an administrator enables them", read
> from the `reviewerCopilotEnabled` / `caseCopilotEnabled` defaults. Tracing
> each capability to the surface that actually delivers it shows the evidence
> copilot emits both `missingContext` and `reviewerPreparation` and is on by
> default. Only the deeper reviewer-ops and case copilots are off. What was
> genuinely broader than runtime truth was the marketing copy being
> UNCONDITIONAL, not the capability being absent.

## E. Metadata-first boundary — result

**PASS, and enforced at the boundary rather than by convention.**

The decisive test hands `buildAllowlistedFields` exactly what the policy
forbids — `rawContent`, `ocrText`, `transcript`, `fileBuffer`, `storageKey`,
`presignedUrl`, `downloadUrl`, `authToken`, `apiKey`, `sessionId`, `ownerEmail`,
`teamId` — and requires every one to be absent from the output. It is. A caller
that passes raw content "just for context" cannot leak it, because the builder
copies only names on the list.

A second test guards the LIST itself: no allow-listed field name may match
`/content|raw|text|body|url|key|token|secret|email|transcript|ocr|buffer|path/`,
so widening it has to argue with a test rather than slip through a large diff.

Embeddings use a different and equally sound mechanism: the
`SEMANTIC_EMBEDDINGS_SEND_CONTENT_OUTBOUND` gate is checked **inside** the
provider (`private gate()`), before the network call — not at a call site. It
defaults off, and is off in every committed configuration.

## F. Exact outbound payload inventory

| Feature | Fields sent | Raw evidence | PII |
|---|---|---|---|
| Support chat | user message (sanitised, ≤5000 chars, ≤20 msgs), redacted route class | no | only what the user types |
| Evidence categorisation | evidenceId, sanitised title, type, mimeType, itemCount, sizeBytes, captureMethod, verificationStatus, availability flags, caseLinked, sanitised workspaceLabel | no | title only |
| Evidence/case copilot | `EVIDENCE_CONTEXT_ALLOWLIST` / `CASE_CONTEXT_ALLOWLIST` — title, type, mimeType, status, verificationStatus, counts, dates, readiness flags | no | title only |
| Embeddings | chunk text — **gated off by default** | would be derived text | n/a while gated |

Every free-text value passes `sanitizeUntrustedField`: NFKC normalisation,
control/bidi stripping, signed-URL redaction, bearer/key redaction, precise-GPS
redaction, length bound. Proven by test: a message containing an `sk-proj-…` key
and an `X-Amz-Signature` URL reaches the provider with both removed.

## G. Raw-evidence leakage — **none found**

No path sends file bytes, images, video, audio, PDFs, OCR text, full document
contents, storage keys, presigned URLs, or S3/R2 credentials.

## H. Cross-workspace isolation — **PASS**

Every provider-invoking AI route resolves the workspace server-side.
`/v1/ai/search/nl` accepts `teamId` in the body but verifies it through
`authorizeOrFail` (ACTIVE membership + org lifecycle + `intelligence.read` +
anti-enumeration 404) before any tenant-scoped query, so a forged id yields 404
rather than another workspace's data. Copilot routes take ids from the path and
authorise against canonical context; none reads `body.teamId`. The client cannot
self-assert workspace, org, role, plan or policy anywhere.

## I. Workspace AI opt-out — **PASS, fail-closed**

Seven denial rows, each flipping exactly one input, each asserting its own
decision code. One-at-a-time matters: a single "everything off" case would pass
even if five gates had been deleted.

The operator-gap / customer-decision split is tested in both directions.
`WORKSPACE_DISABLED`, `FEATURE_DISABLED`, `ROLE_NOT_PERMITTED`,
`PLAN_NOT_ENTITLED` and `DATA_CLASS_NOT_ALLOWED` never permit a local fallback;
only `GLOBAL_DISABLED` and `PROVIDER_NOT_CONFIGURED` do, and those send nothing
outbound.

## J. Prompt injection — **PASS**

Direct injection is refused before the provider: five hostile inputs, each
asserting **provider call count 0**. Default-deny (`classifyChatScope`) refuses
anything not proven in-domain.

Indirect injection — the realistic attack, stored in a title and waiting for a
copilot run — is handled structurally rather than by pattern matching. Customer
data is delivered as the VALUE of a field named `untrusted_record_data`, in a
user turn, separate from the system turn; it can never arrive as instruction.
Bidi and control characters are stripped, so injected text cannot disguise
itself. Injection signals are telemetry only and are proven not to appear in
prompt content — a signal name concatenated into a prompt would itself be
attacker-influenced text.

## K. System prompt / config / secret leakage — **PASS**

No user-visible AI response carries environment variable names, keys, secrets,
provider credentials, stack traces, internal hostnames or connection URLs. The
`NoopAiProvider` leak closed in `c1696826` remains closed and is regression-
tested. Copilot telemetry logs schema name, latency, attempt and outcome —
never payload or response text.

## L. Prohibited claims — **ONE REAL DEFECT, FIXED**

**Severity: HIGH. Category B — policy/implementation mismatch.**

The rules were written as `(is|are)\s+(authentic|admissible|…)` — the copula
immediately followed by the forbidden word. **A single intervening adverb
defeated the entire layer.** Proven by execution, all previously passing:

```
*PASSED*  "This evidence is legally admissible."      ← the exact policy wording
*PASSED*  "This evidence is clearly admissible."
*PASSED*  "This would be fully admissible in a hearing."
*PASSED*  "The recording is clearly authentic."
*PASSED*  "This will be readily accepted by the court."
```

This is not an exotic evasion. It is how a model actually writes a judgement —
asked for one, it hedges. "Clearly authentic" is the sentence the engine exists
to stop, and it was the sentence it let through. The engine's own docstring
claimed it had replaced "a fragile literal phrase blocklist"; it had, for
homoglyphs and letter-spacing — the evasions someone tries on purpose — but not
for the one that happens by accident, in ordinary English, every time.

**Fix.** A `copula()` builder allows up to three intervening words, applied to
the eight affected rules. Bounded on purpose: `.*` would reach across clauses
and flag "a document the court found admissible in 2019", which asserts nothing.

**Verified:** 12 evasions now blocked, 5 legitimate operational sentences still
clean, including that deliberately tricky one.

**Left as-is, deliberately:** the engine flags PROOVRA's own refusal wording
("does not determine whether evidence is authentic"), because it has no negation
handling. Teaching a safety blocklist to parse negation is how "this is not
inauthentic" gets through — the parser becomes the attack surface. Over-blocking
costs a refusal being replaced by a safe summary that says the same thing;
under-blocking costs a forensic verdict. The disclaimers users read are static UI
copy and never pass through the scanner.

## M. Human review / no autonomous decisions — **PASS**

Every write in the AI service tree targets an AI-owned table: `aiUsageEvent`,
`aiUsageDaily`, `aiUsageMonthly`, `aiCopilotRun`, `aiCopilotObservationReview`,
`workspaceAiPolicy`. **Nothing** touches evidence, custody, legal holds,
verification state, reports, retention, billing or membership. No tool/function
calling exists, so there is no tool authorization model to audit.

**Coverage gap found and closed:** the structural guard enforcing this listed the
eight files that existed when it was written and was never extended. The
copilots arrived afterwards — and they are the AI surfaces that read evidence and
case material, so they are the ones with a reason to write. Five copilot surfaces
are now covered (280 assertions).

## N. Output injection / XSS — **PASS**

Assistant and copilot output is rendered as React text children. No
`dangerouslySetInnerHTML`, no markdown renderer, no `innerHTML` anywhere in the
AI UI. Model output is therefore inert by construction rather than by
sanitisation, which is the stronger position: there is no sanitiser
configuration to get wrong.

## O. Rate / cost / token abuse — **PASS**

5 requests/user/minute, 30/IP/minute, 30s hard timeout, ≤20 messages of ≤5000
characters (≈100 KB ceiling), copilot output capped at 1500 tokens, retry bounded
to one attempt on retryable status only, plus a daily cost guard and a durable
reserve→reconcile→release ledger. Refusals and grounded answers short-circuit
**before** any reservation, so the cheap paths cost nothing.

## P. Provider failure — **PASS**

The taxonomy separates customer policy denial, operator configuration gap, and
temporary provider failure, in 15 bounded states with distinct copy. Core
workflows never wait on AI.

## Q. Conversation and retention — **PASS**

**Support-chat prompts and responses are never persisted server-side.** There is
no conversation model in the schema; the transcript exists only in component
state. Nothing to leak on workspace switch, and nothing to reach after account
closure.

Copilot runs and observations are workspace-scoped and bounded:
`cleanupExpiredCopilotRuns` runs opportunistically against the workspace
retention setting, and `purgeWorkspaceAiRecords` runs on workspace deletion.
Both are wired, not decorative.

## R. No-training claim

**CONFIG / CONTRACT PROOF REQUIRED — with an unusually strong code-side floor.**

- **Code proves:** `store: false` on every request from both providers. And
  because evidence content never reaches a provider at all (§E–G), the claim as
  worded — *customer evidence content* is not used to train — is **code-proven
  for evidence content specifically**. What cannot be trained on is what was
  never sent.
- **Configuration proves:** `OPENAI_DATA_USE_MODE` resolves to
  `ZERO_DATA_RETENTION_ATTESTED` / `NO_TRAINING_ATTESTED` / `STANDARD_API` /
  `UNKNOWN`. It is unset in every committed configuration, so the current
  resolved mode is `UNKNOWN`.
- **Contract must prove:** OpenAI API terms / DPA for the residual — the
  metadata (titles, statuses) that does leave.

Worth recording: the code refuses to overclaim on its own behalf —
`// If not explicitly declared, we do NOT claim no-training in code.` That is the
correct posture and should not be "improved".

**Required external evidence:** the OpenAI organization's data-controls setting
and the executed DPA. Neither is inspectable from this repository.

## S. Authentication / authorization

No AI endpoint is public. All require authentication; the four that touch
workspace resources use `authorizeOrFail` (ACTIVE membership, org lifecycle,
capability, anti-enumeration 404). UI hiding is nowhere relied upon.

## T. AI auditability — **PASS**

`auditAiAction` and `emitTenantAudit` record actor, workspace, feature, policy
decision, outcome class and cost. Metadata carries `messageCount` and the
redacted route class — never prompt text, evidence content, or secrets. Audit
logging is not itself an exfiltration sink.

## U. Dead / shadow implementations — none material

The prohibited-claims engine is wired into four runtime services. Retention is
wired. `/v1/ai/search/nl` is deterministic by design, not dead. One naming
inconsistency: the evidence copilot reserves budget under the feature string
`EVIDENCE_COPILOT`, but its policy gate evaluates `EVIDENCE_CATEGORIZATION` —
there is no `EVIDENCE_COPILOT` policy flag. It is gated and fail-closed either
way; the mismatch is a legibility risk for an operator reading the policy, not a
bypass. Recorded, not changed.

## V. Public copy consistency

The AI Use Policy is carefully hedged and matches the implementation, including
"where the provider supports such configuration" on the training claim — the
precise place where code alone cannot prove it. It exists in English only; `ar`
and `de` carry no AI document, so there is no translated variant to drift.

**One underclaim / overclaim to decide, NOT changed here:** the marketing copy
presents "AI Review — spot missing context before submission" without noting that
the reviewer and case copilots are **off by default**. The capability is real;
its availability is conditional. Since this touches product positioning rather
than a false technical statement, it is reported for a decision rather than
edited.

## W. Defects

| # | Severity | Finding | Status |
|---|---|---|---|
| 1 | HIGH | Prohibited-claims rules defeated by one intervening adverb; "is legally admissible", "is clearly authentic", "will be readily accepted by the court" all passed | **FIXED** — 8 rules rebuilt, 12 evasions blocked, 5 clean sentences verified |
| 2 | MEDIUM | Structural no-mutation guard never extended past its original 8 files; the copilots — the surfaces that read evidence — were uncovered | **FIXED** — 5 surfaces added |
| 3 | LOW | `EVIDENCE_COPILOT` budget feature has no matching policy flag | Recorded; gated and fail-closed |
| 4 | INFO | Copilots off by default vs unqualified marketing copy | Reported for decision |

## X. Tests

- `ai-closure-invariants.test.ts` — **25**, new (policy matrix, provider call counts, payload boundary, injection, prohibited claims)
- `phase-e9-ai-operational-intelligence.test.ts` — **280** (was ~180; +5 copilot surfaces)
- `security-credential-and-config-leakage.test.ts` — 15
- `ai-grounded-answers.test.ts` — 12
- API typecheck clean · full suite **24,031 passed / 3 failed**

The 3 failures are one pre-existing file whose every assertion names only
`apps/web/tsconfig.json` — another session's uncommitted working-tree file,
verified against HEAD and not staged here.

## Y. Remaining risk

1. **No-training depends on provider configuration and contract** (§R).
2. **Copilots are unexercised in production** because they default off; their
   gates are proven, their live behaviour under real workspace data is not.
3. **The prohibited-claims engine is deterministic.** It now resists adverb
   separation, homoglyphs and letter-spacing, but no regex layer catches every
   paraphrase. It is one of four layers (system prompt, verdict-free schema,
   this scan, human review) and should not be treated as sufficient alone.
4. **No live adversarial testing against a real model** was possible — AI is
   disabled in every environment reachable from here. Every provider-facing
   result above is proven at the boundary, not through OpenAI.

## Z. Verdict

**AI CLOSURE: PASS WITH EXTERNAL EVIDENCE REQUIRED**

The security boundaries hold under execution: no raw evidence leaves, no
cross-tenant path exists, customer opt-out is fail-closed, untrusted content
cannot become instruction, no AI output can alter authoritative state, and no
configuration detail reaches a user. One real defect in the prohibited-claims
layer was found by execution and fixed; one structural guard was found
under-scoped and extended.

The remaining gap is not in this repository: the no-training commitment requires
the provider's data-control configuration and the executed DPA. Two advertised
capabilities are real but off by default, which is a positioning decision for the
owner rather than a technical defect.

This is not a claim that PROOVRA's AI is free of vulnerabilities. It is a
statement of what was proven, how, and what was not reachable from here.

---

# Appendix — final closure of the three remaining items

**Date:** 2026-09-04. Closes the items left open by the verdict above.

Proof classes used below:

- **CODE-PROVEN** — a property of the source, demonstrated by running it.
- **RUNTIME-PROVEN** — observed against a booted API.
- **EXTERNAL-EVIDENCE-REQUIRED** — cannot be established from this repository.
- **NOT EXECUTABLE IN CURRENT ENVIRONMENT** — no approved environment exists to
  test it, and creating one is out of scope.

## 1. Conditional AI Review wording — CLOSED

### A correction to the audit above

The audit recorded that the advertised capabilities were "off by default"
because `reviewerCopilotEnabled` and `caseCopilotEnabled` default to `false`.
Tracing the capability to the surface that actually delivers it shows that was
**too broad**.

The **evidence copilot** (`/v1/ai/evidence/:id/copilot`, mounted in the UI at
`/evidence/[id]` → Review tab) emits both `missingContext` and
`reviewerPreparation` as first-class schema fields, and it is governed by
`EVIDENCE_CATEGORIZATION`, which defaults **`true`**. So:

| Advertised | Delivered by | Default |
|---|---|---|
| Guide evidence collection | `CAPTURE_ASSISTANCE` | **on** |
| Detect missing context | evidence copilot → `EVIDENCE_CATEGORIZATION` | **on** |
| Prepare reviewers | evidence copilot `reviewerPreparation` | **on** |
| Spot missing context before submission | evidence copilot | **on** |
| Deeper reviewer-ops / case review | `REVIEWER_COPILOT`, `CASE_COPILOT` | **off** |

The capabilities as *worded in the marketing copy* are therefore available by
default. Only the dedicated reviewer-ops and case copilots are off.

### What was actually materially broader than runtime truth

Not the capability — the **unconditionality**. Every AI capability requires:

1. the platform to have a provider configured (`OPENAI_AI_ENABLED` + a key), and
2. the workspace not to have opted out, and
3. plan entitlement.

The AI Use Policy already qualifies this — *"where configured and where enabled
for a workspace"* — and `apps/web/app/why-proovra/page.tsx` already said
*"where enabled"*. Four other surfaces presented the same capabilities with no
qualifier at all.

### Change made

The qualifier already in the product was adopted rather than a fifth phrasing
invented. Capability claims are unchanged; positioning is not weakened.

| File | Was | Now |
|---|---|---|
| `components/marketing/EvidenceOperations.tsx` | "Guide evidence collection, detect missing context, and prepare reviewers." | "…, where enabled." |
| `components/marketing/EvidenceOperations.tsx` | "AI-powered insights and guidance" | "Advisory insights and guidance, where enabled" |
| `app/platform/page.tsx` | "Guide evidence collection, detect missing context, and prepare reviewers." | "…, where enabled." |
| `components/marketing/EvidenceLifecycle.tsx` | "Spot missing context before submission." | "…, where enabled." |
| `app/request-demo/page.tsx` | "Use AI assistance to guide…" | "Where enabled, use AI assistance to guide…" |

No legal or policy document was edited. Status: **CODE-PROVEN**; a repository
sweep confirms no unqualified AI capability copy remains.

## 2. `EVIDENCE_COPILOT` feature identity — CLOSED

### Classification: (A) naming debt, with an attribution consequence

Not (B) wrong key, not (C) missing flag, not (E) dead identifier.

PROOVRA has two "feature" vocabularies on different axes:

- **policy feature** (`WorkspaceAiFeature`) — the switch an administrator turns
  off; a seven-member TypeScript union.
- **operation label** — what ran, persisted to `AiUsageEvent.feature` and
  `AiCopilotRun.feature`. Both are `String` columns, so nothing in the type
  system ever connected them.

Six of seven labels spell the same word as their policy feature. One does not:
the evidence copilot records `EVIDENCE_COPILOT` while its gate evaluates
`EVIDENCE_CATEGORIZATION`.

### It was never a budget bypass

Established by reading the ledger rather than assuming: `resolveLedgerLimits`
reads **workspace-level** daily/monthly operation and cost limits, and the
rollups are keyed `workspaceId_dayUtc` / `workspaceId_monthUtc` — **no feature
dimension anywhere**. The label has never participated in a limit decision. A
workspace cap always applied to the evidence copilot regardless of its name.

The real consequence was narrower and real: **attribution**. An operator reading
the usage ledger saw a feature governed by a switch that does not exist.

### Resolution: one mapping, not one name

`services/api/src/services/ai/ai-operation-registry.ts` maps every operation to
its governing policy switch. `ai-evidence.routes.ts` now derives the gate from
`policyFeatureForOperation(EVIDENCE_COPILOT_OPERATION)`, and the budget reserve
and copilot-run row use that same constant.

Two tempting "tidy-ups" were rejected, deliberately:

- **Renaming the label to `EVIDENCE_CATEGORIZATION`** would destroy real
  information. They are different operations — different route, different
  provider (structured vs advisory), different model variable, different cost —
  and the ledger has to keep telling them apart. It would also require
  migrating persisted historical rows.
- **Adding an eighth policy flag** would change behaviour. A workspace that has
  already disabled evidence AI would silently regain the copilot under a new
  flag. A naming fix must not change what is enabled.

Adding an operation without naming its governing switch is now a type error,
which is the property that was missing.

**Alignment:** gate, budget ledger, copilot-run row and telemetry all resolve
from one constant; the recorded label stays `EVIDENCE_COPILOT`; the enforced
switch stays `EVIDENCE_CATEGORIZATION`; fail-closed behaviour is unchanged and
asserted in both directions.

**Also noted, not changed:** `OPERATIONS_INTELLIGENCE` is a member of the
copilot-run union with **zero producers** anywhere in the source — a dead
identifier. Left in place per "prove zero legitimate consumers before deleting";
the proof is recorded here, the removal is not bundled into a naming fix.

Status: **CODE-PROVEN** (10 tests).

## 3. Live provider validation — NOT EXECUTABLE IN CURRENT ENVIRONMENT

Every environment reachable from this repository was inventoried. Reporting
presence only, never values:

| Env file | `OPENAI_AI_ENABLED` | Key | `NODE_ENV` |
|---|---|---|---|
| `.env` | `true` | present | **production** |
| `services/api/.env` | `true` | present | **production** |
| `.env.audit-local` | `false` | absent | — |
| `infra/docker/.env` | unset | absent | — |
| `apps/web/.env.local` | unset | absent | — |
| fixture (`scripts/local-fixture-env`) | `false` | absent | development |

**The only environments with a usable provider key are production.** There is no
staging or sandbox environment, no non-production credential, and no safe test
workspace. Exercising the provider would mean issuing real, billed OpenAI calls
from a configuration that also points at the production database.

Per the brief, no environment was created and no production setting was
toggled.

### What this does and does not leave unproven

Everything provider-facing in the audit above is proven **at the boundary** —
the payload that would be sent, the call count that would occur, the gate that
runs first. What cannot be observed is the model's behaviour on the far side of
that boundary.

**Still requires a real-provider run:**

1. A prohibited authenticity/admissibility claim attempted against the live
   model, to confirm the engine catches what the model actually produces —
   distinct from what it catches in test strings.
2. A prompt-injection attempt end to end through a real completion.
3. Provider refusal and content-filter handling.
4. Basic product-help quality.

Note that items 1–3 are defence-in-depth confirmations: the scope classifier
refuses these **before** the provider (proven, call count 0), so a live run
tests the second and third layers, not the first.

**Required to execute:** an approved non-production environment with AI enabled,
a non-production provider key, no production customer data, and a disposable
test workspace. None exists today.

## 4. No-training — EXTERNAL-EVIDENCE-REQUIRED

### What the code proves

- `store: false` is sent on every request from both provider paths
  (`openAiRequestStore()` defaults false; `OPENAI_STORE` is unset everywhere).
- **Evidence content never reaches a provider at all** (§E–G above), so the
  claim as worded — *customer evidence content* is not used to train — is
  code-proven for evidence content specifically. What was never sent cannot be
  trained on.
- The code refuses to overclaim on its own behalf:
  `// If not explicitly declared, we do NOT claim no-training in code.`

### What configuration currently proves — nothing

`OPENAI_DATA_USE_MODE` is **unset in every environment, production included**,
so `resolveDataUseMode()` returns `UNKNOWN`.

The platform already detects this. In production with the mode undeclared,
`validateProviderPrivacyConfig()` returns:

```
code:     PRIVACY_MODE_UNKNOWN
severity: warn        (block only if AI_REQUIRE_PROVIDER_PRIVACY=true)
message:  "...the account-level no-training mode is unverified in config."
```

So production runs today with an **unverified account-level no-training
posture**, and the platform is logging that fact as a warning rather than
asserting a guarantee it cannot support. That is the correct behaviour and
should not be "fixed" by defaulting the mode to something.

### Required external evidence and actions

| # | Required | Who |
|---|---|---|
| 1 | Confirm the OpenAI **organization data-control setting** (training disabled / ZDR) for the org and project used in production | Owner / OpenAI console |
| 2 | Once confirmed, set `OPENAI_DATA_USE_MODE=NO_TRAINING` (or `ZDR`) in production so the validator can attest it | Operator |
| 3 | Consider `AI_REQUIRE_PROVIDER_PRIVACY=true` so an undeclared posture **blocks** the live provider instead of warning | Owner decision |
| 4 | Retain the executed **DPA / API terms** covering the metadata that does leave (titles, statuses) | Legal |
| 5 | Confirm `OPENAI_ORG` / `OPENAI_PROJECT` are bound so the posture applies to the right account | Operator |

Nothing here can be established from this repository, and no secret was read or
printed to determine it.

## Closure status

| Item | Status |
|---|---|
| Conditional AI Review wording | **CLOSED** — CODE-PROVEN |
| `EVIDENCE_COPILOT` feature identity | **CLOSED** — CODE-PROVEN |
| Live provider validation | **NOT EXECUTABLE IN CURRENT ENVIRONMENT** |
| No-training posture | **EXTERNAL-EVIDENCE-REQUIRED** (5 actions above) |

## Final verdict

**AI CLOSURE: PASS WITH EXTERNAL EVIDENCE REQUIRED**

Unchanged from the audit above, and unchanged for the same two reasons: the
no-training commitment depends on a provider setting and a contract that are not
in this repository, and no environment exists in which the live model can be
adversarially exercised. Both remaining items are external by nature; neither is
a code defect, and neither can be closed by writing more code.

The two items that *were* closeable in this repository are closed.

---

# Appendix B — AI Settings governance surface

**Date:** 2026-09-04. Closes the four items left open by the Settings pass.

## Organization-level policy locking — NOT IMPLEMENTED

**Classification: PRODUCT GOVERNANCE CAPABILITY — NOT IMPLEMENTED.** Not a
security defect: no public claim asserts it exists, and nothing in the product
implies it.

> **Independent organization-level AI policy locking across child workspaces is
> not currently implemented.**

**What actually exists.** `WorkspaceAiPolicy` is keyed by `teamId`. A workspace
IS a team, of kind `PERSONAL` or `ORGANIZATION`, so an ORGANIZATION workspace's
policy row is that organization's policy for that workspace. There is no parent
record that constrains a child workspace's row, and no evaluation step that
consults one — `decideAiPolicy` reads a single resolved policy and the platform
flags, nothing above them.

**What an Enterprise administrator can control today**, per workspace they
administer: the master AI switch, each capability switch, the data-class
controls (raw content, OCR, transcription, embeddings), the allowed-roles list,
and the daily/monthly operation and cost limits. Enforcement is server-side via
`evaluateWorkspaceAiPolicy`; the UI never gates anything on its own.

**What an Enterprise administrator cannot do today:** set a policy at the
organization level that a workspace administrator may not override, or apply one
policy across several workspaces in one action. Each workspace is configured on
its own.

**Wording used, and why.** The Settings surface says "Managed by your
organization" **only** to a member of an ORGANIZATION-kind workspace who cannot
edit it — which is true: that organization's administrators set it. An
administrator of the same workspace is told "Managed by workspace
administrators", not something above them, because nothing above them exists.
`resolveManagedBy` carries this rule and is tested in both directions. No
organization toggle was created, and no frontend simulation of a lock.

**Would require future architecture work:** an organization-scoped policy
record, an inheritance/override precedence step in the evaluator, a resolution
order for conflicts, and an admin surface for the org scope. None of that is in
this task.

## VIEWER transparency — CLOSED, least privilege

A VIEWER could not open Settings → AI: the privileged envelope requires
`intelligence.read`, which VIEWER does not hold.

**Granting it was refused.** `intelligence.read` gates twenty-six endpoints
including `/v1/executive/metrics`, `/v1/intelligence/budgets/spend`,
`/v1/intelligence/providers/health` and `/v1/intelligence/quality/reviewers`.
Making an AI status visible must not hand a read-only member executive
analytics, provider budgets and reviewer quality scores.

**Lowering the existing endpoint was also refused.** That envelope returns the
whole policy row, the capability disclosure with its internal statuses
(`DISABLED_BY_PLATFORM_CONFIGURATION`, `NOT_CONFIGURED`) and the identity of the
last modifier.

**What was done instead:** `GET /v1/workspaces/ai-assistance-status`, behind
`governance.policy.read` — a permission all five membership roles already hold,
and which means precisely "read the policies that govern you". No role gained
anything. The response carries a bounded status, two booleans, `editable`, three
product-named feature rows and a fixed processing summary; no decision code,
policy version, modifier identity, cost figure, provider or model.

Verified against the fixture as a VIEWER: safe read **200**; and **403** on the
policy write, the privileged envelope, AI usage, intelligence budgets, executive
metrics, provider health and NL search.

## Mobile overflow — CLOSED, and it was not where it looked

The card was a victim, not the cause. Measured min-content contributions of the
organization view's children: the **live capability status table** was **808px**,
every other child 107–189px. An implicit `auto` grid track sizes to the largest
min-content, so one wide table stretched the single track to 807px inside a
298px container and every sibling card rendered at 808px and clipped — with
`documentElement.scrollWidth` still equal to the viewport, which is why it read
as missing text rather than overflow.

Fixed at the cause: `minmax(0, 1fr)` on the track so no item can size it, and
`overflow-x: auto` on the table's own wrapper so it scrolls itself.

| Viewport | Content column | Status card | Doc scrollWidth | Elements wider than viewport, outside the table's scroller |
|---|---|---|---|---|
| 390 | 298 | **298** (was 808) | 390 | **0** |
| 375 | 283 | **283** | 375 | **0** |
| 320 | 228 | **228** | 320 | **0** |

Confirmed by screenshot at 375px: every line wraps inside the column.
