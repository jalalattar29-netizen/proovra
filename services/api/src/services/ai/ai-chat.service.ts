import type { AiProvider } from "./ai-provider.js";
import { AiResult, AiTask } from "./ai-types.js";
import { AiCostGuard } from "./ai-cost-guard.js";
import { AI_LEGAL_DISCLAIMER } from "./ai-policy.js";
import { answerProductKnowledge } from "./proovra-product-knowledge.js";
import { classifyChatScope } from "./chat-scope-classifier.service.js";
import { sanitizeUntrustedField } from "./prompt-context-sanitizer.service.js";
// Phase O1.5E — bounded ai.chat + ai.support.response spans.
import {
  PROOVRA_SPAN_NAMES,
  withProovraSpan,
} from "../../observability/otel.js";

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

/**
 * Phase C #3 — sanitize the page-context path before forwarding to the
 * provider. Paths can include UUIDs (evidence ids), slugs derived from case
 * names, or invite tokens. We strip any UUID-shaped or token-shaped segment
 * and any segment longer than ~24 chars and replace it with a generic
 * placeholder. The route shape is what's analytically useful, not the
 * specific identifiers.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_TOKEN_RE = /^[0-9a-f]{16,}$/i;

export function sanitizePageContextPath(
  path: string | undefined | null
): string | null {
  if (typeof path !== "string") return null;
  const trimmed = path.trim();
  if (!trimmed) return null;
  if (trimmed.length > 256) return null;
  return trimmed
    .split("/")
    .map((segment) => {
      if (!segment) return segment;
      if (UUID_RE.test(segment)) return ":id";
      if (HEX_TOKEN_RE.test(segment)) return ":token";
      if (segment.length > 24) return ":dynamic";
      // Strip query strings entirely; they may carry sensitive params.
      if (segment.includes("?")) return segment.split("?")[0] ?? "";
      return segment;
    })
    .join("/");
}

function sanitizeChatPayload(payload: SupportChatPayload): SupportChatPayload {
  // Phase E2 — user messages are untrusted free text: strip secrets, signed
  // URLs, precise GPS, and control/bidi chars before the provider (bounded).
  const messages = payload.messages.map((m) => ({
    ...m,
    content: sanitizeUntrustedField(m.content, 5000),
  }));
  if (!payload.pageContext) return { ...payload, messages };
  return {
    ...payload,
    messages,
    pageContext: {
      // Title is short and reviewer-safe; path is the risk surface.
      title: payload.pageContext.title,
      path: sanitizePageContextPath(payload.pageContext.path) ?? undefined,
    },
  };
}

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

// Phase O1.5E — bounded ai.chat + ai.support.response spans. NEVER
// the prompts, messages, or responses in attributes.
await withProovraSpan(PROOVRA_SPAN_NAMES.AI_CHAT, { "proovra.operation": "ai_chat", "proovra.provider": "openai" }, () => undefined);
await withProovraSpan(PROOVRA_SPAN_NAMES.AI_SUPPORT_RESPONSE, { "proovra.operation": "ai_support_response", "proovra.provider": "openai" }, () => undefined);

const productAnswer = answerProductKnowledge(payload.messages);

if (productAnswer) {
  this.costGuard.recordChatMessage(userId);
  return productAnswer;
}

// Phase C2 — deterministic scope gate BEFORE any provider call. Off-domain
// legal/general requests, forensic-truth determinations, and unsafe/jailbreak
// attempts are refused without spending provider budget.
const lastUserMessage =
  [...payload.messages].reverse().find((m) => m.role === "user")?.content ?? "";
const scope = classifyChatScope(lastUserMessage);
if (scope.refuse) {
  this.costGuard.recordChatMessage(userId);
  return {
    status: "ok",
    summary: scope.refusalMessage ?? "That request is outside PROOVRA's scope.",
    warnings: [],
    suggestions: [],
    flags: [],
    legalDisclaimer: AI_LEGAL_DISCLAIMER,
  };
}

const result = await this.provider.run(
  AiTask.SUPPORT_CHAT,
  sanitizeChatPayload(payload)
);

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
