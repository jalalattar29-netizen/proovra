"use client";

/**
 * Privacy section (Settings IA refactor 2026-07-17) — former
 * `/settings/privacy` page body, mounted inside the unified Settings
 * workspace. Behavior unchanged.
 *
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

import { Button } from "../../../../components/ui/Button";
import {
  AppStatusText,
  type AppTone,
} from "../../../../components/app-primitives";
import { apiFetch } from "../../../../lib/api";
import { formatUserDateTime } from "../../../../lib/date";
import { openCookiePreferences } from "../../../../lib/consent";
import { useAuth } from "../../../providers";
import { toSafeUserError } from "../../../../lib/feedback/toSafeUserError";
import {
  StepUpVerify,
  extractStepUp,
  type StepUpMethods,
  type StepUpProof,
} from "../../security-center/components/PersonalSecuritySections";
// PHASE 12 VERTICAL A (2026-07-30) — server-authoritative legal acceptance
// status + the accept action that clears the 428 legal gate.
import { LegalAcceptanceStatusCard } from "./LegalAcceptanceStatusCard";

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

/**
 * The export lifecycle, said in colour as well as in words. READY is the one
 * state with something to do; PROCESSING and REQUESTED are waiting, not
 * problems; FAILED is a problem; EXPIRED and CANCELLED are neither.
 */
