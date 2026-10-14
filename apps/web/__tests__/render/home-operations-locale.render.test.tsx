/**
 * HOME'S OPERATIONS SUMMARY SPEAKS THE READER'S LANGUAGE (2026-10-14).
 *
 * The Operations page and drawer were English, German and Arabic; Home's
 * "What needs attention" card printed every Operations row from an
 * English-only map of its own. Its words now come from the canonical
 * Operations catalogue, derived at render time:
 *
 *   - a row's title is its source's catalogue label (the Operations group
 *     title), its explanation the category label and count phrase, its pill the
 *     Operations severity word, its action the Operations "Open details";
 *   - the refusal / loading / clear states are the Operations copy;
 *   - `intake.delivery_failed` reads as an upload start/resume failure, and a
 *     message delivery failure stays the communications condition;
 *   - nothing renders a raw source id, message code, enum, key or UUID;
 *   - Arabic is right-to-left; a workspace switch or a locale change leaves no
 *     stale copy behind.
 */
import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";

const localeState = vi.hoisted(() => ({ locale: "en" as string }));
vi.mock("../../app/providers", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useOptionalLocale: () => localeState.locale,
}));
vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));

import { WorkspacePrioritiesCard } from "../../components/home-experience/HomeDashboardSections";
import { normalizeHomeViewModel } from "../../components/home-experience/home-view-model";

type Locale = "en" | "de" | "ar";
const LOCALES: Locale[] = ["en", "de", "ar"];

const baseInputs = {
  plan: "TEAM",
  planFeatures: null,
  workspaceId: "ws-a",
  workspaceName: "Workspace A",
  activeSpaceType: "ORGANIZATION",
  commandCenter: { sections: { pipelineDetail: { data: { evidence: { uploaded: 0, signed: 1, reported: 0 } } } } },
  trustSummary: null,
  billing: null,
  reports: null,
  intakeLinks: null,
  inbox: null,
  communications: null,
  orgs: null,
  evidenceList: null,
  recordsByType: null,
};

function viewModel(groups: unknown[], summary: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return normalizeHomeViewModel({
    ...baseInputs,
    ...extra,
    operationsSummary: {
      open: groups.length,
      critical: 0,
      high: 0,
      warning: groups.length,
      overdue: 0,
      assignedToMe: 0,
      mayAssertAllClear: false,
      clearRefusalReason: "UNRESOLVED_CONDITIONS",
      groups,
      ...summary,
    },
  } as never);
}

function mount(vm: ReturnType<typeof normalizeHomeViewModel>) {
  return render(<WorkspacePrioritiesCard priorities={vm.workspacePriorities} operations={vm.operations} />);
}

/** The groups `/v1/ops/summary` would send, as Home receives them. */
const UPLOAD_START_OR_RESUME = { sourceId: "intake.delivery_failed", category: "UPLOAD", conditionCount: 2, statusPosture: "OPEN" };
const MESSAGE_DELIVERY = { sourceId: "communications.provider_failure", category: "COMMUNICATIONS", conditionCount: 1, statusPosture: "OPEN" };
const UNKNOWN = { sourceId: "future.condition_kind", category: "WORKER", conditionCount: 1, statusPosture: "OPEN" };

const n = (value: number, locale: Locale) => new Intl.NumberFormat(locale).format(value);
const EXPECTED: Record<Locale, {
  heading: string;
  upload: { title: string; why: string };
  message: { title: string; why: string };
  unknown: { title: string; why: string };
  action: string;
  warning: string;
  info: string;
  english: RegExp;
  intake: RegExp;
}> = {
  en: {
    heading: "What needs attention",
    upload: { title: "Uploads could not be started or resumed", why: `Capture and upload · ${n(2, "en")} conditions` },
    message: { title: "Communications provider failure", why: "Communications · 1 condition" },
    unknown: {
      title: "Unrecognised operational condition",
      why: "Operations is reporting something this version of the app does not know how to describe yet.",
    },
    action: "Open details",
    warning: "Warning",
    info: "Info",
    english: /$^/,
    intake: /intake|invitation|resend|copy link|link could not|recipient/i,
  },
  de: {
    heading: "Was Aufmerksamkeit braucht",
    upload: { title: "Uploads konnten nicht gestartet oder fortgesetzt werden", why: `Erfassung und Upload · ${n(2, "de")} Zustände` },
    message: { title: "Störung beim Kommunikationsanbieter", why: "Kommunikation · 1 Zustand" },
    unknown: {
      title: "Nicht erkannte Betriebsmeldung",
      why: "Der Bereich Betrieb meldet etwas, das diese App-Version noch nicht beschreiben kann.",
    },
    action: "Details öffnen",
    warning: "Warnung",
    info: "Info",
    english: /What needs attention|Uploads could not|Communications provider|Open details|Capture and upload|\bconditions?\b|Unrecognised|Open operations|\bWarning\b/,
    intake: /intake|einladung|erneut senden|link kopieren|empfänger/i,
  },
  ar: {
    heading: "ما يحتاج إلى انتباه",
    upload: { title: "تعذّر بدء عمليات الرفع أو استئنافها", why: `الالتقاط والرفع · ${n(2, "ar")} حالات` },
    message: { title: "عطل لدى مزوّد الاتصالات", why: "الاتصالات · حالة واحدة" },
    unknown: {
      title: "حالة تشغيلية غير معروفة",
      why: "تُبلغ العمليات عن أمر لا يعرف هذا الإصدار من التطبيق كيف يصفه بعد.",
    },
    action: "فتح التفاصيل",
    warning: "تحذير",
    info: "معلومة",
    english: /[A-Za-z]{3,}/,
    intake: /رابط|روابط|دعوة|إعادة إرسال|نسخ الرابط|مستلم/,
  },
};

