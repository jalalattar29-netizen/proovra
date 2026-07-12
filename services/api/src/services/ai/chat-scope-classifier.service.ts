/**
 * Phase P1 — STRICT DEFAULT-DENY chat domain classifier (EN / AR / DE).
 *
 * The Support Chat serves ONLY PROOVRA product help + Evidence Operations.
 * Order of evaluation (all deterministic, BEFORE any provider call):
 *   1. prompt-injection → refuse
 *   2. prohibited forensic asks (truth/authenticity/identity/authorship/
 *      fraud/liability/intent/credibility/admissibility) → refuse
 *   3. unsupported categories (legal/medical/financial/coding/news/general
 *      task) → refuse
 *   4. ALLOW only when a proven PROOVRA / Evidence-Operations intent is
 *      present (multilingual allowlist)
 *   5. otherwise AMBIGUOUS_REQUEST → refuse and ask to restate in a PROOVRA
 *      Evidence-Operations context.
 *
 * Nothing is allowed by default. Refusals are localized (EN/AR/DE) and cost
 * nothing (no provider call, no budget reservation).
 */
import { detectInjectionSignals } from "./prompt-context-sanitizer.service.js";

export type ChatScopeClass =
  | "PROOVRA_PRODUCT_HELP"
  | "CAPTURE_OPERATIONS"
  | "EVIDENCE_OPERATIONS"
  | "CASE_OPERATIONS"
  | "REVIEW_OPERATIONS"
  | "REPORT_PACKAGE_OPERATIONS"
  | "CUSTODY_VERIFICATION_OPERATIONS"
  | "WORKSPACE_OPERATIONS"
  | "UNSUPPORTED_GENERAL_REQUEST"
  | "UNSUPPORTED_LEGAL_REQUEST"
  | "UNSUPPORTED_MEDICAL_REQUEST"
  | "UNSUPPORTED_FINANCIAL_REQUEST"
  | "UNSUPPORTED_CODING_REQUEST"
  | "UNSUPPORTED_NEWS_RESEARCH_REQUEST"
  | "PROHIBITED_TRUTH_REQUEST"
  | "PROHIBITED_AUTHENTICITY_REQUEST"
  | "PROHIBITED_IDENTITY_AUTHORSHIP_REQUEST"
  | "PROHIBITED_FRAUD_LIABILITY_INTENT_REQUEST"
  | "PROMPT_INJECTION_REQUEST"
  | "AMBIGUOUS_REQUEST";

export type ChatLanguage = "en" | "ar" | "de";

export type ChatScopeResult = {
  scope: ChatScopeClass;
  refuse: boolean;
  refusalMessage: string | null;
  language: ChatLanguage;
};

// --- Localized refusal copy (mandated) -------------------------------------
const REFUSAL: Record<ChatLanguage, string> = {
  en: "I can help with PROOVRA workflows, evidence capture and preparation, custody and verification signals, Cases, reviews, Reports, Verification Packages, and workspace operations. I cannot provide general assistance, legal advice, medical or financial advice, coding help, news research, or determine truth, authenticity, identity, authorship, fraud, liability, intent, credibility, or legal admissibility.",
  ar: "يمكنني مساعدتك فقط في استخدام PROOVRA وعمليات الأدلة، مثل جمع الأدلة وتجهيزها، وسلسلة الحيازة، وإشارات التحقق، والقضايا، والمراجعات، والتقارير، وحزم التحقق، وعمليات مساحة العمل. لا يمكنني تقديم مساعدة عامة أو استشارات قانونية أو طبية أو مالية أو برمجية، ولا تحديد الحقيقة أو الأصالة أو الهوية أو التأليف أو الاحتيال أو المسؤولية أو النية أو المصداقية أو القبول القانوني.",
  de: "Ich kann bei PROOVRA-Abläufen und Evidence Operations helfen, einschließlich Erfassung und Vorbereitung von Beweismitteln, Chain of Custody, Verifizierungssignalen, Fällen, Reviews, Berichten, Verification Packages und Workspace-Vorgängen. Ich kann keine allgemeine Unterstützung, Rechts-, Medizin-, Finanz- oder Programmierberatung leisten und keine Wahrheit, Authentizität, Identität, Urheberschaft, Betrug, Haftung, Absicht, Glaubwürdigkeit oder rechtliche Zulässigkeit bestimmen.",
};

