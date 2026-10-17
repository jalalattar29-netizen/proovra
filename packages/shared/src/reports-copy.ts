/**
 * REPORTS & ARTIFACTS (2026-10-16) — the page's words in en/de/ar.
 *
 * The record status, its reason, the summary metrics and the filter dimensions
 * are bounded server values (`DELIVERABLE_STATUSES`, `DELIVERABLE_STATUS_REASONS`,
 * the aggregator's lifecycle filter list). This is the ONE place they become
 * words, so no raw value reaches a reader. Action verbs, download failures and
 * evidence-type / integrity names keep their own shared authorities
 * (output-action-copy, download-failure, evidence-library-status).
 *
 * Pure data, zero imports: re-exported through `@proovra/shared/i18n`, which
 * the browser bundle loads directly.
 */

export type ReportsDeliverableStatusKey =
  | "READY"
  | "IN_PROGRESS"
  | "NEEDS_ATTENTION"
  | "INCOMPLETE"
  | "NOT_AVAILABLE";

export type ReportsDeliverableReasonKey =
  | "COMPLETE"
  | "GENERATING"
  | "REPORT_FAILED"
  | "ARTIFACT_MISSING"
  | "REPORT_BLOCKED"
  | "REPORT_UPDATE_FAILED"
  | "PACKAGE_FAILED"
  | "PACKAGE_BLOCKED"
  | "REPORT_AWAITING_ISSUANCE"
  | "PACKAGE_MISSING"
  | "NOT_INCLUDED"
  | "ENTITLEMENT_UNAVAILABLE"
  | "NOT_APPLICABLE";

/** The per-output lifecycle values the list projects (`ReportLifecycle`). */
export type ReportsOutputStateKey =
  | "ready"
  | "pending"
  | "blocked"
  | "failed"
  | "not_requested"
  | "unavailable";

export type ReportsMetricKey =
  | "reportsReady"
  | "packagesReady"
  | "inProgress"
  | "needsAttention"
  | "incomplete"
  | "records";

export type ReportsBreakdownKey =
  | "reportsPending"
  | "reportsFailed"
  | "reportsUpdateFailed"
  | "reportsBlocked"
  | "reportsAwaitingFirstIssuance"
  | "reportsNotIssued"
  | "packagesPending"
  | "packagesFailed"
  | "packagesBlocked"
  | "packagesMissingForLatestReport"
  | "outputsEntitlementUnavailable"
  | "recordsNotAvailable"
  | "totalEvidenceWithArtifacts"
  | "totalArtifactVersions";

export type ReportsStatusFilterKey =
  | "all"
  | "ready"
  | "in_progress"
  | "needs_attention"
  | "incomplete"
  | "not_available";

export type ReportsReportFilterKey =
  | "report_ready"
  | "report_pending"
  | "report_failed"
  | "report_update_failed"
  | "report_blocked"
  | "report_awaiting_issuance";

export type ReportsPackageFilterKey =
  | "package_ready"
  | "package_pending"
  | "package_failed"
  | "package_blocked"
  | "package_missing";

export type ReportsEntitlementFilterKey = "report_not_issued" | "entitlement_unavailable";