/** A raw key on screen: snake_case, a dotted key, an UPPER_ENUM or a UUID. */
const RAW_KEY = /\b[a-z]+(?:_[a-z0-9]+)+\b|\b[a-z_]+\.[a-z_]+\b|\b[A-Z]{2,}_[A-Z_]+\b|[0-9a-f]{8}-[0-9a-f]{4}-/;

const row = (container: HTMLElement, key: string) => container.querySelector(`[data-priority="${key}"]`) as HTMLElement | null;
const title = (el: HTMLElement) => el.querySelector(".home-attn__title")!.textContent;
const why = (el: HTMLElement) => el.querySelector("[data-priority-why]")!.textContent;
const action = (el: HTMLElement) => el.querySelector("[data-priority-action]")!.textContent;
const pill = (el: HTMLElement) => el.querySelector("[data-priority-chip]")!.textContent;

afterEach(() => {
  cleanup();
  localeState.locale = "en";
});

describe("Home's Operations rows, in English, German and Arabic", () => {
  for (const locale of LOCALES) {
    it(`${locale}: upload start/resume failure, message delivery failure and an unknown condition read in ${locale}`, () => {
      localeState.locale = locale;
      const e = EXPECTED[locale];
      const { container } = mount(viewModel([UPLOAD_START_OR_RESUME, MESSAGE_DELIVERY, UNKNOWN]));

      expect(container.querySelector("h2")!.textContent).toBe(e.heading);

      // The upload service failing to START or RESUME an upload — never an
      // intake link that could not be delivered.
      const upload = row(container, "ops:intake.delivery_failed")!;
      expect(title(upload)).toBe(e.upload.title);
      expect(why(upload)).toBe(e.upload.why);
      expect(action(upload)).toBe(e.action);
      expect(pill(upload)).toBe(e.warning);
      expect(upload.textContent).not.toMatch(e.intake);

      // A message the provider could not deliver stays the communications condition.
      const message = row(container, "ops:communications.provider_failure")!;
      expect(title(message)).toBe(e.message.title);
      expect(why(message)).toBe(e.message.why);
      expect(action(message)).toBe(e.action);

      // A source this build does not know: the catalogue's unrecognised label, never the id.
      const unknown = row(container, "operations_condition_unrecognised")!;
      expect(title(unknown)).toBe(e.unknown.title);
      expect(why(unknown)).toBe(e.unknown.why);
      expect(pill(unknown)).toBe(e.info);

      // No raw identifier anywhere on the card, and no English for a German or Arabic reader.
      const text = container.textContent ?? "";
      expect(text).not.toMatch(RAW_KEY);
      for (const id of ["intake.delivery_failed", "communications.provider_failure", "future.condition_kind", "UPLOAD", "COMMUNICATIONS", "ops.security.signal"]) {
        expect(text).not.toContain(id);
      }
      if (locale !== "en") expect(text).not.toMatch(e.english);
    });
  }

  it("an upload start/resume failure and a stalled upload stay two different rows", () => {
    for (const locale of LOCALES) {
      localeState.locale = locale;
      const { container, unmount } = mount(
        viewModel([UPLOAD_START_OR_RESUME, { sourceId: "capture.upload_stalled", category: "UPLOAD", conditionCount: 1, statusPosture: "OPEN" }]),
      );
      expect(title(row(container, "ops:intake.delivery_failed")!)).toBe(EXPECTED[locale].upload.title);
      expect(title(row(container, "ops:capture.upload_stalled")!)).toBe(
        { en: "Upload appears stalled", de: "Upload scheint festzustecken", ar: "يبدو أن الرفع متوقف" }[locale],
      );
      unmount();
    }
  });

  it("Arabic is right-to-left; English and German are left-to-right", () => {
    for (const locale of LOCALES) {
      localeState.locale = locale;
      const { container, unmount } = mount(viewModel([UPLOAD_START_OR_RESUME]));
      const card = container.querySelector('[data-self-serve-section="workspace-priorities"]')!;
      expect(card.getAttribute("dir"), locale).toBe(locale === "ar" ? "rtl" : "ltr");
      expect(card.getAttribute("lang"), locale).toBe(locale);
      unmount();
    }
  });

  it("a workspace switch leaves no stale copy, and a locale change re-renders every row", () => {
    localeState.locale = "de";
    const a = viewModel([UPLOAD_START_OR_RESUME]);
    const { container, rerender } = mount(a);
    expect(title(row(container, "ops:intake.delivery_failed")!)).toBe(EXPECTED.de.upload.title);

    // Workspace B has only a message delivery failure: A's row is gone.
    const b = viewModel([MESSAGE_DELIVERY], {}, { workspaceId: "ws-b", workspaceName: "Workspace B" });
    rerender(<WorkspacePrioritiesCard priorities={b.workspacePriorities} operations={b.operations} />);
    expect(row(container, "ops:intake.delivery_failed")).toBeNull();
    expect(container.textContent).not.toContain(EXPECTED.de.upload.title);
    expect(title(row(container, "ops:communications.provider_failure")!)).toBe(EXPECTED.de.message.title);

    // The reader switches to Arabic: the same rows, re-worded, no German left.
    localeState.locale = "ar";
    rerender(<WorkspacePrioritiesCard priorities={b.workspacePriorities} operations={b.operations} />);
    expect(title(row(container, "ops:communications.provider_failure")!)).toBe(EXPECTED.ar.message.title);
    expect(container.textContent).not.toMatch(/Kommunikation|Zustand|Was Aufmerksamkeit/);
  });

  it("many platform conditions read as one localized advisory, never as internals", () => {
    const expected = {
      en: "A platform service is degraded",
      de: "Ein Plattformdienst ist beeinträchtigt",
      ar: "إحدى خدمات المنصة متدهورة",
    } as const;
    for (const locale of LOCALES) {
      localeState.locale = locale;
      const { container, unmount } = mount(
        viewModel([
          { sourceId: "platform.worker_heartbeat_stale", category: "WORKER", conditionCount: 2, statusPosture: "OPEN" },
          { sourceId: "database.condition", category: "DATABASE", conditionCount: 1, statusPosture: "OPEN" },
        ]),
      );
      const advisory = row(container, "platform_service_degraded")!;
      expect(title(advisory)).toBe(expected[locale]);
      expect(container.textContent).not.toMatch(/heartbeat|worker|database|Worker-Lebenszeichen/i);
      unmount();
    }
  });
});