const RESTATE: Record<ChatLanguage, string> = {
  en: "I can only help with PROOVRA and Evidence Operations. Please restate your question in the context of PROOVRA workflows — for example capture, evidence preparation, custody, verification, Cases, reviews, Reports, or Verification Packages.",
  ar: "يمكنني المساعدة فقط في PROOVRA وعمليات الأدلة. يرجى إعادة صياغة سؤالك في سياق PROOVRA — مثل الالتقاط أو تجهيز الأدلة أو الحيازة أو التحقق أو القضايا أو المراجعات أو التقارير أو حزم التحقق.",
  de: "Ich kann nur bei PROOVRA und Evidence Operations helfen. Bitte formulieren Sie Ihre Frage im PROOVRA-Kontext — z. B. Erfassung, Beweisvorbereitung, Custody, Verifizierung, Fälle, Reviews, Berichte oder Verification Packages.",
};

// --- Language detection -----------------------------------------------------
const ARABIC_SCRIPT = /[؀-ۿ]/;
const GERMAN_HINTS = /\b(wie|kann|ich|ist|das|dieser|dieses|warum|wo|beweis|bericht|fall|prüf|pruef|hilfe|schreib|mir|einen|eine|nicht|für|fuer|und|echt|gefälscht|gefaelscht|haftbar|betrug|anwalt|gericht|zulässig|zulaessig|arbeitsbereich)\b/i;

export function detectChatLanguage(text: string): ChatLanguage {
  if (ARABIC_SCRIPT.test(text)) return "ar";
  if (GERMAN_HINTS.test(text)) return "de";
  return "en";
}

// --- Normalization ----------------------------------------------------------
function normalize(text: string): string {
  let s = text;
  try {
    s = s.normalize("NFKC");
  } catch {
    /* ignore */
  }
  s = s.toLowerCase();
  // Collapse punctuation to spaces but KEEP unicode letters (Arabic etc.).
  s = s.replace(/[^\p{L}\p{N}%]+/gu, " ").replace(/\s+/g, " ").trim();
  return s;
}

// --- German transliteration folding ------------------------------------------
// German users routinely type ASCII transliterations (gefaelscht for
// gefälscht, glaubwuerdig for glaubwürdig). Fold BOTH the input text and the
// pattern sources into transliterated space and match there as well, so
// "gefaelscht" hits the same prohibited-authenticity rule as "gefälscht".
// This only ADDS matches (more refusals / more proven intents); the
// default-deny floor is unchanged, so no false-allow path is introduced.
function deTransliterate(s: string): string {
  return s
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss");
}

function transliteratedRegex(re: RegExp): RegExp {
  const folded = deTransliterate(re.source);
  return folded === re.source ? re : new RegExp(folded, re.flags);
}

function foldRules(
  rules: Array<{ scope: ChatScopeClass; re: RegExp }>,
): Array<{ scope: ChatScopeClass; re: RegExp; reDe: RegExp }> {
  return rules.map((r) => ({ ...r, reDe: transliteratedRegex(r.re) }));
}

function matchesEither(
  rule: { re: RegExp; reDe: RegExp },
  norm: string,
  normDe: string,
): boolean {
  return rule.re.test(norm) || rule.reDe.test(normDe);
}

// --- Prohibited forensic asks (EN / AR / DE) --------------------------------
const PROHIBITED: Array<{ scope: ChatScopeClass; re: RegExp }> = [
  { scope: "PROHIBITED_TRUTH_REQUEST", re: /\b(really (happen|happened|occurred)|actually happened|is (it|this|that) true|did (it|this|he|she|they|the event) (really )?(happen|occur)|telling the truth|wirklich passiert|ist das wahr|هل (هذا |ذلك )?(صحيح|حقيقي)|هل حدث)\b/u },
  { scope: "PROHIBITED_AUTHENTICITY_REQUEST", re: /\b(authentic|genuine|fake|forged|forgery|doctored|manipulated|tampered|echt|gefälscht|manipuliert|fälschung|مزيف|مزور|أصلي|الأصالة|مفبرك)\b/u },
  { scope: "PROHIBITED_IDENTITY_AUTHORSHIP_REQUEST", re: /\b(who (is|was|took|wrote|created|authored|made|sent|uploaded|committed)|identify (the )?(person|author|uploader|sender)|the author is|the person (in|shown)|wer (hat|ist|war)|من (هو|هي|قام|كتب|أنشأ|أرسل|التقط|ارتكب))\b/u },
  { scope: "PROHIBITED_FRAUD_LIABILITY_INTENT_REQUEST", re: /\b(fraud|fraudulent|liable|liability|at fault|negligen(t|ce)|intentional(ly)?|on purpose|deliberate(ly)?|credible|credibility|trustworthy|betrug|betrügerisch|haftbar|haftung|schuld|absichtlich|vorsätzlich|glaubwürdig(keit)?|احتيال|نصب|مسؤول(ية)?|متعمد|عمدا|النية|مصداقية|موثوق)\b/u },
  // Admissibility / court acceptance / legal validity → prohibited legal-verdict asks.
  { scope: "PROHIBITED_TRUTH_REQUEST", re: /\b(admissible|admissibility|court (will|would) accept|hold up in court|legally (valid|binding)|zulässig|rechtsgültig|vor gericht (bestehen|verwendbar|zulässig)|مقبول (في|أمام) المحكمة|القبول القانوني|صالح قانونيا)\b/u },
];

