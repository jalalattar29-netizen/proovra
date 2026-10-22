/**
 * The isolation facts a test-stack process reports about ITSELF — identical in
 * shape for the API (on /health) and the worker (in its telemetry heartbeat),
 * so the E2E preflight judges every process by one rule
 * (e2e/helpers/stack-isolation.ts). Variable NAMES only — never a value.
 *
 * A separate module from test-stack-isolation.ts because it reads the email
 * transport, which itself imports test-stack-isolation.ts.
 */
import { resolveEmailTransportProvider } from "../notifications/email-transport.js";
import { declaredSecretsMode } from "./secrets-authority.js";
import { presentLiveCredentialNames, resolveTestStackIsolation } from "./test-stack-isolation.js";

export type IsolationFacts = {
  isolated: boolean;
  markers: string[];
  emailTransport: "resend" | "recording";
  secretsMode: "disabled" | "optional" | "required";
  envFilesLoaded: number;
  liveCredentialNames: string[];
};

/** `null` for a process that is not an isolated test stack: it reports nothing new. */
export function buildIsolationFacts(input: {
  env?: Record<string, string | undefined>;
  envFilesLoaded: number;
}): IsolationFacts | null {
  const env = input.env ?? process.env;
  const isolation = resolveTestStackIsolation(env);
  if (!isolation.isolated) return null;
  return {
    isolated: true,
    markers: isolation.reasons,
    emailTransport: resolveEmailTransportProvider(),
    secretsMode: declaredSecretsMode(),
    envFilesLoaded: input.envFilesLoaded,
    liveCredentialNames: presentLiveCredentialNames(env),
  };
}
