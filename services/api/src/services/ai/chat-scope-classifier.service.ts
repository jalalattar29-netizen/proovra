/**
 * Phase C2 — Deterministic chat scope classification + off-domain refusal.
 *
 * Runs BEFORE the model. The support assistant only serves PROOVRA product help
 * and evidence-operations help. Requests that ask for legal advice, general
 * off-topic chatbot use, a forensic/truth determination, or that are unsafe are
 * refused deterministically without a provider call. We do not rely on the LLM
 * to self-classify.
 */
import { detectInjectionSignals } from "./prompt-context-sanitizer.service.js";
import { classifyProhibitedClaims } from "./prohibited-claims-engine.service.js";

export type ChatScopeClass =
  | "IN_SCOPE_PRODUCT_HELP"
  | "IN_SCOPE_EVIDENCE_OPERATIONS"
  | "OUT_OF_SCOPE_LEGAL"
  | "OUT_OF_SCOPE_GENERAL"
  | "PROHIBITED_FORENSIC_CLAIM"
  | "UNSAFE_REQUEST";

export type ChatScopeResult = {
  scope: ChatScopeClass;
  refuse: boolean;
  refusalMessage: string | null;
};

const LEGAL = /\b(legal advice|should i sue|sue (them|him|her)|court strategy|hire a lawyer|am i liable|is (this|it) legal|file a lawsuit|press charges|take (them|him|her) to court)\b/i;
const GENERAL = /\b(weather|write (me )?(a )?(poem|song|essay|story)|recipe|tell me a joke|who won|stock price|translate this paragraph|solve this equation|write (me )?(some )?code|python|javascript function|homework|capital of|meaning of life)\b/i;
const FORENSIC_ASK = /\b(is|are)\b[^.?!]{0,30}\b(authentic|genuine|forged|manipulated|fraudulent|admissible)\b|\b(who (is|took|wrote|created|authored)|who is the (author|person)|prove (that )?(this|it|the event)|did (this|the event) (really )?happen|is (the )?(claimant|person|witness) (telling the truth|truthful|credible|lying)|determine (the )?(truth|authenticity|authorship|identity|liability|intent))\b/i;

const PROOVRA_TERMS = /\b(proovra|capture|evidence|custody|verification|verify|package|report|review|sign|tsa|ots|timestamp|hash|fingerprint|workspace|case|reviewer|upload|intake|redact|retention|legal hold)\b/i;

export function classifyChatScope(userText: string): ChatScopeResult {
  const text = (userText ?? "").trim();
  if (text.length === 0) {
    return { scope: "IN_SCOPE_PRODUCT_HELP", refuse: false, refusalMessage: null };
  }

  // 1. Unsafe / jailbreak attempts.
  const injection = detectInjectionSignals(text);
  if (injection.includes("INSTRUCTION_OVERRIDE") || injection.includes("SYSTEM_PROMPT_PROBE")) {
    return {
      scope: "UNSAFE_REQUEST",
      refuse: true,
      refusalMessage:
        "I can't follow that request. I can help with PROOVRA workflows, evidence preparation, and custody/integrity signals.",
    };
  }

  // 2. Asking the AI to make a forensic/truth determination.
  if (FORENSIC_ASK.test(text) || classifyProhibitedClaims(text).length > 0) {
    return {
      scope: "PROHIBITED_FORENSIC_CLAIM",
      refuse: true,
      refusalMessage:
        "PROOVRA AI cannot determine truth, authenticity, authorship, identity, intent, liability, fraud, or admissibility. It records integrity and provenance signals only — please review the underlying records and consult a qualified human reviewer.",
    };
  }

  // 3. Legal advice.
  if (LEGAL.test(text)) {
    return {
      scope: "OUT_OF_SCOPE_LEGAL",
      refuse: true,
      refusalMessage:
        "I can help with PROOVRA workflows, evidence preparation, custody/integrity signals, and reviewer operations. I can't provide legal advice or determine liability or admissibility.",
    };
  }

  // 4. Clearly-general off-topic use, only when no PROOVRA/evidence context.
  if (GENERAL.test(text) && !PROOVRA_TERMS.test(text)) {
    return {
      scope: "OUT_OF_SCOPE_GENERAL",
      refuse: true,
      refusalMessage:
        "I'm the PROOVRA assistant — I can only help with PROOVRA product questions and evidence operations. For that request, please use a general-purpose tool.",
    };
  }

  // 5. In scope: product help vs evidence operations.
  const scope: ChatScopeClass = PROOVRA_TERMS.test(text)
    ? "IN_SCOPE_EVIDENCE_OPERATIONS"
    : "IN_SCOPE_PRODUCT_HELP";
  return { scope, refuse: false, refusalMessage: null };
}