describe("Home's Operations status states, in English, German and Arabic", () => {
  const EMPTY = { open: 0, warning: 0 };

  it("a stale check names itself in the reader's language", () => {
    const expected = {
      en: ["Status may be out of date.", "The last complete check is too old to describe this workspace now."],
      de: ["Der Status ist möglicherweise veraltet.", "Die letzte vollständige Prüfung ist zu alt, um diesen Arbeitsbereich jetzt zu beschreiben."],
      ar: ["قد يكون الوضع غير محدّث.", "آخر فحص كامل قديم جدًا ولا يصف مساحة العمل الآن."],
    } as const;
    for (const locale of LOCALES) {
      localeState.locale = locale;
      const { container, unmount } = mount(viewModel([], { ...EMPTY, clearRefusalReason: "STALE" }));
      const notice = container.querySelector("[data-priorities-unknown]")!;
      expect(notice.getAttribute("data-priorities-refusal")).toBe("STALE");
      expect(notice.textContent).toBe(expected[locale].join(""));
      unmount();
    }
  });

  it("a read failure keeps its own reason; open conditions are not called a failure", () => {
    localeState.locale = "de";
    const partial = mount(viewModel([], { ...EMPTY, clearRefusalReason: "PARTIAL_SOURCES" }));
    expect(partial.container.textContent).toContain(
      "Die letzte Prüfung konnte nicht jede Quelle lesen, daher kann der Zustand nicht bestätigt werden.",
    );
    partial.unmount();
    const unresolved = mount(viewModel([], { ...EMPTY, clearRefusalReason: "UNRESOLVED_CONDITIONS" }));
    expect(unresolved.container.textContent).toContain("Offene betriebliche Zustände");
    expect(unresolved.container.textContent).not.toContain("nicht jede Quelle");
    unresolved.unmount();
  });

  it("the all-clear and the loading state are localized too, and the all-clear needs the server's licence", () => {
    localeState.locale = "ar";
    const clear = mount(viewModel([], { ...EMPTY, mayAssertAllClear: true, clearRefusalReason: null }));
    expect(clear.container.querySelector("[data-priorities-clear]")!.textContent).toBe(
      "لا شيء يستدعي الانتباهلا توجد أولويات في مساحة العمل هذه تحتاج إلى انتباه الآن.",
    );
    clear.unmount();
    const unlicensed = mount(viewModel([], { ...EMPTY, mayAssertAllClear: false, clearRefusalReason: null }));
    expect(unlicensed.container.querySelector("[data-priorities-clear]")).toBeNull();
    unlicensed.unmount();
  });
});
