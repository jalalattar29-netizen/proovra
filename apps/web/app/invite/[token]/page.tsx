"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { Button, Card, Skeleton, useToast } from "../../../components/ui";
import { apiFetch } from "../../../lib/api";
import { captureException } from "../../../lib/sentry";
import { MarketingHeader } from "../../../components/header";
import { Footer } from "../../../components/Footer";

type InviteState =
  | "loading"
  | "ready"
  | "accepting"
  | "success"
  | "error"
  | "expired"
  | "already_accepted"
  | "mismatch"
  | "invalid";

export default function InviteAcceptPage() {
  const params = useParams<{ token: string }>();
  const router = useRouter();
  const { addToast } = useToast();

  const token = params?.token ?? "";

  const [state, setState] = useState<InviteState>("loading");
  const [errorMessage, setErrorMessage] = useState("");

  useEffect(() => {
    if (!token) return;

    const verify = async () => {
      setState("loading");
      setErrorMessage("");

      try {
        const result = await apiFetch(`/v1/teams/invites/${token}/accept`, {
          method: "POST",
          body: JSON.stringify({}),
        });

        if (result?.invite) {
          setState("success");
          addToast("Invitation accepted! Redirecting to your team...", "success");
          setTimeout(() => {
            router.push("/teams");
          }, 2000);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";

        if (message.includes("already accepted")) {
          setState("already_accepted");
          setErrorMessage("This invitation has already been accepted.");
        } else if (message.includes("expired")) {
          setState("expired");
          setErrorMessage("This invitation has expired. Please ask for a new one.");
        } else if (
          message.includes("signed in with the invited email") ||
          message.includes("Forbidden")
        ) {
          setState("mismatch");
          setErrorMessage(
            "You are signed in with a different email address than the one this invitation was sent to. Please sign in with the correct email account."
          );
        } else if (message.includes("Invite not found")) {
          setState("invalid");
          setErrorMessage("This invitation link is not valid or does not exist.");
        } else {
          setState("error");
          setErrorMessage(message || "Failed to accept invitation");
        }

        captureException(err, { feature: "invite_accept", token });
      }
    };

    verify();
  }, [token]);

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

          <div className="relative z-10 px-7 py-8 md:px-8 md:py-9">
            <h2 className="m-0 text-[1.6rem] font-semibold tracking-[-0.03em] text-[#1d3136]">
              Accepting Invitation
            </h2>
            <p className="mt-2 mb-5 text-[0.96rem] leading-[1.75] text-[#55666a]">
              Please wait...
            </p>
            <Skeleton width="100%" height="80px" />
          </div>
        </Card>
      );
    }

    if (state === "success") {
      return (
        <Card className="relative overflow-hidden rounded-[30px] border border-[rgba(79,112,107,0.22)] bg-transparent p-0 shadow-[0_30px_80px_rgba(0,0,0,0.18)]">
          <img
            src="/images/panel-silver.webp.png"
            alt=""
            className="absolute inset-0 h-full w-full object-cover object-center"
          />
          <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.28)_0%,rgba(245,247,244,0.45)_50%,rgba(236,239,236,0.58)_100%)]" />
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_85%_18%,rgba(214,184,157,0.18),transparent_38%)]" />

          <div className="relative z-10 px-7 py-8 text-center md:px-8 md:py-9">
            <h2 className="m-0 text-[1.6rem] font-semibold tracking-[-0.03em] text-[#1d3136]">
              Invitation Accepted
            </h2>
            <p className="mt-3 text-[0.96rem] leading-[1.75] text-[#55666a]">
              You have successfully accepted the invitation and joined the team.
            </p>
            <div className="mt-6">
              <Button onClick={() => router.push("/teams")}>Go to Teams</Button>
            </div>
          </div>
        </Card>
      );
    }

    const errorTitle =
      state === "expired"
        ? "Invitation Expired"
        : state === "already_accepted"
          ? "Already Accepted"
          : state === "mismatch"
            ? "Email Mismatch"
            : state === "invalid"
              ? "Invalid Invitation"
              : "Invitation Error";

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
          <h2 className="m-0 text-[1.6rem] font-semibold tracking-[-0.03em] text-[#1d3136]">
            {errorTitle}
          </h2>

          <p className="mt-3 text-[0.96rem] leading-[1.75] text-[#55666a]">
            {errorMessage}
          </p>

          <div className="mt-6 flex flex-wrap gap-3">
            <Link href="/teams" style={{ textDecoration: "none" }}>
              <Button>Go to Teams</Button>
            </Link>

            <Link href="/" style={{ textDecoration: "none" }}>
              <Button variant="secondary">Go Home</Button>
            </Link>
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