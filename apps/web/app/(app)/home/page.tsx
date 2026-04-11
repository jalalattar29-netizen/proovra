"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  
  Button,
  Card,
  ListRow,
  useToast,
  EmptyState,
  Skeleton,
} from "../../../components/ui";
import { useLocale } from "../../providers";
import { apiFetch } from "../../../lib/api";
import { captureException } from "../../../lib/sentry";

type HomeEvidenceItem = {
  id: string;
  title: string;
  type: string;
  status: string;
  createdAt: string;
  itemCount: number;
  displaySubtitle: string;
};

type QuickActionItem = {
  href: string;
  label: string;
  toast: string;
  primary?: boolean;
};

export default function HomePage() {
  const { t } = useLocale();
  const { addToast } = useToast();

  const [items, setItems] = useState<HomeEvidenceItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const isUuid = (value: string) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value
    );

  useEffect(() => {
    setLoading(true);
    setError(null);

    apiFetch("/v1/evidence?scope=active")
      .then((data) => {
        setItems(data.items ?? []);
      })
      .catch((err) => {
        const errorMessage = err?.message || "Failed to load evidence";
        setError(errorMessage);
        captureException(err, { feature: "home_page_evidence_list" });
        addToast(errorMessage, "error");
      })
      .finally(() => setLoading(false));
  }, [addToast]);

const velvetGreenButtonStyle = useMemo(
  () =>
    ({
      borderColor: "rgba(58,92,95,0.55)",
      color: "#e6f1ee",
      background:
        "linear-gradient(180deg, rgba(44,74,72,0.95) 0%, rgba(20,38,42,0.98) 100%)",
      boxShadow:
        "inset 0 1px 0 rgba(255,255,255,0.08), 0 16px 34px rgba(12,30,32,0.35)",
      textShadow: "0 1px 0 rgba(0,0,0,0.35)",
      backdropFilter: "blur(6px)",
      WebkitBackdropFilter: "blur(6px)",
    }) as const,
  []
);

