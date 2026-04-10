"use client";

import { useEffect, useMemo, useState } from "react";
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

  const primaryActionButtonStyle = useMemo(
    () =>
      ({
        borderColor: "rgba(191,232,223,0.24)",
        color: "#eef3f1",
        background:
          "linear-gradient(180deg, rgba(89,132,129,0.94) 0%, rgba(43,74,76,0.98) 100%)",
        boxShadow: "0 18px 34px rgba(8,24,26,0.24)",
      }) as const,
    []
  );

  const secondaryActionButtonStyle = useMemo(
    () =>
      ({
        borderColor: "rgba(183,157,132,0.16)",
        color: "#dbe3e0",
        background:
          "linear-gradient(180deg, rgba(255,255,255,0.045) 0%, rgba(255,255,255,0.018) 100%)",
        boxShadow: "0 12px 24px rgba(0,0,0,0.14)",
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
      <section className="mx-auto w-full max-w-[1180px] px-6 pb-12 pt-10 md:px-8 md:pb-14 md:pt-14">
        <div className="flex flex-col gap-10 xl:flex-row xl:items-end xl:justify-between">
          <div className="w-full max-w-[720px] xl:pl-0">
            <div className="inline-flex rounded-full border border-white/10 bg-white/[0.055] px-4 py-2 text-[0.74rem] font-medium uppercase tracking-[0.2em] text-[#d5ddda] shadow-[0_10px_24px_rgba(0,0,0,0.10)] backdrop-blur-md">
              Dashboard
            </div>

            <h1 className="mt-5 max-w-[680px] text-left text-[1.72rem] font-medium leading-[1.02] tracking-[-0.045em] text-[#e4ebe8] md:text-[2.22rem] lg:text-[2.72rem]">
              Your evidence workspace,{" "}
              <span className="text-[#bfe8df]">ready for action</span>.
            </h1>

            <p className="mt-5 max-w-[640px] text-left text-[0.95rem] font-normal leading-[1.8] tracking-[-0.006em] text-[#adb8b5] md:text-[0.99rem]">
              Review your <span className="text-[#d4dcd9]">latest evidence</span>,
              continue active <span className="text-[#c2cdca]">verification workflows</span>,
              and move quickly between <span className="text-[#d6deda]">capture</span>,{" "}
              <span className="text-[#d6c2ae]">reports</span>, and custody-ready records.
            </p>

            <div className="mt-6 flex flex-wrap gap-2.5">
              <div className="rounded-full border border-white/10 bg-white/[0.055] px-3.5 py-2 text-[0.78rem] font-normal text-[#cad3d0] shadow-[0_8px_18px_rgba(0,0,0,0.08)] backdrop-blur-md">
                <span className="mr-2 text-[#91aca5]">✓</span>
                Active evidence at a glance
              </div>

              <div className="rounded-full border border-white/10 bg-white/[0.055] px-3.5 py-2 text-[0.78rem] font-normal text-[#cad3d0] shadow-[0_8px_18px_rgba(0,0,0,0.08)] backdrop-blur-md">
                <span className="mr-2 text-[#91aca5]">✓</span>
                Fast access to core workflows
              </div>

              <div className="rounded-full border border-[rgba(214,184,157,0.18)] bg-[linear-gradient(180deg,rgba(183,157,132,0.07)_0%,rgba(255,255,255,0.028)_100%)] px-3.5 py-2 text-[0.78rem] font-normal text-[#d9ccbf] shadow-[0_8px_18px_rgba(0,0,0,0.08)] backdrop-blur-md">
                <span className="mr-2 text-[#c2a07f]">✓</span>
                Trusted custody status visible
              </div>
            </div>
          </div>

          <div className="flex shrink-0 xl:justify-end">
            <Link href="/capture">
              <Button
                className="min-w-[198px] rounded-[999px] border px-7 py-3 text-[0.95rem] font-semibold transition-all duration-200 hover:-translate-y-[1px] hover:brightness-[1.03]"
                style={primaryActionButtonStyle}
              >
                Capture Evidence
              </Button>
            </Link>
          </div>
        </div>
      </section>

      <section className="relative px-6 pb-12 md:px-8 md:pb-16">
        <div className="mx-auto w-full max-w-[1180px]">
          <div className="grid gap-5 xl:grid-cols-[1.08fr_0.92fr]">
            <Card
              className="relative overflow-hidden rounded-[30px] border bg-transparent p-0 shadow-none"
              style={{
                border: "1px solid rgba(183,157,132,0.20)",
                boxShadow:
                  "0 22px 42px rgba(0, 0, 0, 0.16), inset 0 1px 0 rgba(255,255,255,0.03)",
              }}
            >
              <div className="absolute inset-0">
                <img
                  src="/images/site-velvet-bg.webp.png"
                  alt=""
                  className="h-full w-full scale-[1.12] object-cover object-center"
                />
              </div>
              <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(8,20,24,0.82)_0%,rgba(7,18,22,0.88)_100%)]" />
              <div className="absolute inset-0 bg-[radial-gradient(circle_at_18%_14%,rgba(158,216,207,0.055),transparent_28%)]" />
              <div className="absolute inset-0 bg-[radial-gradient(circle_at_86%_18%,rgba(214,184,157,0.045),transparent_24%)]" />

              <div className="relative z-10 p-6 md:p-7">
                <div className="mb-5 flex items-center justify-between gap-4">
                  <div className="text-[1rem] font-semibold tracking-[-0.02em] text-[#d5ddda]">
                    {t("recentEvidence")}
                  </div>

                  <div className="inline-flex items-center rounded-full border border-[rgba(183,157,132,0.16)] bg-[rgba(255,255,255,0.03)] px-3 py-1.5 text-[0.74rem] font-medium uppercase tracking-[0.18em] text-[#d6cabc]">
                    Active records
                  </div>
                </div>

                <div style={{ display: "grid", gap: 12 }}>
                  {loading ? (
                    <div style={{ display: "grid", gap: 12 }}>
                      <div className="rounded-[22px] border border-white/6 bg-white/[0.03] p-4">
                        <Skeleton width="100%" height="20px" />
                      </div>
                      <div className="rounded-[22px] border border-white/6 bg-white/[0.03] p-4">
                        <Skeleton width="100%" height="20px" />
                      </div>
                      <div className="rounded-[22px] border border-white/6 bg-white/[0.03] p-4">
                        <Skeleton width="100%" height="20px" />
                      </div>
                    </div>
                  ) : error ? (
                    <div className="rounded-[20px] border border-[rgba(255,120,120,0.16)] bg-[rgba(120,20,20,0.12)] px-4 py-3 text-[0.92rem] text-[#ffd7d7]">
                      {error}
                    </div>
                  ) : items.length === 0 ? (
                    <div className="rounded-[24px] border border-white/6 bg-white/[0.03] p-4">
                      <EmptyState
                        title="No evidence yet"
                        subtitle="Capture your first file to see it here."
                        action={() => (
                          <Link href="/capture">
                            <Button
                              className="rounded-[999px] border px-5 py-3 text-[0.92rem] font-medium"
                              style={primaryActionButtonStyle}
                            >
                              {t("ctaCapture")}
                            </Button>
                          </Link>
                        )}
                      />
                    </div>
                  ) : (
                    items.map((item) => {
                      const row = (
                        <div className="rounded-[24px] border border-[rgba(183,157,132,0.14)] bg-[linear-gradient(180deg,rgba(9,22,27,0.88)_0%,rgba(8,18,23,0.94)_100%)] p-1 transition-all duration-200 hover:-translate-y-[1px] hover:border-[rgba(183,157,132,0.24)] hover:shadow-[0_16px_28px_rgba(0,0,0,0.14)]">
                          <ListRow
                            title={item.title || "Digital Evidence Record"}
                            subtitle={item.displaySubtitle}
                            badge={
                              item.status === "SIGNED" ? (
                                <Badge tone="signed">{t("statusSigned")}</Badge>
                              ) : item.status === "PROCESSING" ? (
                                <Badge tone="processing">{t("statusProcessing")}</Badge>
                              ) : item.status === "REPORTED" ? (
                                <span
                                  className="inline-flex min-h-[30px] items-center justify-center rounded-full border px-3 py-[6px] text-[11px] font-extrabold uppercase tracking-[0.08em] leading-none"
                                  style={{
                                    color: "#e4ccb5",
                                    borderColor: "rgba(214,184,157,0.24)",
                                    background:
                                      "linear-gradient(180deg, rgba(214,184,157,0.14) 0%, rgba(255,255,255,0.05) 100%)",
                                    boxShadow:
                                      "inset 0 1px 0 rgba(255,255,255,0.18), 0 6px 14px rgba(92,69,50,0.08)",
                                  }}
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
                    })
                  )}
                </div>
              </div>
            </Card>

            <Card
              className="relative overflow-hidden rounded-[30px] border bg-transparent p-0 shadow-none"
              style={{
                border: "1px solid rgba(183,157,132,0.20)",
                boxShadow:
                  "0 22px 42px rgba(0, 0, 0, 0.16), inset 0 1px 0 rgba(255,255,255,0.03)",
              }}
            >
              <div className="absolute inset-0">
                <img
                  src="/images/site-velvet-bg.webp.png"
                  alt=""
                  className="h-full w-full scale-[1.12] object-cover object-center"
                />
              </div>
              <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(8,20,24,0.82)_0%,rgba(7,18,22,0.88)_100%)]" />
              <div className="absolute inset-0 bg-[radial-gradient(circle_at_18%_14%,rgba(158,216,207,0.055),transparent_28%)]" />
              <div className="absolute inset-0 bg-[radial-gradient(circle_at_86%_18%,rgba(214,184,157,0.045),transparent_24%)]" />

              <div className="relative z-10 p-6 md:p-7">
                <div className="mb-2 text-[1rem] font-semibold tracking-[-0.02em] text-[#d5ddda]">
                  Quick Actions
                </div>

                <div className="mb-5 max-w-[520px] text-[0.92rem] leading-[1.72] text-[rgba(197,207,204,0.76)]">
                  Move through your workspace with a cleaner, focused action flow.
                </div>

                <div className="grid gap-3">
                  {quickActions.map((action) => (
                    <Link key={action.href} href={action.href}>
                      <Button
                        variant={action.primary ? "primary" : "secondary"}
                        className="flex w-full items-center justify-between rounded-[20px] border px-5 py-4 text-left text-[0.96rem] font-medium transition-all duration-200 hover:-translate-y-[1px]"
                        style={
                          action.primary
                            ? primaryActionButtonStyle
                            : secondaryActionButtonStyle
                        }
                        onClick={() => addToast(action.toast, "info")}
                      >
                        <span>{action.label}</span>
                        <span className="ml-4 text-[1.05rem] opacity-60">›</span>
                      </Button>
                    </Link>
                  ))}
                </div>

                <div
                  className="mt-5 rounded-[24px] border px-4 py-4"
                  style={{
                    border: "1px solid rgba(183,157,132,0.20)",
                    background:
                      "linear-gradient(135deg, rgba(183,157,132,0.07), rgba(255,255,255,0.025))",
                    boxShadow: "0 14px 28px rgba(0,0,0,0.08)",
                  }}
                >
                  <div className="flex items-start gap-3">
                    <div
                      className="flex h-11 w-11 items-center justify-center rounded-full text-[1rem] font-semibold"
                      style={{
                        background:
                          "linear-gradient(180deg, rgba(183,157,132,0.16) 0%, rgba(255,255,255,0.05) 100%)",
                        color: "#ddc1a4",
                        border: "1px solid rgba(183,157,132,0.20)",
                        boxShadow: "0 0 18px rgba(183,157,132,0.07)",
                      }}
                    >
                      ✓
                    </div>

                    <div>
                      <div className="font-bold text-[#dde5e2]">
                        Trusted chain of custody
                      </div>
                      <div className="mt-1 text-[12px] text-[rgba(201,211,208,0.72)]">
                        Capture → Sign → Report → Share
                      </div>
                    </div>
                  </div>
                </div>

                <div className="mt-4 rounded-[22px] border border-[rgba(183,157,132,0.14)] bg-[rgba(255,255,255,0.028)] px-4 py-4">
                  <div className="mb-2 text-[0.78rem] font-semibold uppercase tracking-[0.18em] text-[#c9ab8c]">
                    Workspace flow
                  </div>
                  <div className="text-[0.92rem] leading-[1.75] text-[rgba(194,204,201,0.76)]">
                    Everything important stays one click away, while the visual language
                    remains premium, quiet, and consistent with the rest of the platform.
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