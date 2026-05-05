import { AiProvider, AiResult, AiTask } from "./ai-types.js";
import { AI_LEGAL_DISCLAIMER } from "./ai-policy.js";

export class NoopAiProvider implements AiProvider {
  async run(_task: AiTask, _input: unknown): Promise<AiResult> {
    void _task;
    void _input;

    return {
      status: "disabled",
      summary:
        "AI assistance is currently disabled. Configure OPENAI_AI_ENABLED=true and provide OPENAI_API_KEY to enable this feature.",
      warnings: [],
      suggestions: [
        "Enable AI in the PROOVRA backend configuration to receive advisory guidance.",
      ],
      flags: [],
      legalDisclaimer: AI_LEGAL_DISCLAIMER,
    };
  }
}
