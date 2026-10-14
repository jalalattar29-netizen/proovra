/**
 * OPERATIONS CONDITION MESSAGES — ONE CATALOGUE, EVERY LOCALE.
 *
 * A condition's writer records a stable semantic CODE and structured PARAMS
 * (`OperationalIncident.messageCode` / `messageParams`). The stored English
 * `title` / `safeSummary` are rendered from this same catalogue at write time,
 * so the stored text and the localized text cannot drift apart, and every
 * client resolves the code here rather than carrying its own translations.
 *
 * Rules the resolver enforces:
 *   - Identifiers, codes, queue names, references, outcomes and other
 *     technical values are PARAMS and are never translated. In Arabic they are
 *     wrapped in Unicode isolates so a Latin id cannot reorder the sentence.
 *   - Params are validated against the code's declared shape and substituted
 *     as TEXT by plain functions — no template is evaluated, no markup is
 *     produced, and a value containing `{x}` is inserted literally.
 *   - An unknown code, a missing or malformed param, or a row written before
 *     codes existed (legacy English) renders the row's STORED text. Never a
 *     raw key, never an empty string.
 *   - EVERY locale, English included, renders the CURRENT catalogue sentence
 *     when the row carries a valid code: a stored sentence written before the
 *     copy was corrected never outranks the reviewed text. The stored text is
 *     the fallback only for a row with no valid code.
 */

import { STUCK_REASON_CODES, type StuckReasonCode } from "./stuck-workflow-detector.js";

export type ConditionMessageLocale = "en" | "de" | "ar";

type ParamKind = "int" | "token" | "ref" | "text";
type ParamDecl = { readonly kind: ParamKind | readonly string[]; readonly optional?: true };
type ParamSpec = { readonly [name: string]: ParamDecl };

type ValueOf<D extends ParamDecl> = D["kind"] extends readonly (infer E)[]
  ? E
  : D["kind"] extends "int"
    ? number
    : string;

export type ConditionParamsOf<S extends ParamSpec> = {
  -readonly [K in keyof S as S[K] extends { optional: true } ? never : K]: ValueOf<S[K]>;
} & {
  -readonly [K in keyof S as S[K] extends { optional: true } ? K : never]?: ValueOf<S[K]> | null;
};

type Rendered = { readonly title: string; readonly summary: string };
type Renderer<S extends ParamSpec> = (p: ConditionParamsOf<S>) => Rendered;

type MessageDef<S extends ParamSpec> = {
  readonly params: S;
  readonly en: Renderer<S>;
  readonly de: Renderer<S>;
  readonly ar: Renderer<S>;
};

const def = <S extends ParamSpec>(d: MessageDef<S>): MessageDef<S> => d;

// ---------------------------------------------------------------------------
// Param shapes
// ---------------------------------------------------------------------------

const INT = { kind: "int" } as const;
const TOKEN = { kind: "token" } as const;
const REF = { kind: "ref" } as const;
const TEXT = { kind: "text" } as const;
const OPT_TEXT = { kind: "text", optional: true } as const;
const OPT_REF = { kind: "ref", optional: true } as const;

const FAILURE_CLASSES = [
  "RETRYABLE_PROVIDER",
  "CONFIGURATION",
  "QUOTA",
  "CRYPTOGRAPHIC",
  "RETRY_EXHAUSTED",
  "UNKNOWN",
] as const;
type FailureClass = (typeof FAILURE_CLASSES)[number];

const PAYERS = ["personal", "workspace"] as const;
type Payer = (typeof PAYERS)[number];

const STUCK_REASONS = STUCK_REASON_CODES;
type StuckReason = StuckReasonCode;

const PACKAGE_DENIAL_OUTCOMES = [
  "BLOCKED_BY_HOLD",
  "BLOCKED_BY_LIFECYCLE",
  "BLOCKED_BY_REVIEW_GATE",
  "BLOCKED_BY_IMMUTABLE_DRIFT",
  "BLOCKED_BY_REVIEW_POLICY",
  "BLOCKED_BY_REVIEW_STATE",
  "BLOCKED_BY_RETENTION",
  "BLOCKED_BY_GOVERNANCE",
  "BLOCKED_BY_EXTERNAL_ACCESS_POLICY",
  "GOVERNANCE_STATE_UNAVAILABLE",
] as const;
type PackageDenialOutcome = (typeof PACKAGE_DENIAL_OUTCOMES)[number];

const BLOCK_CAUSES = ["hold", "immutable"] as const;

// ---------------------------------------------------------------------------
// Shared phrase tables (per locale, never per client)
// ---------------------------------------------------------------------------

/** Keeps a technical value's own direction inside a sentence. */
/** Unicode FIRST STRONG ISOLATE and POP DIRECTIONAL ISOLATE. */
const FSI = "\u2068";
const PDI = "\u2069";
const iso = (v: string | number): string => `${FSI}${v}${PDI}`;

const FAILURE_CLASS_PHRASE: Record<ConditionMessageLocale, Record<FailureClass, string>> = {
  en: {
    RETRYABLE_PROVIDER: "the timestamping provider was unreachable or timed out",
    CONFIGURATION: "the provider rejected our credentials or configuration",
    QUOTA: "a quota, budget or rate limit was exhausted",
    CRYPTOGRAPHIC: "the proof could not be produced or verified for this input",
    RETRY_EXHAUSTED: "the pipeline exhausted its retries",
    UNKNOWN: "the failure reason is not one we classify",
  },
  de: {
    RETRYABLE_PROVIDER: "der Zeitstempeldienst war nicht erreichbar oder hat nicht rechtzeitig geantwortet",
    CONFIGURATION: "der Dienst hat unsere Zugangsdaten oder Konfiguration abgelehnt",
    QUOTA: "ein Kontingent, Budget oder Ratenlimit war ausgeschöpft",
    CRYPTOGRAPHIC: "der Nachweis konnte für diese Eingabe nicht erzeugt oder geprüft werden",
    RETRY_EXHAUSTED: "die Verarbeitung hat ihre Wiederholungsversuche ausgeschöpft",
    UNKNOWN: "der Fehlergrund gehört zu keiner Klasse, die wir unterscheiden",
  },
  ar: {
    RETRYABLE_PROVIDER: "تعذّر الوصول إلى مزوّد الختم الزمني أو انتهت مهلة الاستجابة",
    CONFIGURATION: "رفض المزوّد بيانات الاعتماد أو الإعدادات الخاصة بنا",
    QUOTA: "استُنفدت حصة أو ميزانية أو حدّ للمعدّل",
    CRYPTOGRAPHIC: "تعذّر إنتاج الإثبات أو التحقق منه لهذا الإدخال",
    RETRY_EXHAUSTED: "استنفد مسار المعالجة محاولات الإعادة",
    UNKNOWN: "سبب الإخفاق ليس ضمن الفئات التي نصنّفها",
  },
};

const PAYER_PHRASE: Record<ConditionMessageLocale, Record<Payer, string>> = {
  en: {
    personal: "You pay for this add-on on your personal account",
    workspace: "This workspace's billing owner pays for this add-on",
  },
  de: {
    personal: "Sie bezahlen diese Erweiterung über Ihr persönliches Konto",
    workspace: "Die abrechnungsverantwortliche Person dieses Arbeitsbereichs bezahlt diese Erweiterung",
  },
  ar: {
    personal: "تدفع رسوم هذه الإضافة من حسابك الشخصي",
    workspace: "يدفع مسؤول الفوترة في مساحة العمل هذه رسوم هذه الإضافة",
  },
};

const STUCK_PHRASE: Record<ConditionMessageLocale, Record<StuckReason, string>> = {
  en: {
    submitted_never_assigned: "Submitted but never assigned to a reviewer",
    assigned_never_opened: "Assigned but never opened by the reviewer",
    opened_no_action: "Opened but no reviewer action in 3+ days",
    needs_info_no_response: "Reviewer requested info; no contributor response in 5+ days",
    sla_overdue_no_escalation: "Reviewer SLA breached but no escalation has been raised",
    escalated_unacknowledged: "Escalation raised but not acknowledged within 8h",
    approved_export_blocked: "Review approved but export / package gate still blocks",
  },
  de: {
    submitted_never_assigned: "Eingereicht, aber nie einer prüfenden Person zugewiesen",
    assigned_never_opened: "Zugewiesen, aber von der prüfenden Person nie geöffnet",
    opened_no_action: "Geöffnet, aber seit mindestens 3 Tagen keine Prüfaktion",
    needs_info_no_response: "Rückfrage gestellt; seit mindestens 5 Tagen keine Antwort",
    sla_overdue_no_escalation: "Prüffrist überschritten, aber keine Eskalation ausgelöst",
    escalated_unacknowledged: "Eskalation ausgelöst, aber nicht binnen 8 Std. bestätigt",
    approved_export_blocked: "Prüfung freigegeben, aber Export-/Paketsperre blockiert weiterhin",
  },
  ar: {
    submitted_never_assigned: "قُدّم لكنه لم يُسند إلى مراجع قط",
    assigned_never_opened: "أُسند لكن المراجع لم يفتحه قط",
    opened_no_action: "فُتح دون أي إجراء من المراجع منذ 3 أيام أو أكثر",
    needs_info_no_response: "طلب المراجع معلومات ولا رد من المساهم منذ 5 أيام أو أكثر",
    sla_overdue_no_escalation: "تجاوزت المراجعة مهلتها دون رفع أي تصعيد",
    escalated_unacknowledged: "رُفع تصعيد ولم يُقرّ به خلال 8 ساعات",
    approved_export_blocked: "اعتُمدت المراجعة لكن بوابة التصدير أو الحزمة ما زالت تمنع",
  },
};

const PACKAGE_DENIAL_PHRASE: Record<ConditionMessageLocale, Record<PackageDenialOutcome, string>> = {
  en: {
    BLOCKED_BY_HOLD: "Active legal hold — package generation blocked",
    BLOCKED_BY_LIFECYCLE: "Lifecycle state blocks package generation",
    BLOCKED_BY_REVIEW_GATE: "Destruction review in progress — package generation blocked",
    BLOCKED_BY_IMMUTABLE_DRIFT: "Storage governance drift — package generation paused until reconciled",
    BLOCKED_BY_REVIEW_POLICY: "Workspace review policy requires review before package generation",
    BLOCKED_BY_REVIEW_STATE: "Review state does not allow package generation",
    BLOCKED_BY_RETENTION: "Retention policy blocks package generation",
    BLOCKED_BY_GOVERNANCE: "Governance policy blocks package generation",
    BLOCKED_BY_EXTERNAL_ACCESS_POLICY: "External access policy blocks package generation",
    GOVERNANCE_STATE_UNAVAILABLE: "Governance state could not be determined — package generation denied",
  },
  de: {
    BLOCKED_BY_HOLD: "Aktive gerichtliche Aufbewahrungspflicht — Paketerstellung gesperrt",
    BLOCKED_BY_LIFECYCLE: "Der Lebenszyklusstatus sperrt die Paketerstellung",
    BLOCKED_BY_REVIEW_GATE: "Vernichtungsprüfung läuft — Paketerstellung gesperrt",
    BLOCKED_BY_IMMUTABLE_DRIFT: "Abweichung in der Speicher-Governance — Paketerstellung bis zum Abgleich pausiert",
    BLOCKED_BY_REVIEW_POLICY: "Die Prüfrichtlinie des Arbeitsbereichs verlangt vor der Paketerstellung eine Prüfung",
    BLOCKED_BY_REVIEW_STATE: "Der Prüfstatus erlaubt keine Paketerstellung",
    BLOCKED_BY_RETENTION: "Die Aufbewahrungsrichtlinie sperrt die Paketerstellung",
    BLOCKED_BY_GOVERNANCE: "Die Governance-Richtlinie sperrt die Paketerstellung",
    BLOCKED_BY_EXTERNAL_ACCESS_POLICY: "Die Richtlinie für externen Zugriff sperrt die Paketerstellung",
    GOVERNANCE_STATE_UNAVAILABLE: "Der Governance-Status konnte nicht ermittelt werden — Paketerstellung abgelehnt",
  },
  ar: {
    BLOCKED_BY_HOLD: "حجز قانوني نشط — إنشاء الحزمة محظور",
    BLOCKED_BY_LIFECYCLE: "حالة دورة الحياة تمنع إنشاء الحزمة",
    BLOCKED_BY_REVIEW_GATE: "مراجعة إتلاف جارية — إنشاء الحزمة محظور",
    BLOCKED_BY_IMMUTABLE_DRIFT: "انحراف في حوكمة التخزين — إنشاء الحزمة متوقف حتى المطابقة",
    BLOCKED_BY_REVIEW_POLICY: "سياسة المراجعة في مساحة العمل تشترط المراجعة قبل إنشاء الحزمة",
    BLOCKED_BY_REVIEW_STATE: "حالة المراجعة لا تسمح بإنشاء الحزمة",
    BLOCKED_BY_RETENTION: "سياسة الاحتفاظ تمنع إنشاء الحزمة",
    BLOCKED_BY_GOVERNANCE: "سياسة الحوكمة تمنع إنشاء الحزمة",
    BLOCKED_BY_EXTERNAL_ACCESS_POLICY: "سياسة الوصول الخارجي تمنع إنشاء الحزمة",
    GOVERNANCE_STATE_UNAVAILABLE: "تعذّر تحديد حالة الحوكمة — رُفض إنشاء الحزمة",
  },
};

const recordLabel = {
  en: (title: string | null | undefined, ref: string) => (title ? `"${title}"` : `record ${ref}`),
  de: (title: string | null | undefined, ref: string) => (title ? `„${title}“` : `Datensatz ${ref}`),
  ar: (title: string | null | undefined, ref: string) => (title ? `«${iso(title)}»` : `السجل ${iso(ref)}`),
};

const RECORD = { recordTitle: OPT_TEXT, recordRef: REF } as const;

// ---------------------------------------------------------------------------
// Vocabularies for technical values a sentence must never print raw
// ---------------------------------------------------------------------------

type L3 = Record<ConditionMessageLocale, string>;

/** Look a code up in a phrase table; an unknown code gets the generic phrase, never itself. */
function phrase(table: Readonly<Record<string, L3>>, fallback: L3, locale: ConditionMessageLocale, code: string): string {
  return (Object.prototype.hasOwnProperty.call(table, code) ? table[code]! : fallback)[locale];
}

const IDP_NAMES: Readonly<Record<string, L3>> = {
  GENERIC_SAML: { en: "your SAML identity provider", de: "Ihren SAML-Identitätsanbieter", ar: "مزوّد هوية SAML الخاص بك" },
  GENERIC_OIDC: { en: "your OpenID Connect identity provider", de: "Ihren OpenID-Connect-Identitätsanbieter", ar: "مزوّد هوية OpenID Connect الخاص بك" },
  GENERIC_SCIM: { en: "your SCIM directory", de: "Ihr SCIM-Verzeichnis", ar: "دليل SCIM الخاص بك" },
  OKTA: { en: "Okta", de: "Okta", ar: "Okta" },
  AZURE_AD: { en: "Microsoft Entra ID", de: "Microsoft Entra ID", ar: "Microsoft Entra ID" },
  GOOGLE_WORKSPACE: { en: "Google Workspace", de: "Google Workspace", ar: "Google Workspace" },
};
const IDP_FALLBACK: L3 = { en: "your identity provider", de: "Ihren Identitätsanbieter", ar: "مزوّد الهوية الخاص بك" };
const idpName = (l: ConditionMessageLocale, code: string) => phrase(IDP_NAMES, IDP_FALLBACK, l, code);
/** An identity provider's display name (never its enum code). */
export function identityProviderDisplayName(locale: string | null | undefined, code: string): string {
  return idpName(conditionMessageLocale(locale), code);
}

const PAYMENT_PROVIDER_NAMES: Readonly<Record<string, L3>> = {
  STRIPE: { en: "Stripe", de: "Stripe", ar: "Stripe" },
  PAYPAL: { en: "PayPal", de: "PayPal", ar: "PayPal" },
};
const PAYMENT_PROVIDER_FALLBACK: L3 = { en: "The payment provider", de: "Der Zahlungsanbieter", ar: "مزوّد الدفع" };
const paymentProviderName = (l: ConditionMessageLocale, code: string) =>
  phrase(PAYMENT_PROVIDER_NAMES, PAYMENT_PROVIDER_FALLBACK, l, code);
/** A payment provider's display name (never its enum code). */
export function paymentProviderDisplayName(locale: string | null | undefined, code: string): string {
  return paymentProviderName(conditionMessageLocale(locale), code);
}

