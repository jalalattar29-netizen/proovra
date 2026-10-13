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
 *   - English always renders the stored text: it is what the writer recorded.
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
// The catalogue
// ---------------------------------------------------------------------------

const CATALOGUE = {
  // ---- identity -----------------------------------------------------------
  "ops.identity.runtime_block": def({
    params: { action: TOKEN, riskScore: INT },
    en: (p) => ({
      title: `Runtime block — ${p.action}`,
      summary: `Adaptive auth blocked a ${p.action} attempt with risk score ${p.riskScore}.`,
    }),
    de: (p) => ({
      title: `Laufzeitsperre — ${p.action}`,
      summary: `Die adaptive Authentifizierung hat einen Versuch „${p.action}“ mit Risikowert ${p.riskScore} blockiert.`,
    }),
    ar: (p) => ({
      title: `حظر وقت التشغيل — ${iso(p.action)}`,
      summary: `حظرت المصادقة التكيفية محاولة ${iso(p.action)} بدرجة مخاطر ${iso(p.riskScore)}.`,
    }),
  }),
  "ops.identity.high_risk_session_surge": def({
    params: { count: INT },
    en: (p) => ({
      title: `High-risk sessions surge (${p.count})`,
      summary: `Runtime risk recompute detected ${p.count} sessions at HIGH+ risk in one sweep.`,
    }),
    de: (p) => ({
      title: "Anstieg risikoreicher Sitzungen",
      summary: `Die Neuberechnung des Laufzeitrisikos hat in einem Durchlauf ${p.count} Sitzungen mit Risiko HIGH oder höher erkannt.`,
    }),
    ar: (p) => ({
      title: "ارتفاع في الجلسات عالية المخاطر",
      summary: `رصدت إعادة حساب مخاطر وقت التشغيل ${iso(p.count)} جلسة بمستوى مخاطر HIGH أو أعلى في مسح واحد.`,
    }),
  }),
  "ops.identity.idp_outage": def({
    params: { provider: TOKEN, failures: INT },
    en: (p) => ({
      title: `IdP outage — ${p.provider}`,
      summary: `Identity provider ${p.provider} has produced ${p.failures} consecutive callback failures.`,
    }),
    de: (p) => ({
      title: `Ausfall des Identitätsanbieters — ${p.provider}`,
      summary: `Der Identitätsanbieter ${p.provider} hat ${p.failures} aufeinanderfolgende fehlgeschlagene Rückmeldungen erzeugt.`,
    }),
    ar: (p) => ({
      title: `انقطاع مزوّد الهوية — ${iso(p.provider)}`,
      summary: `أنتج مزوّد الهوية ${iso(p.provider)} عدد ${iso(p.failures)} من إخفاقات الاستدعاء المتتالية.`,
    }),
  }),
  "ops.security.signal": def({
    params: { eventType: TOKEN, severity: TOKEN, teamRef: OPT_REF, fields: OPT_TEXT },
    en: (p) => ({
      title: `Security signal: ${p.eventType}`,
      summary: [
        `Severity ${p.severity}`,
        ...(p.teamRef ? [`team ${p.teamRef}…`] : []),
        ...(p.fields ? [`fields: ${p.fields}`] : []),
      ].join(" · "),
    }),
    de: (p) => ({
      title: `Sicherheitssignal: ${p.eventType}`,
      summary: [
        `Schweregrad ${p.severity}`,
        ...(p.teamRef ? [`Arbeitsbereich ${p.teamRef}…`] : []),
        ...(p.fields ? [`Felder: ${p.fields}`] : []),
      ].join(" · "),
    }),
    ar: (p) => ({
      title: `إشارة أمنية: ${iso(p.eventType)}`,
      summary: [
        `الخطورة ${iso(p.severity)}`,
        ...(p.teamRef ? [`مساحة العمل ${iso(`${p.teamRef}…`)}`] : []),
        ...(p.fields ? [`الحقول: ${iso(p.fields)}`] : []),
      ].join(" · "),
    }),
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
    params: { provider: TOKEN, operation: TOKEN },
    en: (p) => ({
      title: `${p.provider} refused our credentials`,
      summary: `${p.provider} answered 401/403 during ${p.operation}. Payment states cannot be verified until the credential is restored. No customer payment has been changed.`,
    }),
    de: (p) => ({
      title: `${p.provider} hat unsere Zugangsdaten abgelehnt`,
      summary: `${p.provider} hat bei ${p.operation} mit 401/403 geantwortet. Zahlungsstatus können erst wieder geprüft werden, wenn die Zugangsdaten wiederhergestellt sind. Keine Kundenzahlung wurde geändert.`,
    }),
    ar: (p) => ({
      title: `رفض ${iso(p.provider)} بيانات الاعتماد الخاصة بنا`,
      summary: `أجاب ${iso(p.provider)} بالرمز ${iso("401/403")} أثناء ${iso(p.operation)}. لا يمكن التحقق من حالات الدفع حتى تُستعاد بيانات الاعتماد. لم يُغيَّر أي دفع لأي عميل.`,
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
      summary: `Signed evidence records that are entitled to a report in this workspace have none. Source: Evidence(status=SIGNED, latestReportVersion=null), narrowed to records whose plan or funding includes a report. HIGH at ${p.high}, CRITICAL at ${p.critical}.`,
    }),
    de: (p) => ({
      title: "Rückstau bei der Berichtserstellung",
      summary: `Signierte Beweisdatensätze in diesem Arbeitsbereich, denen ein Bericht zusteht, haben keinen. Quelle: Evidence(status=SIGNED, latestReportVersion=null), eingeschränkt auf Datensätze, deren Tarif oder Finanzierung einen Bericht umfasst. HIGH ab ${p.high}, CRITICAL ab ${p.critical}.`,
    }),
    ar: (p) => ({
      title: "تراكم في إنشاء التقارير",
      summary: `سجلات أدلة موقّعة في مساحة العمل هذه يحق لها تقرير ولا تملك أيًّا. المصدر: ${iso("Evidence(status=SIGNED, latestReportVersion=null)")}، مقصورًا على السجلات التي تشمل خطتها أو تمويلها تقريرًا. ${iso("HIGH")} عند ${iso(p.high)}، و${iso("CRITICAL")} عند ${iso(p.critical)}.`,
    }),
  }),
  "ops.pipeline.package_backlog": def({
    params: { high: INT, critical: INT },
    en: (p) => ({
      title: "Verification package backlog",
      summary: `Reported evidence records that are entitled to a verification package have none. Source: Evidence(status=REPORTED, verificationPackageVersion=null), narrowed to records whose plan or funding includes a package. HIGH at ${p.high}, CRITICAL at ${p.critical}.`,
    }),
    de: (p) => ({
      title: "Rückstau bei Verifizierungspaketen",
      summary: `Beweisdatensätze mit Bericht, denen ein Verifizierungspaket zusteht, haben keines. Quelle: Evidence(status=REPORTED, verificationPackageVersion=null), eingeschränkt auf Datensätze, deren Tarif oder Finanzierung ein Paket umfasst. HIGH ab ${p.high}, CRITICAL ab ${p.critical}.`,
    }),
    ar: (p) => ({
      title: "تراكم في حزم التحقق",
      summary: `سجلات أدلة لها تقارير ويحق لها حزمة تحقق ولا تملك أيًّا. المصدر: ${iso("Evidence(status=REPORTED, verificationPackageVersion=null)")}، مقصورًا على السجلات التي تشمل خطتها أو تمويلها حزمة. ${iso("HIGH")} عند ${iso(p.high)}، و${iso("CRITICAL")} عند ${iso(p.critical)}.`,
    }),
  }),
  "ops.review.stale_workflows": def({
    params: { hours: INT },
    en: (p) => ({
      title: "Stale review workflows",
      summary: `Assigned, in-review or needs-info review workflows have not been touched in ${p.hours}h or more. Source: EvidenceReviewWorkflow.updatedAt.`,
    }),
    de: (p) => ({
      title: "Liegengebliebene Prüfabläufe",
      summary: `Zugewiesene, in Prüfung befindliche oder auf Rückmeldung wartende Prüfabläufe wurden seit ${p.hours} Std. oder länger nicht bearbeitet. Quelle: EvidenceReviewWorkflow.updatedAt.`,
    }),
    ar: (p) => ({
      title: "مسارات مراجعة راكدة",
      summary: `لم تُلمس مسارات مراجعة مُسندة أو قيد المراجعة أو بانتظار معلومات منذ ${iso(p.hours)} ساعة أو أكثر. المصدر: ${iso("EvidenceReviewWorkflow.updatedAt")}.`,
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
    en: (p) => ({ title: `Reviewer escalation — ${p.reason}`, summary: p.note }),
    de: (p) => ({ title: `Eskalation der Prüfung — ${p.reason}`, summary: p.note }),
    ar: (p) => ({ title: `تصعيد مراجعة — ${iso(p.reason)}`, summary: p.note }),
  }),
  "ops.review.escalation.overdue_auto": def({
    params: { reason: TOKEN },
    en: (p) => ({
      title: `Reviewer escalation — ${p.reason}`,
      summary: "Review past due — automatic escalation by reviewer ops reconcile.",
    }),
    de: (p) => ({
      title: `Eskalation der Prüfung — ${p.reason}`,
      summary: "Prüfung überfällig — automatische Eskalation durch den Abgleich der Prüfprozesse.",
    }),
    ar: (p) => ({
      title: `تصعيد مراجعة — ${iso(p.reason)}`,
      summary: "تجاوزت المراجعة موعدها — تصعيد تلقائي من مطابقة عمليات المراجعة.",
    }),
  }),
  "ops.review.escalation.stuck_auto": def({
    params: { reason: TOKEN, stuck: { kind: STUCK_REASONS } },
    en: (p) => ({
      title: `Reviewer escalation — ${p.reason}`,
      summary: `Workflow stuck — ${STUCK_PHRASE.en[p.stuck]}. Automatic escalation by reviewer ops reconcile.`,
    }),
    de: (p) => ({
      title: `Eskalation der Prüfung — ${p.reason}`,
      summary: `Ablauf hängt fest — ${STUCK_PHRASE.de[p.stuck]}. Automatische Eskalation durch den Abgleich der Prüfprozesse.`,
    }),
    ar: (p) => ({
      title: `تصعيد مراجعة — ${iso(p.reason)}`,
      summary: `المسار عالق — ${STUCK_PHRASE.ar[p.stuck]}. تصعيد تلقائي من مطابقة عمليات المراجعة.`,
    }),
  }),
  "ops.review.escalation_storm": def({
    params: { count: INT },
    en: (p) => ({
      title: "Reviewer escalation storm",
      summary: `Reviewer reconcile created ${p.count} escalations in a single sweep. Investigate workload distribution and SLA policy before escalation backlog grows.`,
    }),
    de: (p) => ({
      title: "Welle von Prüfeskalationen",
      summary: `Der Abgleich der Prüfprozesse hat in einem einzigen Durchlauf ${p.count} Eskalationen erzeugt. Prüfen Sie Arbeitsverteilung und Fristenrichtlinie, bevor der Eskalationsrückstau wächst.`,
    }),
    ar: (p) => ({
      title: "موجة تصعيدات المراجعة",
      summary: `أنشأت مطابقة المراجعة ${iso(p.count)} تصعيدًا في مسح واحد. افحص توزيع عبء العمل وسياسة المهل قبل أن يتراكم التصعيد.`,
    }),
  }),

  // ---- governance ---------------------------------------------------------
  "ops.governance.destruction_executed": def({
    params: { reviewId: REF, evidenceId: REF },
    en: (p) => ({
      title: "Evidence destroyed",
      summary: `Destruction review ${p.reviewId} executed for evidence ${p.evidenceId}`,
    }),
    de: (p) => ({
      title: "Beweismittel vernichtet",
      summary: `Vernichtungsprüfung ${p.reviewId} für Beweismittel ${p.evidenceId} ausgeführt`,
    }),
    ar: (p) => ({
      title: "أُتلف الدليل",
      summary: `نُفّذت مراجعة الإتلاف ${iso(p.reviewId)} للدليل ${iso(p.evidenceId)}`,
    }),
  }),
  "ops.governance.notification.destruction_executed": def({
    params: { evidenceRef: REF, certificateRef: REF },
    en: (p) => ({
      title: "Destruction executed",
      summary: `Evidence ${p.evidenceRef}… was destroyed. Certificate ${p.certificateRef}…`,
    }),
    de: (p) => ({
      title: "Vernichtung ausgeführt",
      summary: `Beweismittel ${p.evidenceRef}… wurde vernichtet. Zertifikat ${p.certificateRef}…`,
    }),
    ar: (p) => ({
      title: "نُفّذ الإتلاف",
      summary: `أُتلف الدليل ${iso(`${p.evidenceRef}…`)}. الشهادة ${iso(`${p.certificateRef}…`)}`,
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
      summary: `Storage layer disagrees with DB on evidence ${p.evidenceRef}… (outcome=${p.outcome}).`,
    }),
    de: (p) => ({
      title: "Abweichung im unveränderlichen Speicher erkannt",
      summary: `Die Speicherschicht weicht bei Beweismittel ${p.evidenceRef}… von der Datenbank ab (outcome=${p.outcome}).`,
    }),
    ar: (p) => ({
      title: "رُصد انحراف في التخزين غير القابل للتعديل",
      summary: `طبقة التخزين لا تطابق قاعدة البيانات للدليل ${iso(`${p.evidenceRef}…`)} (${iso(`outcome=${p.outcome}`)}).`,
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
      summary: "Evidence is PENDING_DESTRUCTION but its active destruction review pointer is stale.",
    }),
    de: () => ({
      title: "Abweichung im Lebenszyklus erkannt",
      summary: "Das Beweismittel steht auf PENDING_DESTRUCTION, aber der Verweis auf seine aktive Vernichtungsprüfung ist veraltet.",
    }),
    ar: () => ({
      title: "رُصد انحراف في دورة الحياة",
      summary: `حالة الدليل ${iso("PENDING_DESTRUCTION")} لكن مؤشر مراجعة الإتلاف النشطة الخاص به قديم.`,
    }),
  }),
  "ops.storage.immutable_drift": def({
    // `detail` is the reconciler's own technical diagnosis (`db=… storage=…`);
    // it is a technical value and is shown untranslated.
    params: { outcome: TOKEN, evidenceRef: REF, detail: OPT_TEXT },
    en: (p) => ({
      title: `Immutable storage drift: ${p.outcome}`,
      summary: p.detail ?? `Drift outcome ${p.outcome} on evidence ${p.evidenceRef}…`,
    }),
    de: (p) => ({
      title: `Abweichung im unveränderlichen Speicher: ${p.outcome}`,
      summary: `Abweichung ${p.outcome} bei Beweismittel ${p.evidenceRef}…${p.detail ? ` (${p.detail})` : ""}`,
    }),
    ar: (p) => ({
      title: `انحراف في التخزين غير القابل للتعديل: ${iso(p.outcome)}`,
      summary: `انحراف ${iso(p.outcome)} في الدليل ${iso(`${p.evidenceRef}…`)}${p.detail ? ` (${iso(p.detail)})` : ""}`,
    }),
  }),

  // ---- evidence integrity --------------------------------------------------
  "ops.evidence_integrity.tsa_failed": def({
    params: { ...RECORD, failureClass: { kind: FAILURE_CLASSES } },
    en: (p) => ({
      title: `RFC3161 timestamp missing for ${recordLabel.en(p.recordTitle, p.recordRef)}`,
      summary: `This record has no RFC3161 timestamp: ${FAILURE_CLASS_PHRASE.en[p.failureClass]}. It stays unresolved until the record's timestamp is validated. Each affected record is tracked separately — this condition covers one record only.`,
    }),
    de: (p) => ({
      title: `RFC3161-Zeitstempel fehlt für ${recordLabel.de(p.recordTitle, p.recordRef)}`,
      summary: `Dieser Datensatz hat keinen RFC3161-Zeitstempel: ${FAILURE_CLASS_PHRASE.de[p.failureClass]}. Die Meldung bleibt offen, bis der Zeitstempel des Datensatzes validiert ist. Jeder betroffene Datensatz wird einzeln geführt — diese Meldung betrifft nur einen Datensatz.`,
    }),
    ar: (p) => ({
      title: `الختم الزمني ${iso("RFC3161")} مفقود لـ ${recordLabel.ar(p.recordTitle, p.recordRef)}`,
      summary: `لا يملك هذا السجل ختمًا زمنيًا ${iso("RFC3161")}: ${FAILURE_CLASS_PHRASE.ar[p.failureClass]}. تبقى الحالة دون حل حتى يُتحقق من الختم الزمني للسجل. يُتتبّع كل سجل متأثر على حدة — تخص هذه الحالة سجلًا واحدًا فقط.`,
    }),
  }),
  "ops.evidence_integrity.ots_failed": def({
    params: { ...RECORD, failureClass: { kind: FAILURE_CLASSES } },
    en: (p) => ({
      title: `OpenTimestamps anchor missing for ${recordLabel.en(p.recordTitle, p.recordRef)}`,
      summary: `This record has no OpenTimestamps anchor: ${FAILURE_CLASS_PHRASE.en[p.failureClass]}. It stays unresolved until the record's OpenTimestamps proof is anchored. Each affected record is tracked separately — this condition covers one record only.`,
    }),
    de: (p) => ({
      title: `OpenTimestamps-Verankerung fehlt für ${recordLabel.de(p.recordTitle, p.recordRef)}`,
      summary: `Dieser Datensatz hat keine OpenTimestamps-Verankerung: ${FAILURE_CLASS_PHRASE.de[p.failureClass]}. Die Meldung bleibt offen, bis der OpenTimestamps-Nachweis des Datensatzes verankert ist. Jeder betroffene Datensatz wird einzeln geführt — diese Meldung betrifft nur einen Datensatz.`,
    }),
    ar: (p) => ({
      title: `ترسيخ ${iso("OpenTimestamps")} مفقود لـ ${recordLabel.ar(p.recordTitle, p.recordRef)}`,
      summary: `لا يملك هذا السجل ترسيخ ${iso("OpenTimestamps")}: ${FAILURE_CLASS_PHRASE.ar[p.failureClass]}. تبقى الحالة دون حل حتى يُرسَّخ إثبات ${iso("OpenTimestamps")} للسجل. يُتتبّع كل سجل متأثر على حدة — تخص هذه الحالة سجلًا واحدًا فقط.`,
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
      title: `OTS anchoring gave up (${p.recordRef})`,
      summary:
        "Global budget exhausted: the OpenTimestamps proof did not anchor on the public chain within the configured retry budget — no further attempts will be made.",
    }),
    de: (p) => ({
      title: `OTS-Verankerung aufgegeben (${p.recordRef})`,
      summary:
        "Gesamtbudget ausgeschöpft: Der OpenTimestamps-Nachweis wurde innerhalb des konfigurierten Wiederholungsbudgets nicht in der öffentlichen Blockchain verankert — es folgen keine weiteren Versuche.",
    }),
    ar: (p) => ({
      title: `تُخلّي عن ترسيخ ${iso("OTS")} (${iso(p.recordRef)})`,
      summary: `استُنفدت الميزانية الإجمالية: لم يُرسَّخ إثبات ${iso("OpenTimestamps")} على السلسلة العامة ضمن ميزانية الإعادة المضبوطة — لن تُجرى محاولات أخرى.`,
    }),
  }),

  // ---- report and package pipeline ----------------------------------------
  "ops.pipeline.report_generation_failed.retries_exhausted": def({
    params: { version: INT, recordRef: REF, errorClass: TOKEN },
    en: (p) => ({
      title: `Report v${p.version} stopped after its retries — record ${p.recordRef}`,
      summary: `Automatic retries for report version ${p.version} of this record were exhausted (${p.errorClass}). The evidence is unaffected. An operator can recover or retry it from Operations; the condition clears only when report version ${p.version} exists.`,
    }),
    de: (p) => ({
      title: `Bericht v${p.version} nach Wiederholungen gestoppt — Datensatz ${p.recordRef}`,
      summary: `Die automatischen Wiederholungen für Berichtsversion ${p.version} dieses Datensatzes sind ausgeschöpft (${p.errorClass}). Das Beweismittel ist nicht betroffen. Unter Betrieb kann sie wiederhergestellt oder erneut versucht werden; die Meldung schließt sich erst, wenn Berichtsversion ${p.version} existiert.`,
    }),
    ar: (p) => ({
      title: `توقف التقرير ${iso(`v${p.version}`)} بعد محاولات الإعادة — السجل ${iso(p.recordRef)}`,
      summary: `استُنفدت المحاولات التلقائية لإصدار التقرير ${iso(p.version)} لهذا السجل (${iso(p.errorClass)}). لم يتأثر الدليل. يمكن لمشغّل استعادته أو إعادة محاولته من العمليات؛ لا تُغلق الحالة إلا عند وجود إصدار التقرير ${iso(p.version)}.`,
    }),
  }),
  "ops.pipeline.report_generation_failed.not_retriable": def({
    params: { version: INT, recordRef: REF, errorClass: TOKEN },
    en: (p) => ({
      title: `Report v${p.version} generation failed — record ${p.recordRef}`,
      summary: `Report version ${p.version} of this record could not be generated and will not be retried automatically (${p.errorClass}). The evidence is unaffected. An operator can recover it from Operations; the condition clears only when report version ${p.version} exists.`,
    }),
    de: (p) => ({
      title: `Erstellung von Bericht v${p.version} fehlgeschlagen — Datensatz ${p.recordRef}`,
      summary: `Berichtsversion ${p.version} dieses Datensatzes konnte nicht erstellt werden und wird nicht automatisch wiederholt (${p.errorClass}). Das Beweismittel ist nicht betroffen. Unter Betrieb kann sie wiederhergestellt werden; die Meldung schließt sich erst, wenn Berichtsversion ${p.version} existiert.`,
    }),
    ar: (p) => ({
      title: `أخفق إنشاء التقرير ${iso(`v${p.version}`)} — السجل ${iso(p.recordRef)}`,
      summary: `تعذّر إنشاء إصدار التقرير ${iso(p.version)} لهذا السجل ولن يُعاد تلقائيًا (${iso(p.errorClass)}). لم يتأثر الدليل. يمكن لمشغّل استعادته من العمليات؛ لا تُغلق الحالة إلا عند وجود إصدار التقرير ${iso(p.version)}.`,
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
    params: { outcome: { kind: PACKAGE_DENIAL_OUTCOMES } },
    en: (p) => ({
      title: `Package generation denied — ${p.outcome}`,
      summary: `Verification package denied for evidence record. ${PACKAGE_DENIAL_PHRASE.en[p.outcome]}`,
    }),
    de: (p) => ({
      title: `Paketerstellung abgelehnt — ${p.outcome}`,
      summary: `Verifizierungspaket für den Beweisdatensatz abgelehnt. ${PACKAGE_DENIAL_PHRASE.de[p.outcome]}`,
    }),
    ar: (p) => ({
      title: `رُفض إنشاء الحزمة — ${iso(p.outcome)}`,
      summary: `رُفضت حزمة التحقق لسجل الدليل. ${PACKAGE_DENIAL_PHRASE.ar[p.outcome]}`,
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
    params: { seedRunId: REF, scenario: TOKEN },
    en: (p) => ({
      title: `[SEED:${p.seedRunId}] Operational seed: ${p.scenario}`,
      summary:
        "Demo / staging seed scenario — generated by the operational seeding flow. " +
        "Safe to ignore in production view; cleanup via DELETE " +
        "/v1/ops/seed/reviewer-ops/<seedRunId>.",
    }),
    de: (p) => ({
      title: `[SEED:${p.seedRunId}] Betriebsdaten-Seed: ${p.scenario}`,
      summary:
        "Demo-/Staging-Szenario — erzeugt durch den Ablauf zum Anlegen von Betriebsdaten. " +
        "In der Produktionsansicht unbedenklich; Bereinigung über DELETE " +
        "/v1/ops/seed/reviewer-ops/<seedRunId>.",
    }),
    ar: (p) => ({
      title: `${iso(`[SEED:${p.seedRunId}]`)} بيانات تشغيلية تجريبية: ${iso(p.scenario)}`,
      summary:
        "سيناريو بيانات تجريبية لبيئة العرض أو الاختبار — أنشأه مسار التزويد التشغيلي. " +
        `يمكن تجاهله في عرض الإنتاج؛ التنظيف عبر ${iso("DELETE /v1/ops/seed/reviewer-ops/<seedRunId>")}.`,
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
  const stored: LocalizedCondition = { title: c.title, summary: c.safeSummary, localized: false };
  if (loc === "en") return stored;

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
    "intake.delivery_failed": "Intake delivery failed",
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
    "intake.delivery_failed": "Zustellung über Eingangslink fehlgeschlagen",
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
    "intake.delivery_failed": "أخفق تسليم رابط الاستلام",
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
