import type { AiProvider } from "./ai-provider.js";
import { AiResult, AiTask } from "./ai-types.js";
import { AiCostGuard } from "./ai-cost-guard.js";
import { AI_LEGAL_DISCLAIMER } from "./ai-policy.js";

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

    const result = await this.provider.run(AiTask.SUPPORT_CHAT, payload);
    if (result.status === "ok") {
      this.costGuard.recordChatMessage(userId);
    }

    return result;
  }
}
