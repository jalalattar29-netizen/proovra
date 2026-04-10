"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Badge,
  Button,
  Card,
  ListRow,
  useToast,
  EmptyState,
  Skeleton,
} from "../../../components/ui";
import { SilverWatermarkSection } from "../../../components/SilverWatermarkSection";
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

  const primaryActionButtonStyle = {
    borderColor: "rgba(158,216,207,0.22)",
    color: "#214648",
    background:
      "linear-gradient(180deg, rgba(191,232,223,0.22) 0%, rgba(255,255,255,0.52) 100%)",
  } as const;

  const secondaryActionButtonStyle = {
    borderColor: "rgba(36,55,59,0.10)",
    color: "#2a3b40",
    background:
      "linear-gradient(180deg, rgba(255,255,255,0.54) 0%, rgba(244,246,244,0.84) 100%)",
  } as const;

  const cardBaseStyle = {
    boxShadow: "0 16px 32px rgba(0, 0, 0, 0.07), inset 0 1px 0 rgba(255,255,255,0.45)",
  } as const;

  const reportReadyBadgeStyle = {
    color: "#8f7257",
    background:
      "linear-gradient(180deg, rgba(214,184,157,0.16) 0%, rgba(255,255,255,0.52) 100%)",
    border: "1px solid rgba(183,157,132,0.24)",
    boxShadow: "0 8px 18px rgba(0,0,0,0.06)",
  } as const;

  return (
    <div className="page landing-page home-page-shell">
      <div className="relative overflow-hidden">
        <div className="absolute inset-0">
          <img
            src="/images/site-velvet-bg.webp.png"
            alt=""
            className="h-full w-full object-cover object-center"
          />
        </div>

        <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(8,18,22,0.84)_0%,rgba(8,18,22,0.74)_38%,rgba(8,18,22,0.66)_100%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_16%_16%,rgba(158,216,207,0.09),transparent_24%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_82%_24%,rgba(214,184,157,0.06),transparent_18%)]" />
        <div className="absolute inset-0 opacity-[0.04] [background:repeating-linear-gradient(0deg,rgba(255,255,255,0.026)_0px,rgba(255,255,255,0.026)_1px,transparent_1px,transparent_4px)]" />

        <div className="relative z-10">
          <section className="mx-auto max-w-7xl px-6 pb-16 pt-10 md:px-8 md:pb-20 md:pt-14">
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
                    className="min-w-[198px] rounded-[16px] border px-7 py-3 text-[0.95rem] font-medium ui-transition hover-button-primary"
                    style={primaryActionButtonStyle}
                  >
                    Capture Evidence
                  </Button>
                </Link>
              </div>
            </div>
          </section>
        </div>
      </div>

      <SilverWatermarkSection
        className="section section-body relative overflow-hidden"
        style={{ paddingTop: 48, paddingBottom: 56 }}
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

        <div className="container relative z-10 mx-auto max-w-7xl px-6 md:px-8">
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "minmax(0, 1.08fr) minmax(320px, 0.92fr)",
              gap: 18,
            }}
            className="home-pricing-style-grid"
          >
            <Card
              className="relative h-full overflow-hidden rounded-[28px] border bg-transparent p-0 shadow-none"
              style={{
                border: "1px solid rgba(255,255,255,0.42)",
                ...cardBaseStyle,
              }}
            >
              <div className="absolute inset-0">
                <img
                  src="/images/panel-silver.webp.png"
                  alt=""
                  className="h-full w-full object-cover object-center"
                />
              </div>

              <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.12)_0%,rgba(255,255,255,0.18)_100%)]" />

              <div className="relative z-10 flex h-full flex-col p-6 md:p-7">
                <div className="mb-5 flex items-start justify-between gap-4">
                  <div>
                    <p className="text-[0.72rem] font-medium uppercase tracking-[0.18em] text-[#405357]">
                      Workspace
                    </p>
                    <h2 className="mt-3 text-[1.36rem] font-medium leading-[1.02] tracking-[-0.03em] text-[#21353a] md:text-[1.48rem]">
                      {t("recentEvidence")}
                    </h2>
                  </div>

                  <div className="rounded-full border border-[rgba(36,55,59,0.10)] bg-[linear-gradient(180deg,rgba(255,255,255,0.54)_0%,rgba(244,246,244,0.84)_100%)] px-3 py-1.5 text-[0.72rem] font-medium uppercase tracking-[0.18em] text-[#2a3b40] shadow-[0_8px_18px_rgba(0,0,0,0.06)]">
                    Active records
                  </div>
                </div>

                {loading ? (
                  <div style={{ display: "grid", gap: 12 }}>
                    <div className="rounded-[22px] border border-[rgba(36,55,59,0.10)] bg-[linear-gradient(180deg,rgba(255,255,255,0.54)_0%,rgba(244,246,244,0.84)_100%)] p-4">
                      <Skeleton width="100%" height="20px" />
                    </div>
                    <div className="rounded-[22px] border border-[rgba(36,55,59,0.10)] bg-[linear-gradient(180deg,rgba(255,255,255,0.54)_0%,rgba(244,246,244,0.84)_100%)] p-4">
                      <Skeleton width="100%" height="20px" />
                    </div>
                    <div className="rounded-[22px] border border-[rgba(36,55,59,0.10)] bg-[linear-gradient(180deg,rgba(255,255,255,0.54)_0%,rgba(244,246,244,0.84)_100%)] p-4">
                      <Skeleton width="100%" height="20px" />
                    </div>
                  </div>
                ) : error ? (
                  <div className="rounded-[20px] border border-[rgba(255,120,120,0.16)] bg-[rgba(120,20,20,0.12)] px-4 py-3 text-[0.92rem] text-[#9f3e3e]">
                    {error}
                  </div>
                ) : items.length === 0 ? (
                  <div className="rounded-[24px] border border-[rgba(36,55,59,0.10)] bg-[linear-gradient(180deg,rgba(255,255,255,0.54)_0%,rgba(244,246,244,0.84)_100%)] p-4">
                    <EmptyState
                      title="No evidence yet"
                      subtitle="Capture your first file to see it here."
                      action={() => (
                        <Link href="/capture">
                          <Button
                            className="rounded-[16px] border px-5 py-3 text-[0.92rem] font-medium ui-transition hover-button-primary"
                            style={primaryActionButtonStyle}
                          >
                            {t("ctaCapture")}
                          </Button>
                        </Link>
                      )}
                    />
                  </div>
                ) : (
                  <div style={{ display: "grid", gap: 12 }}>
                    {items.map((item) => {
                      const row = (
                        <div className="rounded-[22px] border border-[rgba(36,55,59,0.10)] bg-[linear-gradient(180deg,rgba(255,255,255,0.54)_0%,rgba(244,246,244,0.84)_100%)] p-1 ui-transition hover:-translate-y-[2px] hover:shadow-[0_20px_32px_rgba(0,0,0,0.08)]">
                          <ListRow
                            title={item.title || "Digital Evidence Record"}
                            subtitle={item.displaySubtitle}
                            badge={
                              item.status === "SIGNED" ? (
                                <Badge tone="signed">{t("statusSigned")}</Badge>
                              ) : item.status === "PROCESSING" ? (
                                <Badge tone="processing">
                                  {t("statusProcessing")}
                                </Badge>
                              ) : item.status === "REPORTED" ? (
                                <span
                                  className="inline-flex min-h-[28px] items-center justify-center rounded-full px-3 py-[5px] text-[10.5px] font-semibold uppercase tracking-[0.12em]"
                                  style={reportReadyBadgeStyle}
                                >
                                  Report Ready
                                </span>
                              ) : (
                                <Badge tone="ready">{t("statusReady")}</Badge>
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
                    })}
                  </div>
                )}
              </div>
            </Card>

            <Card
              className="relative h-full overflow-hidden rounded-[28px] border bg-transparent p-0 shadow-none"
              style={{
                border: "1px solid rgba(183,157,132,0.18)",
                ...cardBaseStyle,
              }}
            >
              <div className="absolute inset-0">
                <img
                  src="/images/panel-silver.webp.png"
                  alt=""
                  className="h-full w-full object-cover object-center"
                />
              </div>

              <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(214,184,157,0.08)_0%,rgba(255,255,255,0.18)_100%)]" />

              <div className="relative z-10 flex h-full flex-col p-6 md:p-7">
                <div className="mb-5">
                  <p className="text-[0.72rem] font-medium uppercase tracking-[0.18em] text-[#9b826b]">
                    Actions
                  </p>
                  <h2 className="mt-3 text-[1.36rem] font-medium leading-[1.02] tracking-[-0.03em] text-[#21353a] md:text-[1.48rem]">
                    Quick Actions
                  </h2>
                  <div className="mt-3 max-w-[480px] text-[0.92rem] leading-[1.75] text-[#667174]">
                    Move through your workspace with a cleaner, more premium action flow.
                  </div>
                </div>

                <div className="grid gap-3">
                  {quickActions.map((action) => {
                    const isPrimary = !!action.primary;

                    return (
                      <Link key={action.href} href={action.href}>
                        <Button
                          variant="secondary"
                          className={`flex w-full items-center justify-between rounded-[16px] border px-5 py-3 text-left text-[0.95rem] font-medium ui-transition ${
                            isPrimary ? "hover-button-primary" : "hover-button-bronze"
                          }`}
                          style={isPrimary ? primaryActionButtonStyle : secondaryActionButtonStyle}
                          onClick={() => addToast(action.toast, "info")}
                        >
                          <span>{action.label}</span>
                          <span className="ml-4 opacity-55">›</span>
                        </Button>
                      </Link>
                    );
                  })}
                </div>

                <div className="mt-5 rounded-[24px] border border-[rgba(183,157,132,0.24)] bg-[linear-gradient(180deg,rgba(214,184,157,0.16)_0%,rgba(255,255,255,0.52)_100%)] p-5 shadow-[0_12px_24px_rgba(0,0,0,0.05)]">
                  <div className="flex items-start gap-3">
                    <div
                      className="flex h-11 w-11 items-center justify-center rounded-full border border-[rgba(183,157,132,0.24)] bg-[linear-gradient(180deg,rgba(214,184,157,0.16)_0%,rgba(255,255,255,0.36)_100%)] text-[1rem] font-semibold text-[#8f7257]"
                    >
                      ✓
                    </div>

                    <div>
                      <div className="font-bold text-[#31464a]">
                        Trusted chain of custody
                      </div>
                      <div className="mt-1 text-[12px] text-[#667174]">
                        Capture → Sign → Report → Share
                      </div>
                    </div>
                  </div>
                </div>

                <div className="mt-4 rounded-[22px] border border-[rgba(36,55,59,0.10)] bg-[linear-gradient(180deg,rgba(255,255,255,0.54)_0%,rgba(244,246,244,0.84)_100%)] px-4 py-4">
                  <div className="mb-2 text-[0.76rem] font-medium uppercase tracking-[0.18em] text-[#8f7257]">
                    Workspace flow
                  </div>
                  <div className="text-[0.92rem] leading-[1.75] text-[#667174]">
                    Everything important stays one click away, while the visual language remains premium, soft, and consistent with the rest of the platform.
                  </div>
                </div>
              </div>
            </Card>
          </div>
        </div>
      </SilverWatermarkSection>

      <style jsx global>{`
        .home-page-shell .evidence-row-pro {
          background: transparent !important;
          border: 0 !important;
          box-shadow: none !important;
          min-height: 78px;
        }

        .home-page-shell .evidence-row-pro__title {
          color: #2a3b40 !important;
        }

        .home-page-shell .evidence-row-pro__subtitle {
          color: #667174 !important;
        }

        .home-page-shell .evidence-row-pro__icon {
          background: linear-gradient(
            180deg,
            rgba(126, 169, 162, 0.18) 0%,
            rgba(126, 169, 162, 0.08) 100%
          ) !important;
          border: 1px solid rgba(126, 169, 162, 0.16) !important;
        }

        .home-page-shell .evidence-row-pro__icon-text {
          color: #31464a !important;
        }

        .home-page-shell .evidence-row-pro__arrow {
          color: rgba(42, 59, 64, 0.35) !important;
        }

        .home-pricing-style-grid {
          grid-template-columns: minmax(0, 1.08fr) minmax(320px, 0.92fr);
        }

        @media (max-width: 1279px) {
          .home-pricing-style-grid {
            grid-template-columns: 1fr !important;
          }
        }
      `}</style>
    </div>
  );
}