export type ReportsCopy = {
  page: {
    eyebrow: string;
    title: string;
    subtitle: string;
    /** {when} */
    refreshed: string;
  };
  summary: {
    heading: string;
    loading: string;
    unavailable: string;
    userScoped: string;
    breakdown: string;
    breakdownReports: string;
    breakdownPackages: string;
    breakdownRecords: string;
    /** {label} {count} */
    showRecords: string;
  };
  metrics: Record<ReportsMetricKey, { label: string; definition: string }>;
  breakdown: Record<ReportsBreakdownKey, string>;
  filters: {
    heading: string;
    searchLabel: string;
    statusLabel: string;
    status: Record<ReportsStatusFilterKey, string>;
    advanced: string;
    /** {n} */
    advancedActive: string;
    advancedTitle: string;
    reportLabel: string;
    packageLabel: string;
    entitlementLabel: string;
    any: string;
    report: Record<ReportsReportFilterKey, string>;
    package: Record<ReportsPackageFilterKey, string>;
    entitlement: Record<ReportsEntitlementFilterKey, string>;
    sortLabel: string;
    sort: Record<"newest" | "oldest", string>;
    clear: string;
    done: string;
    /** {label} */
    removeFilter: string;
  };
  list: {
    heading: string;
    countOne: string;
    /** {n} */
    countMany: string;
    columns: Record<
      "evidence" | "status" | "report" | "package" | "integrity" | "captured" | "actions",
      string
    >;
    /** {n} */
    version: string;
    /** {when} */
    captured: string;
    /** {n} — an older package certifies an earlier report. */
    olderPackage: string;
    /** {title} */
    moreActions: string;
    moreActionsShort: string;
    /** The compact visible label of the Report PDF download (its accessible name stays the full label). */
    reportPdfShort: string;
    /** The compact visible label of the package download. */
    packageZipShort: string;
    openEvidence: string;
    openCase: string;
    /** {id} */
    customer: string;
    refreshing: string;
    unavailable: string;
    pagination: string;
    previous: string;
    next: string;
    /** {page} */
    page: string;
    /** {page} {count} */
    pageOf: string;
    opening: string;
    requesting: string;
  };
  statuses: Record<ReportsDeliverableStatusKey, string>;
  reasons: Record<ReportsDeliverableReasonKey, string>;
  outputStates: Record<ReportsOutputStateKey, string>;
  empty: {
    workspaceTitle: string;
    workspaceBody: string;
    workspaceAction: string;
    filteredTitle: string;
    filteredBody: string;
    clearFilters: string;
    noArtifactsTitle: string;
    /** Records exist, none has a current artifact; each row says why. */
    noArtifactsBody: string;
  };
  footnote: string;
};

