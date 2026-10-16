/**
 * NOTIFICATION PRESENTATION — ONE AUTHORITY, EVERY SURFACE, EVERY LOCALE.
 *
 * The personal notification feed (`GET /v1/me/inbox`) sends each item with a
 * stable CATEGORY code (`discussion_mention`, `ots_failure`, …), a tone, and a
 * server-written title / body / deep link. The category is the one field every
 * client has to turn into words itself, and three clients did — the header bell,
 * the Notifications page and the native app — each from its own hand-kept map.
 * They had already drifted ("Integrity" / "Bitcoin anchoring failure" /
 * "OTS failure" for the same item), and two of them fell back to printing the
 * raw code for any category they had not heard of yet.
 *
 * This module is the ONE place a category, a source, a tone or a read-state
 * view becomes reader-facing text, in English, German and Arabic. The rules:
 *
 *   - Every known category has a reviewed label in every locale (a parity
 *     test holds that).
 *   - An UNKNOWN category — a future server ahead of an older client — renders
 *     a neutral generic label. Never the code, never an empty string.
 *   - A deep link is used only when it is an internal app path; anything else
 *     resolves to the Notifications page rather than navigating somewhere the
 *     product did not intend.
 *
 * It is the notification counterpart of `operations-condition-messages.ts`,
 * which does the same job for the Operations surface, and is exported through
 * `@proovra/shared/i18n` beside it.
 */

import { otsAnchoringCopy } from "./ots-anchoring.js";
import { formatTimestampForLocaleUtc } from "./timestamp-format.js";
import {
  isConditionMessageCode,
  renderConditionMessage,
  reviewEscalationReasonPhrase,
} from "./operations-condition-messages.js";

export type NotificationLocale = "en" | "de" | "ar";

export function notificationLocale(locale: string | null | undefined): NotificationLocale {
  const base = typeof locale === "string" ? locale.trim().toLowerCase().slice(0, 2) : "";
  return base === "de" || base === "ar" ? base : "en";
}

/** Every category the feed emits today (mirrors the API's `InboxCategory`). */
export const NOTIFICATION_CATEGORIES = [
  "onboarding",
  "org_invite",
  "org_admin",
  "governance",
  "review_decision",
  "discussion_mention",
  "discussion_assigned",
  "review_escalation",
  "access_review_pending",
  "mfa_recovery_pending",
  "communication_failure",
  "security_event_high",
  "report_failure",
  "verification_package_failure",
  "ots_failure",
  "intake_submission_pending_review",
  "intake_required_items_missing",
  "intake_link_expiring",
  "collaboration",
  "tsa_failure",
  "case_assignment",
] as const;

export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

export function isNotificationCategory(value: unknown): value is NotificationCategory {
  return typeof value === "string" && (NOTIFICATION_CATEGORIES as readonly string[]).includes(value);
}

type CategoryCopy = Readonly<Record<NotificationCategory, string>>;

const CATEGORY_LABELS: Readonly<Record<NotificationLocale, CategoryCopy>> = {
  en: {
    onboarding: "Getting started",
    org_invite: "Invitation",
    org_admin: "Organization administration",
    governance: "Workspace governance",
    review_decision: "Review decision",
    discussion_mention: "Mention",
    discussion_assigned: "Assigned discussion",
    review_escalation: "Escalation",
    access_review_pending: "Access review",
    mfa_recovery_pending: "MFA approval",
    communication_failure: "Delivery failure",
    security_event_high: "Security alert",
    report_failure: "Report failure",
    verification_package_failure: "Verification package failure",
    ots_failure: "Bitcoin anchoring failure",
    intake_submission_pending_review: "Intake review",
    intake_required_items_missing: "Intake incomplete",
    intake_link_expiring: "Intake link expiring",
    collaboration: "Collaboration",
    tsa_failure: "Timestamp failure",
    case_assignment: "Case assignment",
  },
  de: {
    onboarding: "Erste Schritte",
    org_invite: "Einladung",
    org_admin: "Organisationsverwaltung",
    governance: "Arbeitsbereich-Governance",
    review_decision: "Prüfentscheidung",
    discussion_mention: "Erwähnung",
    discussion_assigned: "Zugewiesene Diskussion",
    review_escalation: "Eskalation",
    access_review_pending: "Zugriffsprüfung",
    mfa_recovery_pending: "MFA-Freigabe",
    communication_failure: "Zustellfehler",
    security_event_high: "Sicherheitswarnung",
    report_failure: "Berichtsfehler",
    verification_package_failure: "Fehler beim Verifizierungspaket",
    ots_failure: "Fehler bei der Bitcoin-Verankerung",
    intake_submission_pending_review: "Eingangsprüfung",
    intake_required_items_missing: "Eingang unvollständig",
    intake_link_expiring: "Eingangslink läuft ab",
    collaboration: "Zusammenarbeit",
    tsa_failure: "Zeitstempelfehler",
    case_assignment: "Fallzuweisung",
  },
  ar: {
    onboarding: "البدء",
    org_invite: "دعوة",
    org_admin: "إدارة المؤسسة",
    governance: "حوكمة مساحة العمل",
    review_decision: "قرار مراجعة",
    discussion_mention: "إشارة",
    discussion_assigned: "نقاش مُسند",
    review_escalation: "تصعيد",
    access_review_pending: "مراجعة الوصول",
    mfa_recovery_pending: "موافقة المصادقة متعددة العوامل",
    communication_failure: "إخفاق في التسليم",
    security_event_high: "تنبيه أمني",
    report_failure: "إخفاق في التقرير",
    verification_package_failure: "إخفاق في حزمة التحقق",
    ots_failure: "إخفاق ترسيخ بيتكوين",
    intake_submission_pending_review: "مراجعة الوارد",
    intake_required_items_missing: "وارد غير مكتمل",
    intake_link_expiring: "رابط الوارد على وشك الانتهاء",
    collaboration: "تعاون",
    tsa_failure: "إخفاق في الختم الزمني",
    case_assignment: "إسناد قضية",
  },
};

const UNKNOWN_CATEGORY: Readonly<Record<NotificationLocale, string>> = {
  en: "Notification",
  de: "Benachrichtigung",
  ar: "إشعار",
};

/** The reader-facing name of a notification's category. Never the code. */
export function notificationCategoryLabel(
  locale: string | null | undefined,
  category: string | null | undefined,
): string {
  const loc = notificationLocale(locale);
  return isNotificationCategory(category) ? CATEGORY_LABELS[loc][category] : UNKNOWN_CATEGORY[loc];
}

/**
 * A notification SOURCE named in a completeness / degraded notice. Sources are
 * the category families, so they read through the same labels; an unknown
 * source still says something true without leaking its identifier.
 */
export function notificationSourceLabel(
  locale: string | null | undefined,
  source: string | null | undefined,
): string {
  const loc = notificationLocale(locale);
  return isNotificationCategory(source) ? CATEGORY_LABELS[loc][source] : OTHER_SOURCE[loc];
}

const OTHER_SOURCE: Readonly<Record<NotificationLocale, string>> = {
  en: "Other notifications",
  de: "Weitere Benachrichtigungen",
  ar: "إشعارات أخرى",
};

