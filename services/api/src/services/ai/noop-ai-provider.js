import { AI_LEGAL_DISCLAIMER } from "./ai-policy.js";
export class NoopAiProvider {
    async run(_task, _input) {
        void _task;
        void _input;
        return {
            status: "disabled",
            summary: "AI assistance is currently disabled. Configure OPENAI_AI_ENABLED=true and provide OPENAI_API_KEY to enable this feature.",
            warnings: [],
            suggestions: [
                "Enable AI in the PROOVRA backend configuration to receive advisory guidance.",
            ],
            flags: [],
            legalDisclaimer: AI_LEGAL_DISCLAIMER,
        };
    }
}