const REASON_PHRASES: Readonly<Record<string, L3>> = {
  NO_REVIEWER_ASSIGNED: { en: "no reviewer assigned", de: "keine prüfende Person zugewiesen", ar: "لم يُسند مراجع" },
  REVIEW_OVERDUE: { en: "review overdue", de: "Prüfung überfällig", ar: "المراجعة متأخرة" },
  FIRST_REVIEW_OVERDUE: { en: "first review overdue", de: "erste Prüfung überfällig", ar: "المراجعة الأولى متأخرة" },
  COMPLETION_OVERDUE: { en: "completion overdue", de: "Abschluss überfällig", ar: "الإنجاز متأخر" },
  WORKFLOW_STALLED: { en: "workflow stalled", de: "Ablauf steht still", ar: "المسار متوقف" },
  EVIDENCE_REQUEST_UNRESOLVED: { en: "evidence request unresolved", de: "Beweisanforderung offen", ar: "طلب الدليل لم يُحل" },
  INTEGRITY_RISK: { en: "integrity risk", de: "Integritätsrisiko", ar: "خطر على السلامة" },
  VERIFICATION_MISMATCH: { en: "verification mismatch", de: "Verifizierung stimmt nicht überein", ar: "عدم تطابق في التحقق" },
  REVIEWER_INACTIVE: { en: "reviewer inactive", de: "prüfende Person inaktiv", ar: "المراجع غير نشط" },
  GOVERNANCE_BLOCKED: { en: "blocked by governance", de: "durch Governance gesperrt", ar: "محظور بسبب الحوكمة" },
  REPEATED_REJECTION_LOOP: { en: "repeated rejections", de: "wiederholte Ablehnungen", ar: "رفض متكرر" },
};
const REASON_FALLBACK: L3 = { en: "needs attention", de: "erfordert Aufmerksamkeit", ar: "يحتاج إلى انتباه" };
const reasonPhrase = (l: ConditionMessageLocale, code: string) => phrase(REASON_PHRASES, REASON_FALLBACK, l, code);

const DRIFT_PHRASES: Readonly<Record<string, L3>> = {
  OK: { en: "no difference found", de: "keine Abweichung gefunden", ar: "لا يوجد اختلاف" },
  MISSING_LOCK: { en: "the storage lock is missing", de: "die Speichersperre fehlt", ar: "قفل التخزين مفقود" },
  RETENTION_MISMATCH: { en: "the retention date differs", de: "das Aufbewahrungsdatum weicht ab", ar: "تاريخ الاحتفاظ مختلف" },
  LEGAL_HOLD_MISMATCH: { en: "the legal hold differs", de: "die gerichtliche Aufbewahrungspflicht weicht ab", ar: "الحجز القانوني مختلف" },
  COMPLIANCE_MODE_MISMATCH: { en: "the retention mode differs", de: "der Aufbewahrungsmodus weicht ab", ar: "وضع الاحتفاظ مختلف" },
  STORAGE_UNAVAILABLE: { en: "storage could not be checked", de: "der Speicher konnte nicht geprüft werden", ar: "تعذّر فحص التخزين" },
  EVIDENCE_NOT_FOUND: { en: "the stored file was not found", de: "die gespeicherte Datei wurde nicht gefunden", ar: "لم يُعثر على الملف المخزّن" },
};
const DRIFT_FALLBACK: L3 = { en: "a difference was found", de: "eine Abweichung wurde gefunden", ar: "عُثر على اختلاف" };
const driftPhrase = (l: ConditionMessageLocale, code: string) => phrase(DRIFT_PHRASES, DRIFT_FALLBACK, l, code);

/** A duration in minutes as words: whole hours when exact, else minutes. */
function minutesPhrase(l: ConditionMessageLocale, minutes: number): string {
  const hours = minutes % 60 === 0 ? minutes / 60 : null;
  if (l === "de") return hours != null ? (hours === 1 ? "1 Stunde" : `${hours} Stunden`) : `${minutes} Minuten`;
  if (l === "ar") return hours != null ? `${iso(hours)} ساعة` : `${iso(minutes)} دقيقة`;
  return hours != null ? (hours === 1 ? "1 hour" : `${hours} hours`) : `${minutes} minutes`;
}

// ---------------------------------------------------------------------------
// Security events — one reviewed sentence per event type the bridge files
// ---------------------------------------------------------------------------

type CopyL3 = Record<ConditionMessageLocale, Rendered>;
type SecurityCopy = CopyL3 & { readonly subject: ConditionSubjectKind };

const sc = (subject: ConditionSubjectKind, en: Rendered, de: Rendered, ar: Rendered): SecurityCopy => ({ subject, en, de, ar });

const SECURITY_SIGNAL_COPY: Readonly<Record<string, SecurityCopy>> = {
  // ---- webhooks ----------------------------------------------------------
  communication_webhook_invalid_signature: sc(
    "WEBHOOK_SIGNING",
    { title: "Messaging callback failed its signature check", summary: "A delivery-status callback from the messaging provider was rejected because its signature did not verify. Message statuses may be out of date until callbacks verify again." },
    { title: "Rückmeldung des Nachrichtendienstes mit ungültiger Signatur", summary: "Eine Zustellstatus-Rückmeldung des Nachrichtenanbieters wurde abgelehnt, weil ihre Signatur nicht geprüft werden konnte. Nachrichtenstatus können veraltet sein, bis Rückmeldungen wieder gültig signiert sind." },
    { title: "فشل التحقق من توقيع استدعاء خدمة الرسائل", summary: "رُفض استدعاء حالة التسليم من مزوّد الرسائل لأن توقيعه لم يُتحقق منه. قد تكون حالات الرسائل قديمة حتى تُتحقق الاستدعاءات من جديد." },
  ),
  webhook_signature_failure: sc(
    "WEBHOOK_SIGNING",
    { title: "Incoming webhook failed its signature check", summary: "An incoming webhook was rejected because its signature did not verify. Check the signing secret configured with the sender." },
    { title: "Eingehender Webhook mit ungültiger Signatur", summary: "Ein eingehender Webhook wurde abgelehnt, weil seine Signatur nicht geprüft werden konnte. Prüfen Sie das beim Absender hinterlegte Signaturgeheimnis." },
    { title: "فشل التحقق من توقيع Webhook وارد", summary: "رُفض Webhook وارد لأن توقيعه لم يُتحقق منه. تحقق من سرّ التوقيع المضبوط لدى المرسل." },
  ),
  webhook_failure_loop: sc(
    "WEBHOOK_DELIVERY",
    { title: "Webhook deliveries keep failing", summary: "Deliveries to one of this workspace's webhook endpoints keep failing. Check that the receiving endpoint is reachable and accepts the requests." },
    { title: "Webhook-Zustellungen schlagen wiederholt fehl", summary: "Zustellungen an einen Webhook-Endpunkt dieses Arbeitsbereichs schlagen wiederholt fehl. Prüfen Sie, ob der empfangende Endpunkt erreichbar ist und die Anfragen annimmt." },
    { title: "تسليمات Webhook تفشل باستمرار", summary: "تفشل التسليمات إلى إحدى نقاط Webhook في مساحة العمل هذه باستمرار. تحقق من أن نقطة الاستقبال متاحة وتقبل الطلبات." },
  ),
  webhook_target_blocked: sc(
    "WEBHOOK_DELIVERY",
    { title: "Webhook destination blocked", summary: "A webhook delivery was blocked because its destination address is not allowed, for example a private or internal address. Update the destination to a public HTTPS endpoint." },
    { title: "Webhook-Ziel gesperrt", summary: "Eine Webhook-Zustellung wurde gesperrt, weil die Zieladresse nicht zulässig ist, etwa eine private oder interne Adresse. Ändern Sie das Ziel auf einen öffentlichen HTTPS-Endpunkt." },
    { title: "حُظرت وجهة Webhook", summary: "حُظر تسليم Webhook لأن عنوان الوجهة غير مسموح به، مثل عنوان خاص أو داخلي. حدّث الوجهة إلى نقطة HTTPS عامة." },
  ),
  webhook_unsafe_redirect: sc(
    "WEBHOOK_DELIVERY",
    { title: "Webhook redirect blocked", summary: "A webhook endpoint answered with a redirect to an address that is not allowed, so the delivery was stopped. Update the destination to its final public address." },
    { title: "Webhook-Weiterleitung gesperrt", summary: "Ein Webhook-Endpunkt hat auf eine unzulässige Adresse weitergeleitet, daher wurde die Zustellung gestoppt. Ändern Sie das Ziel auf seine endgültige öffentliche Adresse." },
    { title: "حُظرت إعادة توجيه Webhook", summary: "ردّت نقطة Webhook بإعادة توجيه إلى عنوان غير مسموح به، فأُوقف التسليم. حدّث الوجهة إلى عنوانها العام النهائي." },
  ),
  // ---- messaging -----------------------------------------------------------
  communication_message_failed: sc(
    "MESSAGE_DELIVERY",
    { title: "A message could not be delivered", summary: "The messaging provider reported that a message from this workspace could not be delivered. Check the recipient's details and the message history." },
    { title: "Eine Nachricht konnte nicht zugestellt werden", summary: "Der Nachrichtenanbieter hat gemeldet, dass eine Nachricht aus diesem Arbeitsbereich nicht zugestellt werden konnte. Prüfen Sie die Empfängerdaten und den Nachrichtenverlauf." },
    { title: "تعذّر تسليم رسالة", summary: "أفاد مزوّد الرسائل بتعذّر تسليم رسالة من مساحة العمل هذه. تحقق من بيانات المستلم وسجل الرسائل." },
  ),
  communication_provider_unconfigured: sc(
    "MESSAGE_DELIVERY",
    { title: "Messaging is not configured", summary: "A message could not be sent because no messaging provider is configured for this service. Contact support." },
    { title: "Nachrichtenversand ist nicht eingerichtet", summary: "Eine Nachricht konnte nicht gesendet werden, weil für diesen Dienst kein Nachrichtenanbieter eingerichtet ist. Wenden Sie sich an den Support." },
    { title: "خدمة الرسائل غير مُعدّة", summary: "تعذّر إرسال رسالة لأنه لا يوجد مزوّد رسائل مُعدّ لهذه الخدمة. تواصل مع الدعم." },
  ),
  communication_rate_limit_exceeded: sc(
    "MESSAGE_DELIVERY",
    { title: "Message sending was rate limited", summary: "The messaging provider limited how many messages can be sent right now, so some messages were not sent. Sending resumes when the limit resets." },
    { title: "Nachrichtenversand wurde begrenzt", summary: "Der Nachrichtenanbieter hat die Anzahl sendbarer Nachrichten vorübergehend begrenzt, daher wurden einige Nachrichten nicht gesendet. Der Versand wird fortgesetzt, sobald die Grenze zurückgesetzt ist." },
    { title: "قُيّد معدل إرسال الرسائل", summary: "حدّ مزوّد الرسائل من عدد الرسائل التي يمكن إرسالها الآن، فلم تُرسل بعض الرسائل. يُستأنف الإرسال عند إعادة ضبط الحد." },
  ),
  verification_check_failed: sc(
    "MESSAGE_DELIVERY",
    { title: "A verification code check failed", summary: "The messaging provider could not complete a verification-code check. The person verifying can request a new code." },
    { title: "Eine Codeprüfung ist fehlgeschlagen", summary: "Der Nachrichtenanbieter konnte eine Prüfung des Bestätigungscodes nicht abschließen. Die betroffene Person kann einen neuen Code anfordern." },
    { title: "فشل التحقق من رمز", summary: "تعذّر على مزوّد الرسائل إكمال التحقق من رمز التأكيد. يمكن للشخص طلب رمز جديد." },
  ),
  // ---- uploads ---------------------------------------------------------------
  upload_session_create_failed: sc(
    "UPLOAD_SERVICE",
    { title: "An upload could not be started", summary: "The upload service failed while starting an upload in this workspace. The person uploading saw an error and can try again; if it keeps happening, contact support." },
    { title: "Ein Upload konnte nicht gestartet werden", summary: "Der Upload-Dienst ist beim Starten eines Uploads in diesem Arbeitsbereich fehlgeschlagen. Die hochladende Person hat eine Fehlermeldung gesehen und kann es erneut versuchen; tritt es wiederholt auf, wenden Sie sich an den Support." },
    { title: "تعذّر بدء رفع", summary: "أخفقت خدمة الرفع أثناء بدء رفع في مساحة العمل هذه. رأى من يرفع الملف رسالة خطأ ويمكنه المحاولة مجددًا؛ وإن تكرر ذلك فتواصل مع الدعم." },
  ),
  upload_session_resume_failed: sc(
    "UPLOAD_SERVICE",
    { title: "An upload could not be resumed", summary: "The upload service failed while resuming an interrupted upload. The person uploading saw an error and can try again; if it keeps happening, contact support." },
    { title: "Ein Upload konnte nicht fortgesetzt werden", summary: "Der Upload-Dienst ist beim Fortsetzen eines unterbrochenen Uploads fehlgeschlagen. Die hochladende Person hat eine Fehlermeldung gesehen und kann es erneut versuchen; tritt es wiederholt auf, wenden Sie sich an den Support." },
    { title: "تعذّر استئناف رفع", summary: "أخفقت خدمة الرفع أثناء استئناف رفع منقطع. رأى من يرفع الملف رسالة خطأ ويمكنه المحاولة مجددًا؛ وإن تكرر ذلك فتواصل مع الدعم." },
  ),
  // ---- sign-in security --------------------------------------------------------
  step_up_denied: sc(
    "SIGN_IN_SECURITY",
    { title: "Additional verification failed", summary: "Someone in this workspace failed an additional verification step for a sensitive action. Review the sign-in activity in Security Center." },
    { title: "Zusätzliche Bestätigung fehlgeschlagen", summary: "Jemand in diesem Arbeitsbereich hat eine zusätzliche Bestätigung für eine sensible Aktion nicht bestanden. Prüfen Sie die Anmeldeaktivität im Sicherheitscenter." },
    { title: "فشل تحقق إضافي", summary: "أخفق شخص في مساحة العمل هذه في خطوة تحقق إضافية لإجراء حساس. راجع نشاط تسجيل الدخول في مركز الأمان." },
  ),
  suspicious_login_detected: sc(
    "SIGN_IN_SECURITY",
    { title: "Suspicious sign-in detected", summary: "A sign-in to this workspace showed signs of risk. Review it in Security Center and confirm it was expected." },
    { title: "Verdächtige Anmeldung erkannt", summary: "Eine Anmeldung bei diesem Arbeitsbereich zeigte Risikomerkmale. Prüfen Sie sie im Sicherheitscenter und bestätigen Sie, dass sie erwartet war." },
    { title: "رُصد تسجيل دخول مريب", summary: "أظهر تسجيل دخول إلى مساحة العمل هذه علامات خطر. راجعه في مركز الأمان وتأكد من أنه متوقع." },
  ),
  high_risk_action_blocked: sc(
    "SIGN_IN_SECURITY",
    { title: "A high-risk action was blocked", summary: "A sensitive action was blocked because the session was considered high risk. Review the session in Security Center." },
    { title: "Eine Aktion mit hohem Risiko wurde blockiert", summary: "Eine sensible Aktion wurde blockiert, weil die Sitzung als hohes Risiko eingestuft wurde. Prüfen Sie die Sitzung im Sicherheitscenter." },
    { title: "حُظر إجراء عالي المخاطر", summary: "حُظر إجراء حساس لأن الجلسة اعتُبرت عالية المخاطر. راجع الجلسة في مركز الأمان." },
  ),
  high_risk_action_step_up_required: sc(
    "SIGN_IN_SECURITY",
    { title: "A high-risk action needed extra verification", summary: "A sensitive action required additional verification because the session was considered high risk. Review the session in Security Center." },
    { title: "Eine Aktion mit hohem Risiko erforderte zusätzliche Bestätigung", summary: "Eine sensible Aktion erforderte eine zusätzliche Bestätigung, weil die Sitzung als hohes Risiko eingestuft wurde. Prüfen Sie die Sitzung im Sicherheitscenter." },
    { title: "تطلّب إجراء عالي المخاطر تحققًا إضافيًا", summary: "تطلّب إجراء حساس تحققًا إضافيًا لأن الجلسة اعتُبرت عالية المخاطر. راجع الجلسة في مركز الأمان." },
  ),
  service_account_risk_detected: sc(
    "SIGN_IN_SECURITY",
    { title: "Service account risk detected", summary: "A service account in this workspace showed risky activity. Review it in Security Center." },
    { title: "Risiko bei einem Dienstkonto erkannt", summary: "Ein Dienstkonto in diesem Arbeitsbereich zeigte riskante Aktivität. Prüfen Sie es im Sicherheitscenter." },
    { title: "رُصد خطر في حساب خدمة", summary: "أظهر حساب خدمة في مساحة العمل هذه نشاطًا محفوفًا بالمخاطر. راجعه في مركز الأمان." },
  ),
  contributor_risk_detected: sc(
    "SIGN_IN_SECURITY",
    { title: "Contributor risk detected", summary: "An external contributor's activity showed signs of risk. Review it in Security Center." },
    { title: "Risiko bei einer mitwirkenden Person erkannt", summary: "Die Aktivität einer externen mitwirkenden Person zeigte Risikomerkmale. Prüfen Sie sie im Sicherheitscenter." },
    { title: "رُصد خطر لدى مساهم", summary: "أظهر نشاط مساهم خارجي علامات خطر. راجعه في مركز الأمان." },
  ),
  impossible_travel_signal: sc(
    "SIGN_IN_SECURITY",
    { title: "Sign-ins from distant locations", summary: "The same account signed in from locations too far apart to travel between in the time recorded. Confirm with the person and review it in Security Center." },
    { title: "Anmeldungen von weit entfernten Orten", summary: "Dasselbe Konto hat sich von Orten angemeldet, die in der erfassten Zeit nicht erreichbar sind. Klären Sie das mit der Person und prüfen Sie es im Sicherheitscenter." },
    { title: "تسجيلات دخول من مواقع متباعدة", summary: "سجّل الحساب نفسه الدخول من مواقع متباعدة يستحيل التنقل بينها في الوقت المسجّل. تأكد مع الشخص وراجع ذلك في مركز الأمان." },
  ),
  trusted_device_auto_invalidated: sc(
    "SIGN_IN_SECURITY",
    { title: "A trusted device was removed", summary: "A trusted device was removed automatically because it showed risky activity. The person will need to verify again on that device." },
    { title: "Ein vertrauenswürdiges Gerät wurde entfernt", summary: "Ein vertrauenswürdiges Gerät wurde wegen riskanter Aktivität automatisch entfernt. Die Person muss sich auf diesem Gerät erneut bestätigen." },
    { title: "أُزيل جهاز موثوق", summary: "أُزيل جهاز موثوق تلقائيًا لأنه أظهر نشاطًا محفوفًا بالمخاطر. سيحتاج الشخص إلى التحقق مجددًا على ذلك الجهاز." },
  ),
  geo_anomaly_detected: sc(
    "SIGN_IN_SECURITY",
    { title: "Unusual sign-in location", summary: "A sign-in came from an unusual location for this account. Review it in Security Center." },
    { title: "Ungewöhnlicher Anmeldeort", summary: "Eine Anmeldung kam von einem für dieses Konto ungewöhnlichen Ort. Prüfen Sie sie im Sicherheitscenter." },
    { title: "موقع تسجيل دخول غير معتاد", summary: "جاء تسجيل دخول من موقع غير معتاد لهذا الحساب. راجعه في مركز الأمان." },
  ),
  suspicious_session_detected: sc(
    "SIGN_IN_SECURITY",
    { title: "Suspicious session detected", summary: "An active session showed signs of risk. Review it in Security Center." },
    { title: "Verdächtige Sitzung erkannt", summary: "Eine aktive Sitzung zeigte Risikomerkmale. Prüfen Sie sie im Sicherheitscenter." },
    { title: "رُصدت جلسة مريبة", summary: "أظهرت جلسة نشطة علامات خطر. راجعها في مركز الأمان." },
  ),
  session_quarantined: sc(
    "SIGN_IN_SECURITY",
    { title: "A session was quarantined", summary: "A session was restricted because it showed signs of risk. Review it in Security Center to restore or end it." },
    { title: "Eine Sitzung wurde unter Quarantäne gestellt", summary: "Eine Sitzung wurde wegen Risikomerkmalen eingeschränkt. Prüfen Sie sie im Sicherheitscenter, um sie wiederherzustellen oder zu beenden." },
    { title: "عُزلت جلسة", summary: "قُيّدت جلسة لأنها أظهرت علامات خطر. راجعها في مركز الأمان لاستعادتها أو إنهائها." },
  ),
  // ---- directory and single sign-on ------------------------------------------------
  saml_certificate_expiring: sc(
    "DIRECTORY",
    { title: "Single sign-on certificate expiring", summary: "The signing certificate for this workspace's SAML single sign-on is expiring or has expired. Sign-ins will stop until it is rotated." },
    { title: "Zertifikat für Single Sign-on läuft ab", summary: "Das Signaturzertifikat für das SAML-Single-Sign-on dieses Arbeitsbereichs läuft ab oder ist abgelaufen. Anmeldungen funktionieren erst nach dem Austausch wieder." },
    { title: "شهادة تسجيل الدخول الموحّد على وشك الانتهاء", summary: "شهادة توقيع تسجيل الدخول الموحّد SAML لمساحة العمل هذه على وشك الانتهاء أو انتهت. ستتوقف تسجيلات الدخول حتى تُستبدل." },
  ),
  scim_account_link_denied: sc(
    "DIRECTORY",
    { title: "Directory account link refused", summary: "Your identity directory asked to link an account that could not be linked safely, so that person cannot sign in. Fix the account in the directory." },
    { title: "Kontoverknüpfung aus dem Verzeichnis abgelehnt", summary: "Ihr Identitätsverzeichnis wollte ein Konto verknüpfen, das nicht sicher verknüpft werden konnte; diese Person kann sich daher nicht anmelden. Korrigieren Sie das Konto im Verzeichnis." },
    { title: "رُفض ربط حساب من الدليل", summary: "طلب دليل الهوية ربط حساب تعذّر ربطه بأمان، لذا لا يستطيع ذلك الشخص تسجيل الدخول. أصلح الحساب في الدليل." },
  ),
  scim_user_provisioning_conflict: sc(
    "DIRECTORY",
    { title: "Directory provisioning conflict", summary: "Your identity directory asked to create an account that conflicts with an existing one, so that person cannot sign in. Fix the account in the directory." },
    { title: "Konflikt bei der Bereitstellung aus dem Verzeichnis", summary: "Ihr Identitätsverzeichnis wollte ein Konto anlegen, das mit einem bestehenden kollidiert; diese Person kann sich daher nicht anmelden. Korrigieren Sie das Konto im Verzeichnis." },
    { title: "تعارض في التزويد من الدليل", summary: "طلب دليل الهوية إنشاء حساب يتعارض مع حساب موجود، لذا لا يستطيع ذلك الشخص تسجيل الدخول. أصلح الحساب في الدليل." },
  ),
};