const REPORTS_EN: ReportsCopy = {
  page: {
    eyebrow: "Deliverables",
    title: "Reports & Artifacts",
    subtitle:
      "Generated report snapshots and verification packages. They record integrity at the time of generation and do not assert legal admissibility, authenticity or court-ready status.",
    refreshed: "Refreshed {when}",
  },
  summary: {
    heading: "Operational summary",
    loading: "Loading the summary…",
    unavailable: "The summary is temporarily unavailable. The record list below remains usable.",
    userScoped:
      "Workspace totals are not available for this view: these records were found through your own account, not through workspace membership. The list below is complete for you.",
    breakdown: "Detailed breakdown",
    breakdownReports: "Reports",
    breakdownPackages: "Verification packages",
    breakdownRecords: "Records",
    showRecords: "{label}: {count}. Show these records",
  },
  metrics: {
    reportsReady: { label: "Reports ready", definition: "Records whose latest report can be downloaded." },
    packagesReady: {
      label: "Packages ready",
      definition: "Records whose verification package for the latest report can be downloaded.",
    },
    inProgress: { label: "In progress", definition: "Records with a report or package being generated now." },
    needsAttention: {
      label: "Needs attention",
      definition:
        "Records with a current failure, block or missing file, or whose latest report has no verification package. Failures already replaced by a newer artifact are not counted.",
    },
    incomplete: {
      label: "Incomplete",
      definition: "Records owed their first report, with nothing in progress.",
    },
    records: { label: "All records", definition: "Finalized records in this workspace." },
  },
  breakdown: {
    reportsPending: "Reports in progress",
    reportsFailed: "Reports failed",
    reportsUpdateFailed: "Updated report failed",
    reportsBlocked: "Reports blocked",
    reportsAwaitingFirstIssuance: "First report not yet issued",
    reportsNotIssued: "Not included in plan",
    packagesPending: "Packages in progress",
    packagesFailed: "Packages failed",
    packagesBlocked: "Packages blocked",
    packagesMissingForLatestReport: "Package missing for latest report",
    outputsEntitlementUnavailable: "Subscription check pending",
    recordsNotAvailable: "No deliverables owed",
    totalEvidenceWithArtifacts: "Records with artifacts",
    totalArtifactVersions: "Artifact versions",
  },
  filters: {
    heading: "Filters",
    searchLabel: "Search by evidence title or customer ID",
    statusLabel: "Record status",
    status: {
      all: "All",
      ready: "Ready",
      in_progress: "In progress",
      needs_attention: "Needs attention",
      incomplete: "Incomplete",
      not_available: "No deliverables owed",
    },
    advanced: "Advanced filters",
    advancedActive: "{n} active",
    advancedTitle: "Advanced filters",
    reportLabel: "Report",
    packageLabel: "Verification package",
    entitlementLabel: "Plan and entitlement",
    any: "Any",
    report: {
      report_ready: "Ready",
      report_pending: "In progress",
      report_failed: "Failed",
      report_update_failed: "Updated report failed",
      report_blocked: "Blocked",
      report_awaiting_issuance: "First report not yet issued",
    },
    package: {
      package_ready: "Ready",
      package_pending: "In progress",
      package_failed: "Failed",
      package_blocked: "Blocked",
      package_missing: "Missing for latest report",
    },
    entitlement: {
      report_not_issued: "Not included in plan",
      entitlement_unavailable: "Subscription check pending",
    },
    sortLabel: "Sort",
    sort: { newest: "Newest captured first", oldest: "Oldest captured first" },
    clear: "Clear filters",
    done: "Done",
    removeFilter: "Remove filter: {label}",
  },
  list: {
    heading: "Evidence records",
    countOne: "1 record",
    countMany: "{n} records",
    columns: {
      evidence: "Evidence",
      status: "Status",
      report: "Report",
      package: "Package",
      integrity: "Original evidence",
      captured: "Captured",
      actions: "Actions",
    },
    version: "v{n}",
    captured: "Captured {when}",
    olderPackage: "Older package v{n} certifies an earlier report, not the latest one.",
    moreActions: "More actions for {title}",
    moreActionsShort: "More",
    reportPdfShort: "Report PDF",
    packageZipShort: "Package ZIP",
    openEvidence: "Open evidence",
    openCase: "Open case",
    customer: "Customer: {id}",
    refreshing: "Updating…",
    unavailable: "The record list is temporarily unavailable. Retry shortly.",
    pagination: "Pagination",
    previous: "Previous",
    next: "Next",
    page: "Page {page}",
    pageOf: "Page {page} of {count}",
    opening: "Opening…",
    requesting: "Requesting…",
  },
  statuses: {
    READY: "Ready",
    IN_PROGRESS: "In progress",
    NEEDS_ATTENTION: "Needs attention",
    INCOMPLETE: "Incomplete",
    NOT_AVAILABLE: "No deliverables owed",
  },
  reasons: {
    COMPLETE: "Deliverables available",
    GENERATING: "Being generated",
    REPORT_FAILED: "Report generation failed",
    ARTIFACT_MISSING: "A stored file is missing",
    REPORT_BLOCKED: "Report blocked by a workspace policy",
    REPORT_UPDATE_FAILED: "Updated report failed; the previous report stays available",
    PACKAGE_FAILED: "Verification package failed",
    PACKAGE_BLOCKED: "Verification package blocked by governance",
    REPORT_AWAITING_ISSUANCE: "First report not yet issued",
    PACKAGE_MISSING: "Verification package missing for the latest report",
    NOT_INCLUDED: "Not included in the current plan",
    ENTITLEMENT_UNAVAILABLE: "Subscription check pending",
    NOT_APPLICABLE: "This record cannot carry deliverables",
  },
  outputStates: {
    ready: "Ready",
    pending: "In progress",
    blocked: "Blocked",
    failed: "Failed",
    not_requested: "Not generated",
    unavailable: "Not included",
  },
  empty: {
    workspaceTitle: "No reports yet",
    workspaceBody:
      "Reports are generated from finalized evidence. Capture or upload evidence to create your first report.",
    workspaceAction: "Open evidence",
    filteredTitle: "No records match these filters",
    filteredBody: "Change or clear the filters to widen the list.",
    clearFilters: "Clear filters",
    noArtifactsTitle: "No reports or packages yet",
    noArtifactsBody:
      "This workspace has finalized records, but none has a current report or package. The status of each record below says why.",
  },
  footnote:
    "Browsing this page never generates a report or package and never marks an artifact as viewed. Download links are created only when you choose a download.",
};

