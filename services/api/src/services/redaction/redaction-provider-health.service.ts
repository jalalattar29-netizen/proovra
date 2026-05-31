/**
 * PROOVRA Phase 3A Closure — Redaction provider health snapshot.
 *
 * Bounded read-only probe across every cloud provider the platform
 * delegates to. Each probe is a CREDENTIALS-only check (no actual
 * cloud call) so the health endpoint stays cheap + safe to poll.
 *
 * Hard rules:
 *   * NEVER logs raw credentials. The bounded `reason` string is
 *     operator-readable but never reveals the secret value.
 *   * Returns a bounded `RedactionProviderProbe[]` shape — same
 *     vocabulary as the per-run provider probe so the UI renders
 *     them identically.
 *   * Surfaces the workspace's policy state alongside the probe so
 *     a NOT_CONFIGURED + DISABLED_BY_POLICY combination is
 *     unambiguous.
 */

import {
  REDACTION_DETECTION_PROVIDERS,
  type RedactionDetectionProvider,
  type RedactionProviderProbe,
} from "@proovra/shared";

import { probeAzureDocumentIntelligence } from "./providers/azure-document-intelligence-client.js";
import { probeDeepgram } from "./providers/deepgram-client.js";
import { probeRekognition } from "./providers/rekognition-client.js";
import { getRedactionDetectionPolicy } from "./redaction-policy.service.js";

export type RedactionProviderHealthRow = RedactionProviderProbe & {
  /** Bounded — true when the workspace policy currently allows the provider. */
  policyAllowed: boolean;
};

export async function buildRedactionProviderHealth(input: {
  teamId: string;
}): Promise<RedactionProviderHealthRow[]> {
  const policy = await getRedactionDetectionPolicy({ teamId: input.teamId });
  const rows: RedactionProviderHealthRow[] = [];
  for (const provider of REDACTION_DETECTION_PROVIDERS) {
    const probe = probeFor(provider);
    rows.push({
      provider,
      state: probe.state,
      reason: probe.reason,
      policyAllowed: policy.providers[provider] !== false,
    });
  }
  return rows;
}

function probeFor(provider: RedactionDetectionProvider): RedactionProviderProbe {
  switch (provider) {
    case "AWS_REKOGNITION_FACES":
    case "AWS_REKOGNITION_TEXT": {
      const p = probeRekognition();
      return { provider, state: p.state, reason: p.reason };
    }
    case "AZURE_DOCUMENT_INTELLIGENCE": {
      const p = probeAzureDocumentIntelligence();
      return { provider, state: p.state, reason: p.reason };
    }
    case "DEEPGRAM_TRANSCRIPT": {
      const p = probeDeepgram();
      return { provider, state: p.state, reason: p.reason };
    }
    case "MANUAL":
    case "REGEX_PII":
      return { provider, state: "READY", reason: null };
    case "POLICY_RULE":
      return {
        provider,
        state: "DISABLED_BY_POLICY",
        reason: "policy_rule_provider_ships_in_phase_3b",
      };
    case "OCR_TEXT_LAYER":
      return {
        provider,
        state: "NOT_CONFIGURED",
        reason: "local OCR capability is INDEX_EXISTING_ONLY",
      };
    case "CUSTOM_PROVIDER":
      return {
        provider,
        state: "DISABLED_BY_POLICY",
        reason: "custom_provider_requires_administrator_binding",
      };
  }
}
