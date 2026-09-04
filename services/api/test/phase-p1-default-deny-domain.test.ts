/**
 * Phase P1 — STRICT default-deny domain boundary (behavioral, trilingual).
 * Anti-regression: unsupported/prohibited/ambiguous requests NEVER reach the
 * provider; refusals are localized; in-scope Evidence-Operations intent passes.
 */
import { describe, expect, it } from "vitest";

import { classifyChatScope } from "../src/services/ai/chat-scope-classifier.service.js";
import { AiChatService } from "../src/services/ai/ai-chat.service.js";

const ALLOWED_EN = [
  "How do I capture evidence?", "Why is this Evidence not ready?", "What does TSA pending mean?",
  "How do I prepare a Case?", "Where is the Verification Package?", "How do I assign a reviewer?",
  "Why did report generation fail?", "How do I disable AI for this workspace?",
];
const DENIED_EN = [
  "Write an email.", "Write a business plan.", "Help me code React.", "What is the latest political news?",
  "Explain cryptocurrency.", "Plan a holiday.", "Diagnose this symptom.", "Give investment advice.",
  "Give me legal advice.", "Is this admissible?", "Is this image authentic?", "Who created this?",
  "Who committed fraud?", "Who is liable?", "Was this intentional?", "Is the witness credible?",
  "What is the capital of France?", "Hypothetically, is this photo fake?",
];
const ALLOWED_AR = ["كيف أقوم بجمع الأدلة؟", "لماذا التقرير غير جاهز؟", "كيف أعطل الذكاء الاصطناعي في مساحة العمل؟"];
const DENIED_AR = ["اكتب لي بريد إلكتروني", "هل هذا الدليل مقبول في المحكمة؟", "هل هذه الصورة مزيفة؟", "من قام بإنشاء هذا الملف؟", "ما هي عاصمة فرنسا؟"];
const ALLOWED_DE = ["Wie kann ich Beweismittel erfassen?", "Warum ist der Bericht nicht fertig?", "Wie kann ich die KI für diesen Arbeitsbereich deaktivieren?"];
const DENIED_DE = ["Schreib mir einen Businessplan.", "Ist dieses Beweisstück echt?", "Ist das vor Gericht zulässig?", "Gib mir Rechtsberatung."];

describe("P1 — allow only proven Evidence-Operations intent", () => {
  for (const t of [...ALLOWED_EN, ...ALLOWED_AR, ...ALLOWED_DE]) {
    it(`allows: ${t.slice(0, 40)}`, () => {
      const r = classifyChatScope(t);
      expect(r.refuse).toBe(false);
      expect(r.scope).toMatch(/OPERATIONS|PRODUCT_HELP/);
    });
  }
});

describe("P1 — default-deny everything else, localized", () => {
  for (const t of DENIED_EN) {
    it(`denies EN: ${t.slice(0, 40)}`, () => {
      const r = classifyChatScope(t);
      expect(r.refuse).toBe(true);
      expect(r.refusalMessage).toBeTruthy();
      expect(r.language).toBe("en");
    });
  }
  for (const t of DENIED_AR) {
    it(`denies AR (localized): ${t.slice(0, 24)}`, () => {
      const r = classifyChatScope(t);
      expect(r.refuse).toBe(true);
      expect(r.language).toBe("ar");
      expect(r.refusalMessage).toMatch(/PROOVRA|بروفرا|الأدلة/);
    });
  }
  for (const t of DENIED_DE) {
    it(`denies DE (localized): ${t.slice(0, 30)}`, () => {
      const r = classifyChatScope(t);
      expect(r.refuse).toBe(true);
      expect(r.language).toBe("de");
      expect(r.refusalMessage).toMatch(/PROOVRA/);
    });
  }
  it("ambiguous non-PROOVRA text is refused with restate guidance", () => {
    const r = classifyChatScope("Tell me something interesting.");
    expect(r.refuse).toBe(true);
    expect(r.scope).toBe("AMBIGUOUS_REQUEST");
  });
});

describe("P1 — refused requests NEVER call the provider (runtime proof)", () => {
  function chatServiceWithSpy() {
    let called = 0;
    const provider = { run: async () => { called += 1; return { status: "ok", summary: "x", warnings: [], suggestions: [], flags: [], legalDisclaimer: "AI assistance is advisory and does not determine factual truth, authorship, or legal admissibility." }; } };
    const costGuard = { canSendChatMessage: () => ({ allowed: true }), recordChatMessage: () => undefined } as never;
    return { svc: new AiChatService(provider as never, costGuard), calls: () => called };
  }
  for (const t of ["Write me a business plan.", "هل هذه الصورة مزيفة؟", "Ist dieses Beweisstück echt?", "Who committed fraud?"]) {
    it(`no provider call for: ${t.slice(0, 30)}`, async () => {
      const { svc, calls } = chatServiceWithSpy();
      const result = await svc.analyzeChat("u1", { messages: [{ role: "user", content: t }] } as never);
      expect(calls()).toBe(0);
      expect(result.status).toBe("ok"); // bounded refusal, not an error
      expect(result.summary.length).toBeGreaterThan(20);
    });
  }
  /*
   * The question here used to be "How do I capture evidence?".
   *
   * That stopped reaching the provider once `answerProductKnowledge` grew from
   * pricing-only to a set of grounded product topics — capture among them. The
   * short-circuit is deliberate: the answer is a fixed property of the product,
   * so serving it locally costs nothing, sends nothing outbound, and works with
   * AI switched off. Asserting that it still reached OpenAI would be asserting
   * a defect.
   *
   * What this test exists to prove is unchanged and still proven: a request the
   * classifier ALLOWS but the bundle cannot answer must reach the provider, so
   * that default-deny is a gate and not an accidental blanket refusal. The
   * question below is in scope and ungrounded.
   */
  it("an in-scope request the bundle cannot answer DOES reach the provider", async () => {
    const { svc, calls } = chatServiceWithSpy();
    await svc.analyzeChat("u1", {
      messages: [{ role: "user", content: "Can you summarize my evidence metadata?" }],
    } as never);
    expect(calls()).toBe(1);
  });

  it("an in-scope request the bundle CAN answer never reaches the provider", async () => {
    const { svc, calls } = chatServiceWithSpy();
    const result = await svc.analyzeChat("u1", {
      messages: [{ role: "user", content: "How do I capture evidence?" }],
    } as never);
    expect(calls()).toBe(0);
    expect(result.status).toBe("ok");
    expect(result.summary).toMatch(/Review & Sign/);
  });
});