/** Distinct, de-duplicated source labels in input order. */
export function notificationSourceLabels(
  locale: string | null | undefined,
  sources: readonly string[] | null | undefined,
): string[] {
  const out: string[] = [];
  for (const s of sources ?? []) {
    const label = notificationSourceLabel(locale, s);
    if (!out.includes(label)) out.push(label);
  }
  return out;
}

export const NOTIFICATION_TONES = ["critical", "high", "warning", "info"] as const;
export type NotificationTone = (typeof NOTIFICATION_TONES)[number];

const TONE_LABELS: Readonly<Record<NotificationLocale, Readonly<Record<NotificationTone, string>>>> = {
  en: { critical: "Critical", high: "High", warning: "Warning", info: "Info" },
  de: { critical: "Kritisch", high: "Hoch", warning: "Warnung", info: "Info" },
  ar: { critical: "حرج", high: "مرتفع", warning: "تحذير", info: "معلومة" },
};

/** A tone's reader-facing name; an unknown tone reads as the quietest one. */
export function notificationToneLabel(locale: string | null | undefined, tone: string | null | undefined): string {
  const loc = notificationLocale(locale);
  const t = (NOTIFICATION_TONES as readonly string[]).includes(tone ?? "") ? (tone as NotificationTone) : "info";
  return TONE_LABELS[loc][t];
}

/**
 * THE READ-STATE VIEWS. Read is a STATE a notification wears, not a place it
 * goes: All holds both, Unread what has not been opened, Read what has.
 * `readState` is the API's query parameter for each (`any` is All).
 */
export const NOTIFICATION_READ_VIEWS = ["all", "unread", "read"] as const;
export type NotificationReadView = (typeof NOTIFICATION_READ_VIEWS)[number];

export function isNotificationReadView(value: unknown): value is NotificationReadView {
  return typeof value === "string" && (NOTIFICATION_READ_VIEWS as readonly string[]).includes(value);
}

export function notificationReadStateParam(view: NotificationReadView): "any" | "unread" | "read" {
  return view === "all" ? "any" : view;
}

const READ_VIEW_COPY: Readonly<
  Record<NotificationLocale, Readonly<Record<NotificationReadView, { label: string; explanation: string }>>>
> = {
  en: {
    all: { label: "All", explanation: "Everything currently addressed to you." },
    unread: { label: "Unread", explanation: "Not opened yet." },
    read: { label: "Read", explanation: "Already opened. Still here until you archive it." },
  },
  de: {
    all: { label: "Alle", explanation: "Alles, was derzeit an Sie gerichtet ist." },
    unread: { label: "Ungelesen", explanation: "Noch nicht geöffnet." },
    read: { label: "Gelesen", explanation: "Bereits geöffnet. Bleibt hier, bis Sie es archivieren." },
  },
  ar: {
    all: { label: "الكل", explanation: "كل ما هو موجّه إليك حاليًا." },
    unread: { label: "غير مقروءة", explanation: "لم تُفتح بعد." },
    read: { label: "مقروءة", explanation: "فُتحت بالفعل. تبقى هنا حتى تؤرشفها." },
  },
};

export function notificationReadViewLabel(locale: string | null | undefined, view: NotificationReadView): string {
  return READ_VIEW_COPY[notificationLocale(locale)][view].label;
}

export function notificationReadViewExplanation(locale: string | null | undefined, view: NotificationReadView): string {
  return READ_VIEW_COPY[notificationLocale(locale)][view].explanation;
}

const READ_STATE_WORD: Readonly<Record<NotificationLocale, { read: string; unread: string }>> = {
  en: { read: "Read", unread: "Unread" },
  de: { read: "Gelesen", unread: "Ungelesen" },
  ar: { read: "مقروء", unread: "غير مقروء" },
};

/** The state a single row wears, stated in words (never colour alone). */
export function notificationReadStateLabel(locale: string | null | undefined, isRead: boolean): string {
  const w = READ_STATE_WORD[notificationLocale(locale)];
  return isRead ? w.read : w.unread;
}

/** Where a notification opens when its own link cannot be trusted. */
export const NOTIFICATIONS_HOME_PATH = "/notifications";

/**
 * A notification's deep link, if it is an internal app path; otherwise the
 * Notifications page. Protocol-relative (`//host`), absolute, scripted and
 * empty links never leave this function — the server writes internal paths,
 * and anything else is a defect to contain, not a destination.
 */
export function safeNotificationHref(href: string | null | undefined): string {
  if (typeof href !== "string") return NOTIFICATIONS_HOME_PATH;
  const h = href.trim();
  if (!h.startsWith("/") || h.startsWith("//") || h.startsWith("/\\")) return NOTIFICATIONS_HOME_PATH;
  // Whitespace or any control character makes the link untrustworthy.
  for (let i = 0; i < h.length; i += 1) {
    if (h.charCodeAt(i) <= 0x20 || /\s/.test(h[i])) return NOTIFICATIONS_HOME_PATH;
  }
  return h;
}

// =============================================================================
// SERVER-WRITTEN ITEMS IN THE READER'S WORDS
// =============================================================================
//
// The feed writes each item's title and body in English (older clients read
// those). Beside them it sends a structured `message`: a key from the closed
// set below and its params — user content (names, titles, notes) verbatim,
// everything else as a CODE. A client renders the message here, in English,
// German or Arabic, and falls back to the server's English only for a key it
// does not know. English below reproduces the server's sentences exactly.

/** One param: user content verbatim, or a code / count / ISO timestamp. */
export type NotificationMessageParams = Readonly<Record<string, string | number | null>>;
export type NotificationMessage = { readonly key: string; readonly params: NotificationMessageParams };

type L3 = Readonly<Record<NotificationLocale, string>>;
type Words = Readonly<Record<string, L3>>;

const word = (table: Words, locale: NotificationLocale, code: unknown, fallback: L3): string =>
  (typeof code === "string" && Object.prototype.hasOwnProperty.call(table, code) ? table[code]! : fallback)[locale];

const fillMessage = (template: string, values: Record<string, string | number>): string =>
  template.replace(/\{(\w+)\}/g, (m, k: string) => (k in values ? String(values[k]) : m));

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * A UTC instant in the reader's calendar words — said by the shared timestamp
 * authority (formatTimestampForLocaleUtc); English is the route's own format.
 */
export function formatNotificationInstant(locale: string | null | undefined, iso: unknown): string {
  return typeof iso === "string" ? formatTimestampForLocaleUtc(iso, notificationLocale(locale), { fallback: "—" }) : "—";
}

// ---- fallbacks for missing names (the server's own English fallbacks) ------

const FALLBACK_NAMES = {
  workspace: { en: "workspace", de: "Arbeitsbereich", ar: "مساحة العمل" },
  organization: { en: "your organization", de: "Ihre Organisation", ar: "مؤسستك" },
  case: { en: "Untitled case", de: "Unbenannter Fall", ar: "قضية بلا عنوان" },
  request: { en: "Untitled request", de: "Unbenannte Anforderung", ar: "طلب بلا عنوان" },
} as const satisfies Record<string, L3>;

// ---- vocabularies (codes the server sends; never shown raw) ----------------