const actionButtonStyle = useMemo(
  () =>
    ({
      borderColor: "rgba(79,112,107,0.12)",
      color: "#24373b",
      background:
        "linear-gradient(180deg, rgba(250,251,249,0.82) 0%, rgba(241,244,241,0.96) 100%)",
      boxShadow:
        "0 10px 20px rgba(0,0,0,0.05), inset 0 1px 0 rgba(255,255,255,0.70)",
      textShadow: "0 1px 0 rgba(255,255,255,0.30)",
      backdropFilter: "blur(6px)",
      WebkitBackdropFilter: "blur(6px)",
    }) as const,
  []
);

  const evidenceCardStyle = useMemo(
    () =>
      ({
        border: "1px solid rgba(79,112,107,0.10)",
        background:
          "linear-gradient(180deg, rgba(255,255,255,0.58) 0%, rgba(243,245,242,0.90) 100%)",
        boxShadow:
          "inset 0 1px 0 rgba(255,255,255,0.42), 0 12px 26px rgba(0,0,0,0.06)",
        backdropFilter: "blur(8px)",
        WebkitBackdropFilter: "blur(8px)",
      }) as const,
    []
  );

  const outerCardStyle = useMemo(
    () =>
      ({
        border: "1px solid rgba(79,112,107,0.16)",
        boxShadow:
          "0 18px 38px rgba(0,0,0,0.08), inset 0 1px 0 rgba(255,255,255,0.48)",
      }) as const,
    []
  );

    const homeReportReadyStyle = useMemo(
    () =>
      ({
        color: "#2d5b59",
        background:
          "linear-gradient(180deg, rgba(191,232,223,0.24) 0%, rgba(255,255,255,0.55) 100%)",
        border: "1px solid rgba(79,112,107,0.14)",
        boxShadow:
          "inset 0 1px 0 rgba(255,255,255,0.55), 0 6px 14px rgba(41,83,85,0.05)",
      }) as const,
    []
  );

  const homeSignedStyle = useMemo(
    () =>
      ({
        color: "#2f625d",
        background:
          "linear-gradient(180deg, rgba(213,237,230,0.88) 0%, rgba(255,255,255,0.66) 100%)",
        border: "1px solid rgba(93,148,138,0.16)",
        boxShadow:
          "inset 0 1px 0 rgba(255,255,255,0.62), 0 6px 14px rgba(41,83,85,0.05)",
      }) as const,
    []
  );

  const homeProcessingStyle = useMemo(
    () =>
      ({
        color: "#9a6a10",
        background:
          "linear-gradient(180deg, rgba(255,239,196,0.92) 0%, rgba(255,255,255,0.68) 100%)",
        border: "1px solid rgba(214,170,74,0.18)",
        boxShadow:
          "inset 0 1px 0 rgba(255,255,255,0.62), 0 6px 14px rgba(120,88,24,0.06)",
      }) as const,
    []
  );

  const homeReadyStyle = useMemo(
    () =>
      ({
        color: "#4a6064",
        background:
          "linear-gradient(180deg, rgba(240,243,241,0.92) 0%, rgba(255,255,255,0.68) 100%)",
        border: "1px solid rgba(79,112,107,0.12)",
        boxShadow:
          "inset 0 1px 0 rgba(255,255,255,0.58), 0 6px 14px rgba(0,0,0,0.03)",
      }) as const,
    []
  );

  const quickActions: QuickActionItem[] = [
    {
      href: "/cases",
      label: "View Cases",
      toast: "Loading cases...",
      primary: true,
    },
    {
      href: "/archive",
      label: "Archived Evidence",
      toast: "Opening archive...",
    },
    {
      href: "/deleted",
      label: "Deleted Evidence",
      toast: "Opening deleted evidence...",
    },
    {
      href: "/locked",
      label: "Locked Evidence",
      toast: "Opening locked evidence...",
    },
    {
      href: "/settings",
      label: "Manage Settings",
      toast: "Opening settings...",
    },
  ];

  return (
    <div className="section app-section home-page-shell">
      <section className="relative mx-auto w-full max-w-[1180px] px-6 pb-12 pt-10 md:px-8 md:pb-14 md:pt-14">
        <div className="flex flex-col gap-10 xl:flex-row xl:justify-between">
          <div className="w-full max-w-[720px] xl:pl-0">
            <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-4 py-1.5 text-[0.68rem] font-medium uppercase tracking-[0.28em] text-[#afbbb7] shadow-[0_10px_24px_rgba(0,0,0,0.08)] backdrop-blur-md">
              <span className="h-[4px] w-[4px] rounded-full bg-[#b79d84] opacity-80" />
              Dashboard
            </div>

            <h1 className="mt-5 max-w-[680px] text-left text-[1.72rem] font-medium leading-[1.02] tracking-[-0.045em] text-[#d9e2df] md:text-[2.22rem] lg:text-[2.72rem]">
              Your evidence workspace,{" "}
              <span className="text-[#c3ebe2]">ready for action</span>.
            </h1>

            <p className="mt-5 max-w-[640px] text-left text-[0.95rem] font-normal leading-[1.8] tracking-[-0.006em] text-[#aab5b2] md:text-[0.99rem]">
              Review your <span className="text-[#cfd8d5]">latest evidence</span>,
              continue active{" "}
              <span className="text-[#bbc7c3]">verification workflows</span>, and
              move quickly between <span className="text-[#d2dcd8]">capture</span>,{" "}
              <span className="text-[#c3ebe2]">reports</span>, and custody-ready
              records.
            </p>

            <div className="mt-6 flex flex-wrap gap-2.5">
              <div className="rounded-full border border-white/10 bg-white/[0.055] px-3.5 py-2 text-[0.78rem] font-normal text-[#c7d1ce] shadow-[0_8px_18px_rgba(0,0,0,0.08)] backdrop-blur-md">
                <span className="mr-2 text-[#91aca5]">✓</span>
                Active evidence at a glance
              </div>

              <div className="rounded-full border border-white/10 bg-white/[0.055] px-3.5 py-2 text-[0.78rem] font-normal text-[#c7d1ce] shadow-[0_8px_18px_rgba(0,0,0,0.08)] backdrop-blur-md">
                <span className="mr-2 text-[#91aca5]">✓</span>
                Fast access to core workflows
              </div>

              <div className="rounded-full border border-[rgba(214,184,157,0.18)] bg-[linear-gradient(180deg,rgba(183,157,132,0.07)_0%,rgba(255,255,255,0.028)_100%)] px-3.5 py-2 text-[0.78rem] font-normal text-[#d9ccbf] shadow-[0_8px_18px_rgba(0,0,0,0.08)] backdrop-blur-md">
                <span className="mr-2 text-[#c2a07f]">✓</span>
                Trusted custody status visible
              </div>
            </div>
          </div>

          <div className="flex shrink-0 xl:mt-[42px] xl:justify-end">
            <Link href="/capture">
              <Button
                className="min-w-[198px] rounded-[999px] border px-7 py-3 text-[0.95rem] font-semibold transition-all duration-200 hover:-translate-y-[1px] hover:brightness-[1.03]"
                style={velvetGreenButtonStyle}
              >
                Capture Evidence
              </Button>
            </Link>
          </div>
        </div>
      </section>

      <section
className="relative overflow-hidden px-6 pt-8 pb-12 md:px-8 md:pt-10 md:pb-16"
        style={{
          background:
            "linear-gradient(180deg, rgba(239,241,238,0.96) 0%, rgba(234,237,234,0.98) 100%)",
        }}
      >
        <div className="pointer-events-none absolute inset-0 z-0" aria-hidden="true">
          <img
            src="/images/landing-network-bg.png"
            alt=""
            className="absolute inset-0 h-full w-full object-cover object-top opacity-[0.12] saturate-[0.55] brightness-[1.02] contrast-[0.94]"
          />
          <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.08)_0%,rgba(255,255,255,0.03)_22%,rgba(255,255,255,0.03)_78%,rgba(255,255,255,0.08)_100%)]" />
          <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(255,255,255,0.10)_0%,rgba(255,255,255,0.03)_12%,rgba(255,255,255,0.00)_24%,rgba(255,255,255,0.00)_76%,rgba(255,255,255,0.03)_88%,rgba(255,255,255,0.10)_100%)]" />
        </div>

        <div className="relative z-10 mx-auto w-full max-w-[1180px]">
          <div className="grid gap-5 xl:grid-cols-[1.08fr_0.92fr]">
            <Card
              className="relative overflow-hidden rounded-[30px] border bg-transparent p-0 shadow-none"
              style={outerCardStyle}
            >
              <div className="absolute inset-0">
                <img
                  src="/images/panel-silver.webp.png"
                  alt=""
                  className="h-full w-full object-cover object-center"
                />
              </div>
              <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.24)_0%,rgba(248,249,246,0.34)_42%,rgba(239,241,238,0.42)_100%)]" />
              <div className="absolute inset-0 bg-[radial-gradient(circle_at_16%_12%,rgba(255,255,255,0.34),transparent_28%)] opacity-90" />

              <div className="relative z-10 p-6 md:p-7">
                <div className="mb-5 flex items-start justify-between gap-4">
                  <div className="text-[1.1rem] font-semibold tracking-[-0.02em] text-[#21353a]">
                    {t("recentEvidence")}
                  </div>

                  <div className="mt-1 inline-flex items-center rounded-full border border-[rgba(183,157,132,0.18)] bg-[linear-gradient(180deg,rgba(183,157,132,0.08)_0%,rgba(255,255,255,0.05)_100%)] px-3 py-1.5 text-[0.7rem] font-medium uppercase tracking-[0.16em] text-[#9b826b]">
                    Active records
                  </div>
                </div>

                <div style={{ display: "grid", gap: 12 }}>
                  {loading ? (
                    <div style={{ display: "grid", gap: 12 }}>
                      <div className="rounded-[22px] p-4" style={evidenceCardStyle}>
                        <Skeleton width="100%" height="20px" />
                      </div>
                      <div className="rounded-[22px] p-4" style={evidenceCardStyle}>
                        <Skeleton width="100%" height="20px" />
                      </div>
                      <div className="rounded-[22px] p-4" style={evidenceCardStyle}>
                        <Skeleton width="100%" height="20px" />
                      </div>
                    </div>
                  ) : error ? (
                    <div className="rounded-[20px] border border-[rgba(255,120,120,0.16)] bg-[rgba(120,20,20,0.12)] px-4 py-3 text-[0.92rem] text-[#ffd7d7]">
                      {error}
                    </div>
                  ) : items.length === 0 ? (
                    <div className="rounded-[24px] p-4" style={evidenceCardStyle}>
                      <EmptyState
                        title="No evidence yet"
                        subtitle="Capture your first file to see it here."
                      />
                      <div className="mt-4 flex justify-center">
                        <Link href="/capture">
                          <Button
                            className="rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
                            style={velvetGreenButtonStyle}
                          >
                            {t("ctaCapture")}
                          </Button>
                        </Link>
                      </div>
                    </div>
                  ) : (
                    items.map((item) => {
                      const row = (
                        <div
                          className="rounded-[24px] p-1 transition-all duration-200 hover:-translate-y-[1px]"
                          style={evidenceCardStyle}
                        >
                          <ListRow
                            title={item.title || "Digital Evidence Record"}
                            subtitle={item.displaySubtitle}
badge={
  item.status === "SIGNED" ? (
    <span
      className="inline-flex min-h-[28px] items-center justify-center rounded-full px-3 py-[5px] text-[10.5px] font-semibold uppercase tracking-[0.12em]"
      style={homeSignedStyle}
    >
      {t("statusSigned")}
    </span>
  ) : item.status === "PROCESSING" ? (
    <span
      className="inline-flex min-h-[28px] items-center justify-center rounded-full px-3 py-[5px] text-[10.5px] font-semibold uppercase tracking-[0.12em]"
      style={homeProcessingStyle}
    >
      {t("statusProcessing")}
    </span>
  ) : item.status === "REPORTED" ? (
    <span
      className="inline-flex min-h-[28px] items-center justify-center rounded-full px-3 py-[5px] text-[10.5px] font-semibold uppercase tracking-[0.12em]"
      style={homeReportReadyStyle}
    >
      Report Ready
    </span>
  ) : (
    <span
      className="inline-flex min-h-[28px] items-center justify-center rounded-full px-3 py-[5px] text-[10.5px] font-semibold uppercase tracking-[0.12em]"
      style={homeReadyStyle}
    >
      {t("statusReady")}
    </span>
  )
}
                          />
                        </div>
                      );

                      return isUuid(item.id) ? (
                        <Link key={item.id} href={`/evidence/${item.id}`}>
                          {row}
                        </Link>
                      ) : (
                        <div key={item.id}>{row}</div>
                      );
                    })
                  )}
                </div>
              </div>
            </Card>

            <Card
              className="relative overflow-hidden rounded-[30px] border bg-transparent p-0 shadow-none"
              style={outerCardStyle}
            >
              <div className="absolute inset-0">
                <img
                  src="/images/panel-silver.webp.png"
                  alt=""
                  className="h-full w-full object-cover object-center"
                />
              </div>
              <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.24)_0%,rgba(248,249,246,0.34)_42%,rgba(239,241,238,0.42)_100%)]" />
              <div className="absolute inset-0 bg-[radial-gradient(circle_at_16%_12%,rgba(255,255,255,0.34),transparent_28%)] opacity-90" />

              <div className="relative z-10 p-6 md:p-7">
                <div className="mb-5">
                  <div className="text-[1.1rem] font-semibold tracking-[-0.02em] text-[#21353a]">
                    Quick Actions
                  </div>
                  <div className="mt-2 max-w-[480px] text-[0.9rem] leading-[1.7] text-[#5d6d71]">
                    Move through your workspace with a cleaner, focused action
                    flow.
                  </div>
                </div>

                <div className="grid gap-3">
                  {quickActions.map((action) => (
                    <Link key={action.href} href={action.href}>
                      <Button
                        variant="secondary"
                        className="flex w-full items-center justify-between rounded-[20px] border px-5 py-4 text-left text-[0.96rem] font-semibold transition-all duration-200 hover:-translate-y-[1px]"
                        style={actionButtonStyle}
                        onClick={() => addToast(action.toast, "info")}
                      >
                        <span>{action.label}</span>
                        <span className="ml-4 text-[1.05rem] text-[#9b826b] opacity-75">
                          ›
                        </span>
                      </Button>
                    </Link>
                  ))}
                </div>

                <div
                  className="mt-5 rounded-[24px] border px-4 py-4"
                  style={{
                    border: "1px solid rgba(183,157,132,0.18)",
                    background:
                      "linear-gradient(180deg, rgba(250,248,245,0.62) 0%, rgba(243,239,234,0.86) 100%)",
                    boxShadow: "0 12px 26px rgba(0,0,0,0.05)",
                  }}
                >
                  <div className="flex items-start gap-3">
                    <div
                      className="flex h-11 w-11 items-center justify-center rounded-full text-[1rem] font-semibold"
                      style={{
                        background:
                          "linear-gradient(180deg, rgba(183,157,132,0.16) 0%, rgba(255,255,255,0.10) 100%)",
                        color: "#9b826b",
                        border: "1px solid rgba(183,157,132,0.20)",
                        boxShadow: "0 0 18px rgba(183,157,132,0.06)",
                      }}
                    >
                      ✓
                    </div>

                    <div>
                      <div className="font-bold text-[#23373b]">
                        Trusted chain of custody
                      </div>
                      <div className="mt-1 text-[12px] text-[#6a777b]">
                        Capture → Sign → Report → Share
                      </div>
                    </div>
                  </div>
                </div>

                <div className="mt-4 rounded-[22px] border border-[rgba(79,112,107,0.10)] bg-[linear-gradient(180deg,rgba(255,255,255,0.52)_0%,rgba(243,245,242,0.82)_100%)] px-4 py-4">
                  <div className="mb-2 text-[0.78rem] font-semibold uppercase tracking-[0.18em] text-[#9b826b]">
                    Workspace flow
                  </div>
                  <div className="text-[0.92rem] leading-[1.75] text-[#5d6d71]">
                    Everything important stays one click away, while the visual
                    language remains premium, quiet, and consistent with the rest
                    of the platform.
                  </div>
                </div>
              </div>
            </Card>
          </div>
        </div>
      </section>
    </div>
  );
}