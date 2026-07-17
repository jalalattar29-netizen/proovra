"use client";

/**
 * Privacy & Legal Records (2026-07-16 Settings IA remediation).
 *
 * Account-relevant privacy content ONLY:
 *
 *   A. Cookie preferences — manage via the consent modal; the latest
 *      recorded consent (version + timestamp + categories) is shown.
 *   B. Legal acceptance history — a STRUCTURED list from
 *      GET /v1/users/legal-acceptance, with the semantic TYPE made
 *      explicit per record. Consent, contract acceptance, and
 *      acknowledgement are legally distinct and are never conflated:
 *        terms   → Contract acceptance
 *        privacy → Acknowledgement
 *        cookies → Consent
 *      (The backend records rows only on explicit acceptance actions —
 *      never on merely viewing a policy.)
 *   C. Privacy actions — only REAL existing flows are linked (privacy
 *      requests). No invented deletion/export buttons: those flows do
 *      not exist in the product today.
 *   D. Essential references — Privacy Policy, Terms, Cookie Policy only.
 *      The full public legal library stays in the footer and the public
 *      Trust Center; the old ~25-link dump does not belong here.
 */

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { PageShell, PageHeader } from "../../../../components/ui/PageShell";
import { Card } from "../../../../components/ui/Card";
import { Button } from "../../../../components/ui/Button";
import { Badge } from "../../../../components/ui/Badge";
import { apiFetch } from "../../../../lib/api";
import { formatUserDateTime } from "../../../../lib/date";
import { openCookiePreferences } from "../../../../lib/consent";
import { useAuth } from "../../../providers";
import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
import { toSafeUserError } from "../../../../lib/feedback/toSafeUserError";
import {
  StepUpVerify,
  extractStepUp,
  type StepUpMethods,
  type StepUpProof,
} from "../../security-center/components/PersonalSecuritySections";

type LegalAcceptanceItem = {
  id: string;
  policyKey: string;
  policyVersion: string;
  acceptedAt: string;
  source?: string | null;
};

type CookieConsentRecord = {
  id: string;
  consentVersion: string;
  necessary: boolean;
  analytics: boolean;
  marketing: boolean;
  preferences: boolean;
  createdAt: string;
};

/**
 * Semantic classification per policy key — consent, contract acceptance,
 * and acknowledgement are NOT legally equivalent and are labeled apart.
 */
const POLICY_PRESENTATION: Record<
  string,
  { title: string; kind: string }
> = {
  terms: { title: "Terms of Service accepted", kind: "Contract acceptance" },
  privacy: { title: "Privacy notice acknowledged", kind: "Acknowledgement" },
  cookies: { title: "Cookie policy accepted", kind: "Consent" },
};

function presentPolicy(key: string): { title: string; kind: string } {
  return (
    POLICY_PRESENTATION[key] ?? {
      title: `${key} accepted`,
      kind: "Acceptance",
    }
  );
}

const sectionTitle: React.CSSProperties = {
  margin: "0 0 8px",
  fontSize: 14,
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: 0.4,
  color: "var(--ink-primary, #0f172a)",
};

const muted: React.CSSProperties = {
  margin: 0,
  fontSize: 13,
  color: "var(--ink-secondary, #475569)",
};

type ExportRequestRow = {
  id: string;
  status: string;
  requestedAtUtc: string;
  completedAtUtc: string | null;
  expiresAtUtc: string | null;
  failureCode: string | null;
  packageSha256: string | null;
  downloadCount: number;
};

const EXPORT_STATUS_LABEL: Record<string, string> = {
  REQUESTED: "Requested — queued for generation",
  PROCESSING: "Generating…",
  READY: "Ready to download",
  FAILED: "Failed",
  EXPIRED: "Expired",
  CANCELLED: "Cancelled",
};

