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

  const secondaryActionButtonStyle = {
    borderColor: "rgba(183,157,132,0.18)",
    color: "#dfe5e3",
    background:
      "linear-gradient(180deg, rgba(255,255,255,0.04) 0%, rgba(255,255,255,0.015) 100%)",
    boxShadow: "0 12px 24px rgba(0,0,0,0.14)",
  } as const;

  const primaryActionButtonStyle = {
    borderColor: "rgba(183,157,132,0.22)",
    color: "#edf1ef",
    background:
      "linear-gradient(180deg, rgba(73,113,110,0.92) 0%, rgba(31,58,60,0.96) 100%)",
    boxShadow: "0 16px 30px rgba(9,27,28,0.22)",
  } as const;

  return (
    <div className="page landing-page home-page-shell">
      <div className="relative min-h-screen overflow-hidden">
        <div className="absolute inset-0">
          <img
            src="/images/site-velvet-bg.webp.png"
            alt=""
            className="h-full w-full object-cover object-center"
          />
        </div>

        <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(8,18,22,0.84)_0%,rgba(8,18,22,0.76)_36%,rgba(8,18,22,0.70)_72%,rgba(8,18,22,0.76)_100%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_16%_14%,rgba(158,216,207,0.08),transparent_24%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_84%_22%,rgba(214,184,157,0.055),transparent_18%)]" />
        <div className="absolute inset-0 opacity-[0.035] [background:repeating-linear-gradient(0deg,rgba(255,255,255,0.022)_0px,rgba(255,255,255,0.022)_1px,transparent_1px,transparent_4px)]" />

        <div className="relative z-10">
          <section className="mx-auto max-w-7xl px-6 pb-14 pt-10 md:px-8 md:pb-16 md:pt-14">
            <div className="flex flex-col gap-8 lg:flex-row lg:items-end lg:justify-between">
              <div className="max-w-[760px]">
                <div className="inline-flex rounded-full border border-white/10 bg-white/[0.055] px-4 py-2 text-[0.74rem] font-medium uppercase tracking-[0.2em] text-[#d7dfdc] shadow-[0_10px_24px_rgba(0,0,0,0.10)] backdrop-blur-md">
                  Dashboard
                </div>

                <h1 className="mt-5 max-w-[700px] text-[1.62rem] font-medium leading-[1.01] tracking-[-0.04em] text-[#dfe5e3] md:text-[2.18rem] lg:text-[2.7rem]">
                  Your evidence workspace,{" "}
                  <span className="text-[#cfd8d5]">ready for action</span>.
                </h1>

                <p className="mt-5 max-w-[690px] text-[0.94rem] font-normal leading-[1.78] tracking-[-0.006em] text-[#b7c0bd] md:text-[0.98rem]">
                  Review your <span className="text-[#d5ddda]">latest evidence</span>, continue active{" "}
                  <span className="text-[#c5cfcb]">verification workflows</span>, and move quickly between{" "}
                  <span className="text-[#d8dfdc]">capture</span>,{" "}
                  <span className="text-[#c9b5a0]">reports</span>, and custody-ready records.
                </p>

                <div className="mt-6 flex flex-wrap gap-2.5">
                  <div className="rounded-full border border-white/10 bg-white/[0.055] px-3.5 py-2 text-[0.78rem] font-normal text-[#cdd5d2] shadow-[0_8px_18px_rgba(0,0,0,0.08)] backdrop-blur-md">
                    <span className="mr-2 text-[#8fa8a2]">✓</span>
                    Active evidence at a glance
                  </div>

                  <div className="rounded-full border border-white/10 bg-white/[0.055] px-3.5 py-2 text-[0.78rem] font-normal text-[#cdd5d2] shadow-[0_8px_18px_rgba(0,0,0,0.08)] backdrop-blur-md">
                    <span className="mr-2 text-[#8fa8a2]">✓</span>
                    Fast access to core workflows
                  </div>

                  <div className="rounded-full border border-[rgba(214,184,157,0.22)] bg-[linear-gradient(180deg,rgba(183,157,132,0.08)_0%,rgba(255,255,255,0.03)_100%)] px-3.5 py-2 text-[0.78rem] font-normal text-[#d7c8ba] shadow-[0_8px_18px_rgba(0,0,0,0.08)] backdrop-blur-md">
                    <span className="mr-2 text-[#b89978]">✓</span>
                    Trusted custody status visible
                  </div>
                </div>
              </div>

              <div className="flex shrink-0">
                <Link href="/capture">
                  <Button
                    className="min-w-[190px] rounded-[999px] border px-7 py-3 text-[0.95rem] font-semibold transition-all duration-200 hover:-translate-y-[1px] hover:brightness-[1.03]"
                    style={primaryActionButtonStyle}
                  >
                    Capture Evidence
                  </Button>
                </Link>
              </div>
            </div>
          </section>

          <section className="relative px-6 pb-12 md:px-8 md:pb-16">
            <div className="mx-auto max-w-7xl">
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
                      className="h-full w-full object-cover object-center scale-[1.12]"
                    />
                  </div>
                  <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(8,20,24,0.82)_0%,rgba(7,18,22,0.88)_100%)]" />
                  <div className="absolute inset-0 bg-[radial-gradient(circle_at_18%_14%,rgba(158,216,207,0.055),transparent_28%)]" />
                  <div className="absolute inset-0 bg-[radial-gradient(circle_at_86%_18%,rgba(214,184,157,0.045),transparent_24%)]" />

                  <div className="relative z-10 p-6 md:p-7">
                    <div className="mb-5 flex items-center justify-between gap-4">
                      <div className="text-[1rem] font-semibold tracking-[-0.02em] text-[#dbe2df]">
                        {t("recentEvidence")}
                      </div>

                      <div className="inline-flex items-center rounded-full border border-[rgba(183,157,132,0.18)] bg-[rgba(255,255,255,0.035)] px-3 py-1.5 text-[0.74rem] font-medium uppercase tracking-[0.18em] text-[#cfc3b6]">
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
<span className="home-bronze-status">Report Ready</span>                                  ) : (
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
                      className="h-full w-full object-cover object-center scale-[1.12]"
                    />
                  </div>
                  <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(8,20,24,0.82)_0%,rgba(7,18,22,0.88)_100%)]" />
                  <div className="absolute inset-0 bg-[radial-gradient(circle_at_18%_14%,rgba(158,216,207,0.055),transparent_28%)]" />
                  <div className="absolute inset-0 bg-[radial-gradient(circle_at_86%_18%,rgba(214,184,157,0.045),transparent_24%)]" />

                  <div className="relative z-10 p-6 md:p-7">
                    <div className="mb-5 text-[1rem] font-semibold tracking-[-0.02em] text-[#dbe2df]">
                      Quick Actions
                    </div>

                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <Link href="/capture">
                        <Button
                          className="w-full rounded-[999px] border px-5 py-3 text-[0.95rem] font-medium transition-all duration-200 hover:-translate-y-[1px] hover:brightness-[1.03]"
                          style={primaryActionButtonStyle}
                          onClick={() => addToast("Opening capture...", "info")}
                        >
                          New Capture
                        </Button>
                      </Link>

                      <Link href="/cases">
                        <Button
                          variant="secondary"
                          className="w-full rounded-[999px] border px-5 py-3 text-[0.95rem] font-medium transition-all duration-200 hover:-translate-y-[1px]"
                          style={secondaryActionButtonStyle}
                          onClick={() => addToast("Loading cases...", "info")}
                        >
                          View Cases
                        </Button>
                      </Link>

                      <Link href="/archive">
                        <Button
                          variant="secondary"
                          className="w-full rounded-[999px] border px-5 py-3 text-[0.95rem] font-medium transition-all duration-200 hover:-translate-y-[1px]"
                          style={secondaryActionButtonStyle}
                          onClick={() => addToast("Opening archive...", "info")}
                        >
                          Archived Evidence
                        </Button>
                      </Link>

                      <Link href="/deleted">
                        <Button
                          variant="secondary"
                          className="w-full rounded-[999px] border px-5 py-3 text-[0.95rem] font-medium transition-all duration-200 hover:-translate-y-[1px]"
                          style={secondaryActionButtonStyle}
                          onClick={() => addToast("Opening deleted evidence...", "info")}
                        >
                          Deleted Evidence
                        </Button>
                      </Link>

                      <Link href="/locked">
                        <Button
                          variant="secondary"
                          className="w-full rounded-[999px] border px-5 py-3 text-[0.95rem] font-medium transition-all duration-200 hover:-translate-y-[1px]"
                          style={secondaryActionButtonStyle}
                          onClick={() => addToast("Opening locked evidence...", "info")}
                        >
                          Locked Evidence
                        </Button>
                      </Link>

                      <Link href="/settings">
                        <Button
                          variant="secondary"
                          className="w-full rounded-[999px] border px-5 py-3 text-[0.95rem] font-medium transition-all duration-200 hover:-translate-y-[1px]"
                          style={secondaryActionButtonStyle}
                          onClick={() => addToast("Opening settings...", "info")}
                        >
                          Manage Settings
                        </Button>
                      </Link>
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
                            color: "#d4b18f",
                            border: "1px solid rgba(183,157,132,0.20)",
                            boxShadow: "0 0 18px rgba(183,157,132,0.07)",
                          }}
                        >
                          ✓
                        </div>

                        <div>
                          <div className="font-bold text-[#dfe6e3]">
                            Trusted chain of custody
                          </div>
                          <div className="mt-1 text-[12px] text-[rgba(201,211,208,0.72)]">
                            Capture → Sign → Report → Share
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="mt-4 rounded-[22px] border border-[rgba(183,157,132,0.14)] bg-[rgba(255,255,255,0.028)] px-4 py-4">
                      <div className="mb-2 text-[0.78rem] font-semibold uppercase tracking-[0.18em] text-[#b79d84]">
                        Workspace flow
                      </div>
                      <div className="text-[0.92rem] leading-[1.75] text-[rgba(194,204,201,0.76)]">
                        Everything important stays one click away, while the visual language remains
                        premium, quiet, and consistent with the rest of the platform.
                      </div>
                    </div>
                  </div>
                </Card>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}