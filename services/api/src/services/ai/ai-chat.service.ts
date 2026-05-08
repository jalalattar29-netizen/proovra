import type { AiProvider } from "./ai-provider.js";
import { AiResult, AiTask } from "./ai-types.js";
import { AiCostGuard } from "./ai-cost-guard.js";
import { AI_LEGAL_DISCLAIMER } from "./ai-policy.js";
import { answerProductKnowledge } from "./proovra-product-knowledge.js";

export type SupportChatMessage = {
  role: "user" | "assistant";
  content: string;
};

export type SupportChatPayload = {
  messages: SupportChatMessage[];
  pageContext?: {
    path?: string;
    title?: string;
  };
};

export class AiChatService {
  constructor(
    private provider: AiProvider,
    private costGuard: AiCostGuard
  ) {}

  async analyzeChat(
    userId: string,
    payload: SupportChatPayload
  ): Promise<AiResult> {
    const guard = this.costGuard.canSendChatMessage(userId);
    if (!guard.allowed) {
      return {
        status: "blocked",
        summary:
          "AI chat support is temporarily blocked due to usage or budget limits.",
        warnings: [guard.reason ?? "Chat usage limit reached."],
        suggestions: [
          "Wait until the next day or contact PROOVRA support for assistance.",
        ],
        flags: [],
        legalDisclaimer: AI_LEGAL_DISCLAIMER,
      };
    }

const productAnswer = answerProductKnowledge(payload.messages);

if (productAnswer) {
  this.costGuard.recordChatMessage(userId);
  return productAnswer;
}
    
const result = await this.provider.run(AiTask.SUPPORT_CHAT, payload);

const cleanedResult: AiResult = {
  ...result,
  warnings:
    result.status === "ok"
      ? result.warnings.slice(0, 1)
      : result.warnings,
  suggestions:
    result.status === "ok"
      ? result.suggestions.slice(0, 2)
      : result.suggestions,
  flags:
    result.status === "ok"
      ? []
      : result.flags,
};

if (cleanedResult.status === "ok") {
  this.costGuard.recordChatMessage(userId);
}

return cleanedResult;
}
}
