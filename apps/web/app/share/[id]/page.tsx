"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Button, Card } from "../../../components/ui";
import { apiFetch } from "../../../lib/api";
import { Icons } from "../../../components/icons";
import { MarketingHeader } from "../../../components/header";
import { Footer } from "../../../components/Footer";

type PageState = "loading" | "success" | "error";

export default function SharePage() {
  const params = useParams<{ id: string }>();
  const [reportUrl, setReportUrl] = useState<string | null>(null);
  const [state, setState] = useState<PageState>("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!params?.id) {
      setState("error");
      setErrorMessage("Invalid share link: no evidence ID provided.");
      return;
    }

    setState("loading");
    setErrorMessage(null);

    apiFetch(`/public/share/${params.id}`)
      .then((data) => {
        const url = data.report?.url ?? null;
        if (url) {
          setReportUrl(url);
          setState("success");
        } else {
          setErrorMessage("Report not available. The evidence may not have been processed yet.");
          setState("error");
        }
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : "Failed to load report";
        setErrorMessage(msg || "Unable to retrieve the shared evidence. Please check the link.");
        setState("error");
      });
  }, [params?.id]);

  const renderCard = () => {
    if (state === "loading") {
      return (
        <Card className="relative overflow-hidden rounded-[30px] border border-[rgba(79,112,107,0.22)] bg-transparent p-0 shadow-[0_30px_80px_rgba(0,0,0,0.18)]">
          <img
            src="/images/panel-silver.webp.png"
            alt=""
            className="absolute inset-0 h-full w-full object-cover object-center"
          />
          <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.28)_0%,rgba(245,247,244,0.45)_50%,rgba(236,239,236,0.58)_100%)]" />
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_85%_18%,rgba(214,184,157,0.18),transparent_38%)]" />

          <div className="relative z-10 flex items-center justify-center gap-3 px-6 py-10 text-[#1f3438]">
            <div style={{ animation: "spin 1s linear infinite" }} className="text-[#3f5e62]">
              <Icons.Fingerprint />
            </div>
            <span className="text-[1rem] font-medium tracking-[-0.01em]">
              Loading shared evidence...
            </span>
          </div>

          <style>{`
            @keyframes spin {
              from { transform: rotate(0deg); }
              to { transform: rotate(360deg); }
            }
          `}</style>
        </Card>
      );
    }

    if (state === "error") {
      return (
        <Card className="relative overflow-hidden rounded-[30px] border border-[rgba(79,112,107,0.22)] bg-transparent p-0 shadow-[0_30px_80px_rgba(0,0,0,0.18)]">
          <img
            src="/images/panel-silver.webp.png"
            alt=""
            className="absolute inset-0 h-full w-full object-cover object-center"
          />
          <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.28)_0%,rgba(245,247,244,0.45)_50%,rgba(236,239,236,0.58)_100%)]" />
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_85%_18%,rgba(214,184,157,0.18),transparent_38%)]" />

          <div className="relative z-10 px-7 py-8 md:px-8 md:py-9">
            <div className="mb-5 flex gap-4">
              <div className="text-[2rem] leading-none text-[#9b826b]">⚠️</div>
              <div>
                <h2 className="m-0 text-[1.55rem] font-semibold tracking-[-0.03em] text-[#1d3136]">
                  Unable to Load Evidence
                </h2>
                <p className="mt-2 mb-0 text-[0.96rem] leading-[1.8] text-[#55666a]">
                  {errorMessage}
                </p>
              </div>
            </div>

            <div className="mt-5 rounded-[18px] border border-[rgba(79,112,107,0.16)] bg-[rgba(255,255,255,0.38)] p-4">
              <p className="m-0 text-[0.86rem] leading-[1.7] text-[#66777b]">
                Evidence ID:{" "}
                <code className="rounded bg-[rgba(183,157,132,0.12)] px-2 py-1 text-[#7f6450]">
                  {params?.id}
                </code>
              </p>
            </div>

            <p className="mt-4 mb-0 text-[0.86rem] leading-[1.7] text-[#66777b]">
              If you believe this is an error, please contact support at{" "}
              <a href="mailto:support@proovra.com" className="font-medium text-[#b79d84]">
                support@proovra.com
              </a>
            </p>
          </div>
        </Card>
      );
    }

    return (
      <Card className="relative overflow-hidden rounded-[30px] border border-[rgba(79,112,107,0.22)] bg-transparent p-0 shadow-[0_30px_80px_rgba(0,0,0,0.18)]">
        <img
          src="/images/panel-silver.webp.png"
          alt=""
          className="absolute inset-0 h-full w-full object-cover object-center"
        />
        <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.28)_0%,rgba(245,247,244,0.45)_50%,rgba(236,239,236,0.58)_100%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_85%_18%,rgba(214,184,157,0.18),transparent_38%)]" />

        <div className="relative z-10 px-7 py-8 md:px-8 md:py-9">
          <div className="mb-5 flex gap-4">
            <div className="text-[2rem] leading-none text-[#3f6b68]">✓</div>
            <div>
              <h2 className="m-0 text-[1.55rem] font-semibold tracking-[-0.03em] text-[#1d3136]">
                Shared Evidence Report
              </h2>
              <p className="mt-2 mb-0 text-[0.92rem] leading-[1.7] text-[#55666a]">
                Evidence ID:{" "}
                <code className="rounded bg-[rgba(183,157,132,0.12)] px-2 py-1 text-[#7f6450]">
                  {params?.id}
                </code>
              </p>
            </div>
          </div>

          <div className="mt-6 w-full">
            <Button
              onClick={() => reportUrl && window.open(reportUrl, "_blank")}
              disabled={!reportUrl}
              className="w-full rounded-[16px]"
            >
              {reportUrl ? "Download Report" : "Report Unavailable"}
            </Button>
          </div>
        </div>
      </Card>
    );
  };

  return (
    <div className="page landing-page">
      <div className="relative min-h-screen overflow-hidden">
        <div className="absolute inset-0">
          <img
            src="/images/site-velvet-bg.webp.png"
            alt=""
            className="h-full w-full object-cover object-center"
          />
        </div>

        <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(8,18,22,0.84)_0%,rgba(8,18,22,0.74)_34%,rgba(8,18,22,0.68)_100%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_16%_14%,rgba(158,216,207,0.08),transparent_24%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_84%_22%,rgba(214,184,157,0.06),transparent_18%)]" />
        <div className="absolute inset-0 opacity-[0.035] [background:repeating-linear-gradient(0deg,rgba(255,255,255,0.022)_0px,rgba(255,255,255,0.022)_1px,transparent_1px,transparent_4px)]" />

        <div className="relative z-10 flex min-h-screen flex-col">
          <MarketingHeader />

          <main className="flex flex-1 items-center justify-center px-6 py-10 md:px-8 md:py-14">
            <div className="w-full max-w-[760px]">
              {renderCard()}
            </div>
          </main>

          <Footer />
        </div>
      </div>
    </div>
  );
}