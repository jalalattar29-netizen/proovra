/**
 * Legacy AI service disabled.
 *
 * Do not use this service for PROOVRA AI.
 * The previous implementation sent signed evidence URLs/images to an AI provider,
 * which violates the current metadata-only, privacy-first AI policy.
 *
 * Use services/api/src/services/ai/* instead:
 * - ai-chat.service.ts
 * - ai-capture.service.ts
 * - ai-provider.ts
 */

export class AIService {
  async analyzeEvidence(): Promise<never> {
    throw new Error(
      "Legacy AI evidence analysis is disabled. Use metadata-only PROOVRA AI services."
    );
  }

  async classify(): Promise<never> {
    throw new Error("Legacy AI classification is disabled.");
  }

  async extractMetadata(): Promise<never> {
    throw new Error("Legacy AI metadata extraction is disabled.");
  }

  async generateDescription(): Promise<never> {
    throw new Error("Legacy AI description generation is disabled.");
  }

  async checkModeration(): Promise<never> {
    throw new Error("Legacy AI moderation is disabled.");
  }

  async suggestTags(): Promise<never> {
    throw new Error("Legacy AI tag suggestion is disabled.");
  }

  getUsageStats() {
    return {
      total_calls: 0,
      total_cost_usd: 0,
      calls_by_type: {},
      average_cost_per_call: 0,
    };
  }

  resetUsageStats(): void {
    // Legacy service disabled.
  }
}

export const aiService = new AIService();