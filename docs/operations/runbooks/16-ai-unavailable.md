# Runbook 16 — AI unavailable

**Scope:** customer reports the AI assistant is unresponsive, returning empty answers, or surfacing a degraded-feature notice. Confirm the AI failure is bounded, communicate the fallback path, and identify whether the platform's deterministic non-AI workflow is sufficient.

**Prerequisites:**

- Read access to the `OPENAI_AI_ENABLED` feature flag state + `OPENAI_API_KEY` presence (do NOT read the value itself).
- Read access to the operational analytics + readiness rollup.

**Forbidden:**

- Mutating evidence / custody / governance to "fix" what the AI was supposed to suggest.
- Re-running an AI call with elevated privileges to bypass the cost guard.
- Pasting OPENAI keys, AI response logs, or chat content into the support ticket.

---

## Steps

1. **Confirm the surface.** Two AI surfaces exist:
   - `CaptureAiAssistant` (modal in capture flow) — calls `POST /v1/ai/capture/analyze-session`.
   - `ProovraChatWidget` (corner chat bubble) — calls `POST /v1/ai/chat`.

2. **Map AI result status to root cause.** Per the Phase E9 `AiResult` discriminated union:
   - `status: "ok"` — AI succeeded. Customer is reporting a UX issue rather than an outage. Re-investigate the symptom.
   - `status: "blocked"` — output triggered the 37-pattern forbidden-phrase filter; the AI tried to say something the policy rejected. By design — no fix required. Educate the customer that the AI response was filtered for safety.
   - `status: "disabled"` — feature flag off or OpenAI key absent. Confirm `OPENAI_AI_ENABLED` state; if intentionally off, communicate to the customer that AI is currently disabled. **The platform's deterministic non-AI workflow continues to operate.**
   - `status: "error"` — provider error or schema-validation failure. Check worker logs for the underlying message; common shapes are network timeout, rate-limit, malformed JSON.

3. **Confirm the deterministic fallback ran.** For capture: deterministic metadata validation (file-type / size / required-step coverage / staleness) runs INDEPENDENT of AI. The capture assistant should still show deterministic flags + suggestions even when AI is `disabled` / `blocked` / `error`. If the deterministic layer is also empty, investigate runbook 12 (failed upload).

4. **Cost-guard exhaustion?** Per-user / per-evidence / monthly EUR budget. If exceeded, the customer sees `blocked` status with a cost-related message. The cost-guard limits are operator-configurable env vars; raise the limit OR wait for the next day's window.

5. **OpenAI outage?** Check `https://status.openai.com`. If outage is confirmed: communicate the bounded impact to the customer (deterministic workflow continues; AI suggestions unavailable). Do NOT page on-call — the platform's failure-tolerance contract is satisfied.

6. **Schema validation failure?** The provider returned a JSON shape that did NOT match `AiResultSchema`. The policy layer surfaces `status: "error"`. This is an integration regression and may indicate a model upgrade; flag to engineering. **DEF-035 (POST_LAUNCH)** known gap — schema-validation failure currently emits no `SecurityEvent`, only `console.error`.

7. **Document.** Update the support ticket with: which AI surface, the AI result status, the deterministic-fallback verification outcome, the customer notification.

---

## Hard rules

- AI failure NEVER blocks the canonical evidence workflow. Capture / upload / finalize / report / package all run without AI by design.
- AI failure NEVER causes a custody event or evidence-record mutation. The AI tree has zero mutation primitives (Phase E9 Test 6 pins this).
- AI failure NEVER causes a permission elevation. The capability registry has zero AI input (Phase E9 Test 12 pins this).
- AI failure NEVER auto-disables related features. Operator action is required to disable AI.

---

## DEF-aware caveats

- **DEF-033 (POST_LAUNCH):** chat message content has no input-side prompt-injection sanitisation. If the customer reports unexpected AI output, check whether the input contained injection-style content; even so, the output-side policy filter should have caught any forbidden response.
- **DEF-034 (POST_LAUNCH):** no explicit OpenAI call timeout override. AI calls may hang up to the SDK default (~600 s) before failing. If the customer reports "AI never returns", check whether the symptom is hang vs error; if hang, the call will eventually time out and surface `status: "error"`.
- **DEF-035 (POST_LAUNCH):** AI provider error emits no SecurityEvent. Failure-rate monitoring is via worker logs + manual operator inspection.
- **DEF-036 (POST_LAUNCH):** AI frontend surfaces have no per-team capability gate. A workspace cannot disable AI for itself without `OPENAI_AI_ENABLED=false` at the process level.

---

## Honest gaps

- No retry on the AI call from the surface side. A transient OpenAI outage surfaces as `status: "error"` on the first attempt; the user re-tries by re-opening the surface.
- AI failures do not surface in `/ops/analytics` as a real metric (DEF-035). A future bounded phase adds AI failure counters to the analytics envelope.
