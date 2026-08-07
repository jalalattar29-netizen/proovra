/**
 * PHASE 12 CORRECTIVE PASS §4 — THE LOCAL RECORDING SECRETS PROVIDER.
 *
 * Nine bootstrap outcomes have to be proven for SEC-004, and five of them are
 * FAILURES: access denied, a malformed payload, a transient error that then
 * succeeds, and the two `required` variants. None of those can be produced
 * against a real AWS account without either provisioning failure states in
 * someone's IAM or, worse, calling out from a run that is supposed to reach
 * nothing.
 *
 * So the harness scripts the provider instead. This is not a mock of the
 * DECISION — the loader's mode handling, fail-closed path, suspension rule,
 * backoff and readiness projection all run exactly as they do in production.
 * What is substituted is only the transport, at the seam the production code
 * already has.
 *
 * It records every call, so "the loader stopped asking after access_denied" is
 * an assertion about observed calls rather than about elapsed time.
 */

import type { SecretsFetchResult, SecretsProvider } from "./secrets-authority.js";

export type ScriptedSecretsOutcome =
  | { kind: "secret"; payload: Record<string, string> }
  /** A payload that is not a JSON object of strings — drives the decode path. */
  | { kind: "raw"; secretString: string | null }
  /** An error whose `name` the loader's classifier maps to a bounded code. */
  | { kind: "error"; name: string };

export type RecordedSecretsCall = {
  secretName: string;
  region: string;
  outcome: ScriptedSecretsOutcome["kind"];
};

const CALLS: RecordedSecretsCall[] = [];
let script: ScriptedSecretsOutcome[] = [];

/**
 * Queue outcomes, consumed one per call. The LAST entry repeats once the queue
 * is drained, so "transient failure then success, and it stays successful" is
 * expressible without scripting an unbounded tail.
 */
export function scriptSecretsProvider(outcomes: ScriptedSecretsOutcome[]): void {
  script = [...outcomes];
}

export function recordedSecretsCalls(): ReadonlyArray<RecordedSecretsCall> {
  return CALLS.slice();
}

export function resetRecordingSecretsProvider(): void {
  CALLS.length = 0;
  script = [];
}

export const recordingSecretsProvider: SecretsProvider = async ({
  secretName,
  region,
}): Promise<SecretsFetchResult> => {
  const next =
    script.length > 1 ? script.shift()! : (script[0] ?? { kind: "raw" as const, secretString: null });
  CALLS.push({ secretName, region, outcome: next.kind });
  if (next.kind === "error") {
    const err = new Error("scripted secrets provider failure");
    err.name = next.name;
    throw err;
  }
  if (next.kind === "raw") return { secretString: next.secretString };
  return { secretString: JSON.stringify(next.payload) };
};