const REPORTS_DE: ReportsCopy = {
  page: {
    eyebrow: "Ergebnisse",
    title: "Berichte & Artefakte",
    subtitle:
      "Erstellte Berichts-Snapshots und Verifizierungspakete. Sie dokumentieren die Integrität zum Zeitpunkt der Erstellung und treffen keine Aussage über rechtliche Zulässigkeit, Echtheit oder Gerichtsfestigkeit.",
    refreshed: "Aktualisiert {when}",
  },
  summary: {
    heading: "Betriebsübersicht",
    loading: "Übersicht wird geladen…",
    unavailable: "Die Übersicht ist vorübergehend nicht verfügbar. Die Datensatzliste unten bleibt nutzbar.",
    userScoped:
      "Arbeitsbereichssummen sind für diese Ansicht nicht verfügbar: Diese Datensätze wurden über Ihr eigenes Konto gefunden, nicht über die Mitgliedschaft im Arbeitsbereich. Die Liste unten ist für Sie vollständig.",
    breakdown: "Detaillierte Aufschlüsselung",
    breakdownReports: "Berichte",
    breakdownPackages: "Verifizierungspakete",
    breakdownRecords: "Datensätze",
    showRecords: "{label}: {count}. Diese Datensätze anzeigen",
  },
  metrics: {
    reportsReady: {
      label: "Berichte bereit",
      definition: "Datensätze, deren neuester Bericht heruntergeladen werden kann.",
    },
    packagesReady: {
      label: "Pakete bereit",
      definition: "Datensätze, deren Verifizierungspaket zum neuesten Bericht heruntergeladen werden kann.",
    },
    inProgress: {
      label: "In Bearbeitung",
      definition: "Datensätze, für die gerade ein Bericht oder Paket erstellt wird.",
    },
    needsAttention: {
      label: "Handlungsbedarf",
      definition:
        "Datensätze mit einem aktuellen Fehler, einer Sperre oder einer fehlenden Datei oder ohne Verifizierungspaket zum neuesten Bericht. Fehler, die bereits durch ein neueres Artefakt ersetzt wurden, zählen nicht.",
    },
    incomplete: {
      label: "Unvollständig",
      definition:
        "Datensätze, denen ihr erster Bericht zusteht, ohne laufende Erstellung.",
    },
    records: { label: "Alle Datensätze", definition: "Abgeschlossene Datensätze in diesem Arbeitsbereich." },
  },
  breakdown: {
    reportsPending: "Berichte in Bearbeitung",
    reportsFailed: "Berichte fehlgeschlagen",
    reportsUpdateFailed: "Aktualisierter Bericht fehlgeschlagen",
    reportsBlocked: "Berichte gesperrt",
    reportsAwaitingFirstIssuance: "Erster Bericht noch nicht ausgestellt",
    reportsNotIssued: "Nicht im Tarif enthalten",
    packagesPending: "Pakete in Bearbeitung",
    packagesFailed: "Pakete fehlgeschlagen",
    packagesBlocked: "Pakete gesperrt",
    packagesMissingForLatestReport: "Paket zum neuesten Bericht fehlt",
    outputsEntitlementUnavailable: "Abonnementprüfung ausstehend",
    recordsNotAvailable: "Keine Ergebnisse geschuldet",
    totalEvidenceWithArtifacts: "Datensätze mit Artefakten",
    totalArtifactVersions: "Artefaktversionen",
  },
  filters: {
    heading: "Filter",
    searchLabel: "Nach Beweistitel oder Kundennummer suchen",
    statusLabel: "Datensatzstatus",
    status: {
      all: "Alle",
      ready: "Bereit",
      in_progress: "In Bearbeitung",
      needs_attention: "Handlungsbedarf",
      incomplete: "Unvollständig",
      not_available: "Keine Ergebnisse geschuldet",
    },
    advanced: "Erweiterte Filter",
    advancedActive: "{n} aktiv",
    advancedTitle: "Erweiterte Filter",
    reportLabel: "Bericht",
    packageLabel: "Verifizierungspaket",
    entitlementLabel: "Tarif und Berechtigung",
    any: "Beliebig",
    report: {
      report_ready: "Bereit",
      report_pending: "In Bearbeitung",
      report_failed: "Fehlgeschlagen",
      report_update_failed: "Aktualisierter Bericht fehlgeschlagen",
      report_blocked: "Gesperrt",
      report_awaiting_issuance: "Erster Bericht noch nicht ausgestellt",
    },
    package: {
      package_ready: "Bereit",
      package_pending: "In Bearbeitung",
      package_failed: "Fehlgeschlagen",
      package_blocked: "Gesperrt",
      package_missing: "Fehlt zum neuesten Bericht",
    },
    entitlement: {
      report_not_issued: "Nicht im Tarif enthalten",
      entitlement_unavailable: "Abonnementprüfung ausstehend",
    },
    sortLabel: "Sortierung",
    sort: { newest: "Zuletzt erfasst zuerst", oldest: "Zuerst erfasst zuerst" },
    clear: "Filter zurücksetzen",
    done: "Fertig",
    removeFilter: "Filter entfernen: {label}",
  },
  list: {
    heading: "Beweisdatensätze",
    countOne: "1 Datensatz",
    countMany: "{n} Datensätze",
    columns: {
      evidence: "Beweismittel",
      status: "Status",
      report: "Bericht",
      package: "Paket",
      integrity: "Originalbeweis",
      captured: "Erfasst",
      actions: "Aktionen",
    },
    version: "v{n}",
    captured: "Erfasst {when}",
    olderPackage: "Das ältere Paket v{n} bestätigt einen früheren Bericht, nicht den neuesten.",
    moreActions: "Weitere Aktionen für {title}",
    moreActionsShort: "Mehr",
    reportPdfShort: "Bericht-PDF",
    packageZipShort: "Paket-ZIP",
    openEvidence: "Beweismittel öffnen",
    openCase: "Fall öffnen",
    customer: "Kunde: {id}",
    refreshing: "Wird aktualisiert…",
    unavailable: "Die Datensatzliste ist vorübergehend nicht verfügbar. Bitte gleich erneut versuchen.",
    pagination: "Seitennavigation",
    previous: "Zurück",
    next: "Weiter",
    page: "Seite {page}",
    pageOf: "Seite {page} von {count}",
    opening: "Wird geöffnet…",
    requesting: "Wird angefordert…",
  },
  statuses: {
    READY: "Bereit",
    IN_PROGRESS: "In Bearbeitung",
    NEEDS_ATTENTION: "Handlungsbedarf",
    INCOMPLETE: "Unvollständig",
    NOT_AVAILABLE: "Keine Ergebnisse geschuldet",
  },
  reasons: {
    COMPLETE: "Ergebnisse verfügbar",
    GENERATING: "Wird erstellt",
    REPORT_FAILED: "Berichtserstellung fehlgeschlagen",
    ARTIFACT_MISSING: "Eine gespeicherte Datei fehlt",
    REPORT_BLOCKED: "Bericht durch eine Arbeitsbereichsrichtlinie gesperrt",
    REPORT_UPDATE_FAILED: "Aktualisierter Bericht fehlgeschlagen; der vorherige Bericht bleibt verfügbar",
    PACKAGE_FAILED: "Verifizierungspaket fehlgeschlagen",
    PACKAGE_BLOCKED: "Verifizierungspaket durch Governance gesperrt",
    REPORT_AWAITING_ISSUANCE: "Erster Bericht noch nicht ausgestellt",
    PACKAGE_MISSING: "Verifizierungspaket zum neuesten Bericht fehlt",
    NOT_INCLUDED: "Im aktuellen Tarif nicht enthalten",
    ENTITLEMENT_UNAVAILABLE: "Abonnementprüfung ausstehend",
    NOT_APPLICABLE: "Für diesen Datensatz sind keine Ergebnisse möglich",
  },
  outputStates: {
    ready: "Bereit",
    pending: "In Bearbeitung",
    blocked: "Gesperrt",
    failed: "Fehlgeschlagen",
    not_requested: "Nicht erstellt",
    unavailable: "Nicht enthalten",
  },
  empty: {
    workspaceTitle: "Noch keine Berichte",
    workspaceBody:
      "Berichte werden aus abgeschlossenen Beweismitteln erstellt. Erfassen oder laden Sie Beweismittel hoch, um Ihren ersten Bericht zu erstellen.",
    workspaceAction: "Beweismittel öffnen",
    filteredTitle: "Keine Datensätze entsprechen diesen Filtern",
    filteredBody: "Ändern oder entfernen Sie die Filter, um die Liste zu erweitern.",
    clearFilters: "Filter zurücksetzen",
    noArtifactsTitle: "Noch keine Berichte oder Pakete",
    noArtifactsBody:
      "Dieser Arbeitsbereich hat abgeschlossene Datensätze, aber keiner hat einen aktuellen Bericht oder ein Paket. Der Status jedes Datensatzes unten nennt den Grund.",
  },
  footnote:
    "Das Durchsuchen dieser Seite erstellt nie einen Bericht oder ein Paket und markiert kein Artefakt als angesehen. Download-Links werden erst erstellt, wenn Sie einen Download wählen.",
};

