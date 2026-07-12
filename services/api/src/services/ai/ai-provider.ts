import type { AiProvider } from "./ai-types.js";
import { NoopAiProvider } from "./noop-ai-provider.js";
import { OpenAiProvider } from "./openai-provider.js";
// Phase P2.0 — OPENAI_API_KEY is in the migrated set. Prefer AWS
// Secrets Manager; fall back to env when AWS is disabled / missing.
import { getSecret } from "../../config/runtime-secrets.js";
import { validateProviderPrivacyConfig } from "./provider-privacy.service.js";

export type { AiProvider } from "./ai-types.js";

export type AiProviderConfig = {
  enabled: boolean;
  apiKey?: string;
  chatModel: string;
  captureModel: string;
  evidenceCategorizationModel: string;
};

export function createAiProvider(): AiProvider {
  const apiKey = getSecret("OPENAI_API_KEY")?.trim();
  const enabled = process.env.OPENAI_AI_ENABLED === "true" && Boolean(apiKey);

  const chatModel =
    process.env.OPENAI_CHAT_MODEL?.trim() ||
    process.env.OPENAI_MODEL?.trim() ||
    "gpt-4.1-mini";

  const captureModel =
    process.env.OPENAI_CAPTURE_MODEL?.trim() ||
    process.env.OPENAI_MODEL?.trim() ||
    "gpt-4.1-mini";

  const evidenceCategorizationModel =
    process.env.OPENAI_EVIDENCE_CATEGORIZATION_MODEL?.trim() ||
    process.env.OPENAI_MODEL?.trim() ||
    "gpt-4.1-mini";

  if (!enabled) {
    return new NoopAiProvider();
  }

  // Phase A3 — validate provider privacy posture before returning a live
  // provider. In strict mode (AI_REQUIRE_PROVIDER_PRIVACY=true) an unsafe/unknown
  // configuration refuses to construct the live provider (falls back to Noop);
  // otherwise it logs a bounded warning. store:false is always applied.
  const privacy = validateProviderPrivacyConfig();
  if (!privacy.ok) {
    if (privacy.severity === "block") {
      // eslint-disable-next-line no-console
      console.warn(
        JSON.stringify({
          level: "warn",
          event: "ai.provider_privacy.refused",
          code: privacy.code,
        }),
      );
      return new NoopAiProvider();
    }
    // eslint-disable-next-line no-console
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "ai.provider_privacy.warning",
        code: privacy.code,
      }),
    );
  }

  return new OpenAiProvider({
    apiKey: apiKey!,
    chatModel,
    captureModel,
    evidenceCategorizationModel,
  });
}