// --- Unsupported categories (EN / AR / DE) ----------------------------------
const UNSUPPORTED: Array<{ scope: ChatScopeClass; re: RegExp }> = [
  { scope: "UNSUPPORTED_LEGAL_REQUEST", re: /\b(legal advice|court strategy|should i sue|sue (them|him|her)|lawsuit|file charges|press charges|lawyer|attorney|rechtsberatung|anwalt|klage|verklagen|محامي|دعوى قضائية|استشارة قانونية|مقاضاة)\b/u },
  { scope: "UNSUPPORTED_MEDICAL_REQUEST", re: /\b(medical|diagnos(e|is)|symptom(s)?|treatment|prescription|doctor|krank(heit)?|diagnose|symptom(e)?|arzt|behandlung|طبي(ة)?|تشخيص|أعراض|علاج|طبيب)\b/u },
  { scope: "UNSUPPORTED_FINANCIAL_REQUEST", re: /\b(invest(ing|ment)?|stock(s)?|shares|crypto(currency)?|bitcoin|trading|financial advice|aktien|investieren|krypto|börse|finanzberatung|استثمار|أسهم|عملات (رقمية|مشفرة)|تداول|نصيحة مالية)\b/u },
  { scope: "UNSUPPORTED_CODING_REQUEST", re: /\b(code|coding|program(ming)?|react app|python|javascript|typescript|api integration|debug|function that|programmier(en|ung)?|quellcode|كود|برمجة|اكتب لي (برنامج|كود))\b/u },
  { scope: "UNSUPPORTED_NEWS_RESEARCH_REQUEST", re: /\b(news|politics|political|election|headline|current events|research the (web|internet)|nachrichten|politik|wahl(en)?|schlagzeilen|أخبار|سياسة|انتخابات|عناوين)\b/u },
  // Generic task verbs with no PROOVRA object → general request.
  { scope: "UNSUPPORTED_GENERAL_REQUEST", re: /\b(write (me )?(an? )?(email|letter|poem|song|essay|story|blog|business plan|plan)|business plan|plan (my|a) (trip|holiday|vacation)|recipe|joke|weather|translate|capital of|meaning of life|schreib (mir )?(eine?n? )?(e ?mail|brief|gedicht|geschichte|businessplan)|reiseplan|urlaub planen|اكتب (لي )?(بريد|رسالة|قصيدة|قصة|خطة عمل)|خطة (رحلة|عمل)|نكتة|وصفة|عاصمة)\b/u },
];