/** Any other event type (retired, or new and not yet reviewed) still reads as a sentence. */
const SECURITY_SIGNAL_FALLBACK: SecurityCopy = sc(
  "SIGN_IN_SECURITY",
  { title: "A security event needs review", summary: "A security event was recorded in this workspace. Review it in Security Center; the event type is listed under the technical references." },
  { title: "Ein Sicherheitsereignis muss geprüft werden", summary: "In diesem Arbeitsbereich wurde ein Sicherheitsereignis erfasst. Prüfen Sie es im Sicherheitscenter; der Ereignistyp steht unter den technischen Referenzen." },
  { title: "حدث أمني يحتاج إلى مراجعة", summary: "سُجّل حدث أمني في مساحة العمل هذه. راجعه في مركز الأمان؛ نوع الحدث مذكور ضمن المراجع التقنية." },
);

function securitySignalCopy(eventType: string): SecurityCopy {
  return Object.prototype.hasOwnProperty.call(SECURITY_SIGNAL_COPY, eventType)
    ? SECURITY_SIGNAL_COPY[eventType]!
    : SECURITY_SIGNAL_FALLBACK;
}

/** Every security event type with a reviewed sentence — for the completeness gate. */
export const SECURITY_SIGNAL_EVENT_TYPES: readonly string[] = Object.freeze(Object.keys(SECURITY_SIGNAL_COPY));

/** The subject a bridged security event is about (a workspace-level domain, never a raw code). */
export function securitySignalSubjectKind(eventType: string): ConditionSubjectKind {
  return securitySignalCopy(eventType).subject;
}

// ---------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------

