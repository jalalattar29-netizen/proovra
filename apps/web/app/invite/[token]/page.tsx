"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { Button, Card, Skeleton, useToast } from "../../../components/ui";
import { apiFetch } from "../../../lib/api";
import { captureException } from "../../../lib/sentry";

type InviteState = "loading" | "ready" | "accepting" | "success" | "error" | "expired" | "already_accepted" | "mismatch" | "invalid";

export default function InviteAcceptPage() {
  const params = useParams<{ token: string }>();
  const router = useRouter();
  const { addToast } = useToast();

  const token = params?.token ?? "";

  const [state, setState] = useState<InviteState>("loading");
  const [teamName, setTeamName] = useState("");
  const [invitedEmail, setInvitedEmail] = useState("");
  const [invitedRole, setInvitedRole] = useState("");
  const [errorMessage, setErrorMessage] = useState("");

  useEffect(() => {
    if (!token) return;

    const verify = async () => {
      setState("loading");
      setErrorMessage("");

      try {
        // Try to accept the invite - if it works, we're good
        // If it fails with specific reasons, we show the appropriate state
        const result = await apiFetch(`/v1/teams/invites/${token}/accept`, {
          method: "POST",
          body: JSON.stringify({}),
        });

        // Success!
        if (result?.invite) {
          // Extract team name from the response if available
          const team = result.invite?.team;
          if (team?.name) {
            setTeamName(team.name);
          }
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

  if (state === "loading") {
    return (
      <div className="section app-section">
        <div className="app-hero app-hero-full">
          <div className="container">
            <h1 className="hero-title pricing-hero-title" style={{ margin: 0 }}>
              Accepting Invitation
            </h1>
            <p className="page-subtitle pricing-subtitle" style={{ marginTop: 6 }}>
              Please wait...
            </p>
          </div>
        </div>

        <div className="app-body app-body-full">
          <div className="container" style={{ maxWidth: 560 }}>
            <Card>
              <Skeleton width="100%" height="80px" />
            </Card>
          </div>
        </div>
      </div>
    );
  }

  if (state === "success") {
    return (
      <div className="section app-section">
        <div className="app-hero app-hero-full">
          <div className="container">
            <h1 className="hero-title pricing-hero-title" style={{ margin: 0 }}>
              Invitation Accepted
            </h1>
            <p className="page-subtitle pricing-subtitle" style={{ marginTop: 6 }}>
              Welcome to your new team workspace
            </p>
          </div>
        </div>

        <div className="app-body app-body-full">
          <div className="container" style={{ maxWidth: 560 }}>
            <Card>
              <div style={{ padding: 24, textAlign: "center" }}>
                <div style={{ fontSize: 14, color: "#E2E8F0", marginBottom: 12 }}>
                  You have successfully accepted the invitation and joined the team.
                </div>
                <div style={{ marginTop: 20 }}>
                  <Button className="navy-btn" onClick={() => router.push("/teams")}>
                    Go to Teams
                  </Button>
                </div>
              </div>
            </Card>
          </div>
        </div>
      </div>
    );
  }

  // Error states
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
    <div className="section app-section">
      <div className="app-hero app-hero-full">
        <div className="container">
          <h1 className="hero-title pricing-hero-title" style={{ margin: 0 }}>
            {errorTitle}
          </h1>
          <p className="page-subtitle pricing-subtitle" style={{ marginTop: 6 }}>
            {state === "expired" && "Request a new invitation"}
            {state === "already_accepted" && "This invitation has already been claimed"}
            {state === "mismatch" && "Sign in with the correct email"}
            {state === "invalid" && "The link is not valid"}
            {state === "error" && "Something went wrong"}
          </p>
        </div>
      </div>

      <div className="app-body app-body-full">
        <div className="container" style={{ maxWidth: 560 }}>
          <Card>
            <div style={{ padding: 24 }}>
              <div style={{ fontSize: 14, color: "#E2E8F0", marginBottom: 20, lineHeight: 1.6 }}>
                {errorMessage}
              </div>

              <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                <Link href="/teams" style={{ textDecoration: "none" }}>
                  <Button className="navy-btn">Go to Teams</Button>
                </Link>

                <Link href="/" style={{ textDecoration: "none" }}>
                  <Button variant="secondary">Go Home</Button>
                </Link>
              </div>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