const EXPORT_STATUS_TONE: Record<string, AppTone> = {
  REQUESTED: "blue",
  PROCESSING: "blue",
  READY: "green",
  FAILED: "red",
  EXPIRED: "slate",
  CANCELLED: "slate",
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
    <section className="set-card" data-cc-privacy-export>
      <h3>Your data</h3>
      <p className="set-card__sub">
        Request a copy of your personal account data — profile, login
        methods, preferences, consent records, account activity, sessions,
        and organization memberships. Evidence and organization records are
        excluded and remain available through their own authorized surfaces.
      </p>

      {rows === null ? (
        <p style={{ ...muted, marginTop: 10 }}>Loading…</p>
      ) : rows.length === 0 ? (
        <p style={{ ...muted, marginTop: 10 }}>No exports requested yet.</p>
      ) : (
        <ul className="set-privacy__rows">
          {rows.slice(0, 3).map((r) => (
            <li
              key={r.id}
              data-cc-export-row={r.status}
              className="set-privacy__export-row"
            >
              <span className="set-privacy__export">
                <AppStatusText tone={EXPORT_STATUS_TONE[r.status] ?? "slate"} size="sm">
                  {EXPORT_STATUS_LABEL[r.status] ?? r.status}
                </AppStatusText>
                <span className="set-privacy__export-meta">
                  Requested {formatUserDateTime(r.requestedAtUtc)}
                  {r.status === "READY" && r.completedAtUtc
                    ? ` · created ${formatUserDateTime(r.completedAtUtc)}`
                    : ""}
                  {r.status === "READY" && r.expiresAtUtc
                    ? ` · expires ${formatUserDateTime(r.expiresAtUtc)}`
                    : ""}
                </span>
                {r.status === "READY" && r.packageSha256 ? (
                  <span className="set-privacy__export-meta">
                    Checksum (SHA-256): {r.packageSha256.slice(0, 16)}…
                  </span>
                ) : null}
                {r.status === "FAILED" ? (
                  <span className="set-privacy__export-meta">
                    The export could not be generated. You can request a new
                    one below.
                  </span>
                ) : null}
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
            variant="primary"
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
    </section>
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

/**
 * §7.2 — every stable blocker code maps to a DIRECT resolution action.
 * A blocker is never shown without a path to resolve it.
 */
const CLOSURE_BLOCKER_ACTION: Record<string, { label: string; href: string }> = {
  BILLING_SUBSCRIPTION_ACTIVE: { label: "Go to Billing", href: "/billing" },
  ORGANIZATION_OWNERSHIP_TRANSFER_REQUIRED: {
    label: "Transfer ownership",
    href: "/organizations",
  },
  WORKSPACE_MEMBERS_ACTIVE: {
    label: "Manage workspace members",
    href: "/teams",
  },
  LEGAL_HOLD_ACTIVE: { label: "Review evidence holds", href: "/evidence" },
};

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
    <section className="set-card set-danger" data-cc-privacy-closure>
      <h3 className="set-danger__title">Close account</h3>
      <p className="set-card__sub">
        Closing your account signs you out everywhere, removes your login
        methods, and anonymizes your personal details after a{" "}
        {state?.coolingOffDays ?? 7}-day cancellation window. Evidence is
        never deleted by account closure — it stays governed by retention
        and legal-hold rules.
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
              {(JSON.parse(req.blockersJson) as ClosureBlocker[]).map((b) => {
                const action = CLOSURE_BLOCKER_ACTION[b.code];
                return (
                  <li key={b.code}>
                    {b.message}{" "}
                    {action ? (
                      <Link
                        href={action.href}
                        style={{
                          color: "var(--ink-primary, #0f172a)",
                          fontWeight: 600,
                          textDecoration: "underline",
                        }}
                      >
                        {action.label} →
                      </Link>
                    ) : null}
                  </li>
                );
              })}
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
                {blockers.map((b) => {
                  const action = CLOSURE_BLOCKER_ACTION[b.code];
                  return (
                    <li key={b.code} data-cc-closure-blocker={b.code}>
                      {b.message}{" "}
                      {action ? (
                        <Link
                          href={action.href}
                          style={{
                            color: "var(--ink-primary, #0f172a)",
                            fontWeight: 600,
                            textDecoration: "underline",
                          }}
                          data-cc-closure-blocker-action={b.code}
                        >
                          {action.label} →
                        </Link>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}

          {blockers.length > 0 ? (
            // §7.2 — the UI never starts a closure request it already
            // knows the backend must refuse. The action stays visible but
            // disabled, with the reason right next to it.
            <div className="mt-4">
              <Button
                variant="secondary"
                size="sm"
                disabled
                aria-disabled="true"
                title="Resolve the items above first."
                data-cc-closure-open-blocked
              >
                Close my account…
              </Button>
              <p style={{ ...muted, marginTop: 6 }}>
                Resolve the items above to enable account closure.
              </p>
            </div>
          ) : !showForm ? (
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
    </section>
  );
}

/**
 * POLICY ACCEPTANCE HISTORY — the immutable record, disclosed on request.
 *
 * This rendered every row it was given, always open, under the status card
 * that says the same policies are current. On an account with a few years of
 * re-acceptances that is the longest thing on the page, and it is the part a
 * reader needs least often: the question "am I up to date?" is answered above
 * it. Collapsed by default, and bounded when opened.
 */
function PolicyHistory({
  acceptances,
}: {
  acceptances: LegalAcceptanceItem[] | null;
}) {
  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const FIRST = 8;

  if (acceptances === null) {
    return (
      <p className="set-privacy__muted" data-cc-privacy-acceptances-loading>
        Loading…
      </p>
    );
  }

  const shown = showAll ? acceptances : acceptances.slice(0, FIRST);

  return (
    <div data-cc-privacy-acceptances>
      <button
        type="button"
        className="set-privacy__disclose"
        aria-expanded={open}
        aria-controls="privacy-acceptance-history"
        onClick={() => setOpen((v) => !v)}
        data-cc-privacy-history-toggle
      >
        {open ? "Hide acceptance history" : "View acceptance history"}
        {acceptances.length > 0 ? (
          <span className="set-privacy__count">{acceptances.length}</span>
        ) : null}
      </button>

      {open ? (
        <div id="privacy-acceptance-history" className="set-privacy__history">
          {/* LEGAL MEANING, PRESERVED. A record exists only because the person
              took an explicit action; opening this list is not one of them. */}
          <p className="set-privacy__muted">
            Records are written only when you explicitly accept — viewing a
            policy is never recorded as consent.
          </p>

          {acceptances.length === 0 ? (
            <p className="set-privacy__muted">
              No acceptance records on this account yet.
            </p>
          ) : (
            <>
              <ul className="set-privacy__rows">
                {shown.map((item) => {
                  const p = presentPolicy(item.policyKey);
                  return (
                    <li
                      key={item.id}
                      data-cc-privacy-acceptance-row={item.policyKey}
                      className="set-privacy__row"
                    >
                      <span className="set-privacy__row-name">{p.title}</span>
                      <span className="set-privacy__row-kind">{p.kind}</span>
                      <span className="set-privacy__row-meta">
                        v{item.policyVersion}
                      </span>
                      <span className="set-privacy__row-meta">
                        {formatUserDateTime(item.acceptedAt)}
                      </span>
                    </li>
                  );
                })}
              </ul>
              {!showAll && acceptances.length > FIRST ? (
                <button
                  type="button"
                  className="set-privacy__more"
                  onClick={() => setShowAll(true)}
                  data-cc-privacy-history-more
                >
                  View {acceptances.length - FIRST} more
                </button>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

export function PrivacySection() {
  const { user } = useAuth();
  const [acceptances, setAcceptances] = useState<LegalAcceptanceItem[] | null>(null);
  const [cookieConsent, setCookieConsent] = useState<CookieConsentRecord | null>(null);

  const loadAcceptances = useCallback(() => {
    if (!user?.id) return;
    apiFetch("/v1/users/legal-acceptance")
      .then((data: { items?: LegalAcceptanceItem[] }) =>
        setAcceptances(Array.isArray(data.items) ? data.items : []),
      )
      .catch(() => setAcceptances([]));
  }, [user?.id]);

  useEffect(() => {
    if (!user?.id) return;
    loadAcceptances();
    apiFetch("/v1/users/cookie-consent/latest")
      .then((data: { record?: CookieConsentRecord | null }) =>
        setCookieConsent(data.record ?? null),
      )
      .catch(() => setCookieConsent(null));
  }, [user?.id, loadAcceptances]);

  const [cookieBusy, setCookieBusy] = useState(false);
  const [cookieError, setCookieError] = useState<string | null>(null);

  /**
   * Open the canonical consent manager, and SAY SO when it does not open.
   *
   * The click used to be fire-and-forget: it dispatched an event and assumed
   * the dialog appeared. When the manager could not open one — it had not
   * built its DOM, an extension had blocked the script, initialisation had
   * failed — the person who asked got nothing at all, with no error anywhere.
   * "I click it and nothing happens" was the complete and literal behaviour.
   */
  const handleManageCookies = useCallback(async () => {
    setCookieBusy(true);
    setCookieError(null);
    const opened = await openCookiePreferences();
    setCookieBusy(false);
    if (!opened) {
      setCookieError(
        "Cookie preferences could not be opened. A browser extension or privacy setting may be blocking the consent manager — allow it for this site and try again.",
      );
    }
  }, []);

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
    <div className="set-stack" data-cc-privacy>
      {/* A. PRIVACY PREFERENCES ------------------------------------------ */}
      <section className="set-card" data-cc-privacy-cookies>
        <h3>Privacy preferences</h3>
        <p className="set-card__sub">
          Manage your cookie and consent preferences.
        </p>

        {cookieConsent ? (
          <dl className="set-privacy__facts">
            <div>
              <dt>Consent version</dt>
              <dd>v{cookieConsent.consentVersion}</dd>
            </div>
            <div>
              <dt>Recorded</dt>
              <dd>{formatUserDateTime(cookieConsent.createdAt)}</dd>
            </div>
            <div>
              <dt>Allowed categories</dt>
              <dd>{consentCategories || "Necessary only"}</dd>
            </div>
          </dl>
        ) : (
          <p className="set-privacy__muted">
            No cookie consent recorded on this account yet.
          </p>
        )}

        {cookieError ? (
          <p
            role="alert"
            className="set-privacy__error"
            data-cc-privacy-cookies-error
          >
            {cookieError}
          </p>
        ) : null}

        <div className="set-privacy__actions">
          {/* The ONE consent manager. `openCookiePreferences` dispatches to
              the handler installed by `CookieConsentInit` in the root layout,
              which opens the same preferences modal the public banner does —
              there is no second cookie implementation here. */}
          <button
            type="button"
            className="set-action--secondary"
            onClick={() => void handleManageCookies()}
            disabled={cookieBusy}
            data-cc-privacy-manage-cookies
          >
            {cookieBusy ? "Opening…" : "Manage cookie preferences"}
          </button>
        </div>
      </section>

      {/* B. POLICIES & CONSENT -------------------------------------------- */}
      <section className="set-card" data-cc-privacy-policies>
        <h3>Policies &amp; consent</h3>
        <p className="set-card__sub">
          Review the policies currently accepted for this account and the
          history of recorded consent.
        </p>

        {/* Server-authoritative status — the resolution surface for the 428
            LEGAL_REACCEPT_REQUIRED gate that fronts billing and checkout. */}
        <LegalAcceptanceStatusCard onAccepted={loadAcceptances} />

        <PolicyHistory acceptances={acceptances} />
      </section>

      {/* C. YOUR DATA ------------------------------------------------------ */}
      <DataExportCard />

      {/* D. DANGER ZONE ---------------------------------------------------- */}
      <AccountClosureCard />

      {/* Real flows only — no invented deletion or export links. */}
      <section className="set-card" data-cc-privacy-references>
        <h3>Privacy actions &amp; references</h3>
        <ul className="set-privacy__links">
          <li>
            <Link href="/settings/legal/privacy-requests">
              Submit a privacy request
            </Link>
          </li>
          <li>
            <Link href="/settings/legal/privacy">Privacy Policy</Link>
          </li>
          <li>
            <Link href="/settings/legal/terms">Terms of Service</Link>
          </li>
          <li>
            <Link href="/settings/legal/cookies">Cookie Policy</Link>
          </li>
        </ul>
        <p className="set-privacy__muted">
          The full legal library (DPA, subprocessors, retention, disclosure
          policies, …) lives in the public Trust Center and the site footer.{" "}
          <a
            href="/trust"
            target="_blank"
            rel="noopener noreferrer"
            data-cc-open-public-trust-center
          >
            Open public Trust Center <span aria-hidden="true">↗</span>
          </a>{" "}
          (opens in a new tab — this app stays open).
        </p>
      </section>
    </div>
  );
}