const CATALOGUE = {
  // ---- identity -----------------------------------------------------------
  "ops.identity.runtime_block": def({
    // `action` is the internal privileged-action code: a technical reference,
    // never part of the sentence.
    params: { action: TOKEN, riskScore: INT },
    en: (p) => ({
      title: "A sensitive action was blocked",
      summary: `Adaptive sign-in protection blocked a sensitive action because the session's risk score was ${p.riskScore}.`,
    }),
    de: (p) => ({
      title: "Eine sensible Aktion wurde blockiert",
      summary: `Der adaptive Anmeldeschutz hat eine sensible Aktion blockiert, weil der Risikowert der Sitzung ${p.riskScore} betrug.`,
    }),
    ar: (p) => ({
      title: "حُظر إجراء حساس",
      summary: `حظرت حماية تسجيل الدخول التكيفية إجراءً حساسًا لأن درجة مخاطر الجلسة كانت ${iso(p.riskScore)}.`,
    }),
  }),
  "ops.identity.high_risk_session_surge": def({
    params: { count: INT },
    en: (p) => ({
      title: "High-risk sessions surge",
      summary: `Runtime risk checks found ${p.count} sessions at high risk or above in one sweep.`,
    }),
    de: (p) => ({
      title: "Anstieg risikoreicher Sitzungen",
      summary: `Die Laufzeit-Risikoprüfung hat in einem Durchlauf ${p.count} Sitzungen mit hohem oder höherem Risiko gefunden.`,
    }),
    ar: (p) => ({
      title: "ارتفاع في الجلسات عالية المخاطر",
      summary: `وجدت فحوص مخاطر وقت التشغيل ${iso(p.count)} جلسة بمستوى مخاطر مرتفع أو أعلى في مسح واحد.`,
    }),
  }),
  "ops.identity.idp_outage": def({
    params: { provider: TOKEN, failures: INT },
    en: (p) => ({
      title: "Identity provider outage",
      summary: `Sign-in through ${idpName("en", p.provider)} has failed ${p.failures} times in a row. People who sign in with it cannot reach this workspace until it recovers.`,
    }),
    de: (p) => ({
      title: "Ausfall des Identitätsanbieters",
      summary: `Die Anmeldung über ${idpName("de", p.provider)} ist ${p.failures}-mal hintereinander fehlgeschlagen. Wer sich darüber anmeldet, erreicht diesen Arbeitsbereich erst nach der Wiederherstellung.`,
    }),
    ar: (p) => ({
      title: "انقطاع مزوّد الهوية",
      summary: `أخفق تسجيل الدخول عبر ${idpName("ar", p.provider)} ${iso(p.failures)} مرات متتالية. لا يستطيع من يسجّل الدخول عبره الوصول إلى مساحة العمل حتى يتعافى.`,
    }),
  }),
  "ops.security.signal": def({
    // The bridge's one code. The SENTENCE comes from the reviewed per-event
    // table (SECURITY_SIGNAL_COPY); the event type, severity, workspace ref and
    // field names are technical references only and never part of the text.
    params: { eventType: TOKEN, severity: TOKEN, teamRef: OPT_REF, fields: OPT_TEXT },
    en: (p) => securitySignalCopy(p.eventType).en,
    de: (p) => securitySignalCopy(p.eventType).de,
    ar: (p) => securitySignalCopy(p.eventType).ar,
  }),

  // ---- integrations and billing -------------------------------------------
  "ops.integration.webhook_destination_disabled": def({
    params: { failures: INT },
    en: (p) => ({
      title: "Webhook destination disabled after repeated failures",
      summary: `Automation stopped delivering to this webhook destination after ${p.failures} consecutive failed deliveries. Fix the receiving endpoint, then re-enable the destination in Automation.`,
    }),
    de: (p) => ({
      title: "Webhook-Ziel nach wiederholten Fehlern deaktiviert",
      summary: `Die Automatisierung hat die Zustellung an dieses Webhook-Ziel nach ${p.failures} aufeinanderfolgenden fehlgeschlagenen Zustellungen eingestellt. Beheben Sie den Fehler am empfangenden Endpunkt und aktivieren Sie das Ziel anschließend in der Automatisierung wieder.`,
    }),
    ar: (p) => ({
      title: "عُطّلت وجهة Webhook بعد إخفاقات متكررة",
      summary: `أوقفت الأتمتة التسليم إلى وجهة Webhook هذه بعد ${iso(p.failures)} محاولات تسليم فاشلة متتالية. أصلح نقطة الاستقبال، ثم أعد تفعيل الوجهة من الأتمتة.`,
    }),
  }),
  "ops.billing.provider_authorization": def({
    // `operation` is the internal call that was refused: a technical reference.
    params: { provider: TOKEN, operation: TOKEN },
    en: (p) => ({
      title: `${paymentProviderName("en", p.provider)} refused our credentials`,
      summary: `${paymentProviderName("en", p.provider)} rejected the platform's credentials during a payment check. Payment states cannot be verified until the credentials are restored. No customer payment has been changed.`,
    }),
    de: (p) => ({
      title: `${paymentProviderName("de", p.provider)} hat unsere Zugangsdaten abgelehnt`,
      summary: `${paymentProviderName("de", p.provider)} hat die Zugangsdaten der Plattform bei einer Zahlungsprüfung abgelehnt. Zahlungsstatus können erst nach Wiederherstellung der Zugangsdaten geprüft werden. Keine Kundenzahlung wurde geändert.`,
    }),
    ar: (p) => ({
      title: `رفض ${paymentProviderName("ar", p.provider)} بيانات الاعتماد الخاصة بنا`,
      summary: `رفض ${paymentProviderName("ar", p.provider)} بيانات اعتماد المنصة أثناء فحص دفع. لا يمكن التحقق من حالات الدفع حتى تُستعاد بيانات الاعتماد. لم يُغيَّر أي دفع لأي عميل.`,
    }),
  }),
  "ops.billing.dependent_cancellation.ungrantable_manual": def({
    params: { payer: { kind: PAYERS } },
    en: (p) => ({
      title: "Ungranted storage add-on still billing — support needed",
      summary: `The payment provider activated a storage add-on that could not be added to this account. Automatic retries to stop it are exhausted and the provider has not confirmed it is stopped, so it may still be charging. Retry from Billing or contact support. ${PAYER_PHRASE.en[p.payer]}.`,
    }),
    de: (p) => ({
      title: "Nicht gewährte Speichererweiterung wird weiter abgerechnet — Support erforderlich",
      summary: `Der Zahlungsanbieter hat eine Speichererweiterung aktiviert, die diesem Konto nicht hinzugefügt werden konnte. Die automatischen Versuche, sie zu beenden, sind ausgeschöpft, und der Anbieter hat das Ende nicht bestätigt; sie wird möglicherweise weiter berechnet. Versuchen Sie es unter Abrechnung erneut oder wenden Sie sich an den Support. ${PAYER_PHRASE.de[p.payer]}.`,
    }),
    ar: (p) => ({
      title: "إضافة تخزين غير ممنوحة ما زالت تُفوتر — يلزم الدعم",
      summary: `فعّل مزوّد الدفع إضافة تخزين تعذّرت إضافتها إلى هذا الحساب. استُنفدت المحاولات التلقائية لإيقافها ولم يؤكد المزوّد إيقافها، لذا قد تستمر الرسوم. أعد المحاولة من الفوترة أو تواصل مع الدعم. ${PAYER_PHRASE.ar[p.payer]}.`,
    }),
  }),
  "ops.billing.dependent_cancellation.ungrantable_stopping": def({
    params: { payer: { kind: PAYERS } },
    en: (p) => ({
      title: "Ungranted storage add-on being stopped",
      summary: `The payment provider activated a storage add-on that could not be added to this account, so stopping it has been requested from the provider. It may still be charging until the provider confirms; PROOVRA retries automatically. ${PAYER_PHRASE.en[p.payer]}.`,
    }),
    de: (p) => ({
      title: "Nicht gewährte Speichererweiterung wird beendet",
      summary: `Der Zahlungsanbieter hat eine Speichererweiterung aktiviert, die diesem Konto nicht hinzugefügt werden konnte; ihre Beendigung wurde beim Anbieter beantragt. Bis zur Bestätigung durch den Anbieter wird sie möglicherweise weiter berechnet; PROOVRA versucht es automatisch erneut. ${PAYER_PHRASE.de[p.payer]}.`,
    }),
    ar: (p) => ({
      title: "جارٍ إيقاف إضافة تخزين غير ممنوحة",
      summary: `فعّل مزوّد الدفع إضافة تخزين تعذّرت إضافتها إلى هذا الحساب، لذا طُلب من المزوّد إيقافها. قد تستمر الرسوم حتى يؤكد المزوّد ذلك؛ يعيد PROOVRA المحاولة تلقائيًا. ${PAYER_PHRASE.ar[p.payer]}.`,
    }),
  }),
  "ops.billing.dependent_cancellation.pending": def({
    params: { payer: { kind: PAYERS } },
    en: (p) => ({
      title: "Storage add-on cancellation in progress",
      summary: `This storage add-on's plan was cancelled and stopping the add-on itself has been requested from the payment provider. It closes when the provider confirms. ${PAYER_PHRASE.en[p.payer]}.`,
    }),
    de: (p) => ({
      title: "Kündigung der Speichererweiterung läuft",
      summary: `Der Tarif dieser Speichererweiterung wurde gekündigt, und die Beendigung der Erweiterung selbst wurde beim Zahlungsanbieter beantragt. Die Meldung schließt sich, sobald der Anbieter bestätigt. ${PAYER_PHRASE.de[p.payer]}.`,
    }),
    ar: (p) => ({
      title: "إلغاء إضافة التخزين قيد التنفيذ",
      summary: `أُلغيت خطة إضافة التخزين هذه وطُلب من مزوّد الدفع إيقاف الإضافة نفسها. تُغلق الحالة عند تأكيد المزوّد. ${PAYER_PHRASE.ar[p.payer]}.`,
    }),
  }),
  "ops.billing.dependent_cancellation.retry_provider_unreachable": def({
    params: { payer: { kind: PAYERS } },
    en: (p) => ({
      title: "Storage add-on cancellation waiting for the payment provider",
      summary: `The payment provider could not be reached to stop this storage add-on. PROOVRA retries automatically; it may still be charging until the provider confirms. ${PAYER_PHRASE.en[p.payer]}.`,
    }),
    de: (p) => ({
      title: "Kündigung der Speichererweiterung wartet auf den Zahlungsanbieter",
      summary: `Der Zahlungsanbieter war nicht erreichbar, um diese Speichererweiterung zu beenden. PROOVRA versucht es automatisch erneut; bis zur Bestätigung durch den Anbieter wird sie möglicherweise weiter berechnet. ${PAYER_PHRASE.de[p.payer]}.`,
    }),
    ar: (p) => ({
      title: "إلغاء إضافة التخزين بانتظار مزوّد الدفع",
      summary: `تعذّر الوصول إلى مزوّد الدفع لإيقاف إضافة التخزين هذه. يعيد PROOVRA المحاولة تلقائيًا؛ قد تستمر الرسوم حتى يؤكد المزوّد. ${PAYER_PHRASE.ar[p.payer]}.`,
    }),
  }),
  "ops.billing.dependent_cancellation.retry": def({
    params: { payer: { kind: PAYERS } },
    en: (p) => ({
      title: "Storage add-on cancellation retrying",
      summary: `The payment provider has not confirmed this storage add-on is stopped. PROOVRA retries automatically; it may still be charging until the provider confirms. ${PAYER_PHRASE.en[p.payer]}.`,
    }),
    de: (p) => ({
      title: "Kündigung der Speichererweiterung wird wiederholt",
      summary: `Der Zahlungsanbieter hat die Beendigung dieser Speichererweiterung nicht bestätigt. PROOVRA versucht es automatisch erneut; bis zur Bestätigung durch den Anbieter wird sie möglicherweise weiter berechnet. ${PAYER_PHRASE.de[p.payer]}.`,
    }),
    ar: (p) => ({
      title: "إعادة محاولة إلغاء إضافة التخزين",
      summary: `لم يؤكد مزوّد الدفع إيقاف إضافة التخزين هذه. يعيد PROOVRA المحاولة تلقائيًا؛ قد تستمر الرسوم حتى يؤكد المزوّد. ${PAYER_PHRASE.ar[p.payer]}.`,
    }),
  }),
  "ops.billing.dependent_cancellation.manual": def({
    params: { payer: { kind: PAYERS } },
    en: (p) => ({
      title: "Storage add-on still billing — support needed",
      summary: `Automatic retries to stop this storage add-on are exhausted and the payment provider has not confirmed it is stopped, so it may still be charging. Retry from Billing or contact support. ${PAYER_PHRASE.en[p.payer]}.`,
    }),
    de: (p) => ({
      title: "Speichererweiterung wird weiter abgerechnet — Support erforderlich",
      summary: `Die automatischen Versuche, diese Speichererweiterung zu beenden, sind ausgeschöpft, und der Zahlungsanbieter hat das Ende nicht bestätigt; sie wird möglicherweise weiter berechnet. Versuchen Sie es unter Abrechnung erneut oder wenden Sie sich an den Support. ${PAYER_PHRASE.de[p.payer]}.`,
    }),
    ar: (p) => ({
      title: "إضافة التخزين ما زالت تُفوتر — يلزم الدعم",
      summary: `استُنفدت المحاولات التلقائية لإيقاف إضافة التخزين هذه ولم يؤكد مزوّد الدفع إيقافها، لذا قد تستمر الرسوم. أعد المحاولة من الفوترة أو تواصل مع الدعم. ${PAYER_PHRASE.ar[p.payer]}.`,
    }),
  }),
  "ops.billing.dependent_cancellation.unconfirmed": def({
    params: { payer: { kind: PAYERS } },
    en: (p) => ({
      title: "Storage add-on may still be billing",
      summary: `This storage add-on's plan was cancelled but the payment provider has not confirmed the add-on itself is stopped, so it may still be charging. Retry from Billing. ${PAYER_PHRASE.en[p.payer]}.`,
    }),
    de: (p) => ({
      title: "Speichererweiterung wird möglicherweise weiter abgerechnet",
      summary: `Der Tarif dieser Speichererweiterung wurde gekündigt, aber der Zahlungsanbieter hat die Beendigung der Erweiterung selbst nicht bestätigt; sie wird möglicherweise weiter berechnet. Versuchen Sie es unter Abrechnung erneut. ${PAYER_PHRASE.de[p.payer]}.`,
    }),
    ar: (p) => ({
      title: "قد تستمر فوترة إضافة التخزين",
      summary: `أُلغيت خطة إضافة التخزين هذه لكن مزوّد الدفع لم يؤكد إيقاف الإضافة نفسها، لذا قد تستمر الرسوم. أعد المحاولة من الفوترة. ${PAYER_PHRASE.ar[p.payer]}.`,
    }),
  }),

  // ---- aggregate pipeline / review backlogs -------------------------------
  "ops.pipeline.report_backlog": def({
    params: { high: INT, critical: INT },
    en: (p) => ({
      title: "Report generation backlog",
      summary: `Signed records in this workspace that are entitled to a report do not have one yet. This is high at ${p.high} records and critical at ${p.critical}.`,
    }),
    de: (p) => ({
      title: "Rückstau bei der Berichtserstellung",
      summary: `Signierte Datensätze in diesem Arbeitsbereich, denen ein Bericht zusteht, haben noch keinen. Hoch ab ${p.high} Datensätzen, kritisch ab ${p.critical}.`,
    }),
    ar: (p) => ({
      title: "تراكم في إنشاء التقارير",
      summary: `سجلات موقّعة في مساحة العمل هذه يحق لها تقرير ولا تملكه بعد. يكون الوضع مرتفعًا عند ${iso(p.high)} سجل وحرجًا عند ${iso(p.critical)}.`,
    }),
  }),
  "ops.pipeline.package_backlog": def({
    params: { high: INT, critical: INT },
    en: (p) => ({
      title: "Verification package backlog",
      summary: `Reported records in this workspace that are entitled to a verification package do not have one yet. This is high at ${p.high} records and critical at ${p.critical}.`,
    }),
    de: (p) => ({
      title: "Rückstau bei Verifizierungspaketen",
      summary: `Datensätze mit Bericht, denen ein Verifizierungspaket zusteht, haben noch keines. Hoch ab ${p.high} Datensätzen, kritisch ab ${p.critical}.`,
    }),
    ar: (p) => ({
      title: "تراكم في حزم التحقق",
      summary: `سجلات لها تقارير ويحق لها حزمة تحقق ولا تملكها بعد. يكون الوضع مرتفعًا عند ${iso(p.high)} سجل وحرجًا عند ${iso(p.critical)}.`,
    }),
  }),
  "ops.review.stale_workflows": def({
    params: { hours: INT },
    en: (p) => ({
      title: "Stale review workflows",
      summary: `Assigned, in-review or waiting-for-information reviews have not been worked on for ${p.hours} hours or more.`,
    }),
    de: (p) => ({
      title: "Liegengebliebene Prüfabläufe",
      summary: `Zugewiesene, laufende oder auf Rückmeldung wartende Prüfungen wurden seit ${p.hours} Stunden oder länger nicht bearbeitet.`,
    }),
    ar: (p) => ({
      title: "مسارات مراجعة راكدة",
      summary: `لم يُعمل على مراجعات مُسندة أو قيد المراجعة أو بانتظار معلومات منذ ${iso(p.hours)} ساعة أو أكثر.`,
    }),
  }),
  "ops.coordination.backlog_stale": def({
    params: { days: INT },
    en: (p) => ({
      title: "Coordination backlog",
      summary: `Reviewer comments, annotations and case comments have been unresolved for more than ${p.days} days.`,
    }),
    de: (p) => ({
      title: "Rückstau bei der Abstimmung",
      summary: `Kommentare von Prüfenden, Anmerkungen und Fallkommentare sind seit mehr als ${p.days} Tagen ungeklärt.`,
    }),
    ar: (p) => ({
      title: "تراكم في التنسيق",
      summary: `تعليقات المراجعين والتعليقات التوضيحية وتعليقات القضايا بلا حل منذ أكثر من ${iso(p.days)} يومًا.`,
    }),
  }),

  // ---- review -------------------------------------------------------------
  "ops.review.escalation": def({
    // `note` is what a person (or the caller) wrote. It is shown as written in
    // every locale: user-authored text is never machine-translated.
    params: { reason: TOKEN, note: TEXT },
    en: (p) => ({ title: `Review escalated: ${reasonPhrase("en", p.reason)}`, summary: p.note }),
    de: (p) => ({ title: `Prüfung eskaliert: ${reasonPhrase("de", p.reason)}`, summary: p.note }),
    ar: (p) => ({ title: `صُعّدت المراجعة: ${reasonPhrase("ar", p.reason)}`, summary: p.note }),
  }),
  "ops.review.escalation.overdue_auto": def({
    params: { reason: TOKEN },
    en: (p) => ({
      title: `Review escalated: ${reasonPhrase("en", p.reason)}`,
      summary: "The review is past its due time and was escalated automatically.",
    }),
    de: (p) => ({
      title: `Prüfung eskaliert: ${reasonPhrase("de", p.reason)}`,
      summary: "Die Prüfung ist überfällig und wurde automatisch eskaliert.",
    }),
    ar: (p) => ({
      title: `صُعّدت المراجعة: ${reasonPhrase("ar", p.reason)}`,
      summary: "تجاوزت المراجعة موعدها وصُعّدت تلقائيًا.",
    }),
  }),
  "ops.review.escalation.stuck_auto": def({
    params: { reason: TOKEN, stuck: { kind: STUCK_REASONS } },
    en: (p) => ({
      title: `Review escalated: ${reasonPhrase("en", p.reason)}`,
      summary: `The review is stuck (${STUCK_PHRASE.en[p.stuck].toLowerCase()}) and was escalated automatically.`,
    }),
    de: (p) => ({
      title: `Prüfung eskaliert: ${reasonPhrase("de", p.reason)}`,
      summary: `Die Prüfung hängt fest (${STUCK_PHRASE.de[p.stuck]}) und wurde automatisch eskaliert.`,
    }),
    ar: (p) => ({
      title: `صُعّدت المراجعة: ${reasonPhrase("ar", p.reason)}`,
      summary: `المراجعة عالقة (${STUCK_PHRASE.ar[p.stuck]}) وصُعّدت تلقائيًا.`,
    }),
  }),
  "ops.review.escalation_storm": def({
    params: { count: INT },
    en: (p) => ({
      title: "Review escalations surging",
      summary: `${p.count} reviews were escalated in a single check. Review workload distribution and review deadlines before the backlog grows.`,
    }),
    de: (p) => ({
      title: "Prüfeskalationen nehmen stark zu",
      summary: `In einer einzigen Prüfung wurden ${p.count} Prüfungen eskaliert. Prüfen Sie Arbeitsverteilung und Fristen, bevor der Rückstau wächst.`,
    }),
    ar: (p) => ({
      title: "تزايد حاد في تصعيدات المراجعة",
      summary: `صُعّدت ${iso(p.count)} مراجعة في فحص واحد. راجع توزيع عبء العمل ومهل المراجعة قبل أن يتراكم التأخير.`,
    }),
  }),

  // ---- governance ---------------------------------------------------------
  "ops.governance.destruction_executed": def({
    // The review and evidence ids are technical references.
    params: { reviewId: REF, evidenceId: REF },
    en: () => ({
      title: "Evidence destroyed",
      summary: "An approved destruction review was carried out and the record was destroyed. Its destruction certificate is kept in the governance history.",
    }),
    de: () => ({
      title: "Beweismittel vernichtet",
      summary: "Eine genehmigte Vernichtungsprüfung wurde ausgeführt und der Datensatz vernichtet. Das Vernichtungszertifikat bleibt in der Governance-Historie erhalten.",
    }),
    ar: () => ({
      title: "أُتلف الدليل",
      summary: "نُفّذت مراجعة إتلاف معتمدة وأُتلف السجل. تبقى شهادة الإتلاف محفوظة في سجل الحوكمة.",
    }),
  }),
  "ops.governance.notification.destruction_executed": def({
    params: { evidenceRef: REF, certificateRef: REF },
    en: (p) => ({
      title: "Destruction executed",
      summary: `Record ${p.evidenceRef} was destroyed and its destruction certificate was recorded.`,
    }),
    de: (p) => ({
      title: "Vernichtung ausgeführt",
      summary: `Datensatz ${p.evidenceRef} wurde vernichtet und sein Vernichtungszertifikat erfasst.`,
    }),
    ar: (p) => ({
      title: "نُفّذ الإتلاف",
      summary: `أُتلف السجل ${iso(p.evidenceRef)} وسُجّلت شهادة إتلافه.`,
    }),
  }),
  "ops.governance.notification.destruction_blocked": def({
    params: { cause: { kind: BLOCK_CAUSES } },
    en: (p) => ({
      title: "Destruction blocked at execution",
      summary:
        p.cause === "hold"
          ? "Destruction was blocked because a legal hold became active before execution."
          : "Destruction was blocked because the retention policy is immutable at execution time.",
    }),
    de: (p) => ({
      title: "Vernichtung bei der Ausführung gesperrt",
      summary:
        p.cause === "hold"
          ? "Die Vernichtung wurde gesperrt, weil vor der Ausführung eine gerichtliche Aufbewahrungspflicht wirksam wurde."
          : "Die Vernichtung wurde gesperrt, weil die Aufbewahrungsrichtlinie zum Ausführungszeitpunkt unveränderlich ist.",
    }),
    ar: (p) => ({
      title: "حُظر الإتلاف عند التنفيذ",
      summary:
        p.cause === "hold"
          ? "حُظر الإتلاف لأن حجزًا قانونيًا أصبح نشطًا قبل التنفيذ."
          : "حُظر الإتلاف لأن سياسة الاحتفاظ غير قابلة للتعديل وقت التنفيذ.",
    }),
  }),
  "ops.governance.notification.immutable_drift": def({
    params: { evidenceRef: REF, outcome: TOKEN },
    en: (p) => ({
      title: "Immutable storage drift detected",
      summary: `Storage for record ${p.evidenceRef} no longer matches its governance settings: ${driftPhrase("en", p.outcome)}.`,
    }),
    de: (p) => ({
      title: "Abweichung im unveränderlichen Speicher erkannt",
      summary: `Der Speicher für Datensatz ${p.evidenceRef} entspricht nicht mehr seinen Governance-Einstellungen: ${driftPhrase("de", p.outcome)}.`,
    }),
    ar: (p) => ({
      title: "رُصد انحراف في التخزين غير القابل للتعديل",
      summary: `لم يعد تخزين السجل ${iso(p.evidenceRef)} مطابقًا لإعدادات الحوكمة الخاصة به: ${driftPhrase("ar", p.outcome)}.`,
    }),
  }),
  "ops.governance.notification.destruction_pending": def({
    params: { evidenceRef: REF, reviewRef: REF },
    en: (p) => ({
      title: "Destruction review pending",
      summary: `Retention has expired on evidence ${p.evidenceRef}…; review #${p.reviewRef}…`,
    }),
    de: (p) => ({
      title: "Vernichtungsprüfung ausstehend",
      summary: `Die Aufbewahrungsfrist für Beweismittel ${p.evidenceRef}… ist abgelaufen; Prüfung #${p.reviewRef}…`,
    }),
    ar: (p) => ({
      title: "مراجعة الإتلاف معلقة",
      summary: `انتهت مدة الاحتفاظ بالدليل ${iso(`${p.evidenceRef}…`)}؛ المراجعة ${iso(`#${p.reviewRef}…`)}`,
    }),
  }),
  "ops.governance.notification.retention_blocked": def({
    params: { cause: { kind: ["immutable", "case_hold", "hold"] } },
    en: (p) => ({
      title: "Destruction blocked",
      summary:
        p.cause === "immutable"
          ? "Retention has expired but the policy is immutable. Operator must supersede the policy before destruction."
          : p.cause === "case_hold"
            ? "Retention has expired but the parent case is on legal hold."
            : "Retention has expired but the evidence is on legal hold.",
    }),
    de: (p) => ({
      title: "Vernichtung gesperrt",
      summary:
        p.cause === "immutable"
          ? "Die Aufbewahrungsfrist ist abgelaufen, aber die Richtlinie ist unveränderlich. Vor der Vernichtung muss die Richtlinie ersetzt werden."
          : p.cause === "case_hold"
            ? "Die Aufbewahrungsfrist ist abgelaufen, aber für den übergeordneten Fall gilt eine gerichtliche Aufbewahrungspflicht."
            : "Die Aufbewahrungsfrist ist abgelaufen, aber für das Beweismittel gilt eine gerichtliche Aufbewahrungspflicht.",
    }),
    ar: (p) => ({
      title: "حُظر الإتلاف",
      summary:
        p.cause === "immutable"
          ? "انتهت مدة الاحتفاظ لكن السياسة غير قابلة للتعديل. يجب استبدال السياسة قبل الإتلاف."
          : p.cause === "case_hold"
            ? "انتهت مدة الاحتفاظ لكن القضية الأم تخضع لحجز قانوني."
            : "انتهت مدة الاحتفاظ لكن الدليل يخضع لحجز قانوني.",
    }),
  }),
  "ops.governance.notification.retention_extended": def({
    params: { days: INT },
    en: (p) => ({
      title: "Retention auto-extended",
      summary: `Policy auto-extended retention by ${p.days} days following recent custody activity.`,
    }),
    de: (p) => ({
      title: "Aufbewahrung automatisch verlängert",
      summary: `Die Richtlinie hat die Aufbewahrung nach jüngster Verwahrungsaktivität automatisch um ${p.days} Tage verlängert.`,
    }),
    ar: (p) => ({
      title: "مُدّد الاحتفاظ تلقائيًا",
      summary: `مدّدت السياسة الاحتفاظ تلقائيًا ${iso(p.days)} يومًا بعد نشاط حيازة حديث.`,
    }),
  }),
  "ops.governance.notification.lifecycle_drift": def({
    params: {},
    en: () => ({
      title: "Lifecycle drift detected",
      summary: "A record is waiting for destruction, but the destruction review it points to is no longer current. A governance administrator should review it.",
    }),
    de: () => ({
      title: "Abweichung im Lebenszyklus erkannt",
      summary: "Ein Datensatz wartet auf die Vernichtung, aber die Vernichtungsprüfung, auf die er verweist, ist nicht mehr aktuell. Eine Governance-Administration sollte das prüfen.",
    }),
    ar: () => ({
      title: "رُصد انحراف في دورة الحياة",
      summary: "ينتظر سجل الإتلاف، لكن مراجعة الإتلاف التي يشير إليها لم تعد حالية. ينبغي لمسؤول الحوكمة مراجعتها.",
    }),
  }),
  "ops.storage.immutable_drift": def({
    // `detail` is the reconciler's own technical diagnosis (`db=… storage=…`):
    // a technical reference, never part of the sentence.
    params: { outcome: TOKEN, evidenceRef: REF, detail: OPT_TEXT },
    en: (p) => ({
      title: `Immutable storage drift: ${driftPhrase("en", p.outcome)}`,
      summary: `Storage for record ${p.evidenceRef} no longer matches its governance settings (${driftPhrase("en", p.outcome)}). The record's content is not affected.`,
    }),
    de: (p) => ({
      title: `Abweichung im unveränderlichen Speicher: ${driftPhrase("de", p.outcome)}`,
      summary: `Der Speicher für Datensatz ${p.evidenceRef} entspricht nicht mehr seinen Governance-Einstellungen (${driftPhrase("de", p.outcome)}). Der Inhalt des Datensatzes ist nicht betroffen.`,
    }),
    ar: (p) => ({
      title: `انحراف في التخزين غير القابل للتعديل: ${driftPhrase("ar", p.outcome)}`,
      summary: `لم يعد تخزين السجل ${iso(p.evidenceRef)} مطابقًا لإعدادات الحوكمة (${driftPhrase("ar", p.outcome)}). لم يتأثر محتوى السجل.`,
    }),
  }),

  // ---- evidence integrity --------------------------------------------------
  "ops.evidence_integrity.tsa_failed": def({
    params: { ...RECORD, failureClass: { kind: FAILURE_CLASSES } },
    en: (p) => ({
      title: `Trusted timestamp missing for ${recordLabel.en(p.recordTitle, p.recordRef)}`,
      summary: `This record has no trusted timestamp: ${FAILURE_CLASS_PHRASE.en[p.failureClass]}. It stays open until the record's timestamp is validated. Each affected record is tracked separately — this condition covers one record only.`,
    }),
    de: (p) => ({
      title: `Vertrauenswürdiger Zeitstempel fehlt für ${recordLabel.de(p.recordTitle, p.recordRef)}`,
      summary: `Dieser Datensatz hat keinen vertrauenswürdigen Zeitstempel: ${FAILURE_CLASS_PHRASE.de[p.failureClass]}. Die Meldung bleibt offen, bis der Zeitstempel validiert ist. Jeder betroffene Datensatz wird einzeln geführt — diese Meldung betrifft nur einen Datensatz.`,
    }),
    ar: (p) => ({
      title: `الختم الزمني الموثوق مفقود لـ ${recordLabel.ar(p.recordTitle, p.recordRef)}`,
      summary: `لا يملك هذا السجل ختمًا زمنيًا موثوقًا: ${FAILURE_CLASS_PHRASE.ar[p.failureClass]}. تبقى الحالة مفتوحة حتى يُتحقق من الختم الزمني للسجل. يُتتبّع كل سجل متأثر على حدة — تخص هذه الحالة سجلًا واحدًا فقط.`,
    }),
  }),
  "ops.evidence_integrity.ots_failed": def({
    params: { ...RECORD, failureClass: { kind: FAILURE_CLASSES } },
    en: (p) => ({
      title: `Blockchain anchor missing for ${recordLabel.en(p.recordTitle, p.recordRef)}`,
      summary: `This record has no public blockchain anchor: ${FAILURE_CLASS_PHRASE.en[p.failureClass]}. It stays open until the record's anchor is confirmed. Each affected record is tracked separately — this condition covers one record only.`,
    }),
    de: (p) => ({
      title: `Blockchain-Verankerung fehlt für ${recordLabel.de(p.recordTitle, p.recordRef)}`,
      summary: `Dieser Datensatz hat keine Verankerung in der öffentlichen Blockchain: ${FAILURE_CLASS_PHRASE.de[p.failureClass]}. Die Meldung bleibt offen, bis die Verankerung bestätigt ist. Jeder betroffene Datensatz wird einzeln geführt — diese Meldung betrifft nur einen Datensatz.`,
    }),
    ar: (p) => ({
      title: `ترسيخ سلسلة الكتل مفقود لـ ${recordLabel.ar(p.recordTitle, p.recordRef)}`,
      summary: `لا يملك هذا السجل ترسيخًا على سلسلة الكتل العامة: ${FAILURE_CLASS_PHRASE.ar[p.failureClass]}. تبقى الحالة مفتوحة حتى يُؤكَّد ترسيخ السجل. يُتتبّع كل سجل متأثر على حدة — تخص هذه الحالة سجلًا واحدًا فقط.`,
    }),
  }),
  "ops.evidence_integrity.ots_pending_aged": def({
    params: { ...RECORD, warningHours: INT, highHours: INT },
    en: (p) => ({
      title: `Blockchain anchoring still pending for ${recordLabel.en(p.recordTitle, p.recordRef)}`,
      summary:
        "This record's OpenTimestamps anchor has not settled within the workspace's anchoring window " +
        `(warning after ${p.warningHours}h, high after ${p.highHours}h). ` +
        "The record's own trusted timestamp is unaffected and the record remains valid evidence; " +
        "the public-chain anchor is a second, independent proof that is still outstanding. " +
        "The platform continues its own anchoring attempts on their existing schedule, and a recovery sweep re-schedules an upgrade whose schedule was lost; nothing here re-anchors or alters a proof.",
    }),
    de: (p) => ({
      title: `Blockchain-Verankerung für ${recordLabel.de(p.recordTitle, p.recordRef)} steht noch aus`,
      summary:
        "Die OpenTimestamps-Verankerung dieses Datensatzes hat sich nicht innerhalb des Verankerungsfensters des Arbeitsbereichs abgeschlossen " +
        `(Warnung nach ${p.warningHours} Std., hoch nach ${p.highHours} Std.). ` +
        "Der vertrauenswürdige Zeitstempel des Datensatzes ist nicht betroffen, und der Datensatz bleibt gültiges Beweismittel; " +
        "die Verankerung in der öffentlichen Blockchain ist ein zweiter, unabhängiger Nachweis, der noch aussteht. " +
        "Die Plattform setzt ihre Verankerungsversuche nach dem bestehenden Zeitplan fort, und ein Wiederherstellungslauf plant ein verlorenes Upgrade neu ein; hier wird kein Nachweis neu verankert oder verändert.",
    }),
    ar: (p) => ({
      title: `ترسيخ سلسلة الكتل ما زال معلقًا لـ ${recordLabel.ar(p.recordTitle, p.recordRef)}`,
      summary:
        `لم يكتمل ترسيخ ${iso("OpenTimestamps")} لهذا السجل ضمن نافذة الترسيخ في مساحة العمل ` +
        `(تحذير بعد ${iso(p.warningHours)} ساعة، ومرتفع بعد ${iso(p.highHours)} ساعة). ` +
        "لم يتأثر الختم الزمني الموثوق للسجل، ويبقى السجل دليلًا صالحًا؛ " +
        "الترسيخ على السلسلة العامة إثبات ثانٍ مستقل لم يكتمل بعد. " +
        "تواصل المنصة محاولات الترسيخ وفق جدولها القائم، ويعيد مسح الاستعادة جدولة أي ترقية فُقد جدولها؛ لا شيء هنا يعيد الترسيخ أو يغيّر أي إثبات.",
    }),
  }),
  "ops.evidence_integrity.ots_initialization_stalled": def({
    params: RECORD,
    en: (p) => ({
      title: `Blockchain anchoring has not started for ${recordLabel.en(p.recordTitle, p.recordRef)}`,
      summary:
        "This record was finalized and signed, but its OpenTimestamps anchoring has not begun. " +
        "The record's own trusted timestamp, signature and chain of custody are unaffected and it remains valid evidence; " +
        "the public-chain anchor is a second, independent proof that has not been requested yet. " +
        "The platform re-requests anchoring for records in this state automatically; nothing here retries, re-anchors or alters a proof.",
    }),
    de: (p) => ({
      title: `Blockchain-Verankerung für ${recordLabel.de(p.recordTitle, p.recordRef)} hat nicht begonnen`,
      summary:
        "Dieser Datensatz wurde abgeschlossen und signiert, aber seine OpenTimestamps-Verankerung hat nicht begonnen. " +
        "Vertrauenswürdiger Zeitstempel, Signatur und Beweismittelkette des Datensatzes sind nicht betroffen, und er bleibt gültiges Beweismittel; " +
        "die Verankerung in der öffentlichen Blockchain ist ein zweiter, unabhängiger Nachweis, der noch nicht angefordert wurde. " +
        "Die Plattform fordert die Verankerung für Datensätze in diesem Zustand automatisch erneut an; hier wird nichts wiederholt, neu verankert oder verändert.",
    }),
    ar: (p) => ({
      title: `لم يبدأ ترسيخ سلسلة الكتل لـ ${recordLabel.ar(p.recordTitle, p.recordRef)}`,
      summary:
        `اكتمل هذا السجل ووُقّع، لكن ترسيخ ${iso("OpenTimestamps")} الخاص به لم يبدأ. ` +
        "لم يتأثر الختم الزمني الموثوق للسجل ولا توقيعه ولا سلسلة حيازته، ويبقى دليلًا صالحًا؛ " +
        "الترسيخ على السلسلة العامة إثبات ثانٍ مستقل لم يُطلب بعد. " +
        "تعيد المنصة طلب الترسيخ تلقائيًا للسجلات في هذه الحالة؛ لا شيء هنا يعيد المحاولة أو يعيد الترسيخ أو يغيّر أي إثبات.",
    }),
  }),
  "ops.evidence_integrity.ots_budget_exhausted": def({
    params: { recordRef: REF },
    en: (p) => ({
      title: `Blockchain anchoring stopped — record ${p.recordRef}`,
      summary: "The record's public blockchain anchor did not confirm within the configured retry window, so no further anchoring attempts will be made. The record's trusted timestamp and signature are not affected.",
    }),
    de: (p) => ({
      title: `Blockchain-Verankerung beendet — Datensatz ${p.recordRef}`,
      summary: "Die Verankerung des Datensatzes in der öffentlichen Blockchain wurde innerhalb des konfigurierten Wiederholungsfensters nicht bestätigt; es folgen keine weiteren Versuche. Zeitstempel und Signatur des Datensatzes sind nicht betroffen.",
    }),
    ar: (p) => ({
      title: `توقف ترسيخ سلسلة الكتل — السجل ${iso(p.recordRef)}`,
      summary: "لم يتأكد ترسيخ السجل على سلسلة الكتل العامة ضمن نافذة الإعادة المضبوطة، لذا لن تُجرى محاولات ترسيخ أخرى. لم يتأثر الختم الزمني الموثوق للسجل ولا توقيعه.",
    }),
  }),

  // ---- report and package pipeline ----------------------------------------
  "ops.pipeline.report_generation_failed.retries_exhausted": def({
    // `errorClass` is the bounded failure code: a technical reference.
    params: { version: INT, recordRef: REF, errorClass: TOKEN },
    en: (p) => ({
      title: `Report v${p.version} stopped after its retries — record ${p.recordRef}`,
      summary: `Automatic retries for report version ${p.version} of this record were exhausted. The evidence is unaffected. An operator can recover or retry it from Operations; the condition clears only when report version ${p.version} exists.`,
    }),
    de: (p) => ({
      title: `Bericht v${p.version} nach Wiederholungen gestoppt — Datensatz ${p.recordRef}`,
      summary: `Die automatischen Wiederholungen für Berichtsversion ${p.version} dieses Datensatzes sind ausgeschöpft. Das Beweismittel ist nicht betroffen. Unter Betrieb kann sie wiederhergestellt oder erneut versucht werden; die Meldung schließt sich erst, wenn Berichtsversion ${p.version} existiert.`,
    }),
    ar: (p) => ({
      title: `توقف التقرير ${iso(`v${p.version}`)} بعد محاولات الإعادة — السجل ${iso(p.recordRef)}`,
      summary: `استُنفدت المحاولات التلقائية لإصدار التقرير ${iso(p.version)} لهذا السجل. لم يتأثر الدليل. يمكن لمشغّل استعادته أو إعادة محاولته من العمليات؛ لا تُغلق الحالة إلا عند وجود إصدار التقرير ${iso(p.version)}.`,
    }),
  }),
  "ops.pipeline.report_generation_failed.not_retriable": def({
    // `errorClass` is the bounded failure code: a technical reference.
    params: { version: INT, recordRef: REF, errorClass: TOKEN },
    en: (p) => ({
      title: `Report v${p.version} generation failed — record ${p.recordRef}`,
      summary: `Report version ${p.version} of this record could not be generated and will not be retried automatically. The evidence is unaffected. An operator can recover it from Operations; the condition clears only when report version ${p.version} exists.`,
    }),
    de: (p) => ({
      title: `Erstellung von Bericht v${p.version} fehlgeschlagen — Datensatz ${p.recordRef}`,
      summary: `Berichtsversion ${p.version} dieses Datensatzes konnte nicht erstellt werden und wird nicht automatisch wiederholt. Das Beweismittel ist nicht betroffen. Unter Betrieb kann sie wiederhergestellt werden; die Meldung schließt sich erst, wenn Berichtsversion ${p.version} existiert.`,
    }),
    ar: (p) => ({
      title: `أخفق إنشاء التقرير ${iso(`v${p.version}`)} — السجل ${iso(p.recordRef)}`,
      summary: `تعذّر إنشاء إصدار التقرير ${iso(p.version)} لهذا السجل ولن يُعاد تلقائيًا. لم يتأثر الدليل. يمكن لمشغّل استعادته من العمليات؛ لا تُغلق الحالة إلا عند وجود إصدار التقرير ${iso(p.version)}.`,
    }),
  }),
  "ops.pipeline.report_generation_failed.retry_budget_exhausted": def({
    params: { version: INT, recordRef: REF },
    en: (p) => ({
      title: `Report v${p.version} stopped after its retry budget was exhausted — record ${p.recordRef}`,
      summary: `Automatic retries for report version ${p.version} of this record were exhausted. An operator can review and retry it from Operations; the condition clears only when report version ${p.version} exists.`,
    }),
    de: (p) => ({
      title: `Bericht v${p.version} nach ausgeschöpftem Wiederholungsbudget gestoppt — Datensatz ${p.recordRef}`,
      summary: `Die automatischen Wiederholungen für Berichtsversion ${p.version} dieses Datensatzes sind ausgeschöpft. Unter Betrieb kann sie geprüft und erneut versucht werden; die Meldung schließt sich erst, wenn Berichtsversion ${p.version} existiert.`,
    }),
    ar: (p) => ({
      title: `توقف التقرير ${iso(`v${p.version}`)} بعد استنفاد ميزانية الإعادة — السجل ${iso(p.recordRef)}`,
      summary: `استُنفدت المحاولات التلقائية لإصدار التقرير ${iso(p.version)} لهذا السجل. يمكن لمشغّل مراجعته وإعادة محاولته من العمليات؛ لا تُغلق الحالة إلا عند وجود إصدار التقرير ${iso(p.version)}.`,
    }),
  }),
  // The fixed sentences the Operations truth reconciliation writes over a
  // legacy row whose stored text carried raw error detail (OPS-016).
  "ops.pipeline.report_generation_failed.sanitized": def({
    params: {},
    en: () => ({
      title: "Report generation failed",
      summary:
        "This record's report could not be generated. The evidence is unaffected. An operator can recover it from Operations; the condition clears only when the report exists.",
    }),
    de: () => ({
      title: "Berichtserstellung fehlgeschlagen",
      summary:
        "Der Bericht dieses Datensatzes konnte nicht erstellt werden. Das Beweismittel ist nicht betroffen. Unter Betrieb kann er wiederhergestellt werden; die Meldung schließt sich erst, wenn der Bericht existiert.",
    }),
    ar: () => ({
      title: "أخفق إنشاء التقرير",
      summary:
        "تعذّر إنشاء تقرير هذا السجل. لم يتأثر الدليل. يمكن لمشغّل استعادته من العمليات؛ لا تُغلق الحالة إلا عند وجود التقرير.",
    }),
  }),
  "ops.pipeline.package_generation_failed.sanitized": def({
    params: {},
    en: () => ({
      title: "Verification package generation failed",
      summary:
        "This record's verification package could not be generated. The evidence and its report are unaffected. An operator can recover it from Operations; the condition clears only when the package exists.",
    }),
    de: () => ({
      title: "Erstellung des Verifizierungspakets fehlgeschlagen",
      summary:
        "Das Verifizierungspaket dieses Datensatzes konnte nicht erstellt werden. Beweismittel und Bericht sind nicht betroffen. Unter Betrieb kann es wiederhergestellt werden; die Meldung schließt sich erst, wenn das Paket existiert.",
    }),
    ar: () => ({
      title: "أخفق إنشاء حزمة التحقق",
      summary:
        "تعذّر إنشاء حزمة التحقق لهذا السجل. لم يتأثر الدليل ولا تقريره. يمكن لمشغّل استعادتها من العمليات؛ لا تُغلق الحالة إلا عند وجود الحزمة.",
    }),
  }),
  "ops.pipeline.package_generation_failed.storage_rejected": def({
    params: { version: INT, recordRef: REF },
    en: (p) => ({
      title: `Verification package v${p.version} refused by object storage (${p.recordRef})`,
      summary: `Report version ${p.version} is stored, but object storage refused its verification package. Retrying the same request cannot succeed; after the storage configuration or worker is corrected, an operator can retry it from Operations. The evidence and the report are unaffected.`,
    }),
    de: (p) => ({
      title: `Verifizierungspaket v${p.version} vom Objektspeicher abgelehnt (${p.recordRef})`,
      summary: `Berichtsversion ${p.version} ist gespeichert, aber der Objektspeicher hat ihr Verifizierungspaket abgelehnt. Eine Wiederholung derselben Anfrage kann nicht gelingen; nach Korrektur der Speicherkonfiguration oder des Workers kann es unter Betrieb erneut versucht werden. Beweismittel und Bericht sind nicht betroffen.`,
    }),
    ar: (p) => ({
      title: `رفض تخزين الكائنات حزمة التحقق ${iso(`v${p.version}`)} (${iso(p.recordRef)})`,
      summary: `إصدار التقرير ${iso(p.version)} مخزّن، لكن تخزين الكائنات رفض حزمة التحقق الخاصة به. لا يمكن أن تنجح إعادة الطلب نفسه؛ بعد تصحيح إعدادات التخزين أو العامل، يمكن لمشغّل إعادة المحاولة من العمليات. لم يتأثر الدليل ولا التقرير.`,
    }),
  }),
  "ops.pipeline.package_generation_failed.failed": def({
    params: { version: INT, recordRef: REF },
    en: (p) => ({
      title: `Verification package v${p.version} generation failed (${p.recordRef})`,
      summary: `Report version ${p.version} is stored, but its verification package was not. The evidence and the report are unaffected; the pipeline retries, and the condition clears only when the package for version ${p.version} exists.`,
    }),
    de: (p) => ({
      title: `Erstellung von Verifizierungspaket v${p.version} fehlgeschlagen (${p.recordRef})`,
      summary: `Berichtsversion ${p.version} ist gespeichert, ihr Verifizierungspaket jedoch nicht. Beweismittel und Bericht sind nicht betroffen; die Verarbeitung wiederholt den Vorgang, und die Meldung schließt sich erst, wenn das Paket für Version ${p.version} existiert.`,
    }),
    ar: (p) => ({
      title: `أخفق إنشاء حزمة التحقق ${iso(`v${p.version}`)} (${iso(p.recordRef)})`,
      summary: `إصدار التقرير ${iso(p.version)} مخزّن، لكن حزمة التحقق الخاصة به لم تُخزَّن. لم يتأثر الدليل ولا التقرير؛ يعيد مسار المعالجة المحاولة، ولا تُغلق الحالة إلا عند وجود حزمة الإصدار ${iso(p.version)}.`,
    }),
  }),
  "ops.pipeline.package_generation_failed.retry_budget_exhausted": def({
    params: { version: INT, recordRef: REF },
    en: (p) => ({
      title: `Verification package v${p.version} stopped after its retry budget was exhausted — record ${p.recordRef}`,
      summary: `Automatic retries for the verification package of report version ${p.version} were exhausted. The report is stored. An operator can review and retry it from Operations; the condition clears only when the package for version ${p.version} exists.`,
    }),
    de: (p) => ({
      title: `Verifizierungspaket v${p.version} nach ausgeschöpftem Wiederholungsbudget gestoppt — Datensatz ${p.recordRef}`,
      summary: `Die automatischen Wiederholungen für das Verifizierungspaket von Berichtsversion ${p.version} sind ausgeschöpft. Der Bericht ist gespeichert. Unter Betrieb kann es geprüft und erneut versucht werden; die Meldung schließt sich erst, wenn das Paket für Version ${p.version} existiert.`,
    }),
    ar: (p) => ({
      title: `توقفت حزمة التحقق ${iso(`v${p.version}`)} بعد استنفاد ميزانية الإعادة — السجل ${iso(p.recordRef)}`,
      summary: `استُنفدت المحاولات التلقائية لحزمة التحقق الخاصة بإصدار التقرير ${iso(p.version)}. التقرير مخزّن. يمكن لمشغّل مراجعتها وإعادة محاولتها من العمليات؛ لا تُغلق الحالة إلا عند وجود حزمة الإصدار ${iso(p.version)}.`,
    }),
  }),
  "ops.pipeline.package_generation_denied": def({
    // `outcome` is the governance gate's code: shown only as its phrase.
    params: { outcome: { kind: PACKAGE_DENIAL_OUTCOMES } },
    en: (p) => ({
      title: "Verification package blocked",
      summary: `The verification package for this record was not built: ${PACKAGE_DENIAL_PHRASE.en[p.outcome]}.`,
    }),
    de: (p) => ({
      title: "Verifizierungspaket gesperrt",
      summary: `Das Verifizierungspaket für diesen Datensatz wurde nicht erstellt: ${PACKAGE_DENIAL_PHRASE.de[p.outcome]}.`,
    }),
    ar: (p) => ({
      title: "حُظرت حزمة التحقق",
      summary: `لم تُنشأ حزمة التحقق لهذا السجل: ${PACKAGE_DENIAL_PHRASE.ar[p.outcome]}.`,
    }),
  }),

  // ---- capture and upload --------------------------------------------------
  // ONE upload that stopped making progress: a real, still-incomplete upload
  // of a record that is neither finalized nor deleted (see the reconciler's
  // qualifying query). `minutes` is the configured inactivity threshold.
  "ops.capture.upload_stalled": def({
    params: { ...RECORD, minutes: INT },
    en: (p) => ({
      title: "Upload appears stalled",
      summary: `No upload progress has been recorded for ${minutesPhrase("en", p.minutes)} on ${recordLabel.en(p.recordTitle, p.recordRef)}. The person uploading can resume it from the record; if it is not resumed it is closed as abandoned. This condition closes on its own when the upload completes or is closed.`,
    }),
    de: (p) => ({
      title: "Upload scheint festzustecken",
      summary: `Seit ${minutesPhrase("de", p.minutes)} wurde für ${recordLabel.de(p.recordTitle, p.recordRef)} kein Upload-Fortschritt erfasst. Die hochladende Person kann ihn im Datensatz fortsetzen; ohne Fortsetzung wird er als abgebrochen geschlossen. Die Meldung schließt sich von selbst, wenn der Upload abgeschlossen oder geschlossen wird.`,
    }),
    ar: (p) => ({
      title: "يبدو أن الرفع متوقف",
      summary: `لم يُسجَّل أي تقدم في رفع ${recordLabel.ar(p.recordTitle, p.recordRef)} منذ ${minutesPhrase("ar", p.minutes)}. يمكن لمن يرفع الملف استئنافه من السجل؛ وإن لم يُستأنف يُغلق بوصفه متروكًا. تُغلق هذه الحالة تلقائيًا عند اكتمال الرفع أو إغلاقه.`,
    }),
  }),

  // ---- history -------------------------------------------------------------
  // The old per-workspace upload-session bridge row (2026-10-14). That bridge
  // filed upload-SESSION sweep signals for a whole workspace without naming an
  // upload or confirming a stall; a genuine stall is `ops.capture.upload_stalled`
  // under the Capture and upload source. History only: nothing writes this.
  "ops.legacy.upload_session_signal": def({
    params: {},
    en: () => ({
      title: "Legacy upload-session signal",
      summary: "Recorded by an earlier version of Operations, which grouped upload-session signals for this whole workspace into one condition. It named no upload, and it did not confirm that any upload was actually stalled. Uploads are now checked one at a time; a genuinely stalled upload appears as its own condition.",
    }),
    de: () => ({
      title: "Älteres Upload-Sitzungssignal",
      summary: "Von einer früheren Version von Operations erfasst, die Upload-Sitzungssignale dieses gesamten Arbeitsbereichs zu einer Meldung zusammenfasste. Sie nannte keinen Upload und bestätigte nicht, dass ein Upload tatsächlich feststeckte. Uploads werden jetzt einzeln geprüft; ein tatsächlich feststeckender Upload erscheint als eigene Meldung.",
    }),
    ar: () => ({
      title: "إشارة قديمة لجلسة رفع",
      summary: "سجّلها إصدار سابق من العمليات كان يجمع إشارات جلسات الرفع لمساحة العمل كلها في حالة واحدة. لم تسمِّ أي رفع، ولم تؤكد أن أي رفع كان متوقفًا فعلًا. تُفحص عمليات الرفع الآن كلٌّ على حدة؛ ويظهر الرفع المتوقف فعلًا كحالة مستقلة.",
    }),
  }),

  // ---- platform -----------------------------------------------------------
  "ops.platform.worker_heartbeat_stale": def({
    params: {},
    en: () => ({
      title: "Worker heartbeat stale",
      summary:
        "No live background worker has reported a heartbeat inside its liveness window. Report, package, anchoring and search work is not being processed.",
    }),
    de: () => ({
      title: "Worker-Lebenszeichen veraltet",
      summary:
        "Kein aktiver Hintergrund-Worker hat innerhalb seines Lebendigkeitsfensters ein Lebenszeichen gemeldet. Berichte, Pakete, Verankerung und Suche werden nicht verarbeitet.",
    }),
    ar: () => ({
      title: "نبضات العامل متأخرة",
      summary:
        "لم يُبلغ أي عامل خلفي نشط عن نبضة ضمن نافذة الحيوية الخاصة به. لا تجري معالجة التقارير والحزم والترسيخ والبحث.",
    }),
  }),
  "ops.job.background_failure": def({
    // `queue` is the queue's operator label: a technical name, untranslated.
    params: { queue: TEXT },
    en: (p) => ({
      title: `Background jobs failing: ${p.queue}`,
      summary: `Jobs on the ${p.queue} queue failed after exhausting their retries within the last hour. Inspect and replay eligible jobs in the platform queue console.`,
    }),
    de: (p) => ({
      title: `Hintergrundaufträge schlagen fehl: ${p.queue}`,
      summary: `Aufträge in der Warteschlange ${p.queue} sind in der letzten Stunde nach Ausschöpfen ihrer Wiederholungen fehlgeschlagen. Prüfen Sie geeignete Aufträge in der Warteschlangenkonsole der Plattform und spielen Sie sie erneut ein.`,
    }),
    ar: (p) => ({
      title: `مهام خلفية تفشل: ${iso(p.queue)}`,
      summary: `أخفقت مهام في طابور ${iso(p.queue)} بعد استنفاد محاولات الإعادة خلال الساعة الأخيرة. افحص المهام المؤهلة وأعد تشغيلها من وحدة تحكم الطوابير في المنصة.`,
    }),
  }),
  "ops.search.not_built": def({
    params: {},
    en: () => ({
      title: "Search index not built yet",
      summary:
        "This workspace's records have not been indexed for search yet — no indexing run has been recorded — so search may not find them until it runs. " +
        "Evidence records, proofs, reports and verification packages are unaffected. " +
        "The condition closes on its own once the index is proven complete.",
    }),
    de: () => ({
      title: "Suchindex noch nicht aufgebaut",
      summary:
        "Die Datensätze dieses Arbeitsbereichs wurden noch nicht für die Suche indexiert — es ist kein Indexierungslauf verzeichnet —, daher findet die Suche sie möglicherweise erst nach diesem Lauf. " +
        "Beweisdatensätze, Nachweise, Berichte und Verifizierungspakete sind nicht betroffen. " +
        "Die Meldung schließt sich von selbst, sobald der Index nachweislich vollständig ist.",
    }),
    ar: () => ({
      title: "لم يُبنَ فهرس البحث بعد",
      summary:
        "لم تُفهرس سجلات مساحة العمل هذه للبحث بعد — لم يُسجَّل أي تشغيل للفهرسة — لذا قد لا يجدها البحث حتى يجري ذلك. " +
        "لم تتأثر سجلات الأدلة ولا الإثباتات ولا التقارير ولا حزم التحقق. " +
        "تُغلق الحالة تلقائيًا بمجرد ثبوت اكتمال الفهرس.",
    }),
  }),
  "ops.search.reconciliation_failing": def({
    params: {},
    en: () => ({
      title: "Search index reconciliation failing",
      summary:
        "This workspace's search index is out of step with its records, and nothing is currently working to close the gap, " +
        "so search results may be missing or out of date. " +
        "Evidence records, proofs, reports and verification packages are unaffected. " +
        "The condition closes on its own once the index is proven complete.",
    }),
    de: () => ({
      title: "Abgleich des Suchindex schlägt fehl",
      summary:
        "Der Suchindex dieses Arbeitsbereichs stimmt nicht mit seinen Datensätzen überein, und derzeit arbeitet nichts daran, die Lücke zu schließen; " +
        "Suchergebnisse können daher fehlen oder veraltet sein. " +
        "Beweisdatensätze, Nachweise, Berichte und Verifizierungspakete sind nicht betroffen. " +
        "Die Meldung schließt sich von selbst, sobald der Index nachweislich vollständig ist.",
    }),
    ar: () => ({
      title: "مطابقة فهرس البحث تفشل",
      summary:
        "فهرس البحث في مساحة العمل هذه غير متوافق مع سجلاتها، ولا شيء يعمل حاليًا على سد الفجوة، " +
        "لذا قد تكون نتائج البحث ناقصة أو قديمة. " +
        "لم تتأثر سجلات الأدلة ولا الإثباتات ولا التقارير ولا حزم التحقق. " +
        "تُغلق الحالة تلقائيًا بمجرد ثبوت اكتمال الفهرس.",
    }),
  }),
  "ops.platform.operational_seed": def({
    // The seed run id and scenario are technical references.
    params: { seedRunId: REF, scenario: TOKEN },
    en: () => ({
      title: "Demonstration condition",
      summary: "This condition was created by the demonstration data tool to show how Operations works. It does not describe a real problem and is removed with the demonstration data.",
    }),
    de: () => ({
      title: "Demonstrationsmeldung",
      summary: "Diese Meldung wurde vom Demonstrationswerkzeug erstellt, um die Funktionsweise von Betrieb zu zeigen. Sie beschreibt kein echtes Problem und wird mit den Demonstrationsdaten entfernt.",
    }),
    ar: () => ({
      title: "حالة عرض توضيحي",
      summary: "أنشأت أداة بيانات العرض هذه الحالة لتوضيح طريقة عمل العمليات. لا تصف مشكلة حقيقية وتُزال مع بيانات العرض.",
    }),
  }),
} as const;