// --- Allowlisted PROOVRA / Evidence-Operations intents (EN / AR / DE) -------
const ALLOW: Array<{ scope: ChatScopeClass; re: RegExp }> = [
  { scope: "CAPTURE_OPERATIONS", re: /\b(capture|capturing|intake|upload(ing)?|record (a )?(video|audio|photo)|erfassung|erfassen|hochladen|aufnahme|التقاط|جمع (الأدلة|الدليل)|رفع (ملف|الأدلة)?)\b/u },
  { scope: "CUSTODY_VERIFICATION_OPERATIONS", re: /\b(custody|chain of custody|verification|verify|verif(y|ication) signal|tsa|ots|timestamp|hash|fingerprint|signature|integrity|anchor(ing)?|public verify|verwahrkette|verifizierung|verifikation|zeitstempel|signatur|integrität|حيازة|سلسلة الحيازة|تحقق|التحقق|بصمة|توقيع|سلامة)\b/u },
  { scope: "REPORT_PACKAGE_OPERATIONS", re: /\b(report(s)?|package(s)?|pdf|export(ing)?|bericht(e)?|paket(e)?|تقرير|تقارير|حزمة|حزم)\b/u },
  { scope: "CASE_OPERATIONS", re: /\b(case(s)?|matter(s)?|fall|fälle|akte|قضية|قضايا|ملف القضية)\b/u },
  { scope: "REVIEW_OPERATIONS", re: /\b(review(s|er|ers)?|criteria|escalation|disagreement|assign (a )?reviewer|prüfung|prüfer|gutachter|review zuweisen|مراجعة|مراجع|مراجعون|تصعيد|تعيين مراجع)\b/u },
  { scope: "EVIDENCE_OPERATIONS", re: /\b(evidence|record(s)? (is|are|not)?|metadata|readiness|missing context|title|description|tags?|beweis(mittel|e)?|metadaten|bereitschaft|دليل|أدلة|بيانات وصفية|جاهزية|سياق مفقود)\b/u },
  { scope: "WORKSPACE_OPERATIONS", re: /\b(workspace|team|settings|policy|permission(s)?|role(s)?|disable ai|enable ai|ai (settings|policy)|budget|quota|retention|arbeitsbereich|einstellungen|richtlinie|berechtigung(en)?|ki (deaktivieren|einstellungen)|مساحة العمل|إعدادات|سياسة|صلاحيات|تعطيل الذكاء|الذكاء الاصطناعي)\b/u },
  { scope: "PROOVRA_PRODUCT_HELP", re: /\b(proovra|بروفرا|navigate|where (do|can) i|how (do|can) i use|what is (a|the))\b/u },
];

// --- Arabic phrase lists (substring match — JS \b is ASCII-only) ------------
const AR_PROHIBITED: Array<{ scope: ChatScopeClass; terms: string[] }> = [
  { scope: "PROHIBITED_TRUTH_REQUEST", terms: ["هل هذا صحيح", "هل حدث", "حقيقي فعلا", "مقبول في المحكمة", "مقبول أمام المحكمة", "القبول القانوني", "صالح قانونيا"] },
  { scope: "PROHIBITED_AUTHENTICITY_REQUEST", terms: ["مزيف", "مزور", "أصلي", "الأصالة", "مفبرك"] },
  { scope: "PROHIBITED_IDENTITY_AUTHORSHIP_REQUEST", terms: ["من هو", "من هي", "من قام", "من كتب", "من أنشأ", "من أرسل", "من التقط", "من ارتكب", "حدد هوية"] },
  { scope: "PROHIBITED_FRAUD_LIABILITY_INTENT_REQUEST", terms: ["احتيال", "نصب", "مسؤول عن", "المسؤولية", "متعمد", "عمدا", "النية", "مصداقية", "موثوق"] },
];
const AR_UNSUPPORTED: Array<{ scope: ChatScopeClass; terms: string[] }> = [
  { scope: "UNSUPPORTED_LEGAL_REQUEST", terms: ["محامي", "دعوى قضائية", "استشارة قانونية", "مقاضاة"] },
  { scope: "UNSUPPORTED_MEDICAL_REQUEST", terms: ["تشخيص", "أعراض", "علاج", "طبيب", "استشارة طبية"] },
  { scope: "UNSUPPORTED_FINANCIAL_REQUEST", terms: ["استثمار", "أسهم", "عملات رقمية", "عملات مشفرة", "تداول", "نصيحة مالية"] },
  { scope: "UNSUPPORTED_CODING_REQUEST", terms: ["كود", "برمجة", "اكتب لي برنامج"] },
  { scope: "UNSUPPORTED_NEWS_RESEARCH_REQUEST", terms: ["أخبار", "سياسة", "انتخابات", "عناوين الصحف"] },
  { scope: "UNSUPPORTED_GENERAL_REQUEST", terms: ["اكتب لي بريد", "اكتب لي رسالة", "اكتب لي قصيدة", "اكتب لي قصة", "خطة عمل", "خطة رحلة", "نكتة", "وصفة", "عاصمة"] },
];
const AR_ALLOW: Array<{ scope: ChatScopeClass; terms: string[] }> = [
  { scope: "CAPTURE_OPERATIONS", terms: ["التقاط", "جمع الأدلة", "جمع الدليل", "رفع ملف", "رفع الأدلة", "تسجيل فيديو", "تسجيل صوت"] },
  { scope: "CUSTODY_VERIFICATION_OPERATIONS", terms: ["حيازة", "سلسلة الحيازة", "تحقق", "التحقق", "بصمة", "توقيع", "سلامة", "ختم زمني"] },
  { scope: "REPORT_PACKAGE_OPERATIONS", terms: ["تقرير", "تقارير", "حزمة", "حزم التحقق"] },
  { scope: "CASE_OPERATIONS", terms: ["قضية", "قضايا", "ملف القضية"] },
  { scope: "REVIEW_OPERATIONS", terms: ["مراجعة", "مراجع", "مراجعون", "تصعيد", "تعيين مراجع"] },
  { scope: "EVIDENCE_OPERATIONS", terms: ["دليل", "أدلة", "بيانات وصفية", "جاهزية", "سياق مفقود", "عنوان السجل"] },
  { scope: "WORKSPACE_OPERATIONS", terms: ["مساحة العمل", "إعدادات", "سياسة", "صلاحيات", "تعطيل الذكاء", "الذكاء الاصطناعي", "ميزانية"] },
  { scope: "PROOVRA_PRODUCT_HELP", terms: ["بروفرا", "proovra"] },
];