const REPORTS_AR: ReportsCopy = {
  page: {
    eyebrow: "المخرجات",
    title: "التقارير والمخرجات",
    subtitle:
      "لقطات التقارير المُنشأة وحزم التحقق. تسجّل السلامة وقت الإنشاء ولا تدّعي المقبولية القانونية أو الأصالة أو الجاهزية للمحكمة.",
    refreshed: "تم التحديث {when}",
  },
  summary: {
    heading: "الملخص التشغيلي",
    loading: "جارٍ تحميل الملخص…",
    unavailable: "الملخص غير متاح مؤقتًا. تبقى قائمة السجلات أدناه قابلة للاستخدام.",
    userScoped:
      "إجماليات مساحة العمل غير متاحة لهذا العرض: عُثر على هذه السجلات عبر حسابك الخاص وليس عبر عضوية مساحة العمل. القائمة أدناه كاملة بالنسبة لك.",
    breakdown: "تفصيل إضافي",
    breakdownReports: "التقارير",
    breakdownPackages: "حزم التحقق",
    breakdownRecords: "السجلات",
    showRecords: "{label}: {count}. عرض هذه السجلات",
  },
  metrics: {
    reportsReady: { label: "تقارير جاهزة", definition: "سجلات يمكن تنزيل أحدث تقرير لها." },
    packagesReady: {
      label: "حزم جاهزة",
      definition: "سجلات يمكن تنزيل حزمة التحقق الخاصة بأحدث تقرير لها.",
    },
    inProgress: { label: "قيد التنفيذ", definition: "سجلات يجري الآن إنشاء تقرير أو حزمة لها." },
    needsAttention: {
      label: "تحتاج إلى متابعة",
      definition: "سجلات بها إخفاق حالي أو حظر أو ملف مفقود، أو ليس لأحدث تقرير فيها حزمة تحقق. لا تُحتسب الإخفاقات التي حلّ محلها مخرج أحدث.",
    },
    incomplete: {
      label: "غير مكتملة",
      definition: "سجلات مستحق لها تقريرها الأول، دون عملية جارية.",
    },
    records: { label: "كل السجلات", definition: "السجلات المكتملة في مساحة العمل هذه." },
  },
  breakdown: {
    reportsPending: "تقارير قيد التنفيذ",
    reportsFailed: "تقارير أخفقت",
    reportsUpdateFailed: "أخفق التقرير المحدّث",
    reportsBlocked: "تقارير محظورة",
    reportsAwaitingFirstIssuance: "لم يُصدر التقرير الأول بعد",
    reportsNotIssued: "غير مشمول في الخطة",
    packagesPending: "حزم قيد التنفيذ",
    packagesFailed: "حزم أخفقت",
    packagesBlocked: "حزم محظورة",
    packagesMissingForLatestReport: "الحزمة مفقودة لأحدث تقرير",
    outputsEntitlementUnavailable: "التحقق من الاشتراك قيد الانتظار",
    recordsNotAvailable: "لا مخرجات مستحقة",
    totalEvidenceWithArtifacts: "سجلات لها مخرجات",
    totalArtifactVersions: "إصدارات المخرجات",
  },
  filters: {
    heading: "عوامل التصفية",
    searchLabel: "البحث بعنوان الدليل أو رقم العميل",
    statusLabel: "حالة السجل",
    status: {
      all: "الكل",
      ready: "جاهزة",
      in_progress: "قيد التنفيذ",
      needs_attention: "تحتاج إلى متابعة",
      incomplete: "غير مكتملة",
      not_available: "لا مخرجات مستحقة",
    },
    advanced: "تصفية متقدمة",
    advancedActive: "{n} نشطة",
    advancedTitle: "تصفية متقدمة",
    reportLabel: "التقرير",
    packageLabel: "حزمة التحقق",
    entitlementLabel: "الخطة والاستحقاق",
    any: "أي",
    report: {
      report_ready: "جاهز",
      report_pending: "قيد التنفيذ",
      report_failed: "أخفق",
      report_update_failed: "أخفق التقرير المحدّث",
      report_blocked: "محظور",
      report_awaiting_issuance: "لم يُصدر التقرير الأول بعد",
    },
    package: {
      package_ready: "جاهزة",
      package_pending: "قيد التنفيذ",
      package_failed: "أخفقت",
      package_blocked: "محظورة",
      package_missing: "مفقودة لأحدث تقرير",
    },
    entitlement: {
      report_not_issued: "غير مشمول في الخطة",
      entitlement_unavailable: "التحقق من الاشتراك قيد الانتظار",
    },
    sortLabel: "الترتيب",
    sort: { newest: "الأحدث التقاطًا أولًا", oldest: "الأقدم التقاطًا أولًا" },
    clear: "مسح عوامل التصفية",
    done: "تم",
    removeFilter: "إزالة عامل التصفية: {label}",
  },
  list: {
    heading: "سجلات الأدلة",
    countOne: "سجل واحد",
    countMany: "{n} سجلات",
    columns: {
      evidence: "الدليل",
      status: "الحالة",
      report: "التقرير",
      package: "الحزمة",
      integrity: "الدليل الأصلي",
      captured: "تاريخ الالتقاط",
      actions: "الإجراءات",
    },
    version: "الإصدار {n}",
    captured: "التُقط {when}",
    olderPackage: "الحزمة الأقدم بالإصدار {n} تثبت تقريرًا سابقًا، وليس أحدث تقرير.",
    moreActions: "إجراءات إضافية لـ {title}",
    moreActionsShort: "المزيد",
    reportPdfShort: "تقرير PDF",
    packageZipShort: "حزمة ZIP",
    openEvidence: "فتح الدليل",
    openCase: "فتح القضية",
    customer: "العميل: {id}",
    refreshing: "جارٍ التحديث…",
    unavailable: "قائمة السجلات غير متاحة مؤقتًا. أعد المحاولة بعد قليل.",
    pagination: "التنقل بين الصفحات",
    previous: "السابق",
    next: "التالي",
    page: "الصفحة {page}",
    pageOf: "الصفحة {page} من {count}",
    opening: "جارٍ الفتح…",
    requesting: "جارٍ الطلب…",
  },
  statuses: {
    READY: "جاهزة",
    IN_PROGRESS: "قيد التنفيذ",
    NEEDS_ATTENTION: "تحتاج إلى متابعة",
    INCOMPLETE: "غير مكتملة",
    NOT_AVAILABLE: "لا مخرجات مستحقة",
  },
  reasons: {
    COMPLETE: "المخرجات متاحة",
    GENERATING: "قيد الإنشاء",
    REPORT_FAILED: "أخفق إنشاء التقرير",
    ARTIFACT_MISSING: "ملف مخزّن مفقود",
    REPORT_BLOCKED: "التقرير محظور بسياسة مساحة العمل",
    REPORT_UPDATE_FAILED: "أخفق التقرير المحدّث؛ يبقى التقرير السابق متاحًا",
    PACKAGE_FAILED: "أخفقت حزمة التحقق",
    PACKAGE_BLOCKED: "حزمة التحقق محظورة بسياسة الحوكمة",
    REPORT_AWAITING_ISSUANCE: "لم يُصدر التقرير الأول بعد",
    PACKAGE_MISSING: "حزمة التحقق مفقودة لأحدث تقرير",
    NOT_INCLUDED: "غير مشمول في الخطة الحالية",
    ENTITLEMENT_UNAVAILABLE: "التحقق من الاشتراك قيد الانتظار",
    NOT_APPLICABLE: "لا يمكن أن يحمل هذا السجل مخرجات",
  },
  outputStates: {
    ready: "جاهز",
    pending: "قيد التنفيذ",
    blocked: "محظور",
    failed: "أخفق",
    not_requested: "لم يُنشأ",
    unavailable: "غير مشمول",
  },
  empty: {
    workspaceTitle: "لا توجد تقارير بعد",
    workspaceBody: "تُنشأ التقارير من الأدلة المكتملة. التقط دليلًا أو ارفعه لإنشاء تقريرك الأول.",
    workspaceAction: "فتح الأدلة",
    filteredTitle: "لا توجد سجلات تطابق عوامل التصفية هذه",
    filteredBody: "غيّر عوامل التصفية أو امسحها لتوسيع القائمة.",
    clearFilters: "مسح عوامل التصفية",
    noArtifactsTitle: "لا توجد تقارير أو حزم بعد",
    noArtifactsBody:
      "في مساحة العمل هذه سجلات مكتملة، لكن لا يملك أي منها تقريرًا أو حزمة حالية. توضّح حالة كل سجل أدناه السبب.",
  },
  footnote:
    "تصفح هذه الصفحة لا ينشئ أي تقرير أو حزمة ولا يضع علامة على أي مخرج بأنه شوهد. لا تُنشأ روابط التنزيل إلا عندما تختار تنزيلًا.",
};

export const reportsDict: Readonly<Record<"en" | "de" | "ar", ReportsCopy>> = {
  en: REPORTS_EN,
  de: REPORTS_DE,
  ar: REPORTS_AR,
};

/** The Reports copy for a locale; English for any locale not written out. */
export function reportsCopyFor(locale: string | null | undefined): ReportsCopy {
  return locale === "de" || locale === "ar" ? reportsDict[locale] : reportsDict.en;
}

/** Fill `{name}` placeholders. Numbers are formatted by the caller. */
export function fillReportsCopy(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_m, k: string) => (k in values ? String(values[k]) : `{${k}}`));
}