function DataExportCard() {
  const [rows, setRows] = useState<ExportRequestRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [stepUpFor, setStepUpFor] = useState<
    null | { kind: "request" } | { kind: "download"; id: string }
  >(null);
  const [stepUpMethods, setStepUpMethods] = useState<StepUpMethods>(["reauth"]);
  const [stepUpMsg, setStepUpMsg] = useState("");

  const reload = useCallback(async () => {
    try {
      const res = (await apiFetch("/v1/identity/data-export", {
        method: "GET",
      })) as { requests: ExportRequestRow[] };
      setRows(res.requests ?? []);
    } catch {
      setRows([]);
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);

  const requestExport = useCallback(
    async (proof?: StepUpProof) => {
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        await apiFetch("/v1/identity/data-export", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(proof ? { stepUp: proof } : {}),
        });
        setStepUpFor(null);
        setNotice(
          "Export requested. Generation runs in the background — check back here; the package stays available for 7 days.",
        );
        await reload();
      } catch (err) {
        const su = extractStepUp(err);
        if (su) {
          setStepUpFor({ kind: "request" });
          setStepUpMethods(su.methods);
          setStepUpMsg(su.message);
          return;
        }
        const e = err as { body?: { error?: { code?: string; message?: string } } };
        setError(
          e.body?.error?.code === "export_request_active"
            ? (e.body.error.message ?? "An export is already active.")
            : toSafeUserError(err, { message: "Could not request the export." }).message,
        );
      } finally {
        setBusy(false);
      }
    },
    [reload],
  );

  const download = useCallback(
    async (id: string, proof?: StepUpProof) => {
      setBusy(true);
      setError(null);
      try {
        // apiFetch carries the auth token + API base and returns the
        // parsed JSON package; we re-serialize it into the downloaded
        // file (integrity sha is visible on the request row + response
        // header server-side).
        const pkg = await apiFetch(`/v1/identity/data-export/${id}/download`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(proof ? { stepUp: proof } : {}),
        });
        const blob = new Blob([JSON.stringify(pkg, null, 2)], {
          type: "application/json",
        });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `proovra-account-export-${id}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        setStepUpFor(null);
        await reload();
      } catch (err) {
        const su = extractStepUp(err);
        if (su) {
          setStepUpFor({ kind: "download", id });
          setStepUpMethods(su.methods);
          setStepUpMsg(su.message);
          return;
        }
        setError(
          toSafeUserError(err, { message: "Could not download the export." }).message,
        );
      } finally {
        setBusy(false);
      }
    },
    [reload],
  );

  const active = rows?.find((r) =>
    ["REQUESTED", "PROCESSING", "READY"].includes(r.status),
  );

  return (
    <Card variant="admin" padding="comfortable" data-cc-privacy-export>
      <h2 style={sectionTitle}>Personal data export</h2>
      <p style={muted}>
        Request a copy of your personal account data — profile, login
        methods, preferences, consent records, account activity, sessions,
        and organization memberships. Evidence and organization records are
        excluded and remain available through their own authorized surfaces.
        Available on every plan.
      </p>

      {rows === null ? (
        <p style={{ ...muted, marginTop: 10 }}>Loading…</p>
      ) : rows.length === 0 ? (
        <p style={{ ...muted, marginTop: 10 }}>No exports requested yet.</p>
      ) : (
        <ul style={{ listStyle: "none", margin: "10px 0 0", padding: 0 }}>
          {rows.slice(0, 3).map((r) => (
            <li
              key={r.id}
              data-cc-export-row={r.status}
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 10,
                flexWrap: "wrap",
                padding: "8px 2px",
                borderBottom: "1px solid var(--border-default, rgba(15,23,42,0.07))",
                fontSize: 13,
              }}
            >
              <span style={{ color: "var(--ink-primary, #0f172a)" }}>
                {EXPORT_STATUS_LABEL[r.status] ?? r.status}
                <span style={{ ...muted, display: "inline", marginLeft: 8 }}>
                  requested {formatUserDateTime(r.requestedAtUtc)}
                  {r.status === "READY" && r.expiresAtUtc
                    ? ` · expires ${formatUserDateTime(r.expiresAtUtc)}`
                    : ""}
                </span>
              </span>
              {r.status === "READY" ? (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => void download(r.id)}
                  disabled={busy}
                  data-cc-export-download={r.id}
                >
                  Download
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {!active ? (
        <div className="mt-4">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void requestExport()}
            loading={busy}
            disabled={busy}
            data-cc-export-request
          >
            Request data export
          </Button>
        </div>
      ) : null}

      {stepUpFor ? (
        <StepUpVerify
          title={
            stepUpFor.kind === "request"
              ? "Confirm requesting a copy of your personal data."
              : "Confirm downloading your personal data export."
          }
          methods={stepUpMethods}
          initialError={stepUpMsg}
          busy={busy}
          onSubmit={(proof) =>
            stepUpFor.kind === "request"
              ? void requestExport(proof)
              : void download(stepUpFor.id, proof)
          }
          onCancel={() => {
            setStepUpFor(null);
            setStepUpMsg("");
          }}
        />
      ) : null}

      {error ? (
        <div
          role="alert"
          className="mt-3 rounded-lg border px-3 py-2 text-[12px]"
          style={{
            borderColor: "rgba(179,38,30,0.35)",
            background: "rgba(179,38,30,0.06)",
            color: "#8f1d16",
          }}
        >
          {error}
        </div>
      ) : null}
      {notice ? (
        <div
          className="mt-3 rounded-lg border px-3 py-2 text-[12px]"
          style={{
            borderColor: "rgba(47,125,91,0.35)",
            background: "rgba(47,125,91,0.07)",
            color: "#215e44",
          }}
        >
          {notice}
        </div>
      ) : null}
    </Card>
  );
}

type ClosureBlocker = { code: string; message: string; count: number };

type ClosureRequestRow = {
  id: string;
  status: string;
  reason: string | null;
  blockersJson: string | null;
  requestedAtUtc: string;
  coolingOffEndsAtUtc: string | null;
  cancelledAtUtc: string | null;
  completedAtUtc: string | null;
  failureCode: string | null;
};

const CLOSURE_STATUS_LABEL: Record<string, string> = {
  REQUESTED: "Requested",
  BLOCKED: "Blocked — action needed",
  COOLING_OFF: "Scheduled — cancellation window open",
  SCHEDULED: "Scheduled",
  PROCESSING: "Closing…",
  COMPLETED: "Closed",
  CANCELLED: "Cancelled",
  FAILED: "Failed",
};

const CLOSURE_CANCELLABLE = ["REQUESTED", "BLOCKED", "COOLING_OFF", "SCHEDULED"];

function AccountClosureCard() {
  const [state, setState] = useState<{
    request: ClosureRequestRow | null;
    blockers: ClosureBlocker[];
    confirmationPhrase: string;
    coolingOffDays: number;
  } | null>(null);
  const [phrase, setPhrase] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stepUpOpen, setStepUpOpen] = useState(false);
  const [stepUpMethods, setStepUpMethods] = useState<StepUpMethods>(["reauth"]);
  const [stepUpMsg, setStepUpMsg] = useState("");

  const reload = useCallback(async () => {
    try {
      const res = (await apiFetch("/v1/identity/account-closure", {
        method: "GET",
      })) as {
        request: ClosureRequestRow | null;
        blockers: ClosureBlocker[];
        confirmationPhrase: string;
        coolingOffDays: number;
      };
      setState(res);
    } catch {
      setState({
        request: null,
        blockers: [],
        confirmationPhrase: "close my account",
        coolingOffDays: 7,
      });
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);

  const requestClosure = useCallback(
    async (proof?: StepUpProof) => {
      setBusy(true);
      setError(null);
      try {
        // The typed phrase travels to the backend and is validated
        // SERVER-SIDE — no frontend confirmation boolean exists anywhere.
        await apiFetch("/v1/identity/account-closure", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            confirmation: phrase,
            ...(proof ? { stepUp: proof } : {}),
          }),
        });
        setStepUpOpen(false);
        setShowForm(false);
        setPhrase("");
        await reload();
      } catch (err) {
        const su = extractStepUp(err);
        if (su) {
          setStepUpOpen(true);
          setStepUpMethods(su.methods);
          setStepUpMsg(su.message);
          return;
        }
        const e = err as { body?: { error?: { code?: string; message?: string } } };
        const code = e.body?.error?.code;
        if (code === "closure_blocked") {
          setError(
            "Closure is blocked — resolve the items listed above and try again.",
          );
          await reload();
        } else if (code === "confirmation_mismatch") {
          setError(e.body?.error?.message ?? "The confirmation phrase does not match.");
        } else if (code === "closure_request_active") {
          setError("An account closure request is already open.");
          await reload();
        } else {
          setError(
            toSafeUserError(err, { message: "Could not request account closure." }).message,
          );
        }
      } finally {
        setBusy(false);
      }
    },
    [phrase, reload],
  );

  const cancelClosure = useCallback(
    async (id: string) => {
      setBusy(true);
      setError(null);
      try {
        await apiFetch(`/v1/identity/account-closure/${id}/cancel`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        });
        await reload();
      } catch (err) {
        setError(
          toSafeUserError(err, { message: "Could not cancel the request." }).message,
        );
      } finally {
        setBusy(false);
      }
    },
    [reload],
  );

  const req = state?.request ?? null;
  const open =
    req !== null &&
    ["REQUESTED", "BLOCKED", "COOLING_OFF", "SCHEDULED", "PROCESSING"].includes(
      req.status,
    );
  const blockers = state?.blockers ?? [];
  const phraseExpected = state?.confirmationPhrase ?? "close my account";

  return (
    <Card variant="admin" padding="comfortable" data-cc-privacy-closure>
      <h2 style={sectionTitle}>Close account</h2>
      <p style={muted}>
        Closing your account signs you out everywhere, removes your login
        methods, and anonymizes your personal details after a{" "}
        {state?.coolingOffDays ?? 7}-day cancellation window. Evidence is
        never deleted by account closure — it stays governed by retention
        and legal-hold rules. Available on every plan.
      </p>

      {open && req ? (
        <div className="mt-3" data-cc-closure-status={req.status}>
          <p style={{ ...muted, color: "var(--ink-primary, #0f172a)" }}>
            {CLOSURE_STATUS_LABEL[req.status] ?? req.status}
            {req.status === "COOLING_OFF" && req.coolingOffEndsAtUtc
              ? ` — your account closes after ${formatUserDateTime(req.coolingOffEndsAtUtc)} unless you cancel.`
              : ""}
          </p>
          {req.status === "BLOCKED" && req.blockersJson ? (
            <ul style={{ ...muted, margin: "6px 0 0", paddingLeft: 18 }}>
              {(JSON.parse(req.blockersJson) as ClosureBlocker[]).map((b) => (
                <li key={b.code}>{b.message}</li>
              ))}
            </ul>
          ) : null}
          {CLOSURE_CANCELLABLE.includes(req.status) ? (
            <div className="mt-3">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void cancelClosure(req.id)}
                loading={busy}
                disabled={busy}
                data-cc-closure-cancel
              >
                Cancel closure request
              </Button>
            </div>
          ) : null}
        </div>
      ) : (
        <>
          {blockers.length > 0 ? (
            <div className="mt-3" data-cc-closure-blockers>
              <p style={{ ...muted, fontWeight: 600 }}>
                These must be resolved before your account can close:
              </p>
              <ul style={{ ...muted, margin: "6px 0 0", paddingLeft: 18 }}>
                {blockers.map((b) => (
                  <li key={b.code}>{b.message}</li>
                ))}
              </ul>
            </div>
          ) : null}

          {!showForm ? (
            <div className="mt-4">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setShowForm(true)}
                disabled={busy}
                data-cc-closure-open
              >
                Close my account…
              </Button>
            </div>
          ) : (
            <div className="mt-4" data-cc-closure-form>
              <label
                htmlFor="closure-confirm"
                style={{ ...muted, display: "block", marginBottom: 6 }}
              >
                Type <strong>{phraseExpected}</strong> to confirm.
              </label>
              <input
                id="closure-confirm"
                type="text"
                value={phrase}
                onChange={(e) => setPhrase(e.target.value)}
                autoComplete="off"
                className="w-full max-w-sm rounded-lg border px-3 py-2 text-[13px]"
                style={{ borderColor: "var(--border-default, rgba(15,23,42,0.15))" }}
              />
              <div className="mt-3 flex gap-2">
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => void requestClosure()}
                  loading={busy}
                  disabled={
                    busy ||
                    phrase.trim().toLowerCase() !== phraseExpected
                  }
                  data-cc-closure-submit
                >
                  Request account closure
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setShowForm(false);
                    setPhrase("");
                    setError(null);
                  }}
                  disabled={busy}
                >
                  Keep my account
                </Button>
              </div>
            </div>
          )}
        </>
      )}

      {stepUpOpen ? (
        <StepUpVerify
          title="Confirm closing your account."
          methods={stepUpMethods}
          initialError={stepUpMsg}
          busy={busy}
          onSubmit={(proof) => void requestClosure(proof)}
          onCancel={() => {
            setStepUpOpen(false);
            setStepUpMsg("");
          }}
        />
      ) : null}

      {error ? (
        <div
          role="alert"
          className="mt-3 rounded-lg border px-3 py-2 text-[12px]"
          style={{
            borderColor: "rgba(179,38,30,0.35)",
            background: "rgba(179,38,30,0.06)",
            color: "#8f1d16",
          }}
        >
          {error}
        </div>
      ) : null}
    </Card>
  );
}

export default function PrivacyPage() {
  return (
    <div data-testid="account-privacy-page">
      <PageRouteGate routeId="account.privacy">
        <PrivacyInner />
      </PageRouteGate>
    </div>
  );
}

function PrivacyInner() {
  const { user } = useAuth();
  const [acceptances, setAcceptances] = useState<LegalAcceptanceItem[] | null>(null);
  const [cookieConsent, setCookieConsent] = useState<CookieConsentRecord | null>(null);

  useEffect(() => {
    if (!user?.id) return;
    apiFetch("/v1/users/legal-acceptance")
      .then((data: { items?: LegalAcceptanceItem[] }) =>
        setAcceptances(Array.isArray(data.items) ? data.items : []),
      )
      .catch(() => setAcceptances([]));
    apiFetch("/v1/users/cookie-consent/latest")
      .then((data: { record?: CookieConsentRecord | null }) =>
        setCookieConsent(data.record ?? null),
      )
      .catch(() => setCookieConsent(null));
  }, [user?.id]);

  const consentCategories = cookieConsent
    ? (
        [
          ["Necessary", cookieConsent.necessary],
          ["Preferences", cookieConsent.preferences],
          ["Analytics", cookieConsent.analytics],
          ["Marketing", cookieConsent.marketing],
        ] as const
      )
        .filter(([, on]) => on)
        .map(([label]) => label)
        .join(", ")
    : null;

  return (
    <PageShell
      header={
        <PageHeader
          eyebrow="Account"
          title="Privacy & legal records"
          subtitle="Your cookie preferences and recorded policy acceptances. Consent, contract acceptance, and acknowledgements are recorded — and shown — as distinct record types."
        />
      }
    >
      <div style={{ display: "grid", gap: 14, maxWidth: 720 }}>
        {/* A. Cookie preferences */}
        <Card variant="admin" padding="comfortable" data-cc-privacy-cookies>
          <h2 style={sectionTitle}>Cookie preferences</h2>
          {cookieConsent ? (
            <div className="grid gap-1.5 text-[13px]">
              <div className="flex items-center justify-between gap-3">
                <span style={muted}>Consent version</span>
                <span style={{ color: "var(--ink-primary, #0f172a)", fontWeight: 600 }}>
                  v{cookieConsent.consentVersion}
                </span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span style={muted}>Recorded</span>
                <span style={{ color: "var(--ink-primary, #0f172a)" }}>
                  {formatUserDateTime(cookieConsent.createdAt)}
                </span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span style={muted}>Allowed categories</span>
                <span style={{ color: "var(--ink-primary, #0f172a)" }}>
                  {consentCategories || "Necessary only"}
                </span>
              </div>
            </div>
          ) : (
            <p style={muted}>No cookie consent recorded on this account yet.</p>
          )}
          <div className="mt-4">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => openCookiePreferences()}
              data-cc-privacy-manage-cookies
            >
              Manage Cookie Preferences
            </Button>
          </div>
        </Card>

        {/* B. Legal acceptance history — structured, typed rows */}
        <Card variant="admin" padding="comfortable" data-cc-privacy-acceptances>
          <h2 style={sectionTitle}>Policy acceptance history</h2>
          <p style={muted}>
            Records are written only when you explicitly accept — viewing a
            policy is never recorded as consent.
          </p>
          {acceptances === null ? (
            <p style={{ ...muted, marginTop: 10 }}>Loading…</p>
          ) : acceptances.length === 0 ? (
            <p style={{ ...muted, marginTop: 10 }}>
              No acceptance records on this account yet.
            </p>
          ) : (
            <ul style={{ listStyle: "none", margin: "10px 0 0", padding: 0 }}>
              {acceptances.map((item) => {
                const p = presentPolicy(item.policyKey);
                return (
                  <li
                    key={item.id}
                    data-cc-privacy-acceptance-row={item.policyKey}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 10,
                      flexWrap: "wrap",
                      padding: "9px 2px",
                      borderBottom:
                        "1px solid var(--border-default, rgba(15,23,42,0.07))",
                      fontSize: 13,
                    }}
                  >
                    <span style={{ color: "var(--ink-primary, #0f172a)", fontWeight: 600 }}>
                      {p.title}
                      <Badge tone="neutral" subtle style={{ marginLeft: 8 }}>
                        {p.kind}
                      </Badge>
                    </span>
                    <span style={muted}>
                      v{item.policyVersion} · {formatUserDateTime(item.acceptedAt)}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        {/* B2. Personal account data export (lifecycle Phase 4) — a REAL
            asynchronous flow: request (step-up) → generated on the platform
            cron → download (step-up, authenticated, user-bound) → expires
            after 7 days with secure payload deletion. Account-level and
            never plan-gated. */}
        <DataExportCard />

        <AccountClosureCard />

        {/* C+D. Privacy actions + essential references. Only REAL flows —
            no invented deletion/export buttons. */}
        <Card variant="admin" padding="comfortable" data-cc-privacy-references>
          <h2 style={sectionTitle}>Privacy actions &amp; references</h2>
          <div className="grid gap-2 text-[13.5px]">
            <Link href="/legal/privacy-requests" style={{ color: "var(--ink-primary, #0f172a)" }}>
              Submit a privacy request →
            </Link>
            <Link href="/privacy" style={{ color: "var(--ink-secondary, #475569)" }}>
              Privacy Policy
            </Link>
            <Link href="/terms" style={{ color: "var(--ink-secondary, #475569)" }}>
              Terms of Service
            </Link>
            <Link href="/legal/cookies" style={{ color: "var(--ink-secondary, #475569)" }}>
              Cookie Policy
            </Link>
          </div>
          <p style={{ ...muted, marginTop: 10 }}>
            The full legal library (DPA, subprocessors, retention, disclosure
            policies, …) lives in the public Trust Center and site footer.
          </p>
        </Card>
      </div>
    </PageShell>
  );
}