// F-6 — precomputed transliterated rule variants (module-load, one-time).
const PROHIBITED_FOLDED = foldRules(PROHIBITED);
const UNSUPPORTED_FOLDED = foldRules(UNSUPPORTED);
const ALLOW_FOLDED = foldRules(ALLOW);

function matchArabic(
  norm: string,
  lists: Array<{ scope: ChatScopeClass; terms: string[] }>,
): ChatScopeClass | null {
  for (const { scope, terms } of lists) {
    for (const t of terms) if (norm.includes(t)) return scope;
  }
  return null;
}

/**
 * DEFAULT-DENY classification. Allow only proven PROOVRA/Evidence-Operations
 * intent; refuse everything else deterministically and locally.
 */
export function classifyChatScope(userText: string): ChatScopeResult {
  const raw = (userText ?? "").trim();
  const language = detectChatLanguage(raw);
  const refuse = (scope: ChatScopeClass, msg: string): ChatScopeResult => ({
    scope,
    refuse: true,
    refusalMessage: msg,
    language,
  });

  if (raw.length === 0) {
    return refuse("AMBIGUOUS_REQUEST", RESTATE[language]);
  }

  // 1. Prompt injection / jailbreak.
  const injection = detectInjectionSignals(raw);
  if (injection.includes("INSTRUCTION_OVERRIDE") || injection.includes("SYSTEM_PROMPT_PROBE") || injection.includes("ROLE_HIJACK")) {
    return refuse("PROMPT_INJECTION_REQUEST", REFUSAL[language]);
  }

  const norm = normalize(raw);
  const normDe = deTransliterate(norm);

  // 2. Prohibited forensic-verdict asks (checked BEFORE allow so an evidence
  //    keyword cannot smuggle an authenticity/identity question through).
  //    Matched in both umlaut and ASCII-transliterated space (F-6).
  for (const rule of PROHIBITED_FOLDED) {
    if (matchesEither(rule, norm, normDe)) return refuse(rule.scope, REFUSAL[language]);
  }
  const arProhibited = matchArabic(norm, AR_PROHIBITED);
  if (arProhibited) return refuse(arProhibited, REFUSAL[language]);

  // 3. Unsupported assistant categories.
  for (const rule of UNSUPPORTED_FOLDED) {
    if (matchesEither(rule, norm, normDe)) return refuse(rule.scope, REFUSAL[language]);
  }
  const arUnsupported = matchArabic(norm, AR_UNSUPPORTED);
  if (arUnsupported) return refuse(arUnsupported, REFUSAL[language]);

  // 4. DEFAULT-DENY: allow only proven PROOVRA / Evidence-Operations intent.
  for (const rule of ALLOW_FOLDED) {
    if (matchesEither(rule, norm, normDe)) {
      return { scope: rule.scope, refuse: false, refusalMessage: null, language };
    }
  }
  const arAllow = matchArabic(norm, AR_ALLOW);
  if (arAllow) return { scope: arAllow, refuse: false, refusalMessage: null, language };

  // 5. No proven intent → ambiguous → refuse with restate guidance.
  return refuse("AMBIGUOUS_REQUEST", RESTATE[language]);
}