const GOVERNANCE_TITLES: Words = {
  DESTRUCTION_PENDING: { en: "Evidence destruction pending review", de: "Vernichtung von Beweismitteln wartet auf Prüfung", ar: "إتلاف الدليل بانتظار المراجعة" },
  DESTRUCTION_APPROVED: { en: "Evidence destruction approved", de: "Vernichtung von Beweismitteln genehmigt", ar: "تمت الموافقة على إتلاف الدليل" },
  DESTRUCTION_EXECUTED: { en: "Evidence destruction executed", de: "Vernichtung von Beweismitteln ausgeführt", ar: "تم تنفيذ إتلاف الدليل" },
  DESTRUCTION_BLOCKED: { en: "Evidence destruction blocked", de: "Vernichtung von Beweismitteln gesperrt", ar: "تم منع إتلاف الدليل" },
  LEGAL_HOLD_PLACED: { en: "Legal hold placed", de: "Gerichtliche Aufbewahrungspflicht gesetzt", ar: "تم فرض حجز قانوني" },
  LEGAL_HOLD_RELEASED: { en: "Legal hold released", de: "Gerichtliche Aufbewahrungspflicht aufgehoben", ar: "تم رفع الحجز القانوني" },
  RETENTION_CONFLICT: { en: "Retention policy conflict", de: "Konflikt in der Aufbewahrungsrichtlinie", ar: "تعارض في سياسة الاحتفاظ" },
  RETENTION_EXTENSION_APPLIED: { en: "Retention extension applied", de: "Aufbewahrungsverlängerung angewendet", ar: "تم تطبيق تمديد الاحتفاظ" },
  LIFECYCLE_DRIFT: { en: "Evidence lifecycle drift", de: "Abweichung im Lebenszyklus von Beweismitteln", ar: "انحراف في دورة حياة الدليل" },
  IMMUTABLE_RECONCILIATION_FAILURE: { en: "Object-lock reconciliation failure", de: "Abgleich der Objektsperre fehlgeschlagen", ar: "فشل مطابقة قفل الكائن" },
  GOVERNANCE_INCIDENT_RAISED: { en: "Governance incident raised", de: "Governance-Vorfall gemeldet", ar: "تم رفع حادثة حوكمة" },
  EXPORT_BLOCKED: { en: "Export blocked by governance", de: "Export durch Governance gesperrt", ar: "تم حظر التصدير بسبب الحوكمة" },
};
const GOVERNANCE_TITLE_FALLBACK: L3 = { en: "Governance event", de: "Governance-Ereignis", ar: "حدث حوكمة" };
const GOVERNANCE_BODIES: Words = {
  DESTRUCTION_PENDING: { en: "An evidence item is awaiting destruction review.", de: "Ein Beweismittel wartet auf die Prüfung zur Vernichtung.", ar: "عنصر دليل بانتظار مراجعة الإتلاف." },
  LEGAL_HOLD_PLACED: { en: "A legal hold has been placed on evidence in this workspace.", de: "Für Beweismittel in diesem Arbeitsbereich wurde eine gerichtliche Aufbewahrungspflicht gesetzt.", ar: "تم فرض حجز قانوني على أدلة في مساحة العمل هذه." },
  RETENTION_CONFLICT: { en: "A retention policy conflict needs governance review.", de: "Ein Konflikt in der Aufbewahrungsrichtlinie erfordert eine Governance-Prüfung.", ar: "يحتاج تعارض في سياسة الاحتفاظ إلى مراجعة الحوكمة." },
  IMMUTABLE_RECONCILIATION_FAILURE: { en: "Object-lock reconciliation failed for evidence in this workspace.", de: "Der Abgleich der Objektsperre ist für Beweismittel in diesem Arbeitsbereich fehlgeschlagen.", ar: "فشلت مطابقة قفل الكائن لأدلة في مساحة العمل هذه." },
  EXPORT_BLOCKED: { en: "An evidence export was blocked by governance policy.", de: "Ein Export von Beweismitteln wurde durch eine Governance-Richtlinie gesperrt.", ar: "تم حظر تصدير دليل بموجب سياسة الحوكمة." },
};
const GOVERNANCE_BODY_FALLBACK: L3 = { en: "A governance event requires acknowledgement.", de: "Ein Governance-Ereignis muss bestätigt werden.", ar: "يتطلب حدث حوكمة الإقرار به." };

const ORG_ROLES: Words = {
  ORG_OWNER: { en: "an owner", de: "Eigentümer", ar: "مالك" },
  ORG_ADMIN: { en: "an administrator", de: "Administrator", ar: "مسؤول" },
  ORG_SECURITY_ADMIN: { en: "a security administrator", de: "Sicherheitsadministrator", ar: "مسؤول أمان" },
  ORG_BILLING_ADMIN: { en: "a billing administrator", de: "Abrechnungsadministrator", ar: "مسؤول فوترة" },
  ORG_AUDITOR: { en: "an auditor", de: "Prüfer", ar: "مدقق" },
  ORG_MEMBER: { en: "a member", de: "Mitglied", ar: "عضو" },
};
const ORG_ROLE_FALLBACK: L3 = { en: "a member", de: "Mitglied", ar: "عضو" };

const THREAD_STATUSES: Words = {
  OPEN: { en: "Open", de: "Offen", ar: "مفتوحة" },
  IN_PROGRESS: { en: "In progress", de: "In Bearbeitung", ar: "قيد التنفيذ" },
  RESOLVED: { en: "Resolved", de: "Gelöst", ar: "تم حلها" },
  CLOSED: { en: "Closed", de: "Geschlossen", ar: "مغلقة" },
};
const THREAD_STATUS_FALLBACK: L3 = { en: "Open", de: "Offen", ar: "مفتوحة" };

const ACCESS_REVIEW_KINDS: Words = {
  PERIODIC_MEMBER_REVIEW: { en: "Periodic member review", de: "Regelmäßige Mitgliederprüfung", ar: "مراجعة دورية للأعضاء" },
  STALE_ACCESS: { en: "Stale access review", de: "Prüfung veralteter Zugriffe", ar: "مراجعة الوصول غير المستخدم" },
  UNUSED_SERVICE_ACCOUNT: { en: "Unused service account review", de: "Prüfung ungenutzter Dienstkonten", ar: "مراجعة حساب خدمة غير مستخدم" },
  EXPIRING_TEMPORARY_ACCESS: { en: "Expiring temporary access review", de: "Prüfung ablaufender befristeter Zugriffe", ar: "مراجعة وصول مؤقت على وشك الانتهاء" },
  SUSPICIOUS_ACCESS_PATTERN: { en: "Suspicious access review", de: "Prüfung verdächtiger Zugriffe", ar: "مراجعة وصول مشبوه" },
  EMERGENCY_REVOCATION_FOLLOWUP: { en: "Emergency revocation follow-up", de: "Nachverfolgung eines Notfall-Widerrufs", ar: "متابعة إلغاء طارئ" },
};
const ACCESS_REVIEW_FALLBACK: L3 = { en: "Access review", de: "Zugriffsprüfung", ar: "مراجعة الوصول" };

const CHANNELS: Words = {
  SMS: { en: "SMS", de: "SMS", ar: "الرسائل النصية" },
  WHATSAPP: { en: "WhatsApp", de: "WhatsApp", ar: "واتساب" },
  EMAIL: { en: "email", de: "E-Mail", ar: "البريد الإلكتروني" },
  SYSTEM: { en: "system", de: "System", ar: "النظام" },
};
const CHANNEL_FALLBACK: L3 = { en: "message", de: "Nachrichten", ar: "الرسائل" };