export type ConditionMessageCode = keyof typeof CATALOGUE;

type SpecOf<C extends ConditionMessageCode> = (typeof CATALOGUE)[C]["params"];

/** A code and its params, typed per code — a writer cannot omit or misname one. */
export type ConditionMessage = {
  [C in ConditionMessageCode]: { readonly code: C; readonly params: ConditionParamsOf<SpecOf<C>> };
}[ConditionMessageCode];

export const CONDITION_MESSAGE_CODES: readonly ConditionMessageCode[] = Object.freeze(
  Object.keys(CATALOGUE) as ConditionMessageCode[],
);

/**
 * WHICH SOURCE EACH MESSAGE MAY BE WRITTEN UNDER (2026-10-14).
 *
 * One table, read by both incident writers at the write boundary: a message
 * written under a source it does not belong to is normalized to its one
 * permitted source, or refused when it has several. This is what keeps a
 * signal from being filed as a different condition — the old bridge filed
 * upload-session stalls as an intake delivery failure. `ops.security.signal`
 * is the bridge's generic message; its exact source per event type is the
 * security-event classification, which the API checks first.
 */
const PIPELINE_REPORT = ["pipeline.report_generation_failed"] as const;
const PIPELINE_PACKAGE = ["pipeline.package_generation_failed"] as const;
const DEPENDENT_CANCELLATION = ["billing.dependent_cancellation_failed"] as const;
const GOVERNANCE_NOTICE = ["governance.notification_escalated"] as const;
const REVIEW_ESCALATION = ["review.escalation"] as const;
export const CONDITION_MESSAGE_SOURCES: Readonly<Record<ConditionMessageCode, readonly string[]>> = Object.freeze({
  "ops.identity.runtime_block": ["identity.runtime_block"],
  "ops.identity.high_risk_session_surge": ["identity.high_risk_session_surge"],
  "ops.identity.idp_outage": ["identity.idp_outage"],
  "ops.security.signal": [
    "identity.security_condition",
    "webhook.security_failure",
    "communications.provider_failure",
    "intake.delivery_failed",
  ],
  "ops.integration.webhook_destination_disabled": ["integration.webhook_destination_disabled"],
  "ops.billing.provider_authorization": ["billing.provider_authorization"],
  "ops.billing.dependent_cancellation.ungrantable_manual": DEPENDENT_CANCELLATION,
  "ops.billing.dependent_cancellation.ungrantable_stopping": DEPENDENT_CANCELLATION,
  "ops.billing.dependent_cancellation.pending": DEPENDENT_CANCELLATION,
  "ops.billing.dependent_cancellation.retry_provider_unreachable": DEPENDENT_CANCELLATION,
  "ops.billing.dependent_cancellation.retry": DEPENDENT_CANCELLATION,
  "ops.billing.dependent_cancellation.manual": DEPENDENT_CANCELLATION,
  "ops.billing.dependent_cancellation.unconfirmed": DEPENDENT_CANCELLATION,
  "ops.pipeline.report_backlog": ["pipeline.report_backlog"],
  "ops.pipeline.package_backlog": ["pipeline.package_backlog"],
  "ops.review.stale_workflows": ["review.stale_workflows"],
  "ops.coordination.backlog_stale": ["coordination.backlog_stale"],
  "ops.review.escalation": REVIEW_ESCALATION,
  "ops.review.escalation.overdue_auto": REVIEW_ESCALATION,
  "ops.review.escalation.stuck_auto": REVIEW_ESCALATION,
  "ops.review.escalation_storm": ["review.escalation_storm"],
  "ops.governance.destruction_executed": ["governance.destruction_executed"],
  "ops.governance.notification.destruction_executed": GOVERNANCE_NOTICE,
  "ops.governance.notification.destruction_blocked": GOVERNANCE_NOTICE,
  "ops.governance.notification.immutable_drift": GOVERNANCE_NOTICE,
  "ops.governance.notification.destruction_pending": GOVERNANCE_NOTICE,
  "ops.governance.notification.retention_blocked": GOVERNANCE_NOTICE,
  "ops.governance.notification.retention_extended": GOVERNANCE_NOTICE,
  "ops.governance.notification.lifecycle_drift": GOVERNANCE_NOTICE,
  "ops.storage.immutable_drift": ["storage.immutable_drift"],
  "ops.evidence_integrity.tsa_failed": ["evidence_integrity.tsa_failed"],
  "ops.evidence_integrity.ots_failed": ["evidence_integrity.ots_failed"],
  "ops.evidence_integrity.ots_pending_aged": ["evidence_integrity.ots_pending_aged"],
  "ops.evidence_integrity.ots_initialization_stalled": ["evidence_integrity.ots_initialization_stalled"],
  "ops.evidence_integrity.ots_budget_exhausted": ["evidence_integrity.ots_budget_exhausted"],
  "ops.pipeline.report_generation_failed.retries_exhausted": PIPELINE_REPORT,
  "ops.pipeline.report_generation_failed.not_retriable": PIPELINE_REPORT,
  "ops.pipeline.report_generation_failed.retry_budget_exhausted": PIPELINE_REPORT,
  "ops.pipeline.report_generation_failed.sanitized": PIPELINE_REPORT,
  "ops.pipeline.package_generation_failed.sanitized": PIPELINE_PACKAGE,
  "ops.pipeline.package_generation_failed.storage_rejected": PIPELINE_PACKAGE,
  "ops.pipeline.package_generation_failed.failed": PIPELINE_PACKAGE,
  "ops.pipeline.package_generation_failed.retry_budget_exhausted": PIPELINE_PACKAGE,
  "ops.pipeline.package_generation_denied": ["pipeline.package_generation_denied"],
  "ops.capture.upload_stalled": ["capture.upload_stalled"],
  "ops.legacy.upload_session_signal": ["capture.legacy_upload_session_signal"],
  "ops.platform.worker_heartbeat_stale": ["platform.worker_heartbeat_stale"],
  "ops.job.background_failure": ["job.background_failure"],
  "ops.search.not_built": ["search.indexing_failure"],
  "ops.search.reconciliation_failing": ["search.indexing_failure"],
  "ops.platform.operational_seed": ["platform.operational_seed"],
});

