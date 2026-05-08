import type { AiProvider } from "./ai-types.js";
import { NoopAiProvider } from "./noop-ai-provider.js";
import { OpenAiProvider } from "./openai-provider.js";

export type { AiProvider } from "./ai-types.js";

export type AiProviderConfig = {
  enabled: boolean;
  apiKey?: string;
  chatModel: string;
  captureModel: string;
  evidenceCategorizationModel: string;
};

export function createAiProvider(): AiProvider {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
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

  return new OpenAiProvider({
    apiKey: apiKey!,
    chatModel,
    captureModel,
    evidenceCategorizationModel,
  });
}
