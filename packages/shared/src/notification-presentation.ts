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
  if (/[\u0000-\u001f\s]/.test(h)) return NOTIFICATIONS_HOME_PATH;
  return h;
}