const PURPOSES: Words = {
  OTP: { en: "A verification code", de: "Ein Bestätigungscode", ar: "رمز تحقق" },
  EVIDENCE_REQUEST: { en: "An evidence request", de: "Eine Beweisanforderung", ar: "طلب دليل" },
  INTAKE_LINK: { en: "An intake link", de: "Ein Erfassungslink", ar: "رابط استلام" },
  REVIEW_ESCALATION: { en: "A review escalation", de: "Eine Prüfungseskalation", ar: "تصعيد مراجعة" },
  REVIEW_REMINDER: { en: "A review reminder", de: "Eine Prüfungserinnerung", ar: "تذكير بالمراجعة" },
  CONTRIBUTOR_CLARIFICATION: { en: "A clarification request", de: "Eine Rückfrage", ar: "طلب توضيح" },
  COLLABORATION_MENTION: { en: "A mention notice", de: "Ein Erwähnungshinweis", ar: "إشعار إشارة" },
  GOVERNANCE_ALERT: { en: "A governance alert", de: "Eine Governance-Warnung", ar: "تنبيه حوكمة" },
  SECURITY_ALERT: { en: "A security alert", de: "Eine Sicherheitswarnung", ar: "تنبيه أمني" },
  PREFERENCE_UPDATE: { en: "A preference update", de: "Eine Einstellungsänderung", ar: "تحديث تفضيلات" },
};
const PURPOSE_FALLBACK: L3 = { en: "A message", de: "Eine Nachricht", ar: "رسالة" };

const CASE_ROLES: Words = {
  OWNER: { en: "owner", de: "Verantwortlich", ar: "مالك" },
  INVESTIGATOR: { en: "investigator", de: "Ermittlung", ar: "محقق" },
  REVIEWER: { en: "reviewer", de: "Prüfung", ar: "مراجع" },
  GOVERNANCE: { en: "governance", de: "Governance", ar: "الحوكمة" },
  OBSERVER: { en: "observer", de: "Beobachtung", ar: "مراقب" },
};
const CASE_ROLE_FALLBACK: L3 = { en: "member", de: "Mitglied", ar: "عضو" };

const SECURITY_EVENTS: Words = {
  step_up_failed: { en: "Step-up verification required", de: "Zusätzliche Verifizierung erforderlich", ar: "مطلوب تحقق إضافي" },
  step_up_required: { en: "Step-up verification required", de: "Zusätzliche Verifizierung erforderlich", ar: "مطلوب تحقق إضافي" },
  mfa_recovery_requested: { en: "MFA recovery requested", de: "MFA-Wiederherstellung angefordert", ar: "تم طلب استرداد المصادقة متعددة العوامل" },
  session_quarantined: { en: "Session quarantined", de: "Sitzung isoliert", ar: "تم عزل الجلسة" },
  session_revoked_self: { en: "Session revoked", de: "Sitzung widerrufen", ar: "تم إلغاء الجلسة" },
  device_revoked: { en: "Trusted device revoked", de: "Vertrauenswürdiges Gerät widerrufen", ar: "تم إلغاء الجهاز الموثوق" },
  password_changed: { en: "Password changed", de: "Passwort geändert", ar: "تم تغيير كلمة المرور" },
  anomalous_login: { en: "Anomalous login detected", de: "Ungewöhnliche Anmeldung erkannt", ar: "تم اكتشاف تسجيل دخول غير معتاد" },
};
const SECURITY_EVENT_FALLBACK: L3 = { en: "Security event", de: "Sicherheitsereignis", ar: "حدث أمني" };

const REQUEST_STATUSES: Words = {
  DRAFT: { en: "draft", de: "Entwurf", ar: "مسودة" },
  OPEN: { en: "open", de: "offen", ar: "مفتوح" },
  SENT: { en: "sent", de: "gesendet", ar: "مُرسل" },
  VIEWED: { en: "viewed", de: "angesehen", ar: "تمت مشاهدته" },
  IN_PROGRESS: { en: "in progress", de: "in Bearbeitung", ar: "قيد التنفيذ" },
  RESPONSE_RECEIVED: { en: "response received", de: "Antwort erhalten", ar: "تم استلام الرد" },
  UNDER_REVIEW: { en: "under review", de: "in Prüfung", ar: "قيد المراجعة" },
  PARTIALLY_FULFILLED: { en: "partially fulfilled", de: "teilweise erfüllt", ar: "مستوفى جزئيًا" },
  FULFILLED: { en: "fulfilled", de: "erfüllt", ar: "مستوفى" },
  NEEDS_MORE_INFO: { en: "needs more info", de: "weitere Angaben nötig", ar: "يحتاج إلى معلومات إضافية" },
  CANCELLED: { en: "cancelled", de: "storniert", ar: "ملغى" },
  CLOSED: { en: "closed", de: "geschlossen", ar: "مغلق" },
};
const REQUEST_STATUS_FALLBACK: L3 = { en: "open", de: "offen", ar: "مفتوح" };

const COLLAB_TITLES: Words = {
  MENTION_IN_COMMENT: { en: "You were mentioned in a team comment", de: "Sie wurden in einem Teamkommentar erwähnt", ar: "تمت الإشارة إليك في تعليق للفريق" },
  ASSIGNMENT_ASSIGNED: { en: "Work assigned to you", de: "Ihnen zugewiesene Arbeit", ar: "عمل مُسند إليك" },
  ASSIGNMENT_DUE_SOON: { en: "Assigned work due soon", de: "Zugewiesene Arbeit bald fällig", ar: "عمل مُسند يقترب موعده" },
  ASSIGNMENT_COMPLETED: { en: "Assigned work completed", de: "Zugewiesene Arbeit abgeschlossen", ar: "اكتمل العمل المُسند" },
  INVITE_ACCEPTED: { en: "Invitation accepted", de: "Einladung angenommen", ar: "تم قبول الدعوة" },
  ROLE_CHANGED: { en: "Your team role changed", de: "Ihre Teamrolle wurde geändert", ar: "تغيّر دورك في الفريق" },
  MEMBER_ADDED: { en: "Team member added", de: "Teammitglied hinzugefügt", ar: "تمت إضافة عضو إلى الفريق" },
  MEMBER_REMOVED: { en: "Team member removed", de: "Teammitglied entfernt", ar: "تمت إزالة عضو من الفريق" },
  GUEST_ACCEPTED: { en: "Guest access accepted", de: "Gastzugang angenommen", ar: "تم قبول وصول الضيف" },
  ACCESS_REVIEW_OPENED: { en: "Team access review opened", de: "Zugriffsprüfung des Teams eröffnet", ar: "تم فتح مراجعة وصول الفريق" },
};
/** Fixed bodies the server writes for these types; any other body is user content and stays verbatim. */
const COLLAB_BODIES: Words = {
  ASSIGNMENT_ASSIGNED: { en: "You are now responsible for a record assigned to your team.", de: "Sie sind jetzt für einen Datensatz verantwortlich, der Ihrem Team zugewiesen ist.", ar: "أصبحت مسؤولًا عن سجل مُسند إلى فريقك." },
  ASSIGNMENT_COMPLETED: { en: "Work assigned to your team has been marked completed.", de: "Die Ihrem Team zugewiesene Arbeit wurde als abgeschlossen markiert.", ar: "تم وضع علامة الاكتمال على العمل المُسند إلى فريقك." },
};

