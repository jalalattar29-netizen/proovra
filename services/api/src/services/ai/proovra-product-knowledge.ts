import { AiResult } from "./ai-types.js";
import { AI_LEGAL_DISCLAIMER } from "./ai-policy.js";

export const PROOVRA_PRODUCT_KNOWLEDGE = {
  plans: {
    personal: {
      name: "Personal",
      summary:
        "For individuals who need to preserve, organize, and verify digital evidence records.",
    },
    pro: {
      name: "Pro",
      summary:
        "For advanced evidence workflows with reports, verification packages, and stronger review preparation.",
      pricing:
        "PRO plan pricing is shown on the official PROOVRA Billing/Pricing page. Prices may vary by currency, billing cycle, and enabled add-ons.",
    },
    team: {
      name: "Team",
      summary:
        "For organizations that need shared evidence workflows, team access, roles, review, and billing management.",
    },
    enterprise: {
      name: "Enterprise",
      summary:
        "For organizations that need custom onboarding, compliance workflows, support, and enterprise requirements.",
      pricing:
        "Enterprise pricing is custom and should be discussed with PROOVRA support.",
    },
  },
};

function isPricingQuestion(text: string): boolean {
  return /\b(price|pricing|cost|premium|primum|pro plan|subscription|billing|how much|اشتراك|سعر|تكلفة|بريميوم|برو)\b/i.test(
    text
  );
}

export function answerProductKnowledge(messages: { role: string; content: string }[]): AiResult | null {
  const lastUserMessage = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";

  if (!isPricingQuestion(lastUserMessage)) return null;

  return {
    status: "ok",
    summary:
      "PROOVRA plan prices are shown on the official Billing/Pricing page because pricing can vary by currency, billing cycle, and add-ons. The PRO plan is intended for advanced evidence workflows such as reports, verification packages, and reviewer-ready evidence preparation.",
    warnings: [],
    suggestions: [
      "Open Billing/Pricing in PROOVRA to see the current price for your account and currency.",
      "For Enterprise or custom needs, contact PROOVRA support.",
    ],
    flags: [],
    legalDisclaimer: AI_LEGAL_DISCLAIMER,
  };
}