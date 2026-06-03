import { NoopAiProvider } from "./noop-ai-provider.js";
import { OpenAiProvider } from "./openai-provider.js";
// Phase P2.0 — OPENAI_API_KEY is in the migrated set. Prefer AWS
// Secrets Manager; fall back to env when AWS is disabled / missing.
import { getSecret } from "../../config/runtime-secrets.js";
export function createAiProvider() {
    const apiKey = getSecret("OPENAI_API_KEY")?.trim();
    const enabled = process.env.OPENAI_AI_ENABLED === "true" && Boolean(apiKey);
    const chatModel = process.env.OPENAI_CHAT_MODEL?.trim() ||
        process.env.OPENAI_MODEL?.trim() ||
        "gpt-4.1-mini";
    const captureModel = process.env.OPENAI_CAPTURE_MODEL?.trim() ||
        process.env.OPENAI_MODEL?.trim() ||
        "gpt-4.1-mini";
    const evidenceCategorizationModel = process.env.OPENAI_EVIDENCE_CATEGORIZATION_MODEL?.trim() ||
        process.env.OPENAI_MODEL?.trim() ||
        "gpt-4.1-mini";
    if (!enabled) {
        return new NoopAiProvider();
    }
    return new OpenAiProvider({
        apiKey: apiKey,
        chatModel,
        captureModel,
        evidenceCategorizationModel,
    });
}