// ---- the templates ----------------------------------------------------------

const t = (en: string, de: string, ar: string): L3 => ({ en, de, ar });

const MSG = {
  noOrgTitle: t("You haven't joined an organization yet", "Sie sind noch keiner Organisation beigetreten", "لم تنضم إلى أي مؤسسة بعد"),
  noOrgBody: t(
    "Organizations group workspaces for governance, members, and audit. Create one, or accept an invite token.",
    "Organisationen bündeln Arbeitsbereiche für Governance, Mitglieder und Audit. Erstellen Sie eine oder nehmen Sie ein Einladungstoken an.",
    "تجمع المؤسسات مساحات العمل لأغراض الحوكمة والأعضاء والتدقيق. أنشئ مؤسسة أو اقبل رمز دعوة.",
  ),
  noEmailTitle: t("Add an email to your account", "Fügen Sie Ihrem Konto eine E-Mail-Adresse hinzu", "أضف بريدًا إلكترونيًا إلى حسابك"),
  noEmailBody: t(
    "Email-matched invites and audit-trail attribution require an email identity.",
    "Einladungen per E-Mail-Abgleich und die Zuordnung im Prüfpfad erfordern eine E-Mail-Identität.",
    "تتطلب الدعوات المطابقة بالبريد الإلكتروني ونسب سجل التدقيق هوية بريد إلكتروني.",
  ),
  inviteTitle: t("Organization invite waiting: {org}", "Einladung zu einer Organisation wartet: {org}", "دعوة مؤسسة بانتظارك: {org}"),
  inviteBody: t(
    "You have been invited to join {org} as {role}. Accept before {expires}.",
    "Sie wurden eingeladen, {org} als {role} beizutreten. Nehmen Sie bis {expires} an.",
    "تمت دعوتك للانضمام إلى {org} بصفة {role}. اقبل قبل {expires}.",
  ),
  pendingInvitesTitleOne: t("{count} pending invite in {org}", "{count} offene Einladung in {org}", "دعوة معلّقة واحدة في {org}"),
  pendingInvitesTitleMany: t("{count} pending invites in {org}", "{count} offene Einladungen in {org}", "{count} دعوات معلّقة في {org}"),
  pendingInvitesBody: t(
    "As an admin you can resend or revoke open invites from this organization's detail page.",
    "Als Administrator können Sie offene Einladungen auf der Detailseite dieser Organisation erneut senden oder widerrufen.",
    "بصفتك مسؤولًا يمكنك إعادة إرسال الدعوات المفتوحة أو إلغاؤها من صفحة تفاصيل هذه المؤسسة.",
  ),
  conflictTitle: t("Reviewer conflict — adjudication required", "Prüferkonflikt — Entscheidung erforderlich", "تعارض بين المراجعين — يلزم الفصل"),
  conflictBody: t(
    "Two reviewers disagreed on this workflow. As team OWNER/ADMIN you can resolve it via the multi-stage review panel.",
    "Zwei prüfende Personen waren sich bei diesem Ablauf uneinig. Als Inhaber oder Administrator des Teams können Sie dies im mehrstufigen Prüfbereich klären.",
    "اختلف مراجعان بشأن هذا المسار. بصفتك مالك الفريق أو مسؤوله يمكنك حسمه عبر لوحة المراجعة متعددة المراحل.",
  ),
  awaitingSecondTitle: t("Your first-stage decision is awaiting peer review", "Ihre Entscheidung der ersten Stufe wartet auf die Gegenprüfung", "قرارك في المرحلة الأولى بانتظار مراجعة النظير"),
  awaitingSecondBody: t(
    "Independence policy requires a different reviewer to submit the second-stage decision. No action needed from you.",
    "Die Unabhängigkeitsrichtlinie verlangt, dass eine andere prüfende Person die Entscheidung der zweiten Stufe abgibt. Sie müssen nichts tun.",
    "تتطلب سياسة الاستقلالية أن يقدّم مراجع آخر قرار المرحلة الثانية. لا يلزمك أي إجراء.",
  ),
  dashJoin: t("{a} — {b}", "{a} — {b}", "{a} — {b}"),
  seenTimes: t(" Seen {n} times.", " {n}-mal aufgetreten.", " تكرر {n} مرات."),
  mentionTitle: t('You were mentioned in "{thread}"', "Sie wurden in „{thread}“ erwähnt", "تمت الإشارة إليك في «{thread}»"),
  mentionBody: t(
    "A reviewer or investigator @-mentioned you in a workspace discussion. Open the thread to respond.",
    "Eine prüfende oder ermittelnde Person hat Sie in einer Diskussion des Arbeitsbereichs erwähnt. Öffnen Sie die Diskussion, um zu antworten.",
    "أشار إليك مراجع أو محقق في نقاش ضمن مساحة العمل. افتح النقاش للرد.",
  ),
  assignedTitle: t('Discussion assigned to you: "{thread}"', "Ihnen zugewiesene Diskussion: „{thread}“", "نقاش مُسند إليك: «{thread}»"),
  assignedOpenBody: t("An open discussion is assigned to you. Status: {status}.", "Ihnen ist eine offene Diskussion zugewiesen. Status: {status}.", "نقاش مفتوح مُسند إليك. الحالة: {status}."),
  assignedEscalatedBody: t("An escalated discussion is assigned to you. Status: {status}.", "Ihnen ist eine eskalierte Diskussion zugewiesen. Status: {status}.", "نقاش مُصعَّد مُسند إليك. الحالة: {status}."),
  escalationTitle: t("Escalation assigned to you: {reason}", "Ihnen zugewiesene Eskalation: {reason}", "تصعيد مُسند إليك: {reason}"),
  accessSubjectTitle: t("Your access is being reviewed", "Ihr Zugriff wird geprüft", "تجري مراجعة وصولك"),
  accessInitiatorTitle: t("An access review you initiated is pending", "Eine von Ihnen eingeleitete Zugriffsprüfung steht aus", "مراجعة وصول بدأتها معلّقة"),
  accessOverdueBody: t("{kind}. Past due — please act in the access reviews console.", "{kind}. Überfällig — bitte handeln Sie in der Konsole für Zugriffsprüfungen.", "{kind}. تجاوزت موعدها — يرجى اتخاذ إجراء في وحدة مراجعات الوصول."),
  accessBody: t("{kind}. Open the access reviews console to certify, revoke, or suspend.", "{kind}. Öffnen Sie die Konsole für Zugriffsprüfungen, um zu bestätigen, zu widerrufen oder zu sperren.", "{kind}. افتح وحدة مراجعات الوصول للاعتماد أو الإلغاء أو التعليق."),
  mfaTitle: t("MFA recovery request pending — {team}", "MFA-Wiederherstellungsanfrage ausstehend — {team}", "طلب استرداد المصادقة متعددة العوامل معلّق — {team}"),
  mfaBody: t(
    "A member has requested a lost-factor reset. Approvals: {approvals}/{required}. Quorum-based approval forces re-enrollment; it does NOT grant a session.",
    "Ein Mitglied hat das Zurücksetzen eines verlorenen Faktors angefordert. Genehmigungen: {approvals}/{required}. Eine Genehmigung per Quorum erzwingt eine Neuregistrierung; sie gewährt KEINE Sitzung.",
    "طلب عضو إعادة تعيين عامل مفقود. الموافقات: {approvals}/{required}. الموافقة بالنصاب تفرض إعادة التسجيل؛ ولا تمنح جلسة.",
  ),
  commTitle: t("Failed {channel} delivery — {team}", "Zustellung per {channel} fehlgeschlagen — {team}", "فشل التسليم عبر {channel} — {team}"),
  commBodyOne: t(
    "{purpose} to {recipient} failed after {attempts} attempt. Open Messaging operations to retry or cancel.",
    "{purpose} an {recipient} ist nach {attempts} Versuch fehlgeschlagen. Öffnen Sie den Nachrichtenbetrieb, um es erneut zu versuchen oder abzubrechen.",
    "فشل إرسال {purpose} إلى {recipient} بعد محاولة واحدة. افتح عمليات المراسلة لإعادة المحاولة أو الإلغاء.",
  ),
  commBodyMany: t(
    "{purpose} to {recipient} failed after {attempts} attempts. Open Messaging operations to retry or cancel.",
    "{purpose} an {recipient} ist nach {attempts} Versuchen fehlgeschlagen. Öffnen Sie den Nachrichtenbetrieb, um es erneut zu versuchen oder abzubrechen.",
    "فشل إرسال {purpose} إلى {recipient} بعد {attempts} محاولات. افتح عمليات المراسلة لإعادة المحاولة أو الإلغاء.",
  ),
  securityTitle: t("Security alert: {event}", "Sicherheitswarnung: {event}", "تنبيه أمني: {event}"),
  securityBody: t(
    "A high-severity event on your account was recorded. Open Account security to review the timeline.",
    "Für Ihr Konto wurde ein Ereignis mit hohem Schweregrad aufgezeichnet. Öffnen Sie die Kontosicherheit, um den Verlauf zu prüfen.",
    "تم تسجيل حدث عالي الخطورة على حسابك. افتح أمان الحساب لمراجعة المخطط الزمني.",
  ),
  reportFailureTitle: t("Report generation failure — {team}", "Fehler bei der Berichterstellung — {team}", "فشل إنشاء التقرير — {team}"),
  packageFailureTitle: t("Verification package failure — {team}", "Fehler beim Verifizierungspaket — {team}", "فشل حزمة التحقق — {team}"),
  acknowledged: t(" (acknowledged)", " (bestätigt)", " (تم الإقرار)"),
  otsChainTitle: t("Bitcoin verification failed — {evidence}", "Bitcoin-Verifizierung fehlgeschlagen — {evidence}", "فشل التحقق عبر بيتكوين — {evidence}"),
  otsProofTitle: t("OpenTimestamps proof failed — {evidence}", "OpenTimestamps-Nachweis fehlgeschlagen — {evidence}", "فشل إثبات OpenTimestamps — {evidence}"),
  otsChainBody: t(
    "The OpenTimestamps proof does not match the referenced block in the active Bitcoin main chain. Open the evidence Integrity tab for the verification details and operator runbook.",
    "Der OpenTimestamps-Nachweis stimmt nicht mit dem referenzierten Block der aktiven Bitcoin-Hauptkette überein. Öffnen Sie den Integritäts-Tab des Beweismittels für die Verifizierungsdetails und das Betriebshandbuch.",
    "لا يطابق إثبات OpenTimestamps الكتلة المشار إليها في سلسلة بيتكوين الرئيسية النشطة. افتح تبويب السلامة للدليل للاطلاع على تفاصيل التحقق ودليل التشغيل.",
  ),
  otsProofBody: t(
    "{reason} Open the evidence Integrity tab for the preservation status and operator runbook.",
    "{reason} Öffnen Sie den Integritäts-Tab des Beweismittels für den Sicherungsstatus und das Betriebshandbuch.",
    "{reason} افتح تبويب السلامة للدليل للاطلاع على حالة الحفظ ودليل التشغيل.",
  ),
  otsNoMoreAttempts: t(" No further attempts will be made.", " Es werden keine weiteren Versuche unternommen.", " لن تُجرى محاولات أخرى."),
  tsaTitle: t("Trusted timestamp failed — {evidence}", "Vertrauenswürdiger Zeitstempel fehlgeschlagen — {evidence}", "فشل الطابع الزمني الموثوق — {evidence}"),
  tsaBody: t(
    "{reason} Open the evidence Integrity tab for the timestamping status and retry posture.",
    "{reason} Öffnen Sie den Integritäts-Tab des Beweismittels für den Zeitstempelstatus und die Wiederholungslage.",
    "{reason} افتح تبويب السلامة للدليل للاطلاع على حالة الختم الزمني ووضع إعادة المحاولة.",
  ),
  tsaReasonFallback: t("Timestamping failed.", "Zeitstempelung fehlgeschlagen.", "فشل الختم الزمني."),
  caseTitle: t('Case assigned to you: "{case}"', "Ihnen zugewiesener Fall: „{case}“", "قضية مُسندة إليك: «{case}»"),
  caseBody: t("Role: {role}. Open the case to begin.", "Rolle: {role}. Öffnen Sie den Fall, um zu beginnen.", "الدور: {role}. افتح القضية للبدء."),
  caseBodyNote: t("Role: {role}. {note}", "Rolle: {role}. {note}", "الدور: {role}. {note}"),
  intakeReviewTitle: t("Intake submission awaiting review — {team}", "Eingereichte Erfassung wartet auf Prüfung — {team}", "إرسال استلام بانتظار المراجعة — {team}"),
  intakeReviewBody: t(
    '"{title}" is in {status} state with no assigned reviewer. Open evidence requests to claim it.',
    "„{title}“ ist im Status „{status}“ ohne zugewiesene prüfende Person. Öffnen Sie die Beweisanforderungen, um sie zu übernehmen.",
    "«{title}» في حالة «{status}» دون مراجع مُسند. افتح طلبات الأدلة لتولّيه.",
  ),
  intakeIncompleteTitle: t("Intake incomplete — {team}", "Erfassung unvollständig — {team}", "الاستلام غير مكتمل — {team}"),
  intakeIncompleteMoreInfo: t(
    '"{title}" cannot complete because the reviewer requested more information. Open evidence requests for the checklist.',
    "„{title}“ kann nicht abgeschlossen werden, weil die prüfende Person weitere Angaben angefordert hat. Öffnen Sie die Beweisanforderungen für die Checkliste.",
    "لا يمكن إكمال «{title}» لأن المراجع طلب مزيدًا من المعلومات. افتح طلبات الأدلة للاطلاع على قائمة التحقق.",
  ),
  intakeIncompleteDeliverables: t(
    '"{title}" cannot complete because required deliverables are still outstanding. Open evidence requests for the checklist.',
    "„{title}“ kann nicht abgeschlossen werden, weil erforderliche Lieferungen noch ausstehen. Öffnen Sie die Beweisanforderungen für die Checkliste.",
    "لا يمكن إكمال «{title}» لأن مخرجات مطلوبة ما زالت معلّقة. افتح طلبات الأدلة للاطلاع على قائمة التحقق.",
  ),
  intakeLinkTitle: t("Intake link expiring soon — {team}", "Erfassungslink läuft bald ab — {team}", "رابط الاستلام على وشك الانتهاء — {team}"),
  intakeLinkBody: t(
    "An active intake link expires on {expires}. Open intake links to renew or revoke.",
    "Ein aktiver Erfassungslink läuft am {expires} ab. Öffnen Sie die Erfassungslinks, um ihn zu verlängern oder zu widerrufen.",
    "ينتهي رابط استلام نشط في {expires}. افتح روابط الاستلام لتجديده أو إلغائه.",
  ),
  intakeLinkBodyUses: t(
    "An active intake link ({used}/{max} uses) expires on {expires}. Open intake links to renew or revoke.",
    "Ein aktiver Erfassungslink ({used}/{max} Nutzungen) läuft am {expires} ab. Öffnen Sie die Erfassungslinks, um ihn zu verlängern oder zu widerrufen.",
    "ينتهي رابط استلام نشط ({used}/{max} استخدامات) في {expires}. افتح روابط الاستلام لتجديده أو إلغائه.",
  ),
  collabBodyFallback: t("Open the collaboration team page for details.", "Öffnen Sie die Seite des Kollaborationsteams für Details.", "افتح صفحة فريق التعاون للاطلاع على التفاصيل."),
  unavailableTitle: t("[No longer accessible — workspace access removed]", "[Nicht mehr zugänglich — Zugriff auf den Arbeitsbereich entfernt]", "[لم يعد متاحًا — أُزيل الوصول إلى مساحة العمل]"),
  unavailableBody: t(
    "This historical item belongs to a workspace you no longer have access to.",
    "Dieser frühere Eintrag gehört zu einem Arbeitsbereich, auf den Sie keinen Zugriff mehr haben.",
    "ينتمي هذا العنصر السابق إلى مساحة عمل لم يعد لديك وصول إليها.",
  ),
} as const;