/** The sources a message may be written under (empty for an unknown code). */
export function permittedSourcesForMessage(code: string | null | undefined): readonly string[] {
  return isConditionMessageCode(code) ? CONDITION_MESSAGE_SOURCES[code] : [];
}

export function isConditionMessageCode(code: unknown): code is ConditionMessageCode {
  return typeof code === "string" && Object.prototype.hasOwnProperty.call(CATALOGUE, code);
}

// ---------------------------------------------------------------------------
// Param validation — what may be interpolated, and how much of it
// ---------------------------------------------------------------------------

const TOKEN_RE = /^[A-Za-z0-9_.:/-]{1,64}$/;
const REF_RE = /^[A-Za-z0-9_-]{1,64}$/;
const TEXT_MAX = 400;
/**
 * C0/C1 controls and every bidi mark, embedding, override and isolate
 * (U+200E, U+200F, U+202A–U+202E, U+2066–U+2069). A param cannot carry its own
 * direction marks: the catalogue alone decides direction. Named as code-point
 * ranges rather than embedded in a regex literal (no `no-control-regex`
 * suppression, nothing invisible in the source).
 */
function isUnsafeTextCode(code: number): boolean {
  return (
    code <= 0x1f ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0x200e ||
    code === 0x200f ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

/** Normalise free text for interpolation: no controls, no bidi marks, bounded. */
export function sanitizeConditionText(value: string): string {
  let clean = "";
  for (const ch of value) clean += isUnsafeTextCode(ch.codePointAt(0)!) ? " " : ch;
  return clean.replace(/\s+/g, " ").trim().slice(0, TEXT_MAX);
}

function validValue(decl: ParamDecl, raw: unknown): string | number | undefined {
  const kind = decl.kind;
  if (Array.isArray(kind)) {
    return typeof raw === "string" && (kind as readonly string[]).includes(raw) ? raw : undefined;
  }
  switch (kind) {
    case "int":
      return typeof raw === "number" && Number.isSafeInteger(raw) ? raw : undefined;
    case "token":
      return typeof raw === "string" && TOKEN_RE.test(raw) ? raw : undefined;
    case "ref":
      return typeof raw === "string" && REF_RE.test(raw) ? raw : undefined;
    case "text": {
      if (typeof raw !== "string") return undefined;
      const clean = sanitizeConditionText(raw);
      return clean.length > 0 ? clean : undefined;
    }
  }
  return undefined;
}

/**
 * Validate params against a code's declared shape. Returns the clean params,
 * or null when any declared param is missing or malformed, or any undeclared
 * key is present. Optional params may be absent or null.
 */
export function validateConditionParams(
  code: ConditionMessageCode,
  params: unknown,
): Record<string, string | number> | null {
  const spec = CATALOGUE[code].params as ParamSpec;
  const input = params == null ? {} : params;
  if (typeof input !== "object" || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!Object.prototype.hasOwnProperty.call(spec, key)) return null;
  }
  const out: Record<string, string | number> = {};
  for (const [name, decl] of Object.entries(spec)) {
    const raw = record[name];
    if (raw === undefined || raw === null) {
      if (decl.optional) continue;
      return null;
    }
    const v = validValue(decl, raw);
    if (v === undefined) return null;
    out[name] = v;
  }
  return out;
}

function render(locale: ConditionMessageLocale, code: ConditionMessageCode, params: Record<string, string | number>): Rendered {
  const entry = CATALOGUE[code] as unknown as MessageDef<ParamSpec>;
  return entry[locale](params as never);
}

// ---------------------------------------------------------------------------
// The writer side
// ---------------------------------------------------------------------------

export type StampedConditionMessage = {
  code: ConditionMessageCode;
  params: Record<string, string | number>;
  /** English, as stored in `title` / `safeSummary`. */
  title: string;
  summary: string;
};

/**
 * Validate a writer's message and render the English stored text from it.
 * Null when the message does not satisfy its code's shape — the writer then
 * records no code, and readers fall back to the stored text.
 */
export function stampConditionMessage(message: { code: string; params: unknown }): StampedConditionMessage | null {
  if (!isConditionMessageCode(message.code)) return null;
  const params = validateConditionParams(message.code, message.params);
  if (!params) return null;
  const en = render("en", message.code, params);
  return { code: message.code, params, title: en.title, summary: en.summary };
}

// ---------------------------------------------------------------------------
// The reader side
// ---------------------------------------------------------------------------

export function conditionMessageLocale(locale: string | null | undefined): ConditionMessageLocale {
  return locale === "de" || locale === "ar" ? locale : "en";
}

export type LocalizableCondition = {
  /** The title the server projected (already the source label where the source declares one). */
  title: string;
  safeSummary: string;
  /** The stored code and params, or null for a legacy row. */
  message?: { code: string | null; params: unknown } | null;
  /** The condition's source, and whether its title is that source's label. */
  sourceId?: string | null;
  titleSource?: "SOURCE_LABEL" | "CONDITION" | null;
};

export type LocalizedCondition = {
  title: string;
  summary: string;
  /** True when a catalogue entry (not the stored text) produced the summary. */
  localized: boolean;
};

/**
 * The ONE resolver every client uses. English renders the stored text; de/ar
 * render the catalogue when the stored code and params are valid, and the
 * stored English otherwise — never a raw key, never an empty string.
 */
export function localizeCondition(locale: string | null | undefined, c: LocalizableCondition): LocalizedCondition {
  const loc = conditionMessageLocale(locale);
  const code = c.message?.code ?? null;
  const params = code && isConditionMessageCode(code) ? validateConditionParams(code, c.message?.params) : null;
  const rendered = code && params && isConditionMessageCode(code) ? render(loc, code, params) : null;

  const sourceLabel =
    c.titleSource === "SOURCE_LABEL" && c.sourceId ? conditionSourceLabel(loc, c.sourceId) : null;
  const title = sourceLabel ?? rendered?.title ?? c.title;
  const summary = rendered?.summary ?? c.safeSummary;
  return {
    title: title.length > 0 ? title : c.title,
    summary: summary.length > 0 ? summary : c.safeSummary,
    localized: rendered !== null,
  };
}

// ---------------------------------------------------------------------------
// Source labels — the title of an AGGREGATE or RETIRED source, and of a group
// ---------------------------------------------------------------------------

const SOURCE_LABELS: Record<ConditionMessageLocale, Readonly<Record<string, string>>> = {
  en: {
    "evidence_integrity.tsa_failed": "Trusted timestamping failed",
    "evidence_integrity.ots_failed": "Blockchain anchoring failed",
    "evidence_integrity.ots_pending_aged": "Blockchain anchoring still pending",
    "evidence_integrity.ots_initialization_stalled": "Blockchain anchoring has not started",
    "pipeline.package_generation_failed": "Verification package generation failed",
    "evidence_integrity.ots_budget_exhausted": "Blockchain anchoring abandoned",
    "pipeline.report_backlog": "Report generation backlog",
    "pipeline.package_backlog": "Verification package backlog",
    "pipeline.signed_without_report_aged": "Uploaded evidence awaiting signing (retired)",
    "pipeline.report_generation_failed": "Report generation failed",
    "pipeline.package_generation_denied": "Verification package denied",
    "review.stale_workflows": "Stale review workflows",
    "review.escalation": "Review escalated",
    "review.escalation_storm": "Review escalations surging",
    "coordination.backlog_stale": "Coordination backlog",
    "queue.retry_storm": "Queue retry storm (retired)",
    "platform.telemetry_stale": "Queue telemetry sampler delayed (retired)",
    "platform.worker_heartbeat_stale": "Worker heartbeat stale",
    "intake.delivery_failed": "Uploads could not be started or resumed",
    "capture.upload_stalled": "Upload appears stalled",
    "capture.legacy_upload_session_signal": "Legacy upload-session signals",
    "communications.provider_failure": "Communications provider failure",
    "webhook.security_failure": "Webhook security event",
    "identity.security_condition": "Identity security condition",
    "governance.policy_condition": "Governance policy condition",
    "security.unclassified_signal": "Unclassified security signal (retired)",
    "identity.idp_outage": "Identity provider outage",
    "identity.runtime_block": "Sign-in blocked by runtime risk",
    "identity.high_risk_session_surge": "High-risk session surge",
    "governance.destruction_executed": "Evidence destruction executed",
    "governance.notification_escalated": "Governance notification escalated",
    "billing.provider_authorization": "Payment provider refused our credentials",
    "billing.dependent_cancellation_failed": "Storage add-on still billing after cancellation",
    "storage.immutable_drift": "Immutable storage drift",
    "platform.operational_seed": "Seeded demonstration condition",
    "search.indexing_failure": "Search index reconciliation failing",
    "integration.webhook_destination_disabled": "Webhook destination disabled after repeated failures",
    "integration.configuration_failure": "Integration configuration invalid",
    "job.background_failure": "Background jobs failing",
    "storage.condition": "Object storage condition",
    "database.condition": "Database condition",
    "ai.condition": "AI service condition",
    "unregistered.condition": "Unrecognised operational condition",
  },
  de: {
    "evidence_integrity.tsa_failed": "Vertrauenswürdiger Zeitstempel fehlgeschlagen",
    "evidence_integrity.ots_failed": "Blockchain-Verankerung fehlgeschlagen",
    "evidence_integrity.ots_pending_aged": "Blockchain-Verankerung steht noch aus",
    "evidence_integrity.ots_initialization_stalled": "Blockchain-Verankerung hat nicht begonnen",
    "pipeline.package_generation_failed": "Erstellung des Verifizierungspakets fehlgeschlagen",
    "evidence_integrity.ots_budget_exhausted": "Blockchain-Verankerung aufgegeben",
    "pipeline.report_backlog": "Rückstau bei der Berichtserstellung",
    "pipeline.package_backlog": "Rückstau bei Verifizierungspaketen",
    "pipeline.signed_without_report_aged": "Hochgeladene Beweismittel warten auf Signatur (eingestellt)",
    "pipeline.report_generation_failed": "Berichtserstellung fehlgeschlagen",
    "pipeline.package_generation_denied": "Verifizierungspaket abgelehnt",
    "review.stale_workflows": "Liegengebliebene Prüfabläufe",
    "review.escalation": "Prüfung eskaliert",
    "review.escalation_storm": "Prüfeskalationen nehmen stark zu",
    "coordination.backlog_stale": "Rückstau bei der Abstimmung",
    "queue.retry_storm": "Wiederholungswelle in der Warteschlange (eingestellt)",
    "platform.telemetry_stale": "Telemetrie der Warteschlangen verzögert (eingestellt)",
    "platform.worker_heartbeat_stale": "Worker-Lebenszeichen veraltet",
    "intake.delivery_failed": "Uploads konnten nicht gestartet oder fortgesetzt werden",
    "capture.upload_stalled": "Upload scheint festzustecken",
    "capture.legacy_upload_session_signal": "Ältere Upload-Sitzungssignale",
    "communications.provider_failure": "Störung beim Kommunikationsanbieter",
    "webhook.security_failure": "Sicherheitsereignis bei Webhook",
    "identity.security_condition": "Sicherheitsmeldung zur Identität",
    "governance.policy_condition": "Governance-Richtlinienmeldung",
    "security.unclassified_signal": "Nicht klassifiziertes Sicherheitssignal (eingestellt)",
    "identity.idp_outage": "Ausfall des Identitätsanbieters",
    "identity.runtime_block": "Anmeldung durch Laufzeitrisiko gesperrt",
    "identity.high_risk_session_surge": "Anstieg risikoreicher Sitzungen",
    "governance.destruction_executed": "Vernichtung von Beweismitteln ausgeführt",
    "governance.notification_escalated": "Governance-Benachrichtigung eskaliert",
    "billing.provider_authorization": "Zahlungsanbieter hat unsere Zugangsdaten abgelehnt",
    "billing.dependent_cancellation_failed": "Speichererweiterung wird nach Kündigung weiter abgerechnet",
    "storage.immutable_drift": "Abweichung im unveränderlichen Speicher",
    "platform.operational_seed": "Angelegte Demonstrationsmeldung",
    "search.indexing_failure": "Abgleich des Suchindex schlägt fehl",
    "integration.webhook_destination_disabled": "Webhook-Ziel nach wiederholten Fehlern deaktiviert",
    "integration.configuration_failure": "Integrationskonfiguration ungültig",
    "job.background_failure": "Hintergrundaufträge schlagen fehl",
    "storage.condition": "Meldung zum Objektspeicher",
    "database.condition": "Meldung zur Datenbank",
    "ai.condition": "Meldung zum KI-Dienst",
    "unregistered.condition": "Nicht erkannte Betriebsmeldung",
  },
  ar: {
    "evidence_integrity.tsa_failed": "أخفق الختم الزمني الموثوق",
    "evidence_integrity.ots_failed": "أخفق ترسيخ سلسلة الكتل",
    "evidence_integrity.ots_pending_aged": "ترسيخ سلسلة الكتل ما زال معلقًا",
    "evidence_integrity.ots_initialization_stalled": "لم يبدأ ترسيخ سلسلة الكتل",
    "pipeline.package_generation_failed": "أخفق إنشاء حزمة التحقق",
    "evidence_integrity.ots_budget_exhausted": "تُخلّي عن ترسيخ سلسلة الكتل",
    "pipeline.report_backlog": "تراكم في إنشاء التقارير",
    "pipeline.package_backlog": "تراكم في حزم التحقق",
    "pipeline.signed_without_report_aged": "أدلة مرفوعة بانتظار التوقيع (متوقف)",
    "pipeline.report_generation_failed": "أخفق إنشاء التقرير",
    "pipeline.package_generation_denied": "رُفضت حزمة التحقق",
    "review.stale_workflows": "مسارات مراجعة راكدة",
    "review.escalation": "صُعّدت المراجعة",
    "review.escalation_storm": "تزايد حاد في تصعيدات المراجعة",
    "coordination.backlog_stale": "تراكم في التنسيق",
    "queue.retry_storm": "موجة إعادة محاولات في الطابور (متوقف)",
    "platform.telemetry_stale": "تأخر قياس الطوابير (متوقف)",
    "platform.worker_heartbeat_stale": "نبضات العامل متأخرة",
    "intake.delivery_failed": "تعذّر بدء عمليات الرفع أو استئنافها",
    "capture.upload_stalled": "يبدو أن الرفع متوقف",
    "capture.legacy_upload_session_signal": "إشارات قديمة لجلسات الرفع",
    "communications.provider_failure": "عطل لدى مزوّد الاتصالات",
    "webhook.security_failure": "حدث أمني في Webhook",
    "identity.security_condition": "حالة أمنية للهوية",
    "governance.policy_condition": "حالة سياسة الحوكمة",
    "security.unclassified_signal": "إشارة أمنية غير مصنّفة (متوقف)",
    "identity.idp_outage": "انقطاع مزوّد الهوية",
    "identity.runtime_block": "حُظر تسجيل الدخول بسبب مخاطر وقت التشغيل",
    "identity.high_risk_session_surge": "ارتفاع في الجلسات عالية المخاطر",
    "governance.destruction_executed": "نُفّذ إتلاف الدليل",
    "governance.notification_escalated": "صُعّد إشعار حوكمة",
    "billing.provider_authorization": "رفض مزوّد الدفع بيانات الاعتماد الخاصة بنا",
    "billing.dependent_cancellation_failed": "إضافة التخزين ما زالت تُفوتر بعد الإلغاء",
    "storage.immutable_drift": "انحراف في التخزين غير القابل للتعديل",
    "platform.operational_seed": "حالة عرض تجريبية مُزوّدة",
    "search.indexing_failure": "مطابقة فهرس البحث تفشل",
    "integration.webhook_destination_disabled": "عُطّلت وجهة Webhook بعد إخفاقات متكررة",
    "integration.configuration_failure": "إعدادات التكامل غير صالحة",
    "job.background_failure": "مهام خلفية تفشل",
    "storage.condition": "حالة تخزين الكائنات",
    "database.condition": "حالة قاعدة البيانات",
    "ai.condition": "حالة خدمة الذكاء الاصطناعي",
    "unregistered.condition": "حالة تشغيلية غير معروفة",
  },
};

/** Every source id the catalogue labels — the completeness test compares it with the registry. */
export const CONDITION_SOURCE_LABEL_IDS: readonly string[] = Object.freeze(Object.keys(SOURCE_LABELS.en));

/** A source's label in a locale, or null for a source the catalogue does not know. */
export function conditionSourceLabel(locale: string | null | undefined, sourceId: string): string | null {
  const loc = conditionMessageLocale(locale);
  return SOURCE_LABELS[loc][sourceId] ?? null;
}

// ---------------------------------------------------------------------------
// Affected subject — WHAT a condition is about, as the server resolved it
// ---------------------------------------------------------------------------

/**
 * The closed set of things a condition can be about. The server resolves the
 * subject (authorized, tenant-bound) and sends its kind plus a safe name or
 * reference; clients render it here. A raw signal code is never a subject.
 */
export const CONDITION_SUBJECT_KINDS = [
  "EVIDENCE",
  "UPLOAD",
  "REPORT",
  "VERIFICATION_PACKAGE",
  "STORAGE_ADDON",
  "PAYMENT_PROVIDER",
  "WEBHOOK_DESTINATION",
  "IDENTITY_PROVIDER",
  "REVIEW_WORKFLOW",
  "REPORT_QUEUE",
  "PACKAGE_QUEUE",
  "REVIEW_QUEUE",
  "COORDINATION_QUEUE",
  "SEARCH_INDEX",
  "WORKER_FLEET",
  "JOB_QUEUE",
  "SIGN_IN_SECURITY",
  "DIRECTORY",
  "WEBHOOK_SIGNING",
  "WEBHOOK_DELIVERY",
  "MESSAGE_DELIVERY",
  "UPLOAD_SERVICE",
  "UPLOADS",
  "GOVERNANCE_NOTIFICATION",
  "DEMONSTRATION",
  "WORKSPACE",
] as const;
export type ConditionSubjectKind = (typeof CONDITION_SUBJECT_KINDS)[number];

/** The projection's subject: resolved, authorized, and never a raw code. */
export type ConditionSubject = {
  kind: ConditionSubjectKind;
  /** A safe display name (a record title, a file label, a product label), or null. */
  name: string | null;
  /** A short safe reference (an 8-character record ref), or null. */
  reference: string | null;
  /** The artifact version, for REPORT / VERIFICATION_PACKAGE. */
  version: number | null;
  /** AVAILABLE, UNAVAILABLE (deleted, expired or no longer reachable) or NOT_APPLICABLE. */
  state: "AVAILABLE" | "UNAVAILABLE" | "NOT_APPLICABLE";
};

type SubjectCopy = {
  /** The label prefix for a named subject ("Evidence"). */
  noun: L3;
  /** The whole label when there is no name ("This workspace's search index"). */
  standalone: L3;
  /** The truthful text when the subject is gone. */
  unavailable: L3;
};

const RECORD_UNAVAILABLE: L3 = {
  en: "The affected record is no longer available",
  de: "Der betroffene Datensatz ist nicht mehr verfügbar",
  ar: "السجل المتأثر لم يعد متاحًا",
};

const SUBJECT_COPY: Record<ConditionSubjectKind, SubjectCopy> = {
  EVIDENCE: {
    noun: { en: "Evidence", de: "Beweismittel", ar: "الدليل" },
    standalone: { en: "An evidence record", de: "Ein Beweisdatensatz", ar: "سجل دليل" },
    unavailable: RECORD_UNAVAILABLE,
  },
  UPLOAD: {
    noun: { en: "Upload", de: "Upload", ar: "الرفع" },
    standalone: { en: "An upload", de: "Ein Upload", ar: "عملية رفع" },
    unavailable: { en: "The affected upload is no longer available", de: "Der betroffene Upload ist nicht mehr verfügbar", ar: "عملية الرفع المتأثرة لم تعد متاحة" },
  },
  REPORT: {
    noun: { en: "Report", de: "Bericht", ar: "التقرير" },
    standalone: { en: "A report", de: "Ein Bericht", ar: "تقرير" },
    unavailable: RECORD_UNAVAILABLE,
  },
  VERIFICATION_PACKAGE: {
    noun: { en: "Verification package", de: "Verifizierungspaket", ar: "حزمة التحقق" },
    standalone: { en: "A verification package", de: "Ein Verifizierungspaket", ar: "حزمة تحقق" },
    unavailable: RECORD_UNAVAILABLE,
  },
  STORAGE_ADDON: {
    noun: { en: "Storage add-on", de: "Speichererweiterung", ar: "إضافة التخزين" },
    standalone: { en: "A storage add-on", de: "Eine Speichererweiterung", ar: "إضافة تخزين" },
    unavailable: { en: "The affected storage add-on is no longer available", de: "Die betroffene Speichererweiterung ist nicht mehr verfügbar", ar: "إضافة التخزين المتأثرة لم تعد متاحة" },
  },
  PAYMENT_PROVIDER: {
    noun: { en: "Payment provider", de: "Zahlungsanbieter", ar: "مزوّد الدفع" },
    standalone: { en: "The payment provider", de: "Der Zahlungsanbieter", ar: "مزوّد الدفع" },
    unavailable: { en: "The payment provider is no longer configured", de: "Der Zahlungsanbieter ist nicht mehr eingerichtet", ar: "مزوّد الدفع لم يعد مُعدًّا" },
  },
  WEBHOOK_DESTINATION: {
    noun: { en: "Webhook destination", de: "Webhook-Ziel", ar: "وجهة Webhook" },
    standalone: { en: "A webhook destination", de: "Ein Webhook-Ziel", ar: "وجهة Webhook" },
    unavailable: { en: "The affected webhook destination is no longer available", de: "Das betroffene Webhook-Ziel ist nicht mehr verfügbar", ar: "وجهة Webhook المتأثرة لم تعد متاحة" },
  },
  IDENTITY_PROVIDER: {
    noun: { en: "Identity provider", de: "Identitätsanbieter", ar: "مزوّد الهوية" },
    standalone: { en: "An identity provider connection", de: "Eine Verbindung zum Identitätsanbieter", ar: "اتصال مزوّد هوية" },
    unavailable: { en: "The affected sign-in connection is no longer available", de: "Die betroffene Anmeldeverbindung ist nicht mehr verfügbar", ar: "اتصال تسجيل الدخول المتأثر لم يعد متاحًا" },
  },
  REVIEW_WORKFLOW: {
    noun: { en: "Review", de: "Prüfung", ar: "المراجعة" },
    standalone: { en: "A review", de: "Eine Prüfung", ar: "مراجعة" },
    unavailable: { en: "The affected review is no longer available", de: "Die betroffene Prüfung ist nicht mehr verfügbar", ar: "المراجعة المتأثرة لم تعد متاحة" },
  },
  REPORT_QUEUE: workspaceWide({ en: "This workspace's reports", de: "Berichte dieses Arbeitsbereichs", ar: "تقارير مساحة العمل هذه" }),
  PACKAGE_QUEUE: workspaceWide({ en: "This workspace's verification packages", de: "Verifizierungspakete dieses Arbeitsbereichs", ar: "حزم التحقق في مساحة العمل هذه" }),
  REVIEW_QUEUE: workspaceWide({ en: "This workspace's reviews", de: "Prüfungen dieses Arbeitsbereichs", ar: "مراجعات مساحة العمل هذه" }),
  COORDINATION_QUEUE: workspaceWide({ en: "This workspace's open comments", de: "Offene Kommentare dieses Arbeitsbereichs", ar: "التعليقات المفتوحة في مساحة العمل هذه" }),
  SEARCH_INDEX: workspaceWide({ en: "This workspace's search index", de: "Suchindex dieses Arbeitsbereichs", ar: "فهرس البحث في مساحة العمل هذه" }),
  WORKER_FLEET: workspaceWide({ en: "Background processing", de: "Hintergrundverarbeitung", ar: "المعالجة في الخلفية" }),
  JOB_QUEUE: {
    noun: { en: "Queue", de: "Warteschlange", ar: "الطابور" },
    standalone: { en: "A background queue", de: "Eine Hintergrund-Warteschlange", ar: "طابور خلفي" },
    unavailable: { en: "The affected queue is no longer available", de: "Die betroffene Warteschlange ist nicht mehr verfügbar", ar: "الطابور المتأثر لم يعد متاحًا" },
  },
  SIGN_IN_SECURITY: workspaceWide({ en: "Sign-in security in this workspace", de: "Anmeldesicherheit in diesem Arbeitsbereich", ar: "أمان تسجيل الدخول في مساحة العمل هذه" }),
  DIRECTORY: workspaceWide({ en: "Single sign-on and directory", de: "Single Sign-on und Verzeichnis", ar: "تسجيل الدخول الموحّد والدليل" }),
  WEBHOOK_SIGNING: workspaceWide({ en: "Incoming webhook signatures", de: "Signaturen eingehender Webhooks", ar: "توقيعات Webhook الواردة" }),
  WEBHOOK_DELIVERY: workspaceWide({ en: "Webhook deliveries", de: "Webhook-Zustellungen", ar: "تسليمات Webhook" }),
  MESSAGE_DELIVERY: workspaceWide({ en: "Message delivery", de: "Nachrichtenzustellung", ar: "تسليم الرسائل" }),
  UPLOAD_SERVICE: workspaceWide({ en: "The upload service", de: "Der Upload-Dienst", ar: "خدمة الرفع" }),
  UPLOADS: workspaceWide({ en: "Uploads in this workspace", de: "Uploads in diesem Arbeitsbereich", ar: "عمليات الرفع في مساحة العمل هذه" }),
  GOVERNANCE_NOTIFICATION: {
    noun: { en: "Governance notice", de: "Governance-Hinweis", ar: "إشعار الحوكمة" },
    standalone: { en: "A governance notice", de: "Ein Governance-Hinweis", ar: "إشعار حوكمة" },
    unavailable: RECORD_UNAVAILABLE,
  },
  DEMONSTRATION: workspaceWide({ en: "Demonstration data", de: "Demonstrationsdaten", ar: "بيانات العرض" }),
  WORKSPACE: workspaceWide({ en: "This workspace", de: "Dieser Arbeitsbereich", ar: "مساحة العمل هذه" }),
};

function workspaceWide(label: L3): SubjectCopy {
  return { noun: label, standalone: label, unavailable: label };
}

const VERSION_WORD: L3 = { en: "version", de: "Version", ar: "الإصدار" };
const RECORD_WORD: L3 = { en: "record", de: "Datensatz", ar: "السجل" };

/**
 * The affected-subject label in a locale. A named subject reads
 * "Evidence: Roof damage" / "Report: version 2 of record 9f1d2c3b"; a
 * workspace-wide one reads as its own phrase; a gone one says so truthfully.
 * Never a raw code, never an empty string.
 */
export function conditionSubjectLabel(locale: string | null | undefined, subject: ConditionSubject | null | undefined): string | null {
  if (!subject || !(CONDITION_SUBJECT_KINDS as readonly string[]).includes(subject.kind)) return null;
  const loc = conditionMessageLocale(locale);
  const copy = SUBJECT_COPY[subject.kind];
  if (subject.state === "UNAVAILABLE") return copy.unavailable[loc];
  const name = subject.name ? sanitizeConditionText(subject.name) : "";
  const ref = subject.reference && REF_RE.test(subject.reference) ? subject.reference : "";
  const what = name || (ref ? `${RECORD_WORD[loc]} ${loc === "ar" ? iso(ref) : ref}` : "");
  if ((subject.kind === "REPORT" || subject.kind === "VERIFICATION_PACKAGE") && subject.version != null) {
    const v = loc === "ar" ? iso(subject.version) : String(subject.version);
    return what
      ? `${copy.noun[loc]}: ${VERSION_WORD[loc]} ${v} — ${loc === "ar" && name ? iso(what) : what}`
      : `${copy.noun[loc]}: ${VERSION_WORD[loc]} ${v}`;
  }
  if (copy.noun === copy.standalone) return copy.standalone[loc];
  if (!what) return copy.standalone[loc];
  return `${copy.noun[loc]}: ${loc === "ar" && name ? iso(what) : what}`;
}

// ---------------------------------------------------------------------------
// Technical references — the raw codes, for support only
// ---------------------------------------------------------------------------

/**
 * The closed set of technical references a condition may carry. These are the
 * ONLY place a signal code, an enum or a bounded reason code reaches a reader,
 * and they are labelled as what they are.
 */
export const CONDITION_TECHNICAL_REFERENCE_KEYS = [
  "signalCode",
  "messageCode",
  "sourceId",
  "evidenceId",
  "jobId",
  "requestId",
  "traceId",
  "errorClass",
  "outcome",
  "reason",
  "action",
  "provider",
  "operation",
  "scenario",
  "seedRunId",
  "reviewId",
  "detail",
] as const;
export type ConditionTechnicalReferenceKey = (typeof CONDITION_TECHNICAL_REFERENCE_KEYS)[number];
/** One identifier for support, shown only under Technical references. */
export type ConditionTechnicalReference = { key: ConditionTechnicalReferenceKey; value: string };

const TECHNICAL_REFERENCE_LABELS: Record<ConditionTechnicalReferenceKey, L3> = {
  signalCode: { en: "Signal code", de: "Signalcode", ar: "رمز الإشارة" },
  messageCode: { en: "Message code", de: "Meldungscode", ar: "رمز الرسالة" },
  sourceId: { en: "Source", de: "Quelle", ar: "المصدر" },
  evidenceId: { en: "Evidence ID", de: "Beweismittel-ID", ar: "معرّف الدليل" },
  jobId: { en: "Job", de: "Auftrag", ar: "المهمة" },
  requestId: { en: "Request", de: "Anfrage", ar: "الطلب" },
  traceId: { en: "Trace", de: "Ablaufverfolgung", ar: "التتبع" },
  errorClass: { en: "Error code", de: "Fehlercode", ar: "رمز الخطأ" },
  outcome: { en: "Outcome code", de: "Ergebniscode", ar: "رمز النتيجة" },
  reason: { en: "Reason code", de: "Grundcode", ar: "رمز السبب" },
  action: { en: "Action code", de: "Aktionscode", ar: "رمز الإجراء" },
  provider: { en: "Provider code", de: "Anbietercode", ar: "رمز المزوّد" },
  operation: { en: "Operation code", de: "Vorgangscode", ar: "رمز العملية" },
  scenario: { en: "Scenario", de: "Szenario", ar: "السيناريو" },
  seedRunId: { en: "Demonstration run", de: "Demonstrationslauf", ar: "تشغيل العرض" },
  reviewId: { en: "Review ID", de: "Prüfungs-ID", ar: "معرّف المراجعة" },
  detail: { en: "Diagnostic", de: "Diagnose", ar: "التشخيص" },
};

/** A technical reference's label in a locale; an unknown key is labelled generically, never echoed. */
export function conditionTechnicalReferenceLabel(locale: string | null | undefined, key: string): string {
  const loc = conditionMessageLocale(locale);
  return (Object.prototype.hasOwnProperty.call(TECHNICAL_REFERENCE_LABELS, key)
    ? TECHNICAL_REFERENCE_LABELS[key as ConditionTechnicalReferenceKey]
    : { en: "Reference", de: "Referenz", ar: "مرجع" })[loc];
}

/** The catalogue's own completeness, for tests: every code renders in every locale. */
export function conditionMessageCatalogueLocales(): readonly ConditionMessageLocale[] {
  return ["en", "de", "ar"];
}

/** Test seam: render a code directly (validates params first). */
export function renderConditionMessage(
  locale: ConditionMessageLocale,
  code: string,
  params: unknown,
): Rendered | null {
  if (!isConditionMessageCode(code)) return null;
  const clean = validateConditionParams(code, params);
  return clean ? render(locale, code, clean) : null;
}
