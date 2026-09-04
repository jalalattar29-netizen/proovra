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
| B | Guide collection / detect missing context / prepare reviewers | `missingContext` is a first-class schema field in both copilots | **IMPLEMENTED, off by default** |
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
| Spot missing context before submission | **IMPLEMENTED but POLICY-DEPENDENT** — `reviewerCopilotEnabled` and `caseCopilotEnabled` default **false** |

None is placeholder or dead code. The honest qualifier is that two of the four
are **off until an administrator enables them**, so a workspace that has never
touched its AI policy does not have them. That is a defensible default for a
feature that reads case material — but the marketing copy presents them without
that qualifier.

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