/** The keys a server may send. Closed: a client renders exactly these. */
export const NOTIFICATION_MESSAGE_KEYS = [
  "onboarding.no_organization",
  "onboarding.no_email",
  "org_invite",
  "org_admin.pending_invites",
  "review.conflict",
  "review.awaiting_second",
  "governance",
  "discussion.mention",
  "discussion.assigned",
  "escalation.assigned",
  "access_review",
  "mfa_recovery",
  "communication_failure",
  "security_alert",
  "report_failure",
  "package_failure",
  "ots_failure",
  "tsa_failure",
  "case_assignment",
  "intake.review",
  "intake.incomplete",
  "intake.link_expiring",
  "collaboration",
  "history.unavailable",
] as const;
export type NotificationMessageKey = (typeof NOTIFICATION_MESSAGE_KEYS)[number];

function sentenceCase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** A condition summary in the reader's words, or the stored text verbatim. */
function incidentSummary(l: NotificationLocale, p: NotificationMessageParams): string {
  const code = str(p.conditionCode);
  if (code && isConditionMessageCode(code)) {
    let params: unknown = {};
    try {
      params = typeof p.conditionParams === "string" ? JSON.parse(p.conditionParams) : {};
    } catch {
      params = {};
    }
    const rendered = renderConditionMessage(l, code, params);
    if (rendered) return rendered.summary;
  }
  return str(p.summary) ?? "";
}

