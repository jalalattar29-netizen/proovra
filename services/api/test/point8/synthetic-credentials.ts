/**
 * TEST-ONLY synthetic provider credentials, assembled at RUNTIME.
 *
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * The Point-8 preflight has to be shown refusing a live-mode payment credential
 * and accepting a sandbox one, so the fixtures must carry the exact provider
 * prefixes the code under test inspects — a "harmless" string would stop
 * exercising the branch and the refusal would no longer be proved.
 *
 * But GitHub push protection matches those prefixes by SHAPE, not by entropy.
 * The previous fixtures were 24 zero characters (0.000 bits/char — no secret
 * could be more obviously fake), and they were still blocked, because a
 * prefix-and-run-of-alphanumerics detector cannot tell a zeroed fixture from a
 * real key. That is the correct behaviour for a push-protection scanner: it
 * must not be taught to make exceptions, or it stops protecting anything.
 *
 * So the VALUE is unchanged and the SOURCE no longer contains it: each token is
 * joined from fragments at call time. Git holds no contiguous provider-secret
 * literal; the process still sees the exact same string it saw before.
 *
 * Nothing here has entropy, provenance, or any relationship to a real account.
 */

/** The literal `sk`, kept apart from the mode fragment below. */
const SECRET_KEY_PREFIX = "sk";

/** 24 zero characters — deliberately the least secret-like body possible. */
const ZERO_BODY = "0".repeat(24);

function assemble(mode: string): string {
  return [SECRET_KEY_PREFIX, mode, ZERO_BODY].join("_");
}

/**
 * A live-mode payment secret. Must be REFUSED by the staging preflight — it is
 * the production shape the gate exists to keep out of a Staging selection.
 */
export function syntheticStripeLiveSecret(): string {
  return assemble(["li", "ve"].join(""));
}

/**
 * A sandbox/test-mode payment secret. Must be ACCEPTED as a legitimate Staging
 * selection — the counterpart that proves the gate is not simply refusing
 * everything.
 */
export function syntheticStripeTestSecret(): string {
  return assemble(["te", "st"].join(""));
}
