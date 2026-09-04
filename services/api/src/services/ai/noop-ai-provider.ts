import { AiProvider, AiResult, AiTask } from "./ai-types.js";
import { AI_LEGAL_DISCLAIMER } from "./ai-policy.js";

/**
 * THE ADAPTER USED WHEN THERE IS NO PROVIDER.
 *
 * =============================================================================
 * WHAT WENT WRONG
 * =============================================================================
 * This class used to answer every request with:
 *
 *     "AI assistance is currently disabled. Configure OPENAI_AI_ENABLED=true
 *      and provide OPENAI_API_KEY to enable this feature."
 *
 * and suggested "Enable AI in the PROOVRA backend configuration".
 *
 * `summary` and `suggestions` are USER-FACING fields. They are rendered in the
 * assistant panel and forwarded verbatim by the evidence categorisation route,
 * so a customer asking how to capture evidence could be told the names of the
 * deployment's environment variables and instructed to reconfigure a backend
 * they have no access to. Naming `OPENAI_API_KEY` to an end user discloses
 * which provider the platform uses, that the key is absent, and precisely which
 * variable an attacker would want to influence — none of which is theirs to
 * know, and none of which helps them.
 *
 * It was also, plainly, useless advice: the one person who cannot act on
 * "configure OPENAI_AI_ENABLED" is the person reading it.
 *
 * =============================================================================
 * WHERE IT WAS REACHABLE
 * =============================================================================
 * Not only in an unconfigured deployment. `createAiProvider` also falls back to
 * this adapter when the provider PRIVACY posture is refused
 * (`AI_REQUIRE_PROVIDER_PRIVACY=true` with an unsafe or unknown region/data-use
 * configuration). In that state `OPENAI_AI_ENABLED` is `"true"` and a key IS
 * present, so `isPlatformAiGloballyEnabled()` returns true, the workspace
 * policy gate PASSES, and the route calls this provider — in production, with
 * AI switched fully on.
 *
 * =============================================================================
 * WHY THE DETAIL IS NOT SIMPLY DELETED
 * =============================================================================
 * An operator still has to be able to tell "no key configured" from "privacy
 * posture refused" — they are different problems with different fixes. So the
 * detail moves rather than disappearing: a structured log line at construction,
 * carrying a bounded reason code and no secret values. The user gets a neutral
 * sentence; the operator gets the diagnosis; neither gets the other's.
 *
 * It is logged ONCE, at construction, because the factory builds one adapter
 * per process. Logging per request would turn a configuration mistake into a
 * flood proportional to traffic.
 *
 * =============================================================================
 * WHY IT STILL RETURNS A RESULT RATHER THAN THROWING
 * =============================================================================
 * `status: "disabled"` is already the typed unavailable outcome in `AiResult`,
 * and it is not a success: callers branch on it, the assistant panel maps it to
 * a `CONFIGURATION_ERROR` state, and `recordWorkspaceAiOperation` only counts
 * `status === "ok"`, so nothing here records a fake inference, a misleading
 * audit entry, or a false provider-health signal. Throwing instead would turn a
 * known, expected configuration state into an exception path shared with real
 * provider faults — losing exactly the distinction this class exists to carry.
 */

/** Why no live provider was constructed. Bounded, and never a secret value. */
export type NoopAiProviderReason =
  | "PROVIDER_NOT_CONFIGURED"
  | "PROVIDER_PRIVACY_REFUSED";

/*
 * The single user-facing sentence.
 *
 * It says the true thing (AI is not answering), the useful thing (nothing else
 * is affected), and nothing else. No provider name, no variable name, no
 * instruction the reader cannot act on.
 */
const USER_SAFE_SUMMARY =
  "AI assistance is temporarily unavailable. You can continue using PROOVRA normally — capture, reports, verification and packages are unaffected.";

export class NoopAiProvider implements AiProvider {
  private readonly reason: NoopAiProviderReason;

  constructor(reason: NoopAiProviderReason = "PROVIDER_NOT_CONFIGURED") {
    this.reason = reason;

    // Operator diagnosis, server-side only. A bounded code — never the value
    // of any variable, and never the key itself.
    // eslint-disable-next-line no-console
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "ai.provider.unavailable",
        reason,
        detail:
          reason === "PROVIDER_PRIVACY_REFUSED"
            ? "Provider privacy posture refused; see ai.provider_privacy.refused for the code."
            : "OPENAI_AI_ENABLED is not 'true' or no API key is available to this process.",
      }),
    );
  }

  /** The bounded reason, for health and runtime-status surfaces. */
  getReason(): NoopAiProviderReason {
    return this.reason;
  }

  async run(_task: AiTask, _input: unknown): Promise<AiResult> {
    void _task;
    void _input;

    return {
      status: "disabled",
      summary: USER_SAFE_SUMMARY,
      warnings: [],
      // Deliberately empty. The previous suggestion told the reader to
      // reconfigure the backend, which is neither their job nor their access.
      suggestions: [],
      flags: [],
      legalDisclaimer: AI_LEGAL_DISCLAIMER,
    };
  }
}