/**
 * A server-written item in the reader's words, or null for a message this
 * client does not know (the caller then shows the server's English).
 */
export function renderNotificationMessage(
  locale: string | null | undefined,
  message: NotificationMessage | null | undefined,
): { title: string; body: string } | null {
  if (!message || typeof message.key !== "string") return null;
  const l = notificationLocale(locale);
  const p = message.params ?? {};
  const team = str(p.team) ?? FALLBACK_NAMES.workspace[l];
  const f = (tpl: L3, v: Record<string, string | number> = {}) => fillMessage(tpl[l], v);
  const seenSuffix = () => {
    const n = num(p.occurrences);
    return n !== null && n > 1 ? f(MSG.seenTimes, { n }) : "";
  };
  switch (message.key as NotificationMessageKey) {
    case "onboarding.no_organization":
      return { title: f(MSG.noOrgTitle), body: f(MSG.noOrgBody) };
    case "onboarding.no_email":
      return { title: f(MSG.noEmailTitle), body: f(MSG.noEmailBody) };
    case "org_invite": {
      const org = str(p.org) ?? FALLBACK_NAMES.organization[l];
      return {
        title: f(MSG.inviteTitle, { org }),
        body: f(MSG.inviteBody, {
          org,
          role: word(ORG_ROLES, l, p.role, ORG_ROLE_FALLBACK),
          expires: formatNotificationInstant(l, p.expiresAt),
        }),
      };
    }
    case "org_admin.pending_invites": {
      const count = num(p.count) ?? 0;
      const org = str(p.org) ?? FALLBACK_NAMES.organization[l];
      return {
        title: f(count === 1 ? MSG.pendingInvitesTitleOne : MSG.pendingInvitesTitleMany, { count, org }),
        body: f(MSG.pendingInvitesBody),
      };
    }
    case "review.conflict":
      return { title: f(MSG.conflictTitle), body: f(MSG.conflictBody) };
    case "review.awaiting_second":
      return { title: f(MSG.awaitingSecondTitle), body: f(MSG.awaitingSecondBody) };
    case "governance":
      return {
        title: f(MSG.dashJoin, { a: word(GOVERNANCE_TITLES, l, p.kind, GOVERNANCE_TITLE_FALLBACK), b: team }),
        body: word(GOVERNANCE_BODIES, l, p.kind, GOVERNANCE_BODY_FALLBACK) + seenSuffix(),
      };
    case "discussion.mention":
      return { title: f(MSG.mentionTitle, { thread: str(p.thread) ?? "" }), body: f(MSG.mentionBody) };
    case "discussion.assigned": {
      const status = word(THREAD_STATUSES, l, p.status, THREAD_STATUS_FALLBACK);
      return {
        title: f(MSG.assignedTitle, { thread: str(p.thread) ?? "" }),
        body: f(p.escalated === 1 ? MSG.assignedEscalatedBody : MSG.assignedOpenBody, { status }),
      };
    }
    case "escalation.assigned":
      return {
        title: f(MSG.escalationTitle, { reason: sentenceCase(reviewEscalationReasonPhrase(l, str(p.reason) ?? "")) }),
        // The escalation's own stored summary, verbatim.
        body: str(p.summary) ?? "",
      };
    case "access_review": {
      const kind = word(ACCESS_REVIEW_KINDS, l, p.kind, ACCESS_REVIEW_FALLBACK);
      return {
        title: f(p.subject === 1 ? MSG.accessSubjectTitle : MSG.accessInitiatorTitle),
        body: f(p.overdue === 1 ? MSG.accessOverdueBody : MSG.accessBody, { kind }),
      };
    }
    case "mfa_recovery":
      return {
        title: f(MSG.mfaTitle, { team }),
        body: f(MSG.mfaBody, { approvals: num(p.approvals) ?? 0, required: num(p.required) ?? 0 }),
      };
    case "communication_failure": {
      const attempts = num(p.attempts) ?? 0;
      return {
        title: f(MSG.commTitle, { channel: word(CHANNELS, l, p.channel, CHANNEL_FALLBACK), team }),
        body: f(attempts === 1 ? MSG.commBodyOne : MSG.commBodyMany, {
          purpose: word(PURPOSES, l, p.purpose, PURPOSE_FALLBACK),
          recipient: str(p.recipient) ?? "",
          attempts,
        }),
      };
    }
    case "security_alert":
      return {
        title: f(MSG.securityTitle, { event: word(SECURITY_EVENTS, l, p.eventType, SECURITY_EVENT_FALLBACK) }),
        body: f(MSG.securityBody),
      };
    case "report_failure":
    case "package_failure":
      return {
        title:
          f(message.key === "report_failure" ? MSG.reportFailureTitle : MSG.packageFailureTitle, { team }) +
          (p.acknowledged === 1 ? MSG.acknowledged[l] : ""),
        body: incidentSummary(l, p) + seenSuffix(),
      };
    case "ots_failure": {
      const evidence = str(p.evidence) ?? "";
      if (p.chain === 1) return { title: f(MSG.otsChainTitle, { evidence }), body: f(MSG.otsChainBody) };
      const labels = otsAnchoringCopy(l).failureLabels;
      const code = str(p.code) ?? "OTS_PROCESSING_FAILED";
      const reason =
        (labels[code] ?? labels.OTS_PROCESSING_FAILED ?? "") +
        (code === "OTS_GLOBAL_BUDGET_EXHAUSTED" ? MSG.otsNoMoreAttempts[l] : "");
      return { title: f(MSG.otsProofTitle, { evidence }), body: f(MSG.otsProofBody, { reason }) };
    }
    case "tsa_failure":
      return {
        title: f(MSG.tsaTitle, { evidence: str(p.evidence) ?? "" }),
        // The pipeline's stored failure text verbatim when it recorded one.
        body: f(MSG.tsaBody, { reason: str(p.reason) ?? MSG.tsaReasonFallback[l] }),
      };
    case "case_assignment": {
      const role = word(CASE_ROLES, l, p.role, CASE_ROLE_FALLBACK);
      const note = str(p.note);
      return {
        title: f(MSG.caseTitle, { case: str(p.case) ?? FALLBACK_NAMES.case[l] }),
        body: note ? f(MSG.caseBodyNote, { role, note }) : f(MSG.caseBody, { role }),
      };
    }
    case "intake.review":
      return {
        title: f(MSG.intakeReviewTitle, { team }),
        body: f(MSG.intakeReviewBody, {
          title: str(p.title) ?? FALLBACK_NAMES.request[l],
          status: word(REQUEST_STATUSES, l, p.status, REQUEST_STATUS_FALLBACK),
        }),
      };
    case "intake.incomplete":
      return {
        title: f(MSG.intakeIncompleteTitle, { team }),
        body: f(p.moreInfo === 1 ? MSG.intakeIncompleteMoreInfo : MSG.intakeIncompleteDeliverables, {
          title: str(p.title) ?? FALLBACK_NAMES.request[l],
        }),
      };
    case "intake.link_expiring": {
      const used = num(p.used);
      const max = num(p.max);
      const expires = formatNotificationInstant(l, p.expiresAt);
      return {
        title: f(MSG.intakeLinkTitle, { team }),
        body:
          used !== null && max !== null
            ? f(MSG.intakeLinkBodyUses, { used, max, expires })
            : f(MSG.intakeLinkBody, { expires }),
      };
    }
    case "collaboration": {
      const type = str(p.type);
      if (type === null || !Object.prototype.hasOwnProperty.call(COLLAB_TITLES, type)) return null;
      // English is the text the server stored when it raised the item (it
      // has more than one wording per type); other locales say the type.
      if (l === "en") {
        return { title: str(p.title) ?? COLLAB_TITLES[type]!.en, body: str(p.body) ?? f(MSG.collabBodyFallback) };
      }
      const fixedBody = Object.prototype.hasOwnProperty.call(COLLAB_BODIES, type) ? COLLAB_BODIES[type]![l] : null;
      return {
        title: COLLAB_TITLES[type]![l],
        // A comment mention's body is the member's own words: verbatim.
        body: fixedBody ?? str(p.body) ?? f(MSG.collabBodyFallback),
      };
    }
    case "history.unavailable":
      return { title: f(MSG.unavailableTitle), body: f(MSG.unavailableBody) };
    default:
      return null;
  }
}

/** Read a served `message` defensively: a string key and scalar params only. */
export function readNotificationMessage(value: unknown): NotificationMessage | null {
  if (!value || typeof value !== "object") return null;
  const v = value as { key?: unknown; params?: unknown };
  if (typeof v.key !== "string") return null;
  const params: Record<string, string | number | null> = {};
  if (v.params && typeof v.params === "object") {
    for (const [k, x] of Object.entries(v.params as Record<string, unknown>)) {
      if (x === null || typeof x === "string" || typeof x === "number") params[k] = x;
    }
  }
  return { key: v.key, params };
}

/** The title and body to show: the message in the reader's words, else the server's text. */
export function notificationItemText(
  locale: string | null | undefined,
  item: { title: string; body: string; message?: unknown },
): { title: string; body: string } {
  return renderNotificationMessage(locale, readNotificationMessage(item.message)) ?? { title: item.title, body: item.body };
}

// =============================================================================
// THE "SHOWING" LINE
// =============================================================================
//
// English keeps the page's own sentence ("Showing 3 of 5 read notifications",
// built by the caller, byte-for-byte as before). German and Arabic say the
// same facts without noun inflection: the counts, then the active read-state /
// tone / archive labels from the tables above.

const SHOWING_COPY: Readonly<Record<"de" | "ar", { withTotal: string; noTotal: string; archived: string }>> = {
  de: { withTotal: "Angezeigt: {n} von {total}", noTotal: "Angezeigt: {n} (möglicherweise mehr)", archived: "Archiviert" },
  ar: { withTotal: "المعروض: {n} من {total}", noTotal: "المعروض: {n} (قد يوجد المزيد)", archived: "مؤرشفة" },
};

export function notificationShowingLine(
  locale: string | null | undefined,
  facts: {
    shown: number;
    total: number | null;
    archived: boolean;
    /** The primary view: a read-state view or a tone. */
    view: string;
    /** The English noun phrase the page builds today ("archived read notifications"). */
    englishNoun: string;
  },
): string {
  const l = notificationLocale(locale);
  if (l === "en") {
    return facts.total !== null
      ? `Showing ${facts.shown} of ${facts.total} ${facts.englishNoun}`
      : `Showing ${facts.shown} ${facts.englishNoun} (more may exist)`;
  }
  const copy = SHOWING_COPY[l];
  const base = fillMessage(facts.total !== null ? copy.withTotal : copy.noTotal, {
    n: facts.shown,
    total: facts.total ?? 0,
  });
  const parts: string[] = [];
  if (facts.archived) parts.push(copy.archived);
  if (facts.view === "unread" || facts.view === "read") parts.push(notificationReadViewLabel(l, facts.view));
  else if ((NOTIFICATION_TONES as readonly string[]).includes(facts.view)) parts.push(notificationToneLabel(l, facts.view));
  return parts.length > 0 ? `${base} · ${parts.join(" · ")}` : base;
}
