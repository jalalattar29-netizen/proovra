/**
 * PRIVACY — data export and account closure.
 *
 * The native port of the Settings privacy pane. Both are rights a user has
 * over their own account, and neither existed on the device.
 *
 * Closure is the most consequential control in the product, and three things
 * make it safe — all three from the server. `blockers` says why it cannot
 * proceed; `confirmationPhrase` is the exact wording the route checks, read
 * from the response rather than hard-coded so the two can never drift; and
 * `coolingOffDays` says that closure is not immediate, which a user must be
 * told BEFORE they confirm rather than after.
 *
 * PRO-114 / MOBILE-02 — all three actions are step-up guarded on the server
 * (verifyAccountStepUp), so each runs through the shared step-up loop: the
 * first attempt goes without proof, a STEP_UP_REQUIRED challenge opens the
 * sheet, and the SAME request is re-sent with the proof. The download is the
 * route's POST (there is no GET), and the package is written to the export
 * folder sign-out clears and handed to the share sheet — the web's
 * "download a JSON file".
 */
import { useCallback, useEffect, useState } from "react";
import * as FileSystem from "expo-file-system";
import { CookieConsentRecord, LegalRecordsSection, PrivacyReferences } from "../../../src/ui/legal-records";
import { View } from "react-native";
import { useRouter } from "expo-router";

import { apiFetch } from "../../../src/api";
import { exportFileUri, shareFile } from "../../../src/lib/share-file";
import { StepUpSheet, useStepUp } from "../../../src/ui/step-up-sheet";
import { formatUserDateTime } from "../../../src/lib/date";
import { toSafeUserError } from "../../../src/errors/safe-error";
import { useToast } from "../../../src/toast-context";
import { theme } from "../../../src/theme/theme";
import {
  ProovraScreen,
  ProovraCard,
  ProovraText,
  ProovraButton,
  ProovraBadge,
  ProovraInput,
  ProovraFormField,
  ProovraPageHeader,
  ProovraPageSection,
  ProovraLoadingState,
  ProovraErrorState,
  ProovraEmpty,
} from "../../../src/ui";
import {
  ACCOUNT_CLOSURE_PATH,
  DATA_EXPORT_PATH,
  EXPORT_DOWNLOAD_METHOD,
  buildClosureCancelPath,
  buildClosureRequestBody,
  buildExportDownloadPath,
  buildExportStepUpBody,
  closureCountdown,
  closureRequestFailure,
  closureStatusLabel,
  closureStatusTone,
  confirmationMatches,
  exportPackageFilename,
  exportStatusLabel,
  exportStatusTone,
  hasExportInFlight,
  isClosureActive,
  isClosureCancellable,
  isExportDownloadable,
  parseClosure,
  parseDataExports,
  type ClosureView,
  type DataExportRequest,
} from "../../../src/product/account-privacy";

type StepUpFor = "export" | "download" | "closure";

const STEP_UP_TITLE: Record<StepUpFor, string> = {
  export: "Confirm requesting a copy of your personal data.",
  download: "Confirm downloading your personal data export.",
  closure: "Confirm closing your account.",
};

export default function PrivacyScreen() {
  const router = useRouter();
  const { addToast } = useToast();

  const [exports, setExports] = useState<DataExportRequest[] | null>(null);
  const [closure, setClosure] = useState<ClosureView | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [reason, setReason] = useState("");
  const [closureError, setClosureError] = useState<string | null>(null);
  const stepUp = useStepUp();
  const [stepUpFor, setStepUpFor] = useState<StepUpFor>("export");

  const load = useCallback(async () => {
    setFailed(false);
    const [e, c] = await Promise.allSettled([
      apiFetch(DATA_EXPORT_PATH),
      apiFetch(ACCOUNT_CLOSURE_PATH),
    ]);
    if (e.status === "fulfilled") setExports(parseDataExports(e.value));
    if (c.status === "fulfilled") setClosure(parseClosure(c.value));
    if (e.status === "rejected" && c.status === "rejected") setFailed(true);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const onExportError = useCallback(
    (err: unknown) => {
      const e = err as { code?: string; body?: { error?: { code?: string; message?: string } } };
      const code = e.body?.error?.code ?? e.code;
      if (code === "export_request_active") {
        addToast(e.body?.error?.message ?? "An export is already active.", "error");
        void load();
        return;
      }
      addToast(toSafeUserError(err, { message: "Could not request the export." }).message, "error");
    },
    [addToast, load],
  );

  const requestExport = useCallback(async () => {
    setBusy(true);
    setStepUpFor("export");
    await stepUp.start(async (proof) => {
      await apiFetch(DATA_EXPORT_PATH, { method: "POST", body: JSON.stringify(buildExportStepUpBody(proof)) });
      addToast(
        "Export requested. Generation runs in the background — check back here; the package stays available for 7 days.",
        "success",
      );
      await load();
    }, onExportError);
    setBusy(false);
  }, [stepUp, addToast, load, onExportError]);

  const onDownloadError = useCallback(
    (err: unknown) => {
      addToast(toSafeUserError(err, { message: "Could not download the export." }).message, "error");
    },
    [addToast],
  );

  const downloadExport = useCallback(
    async (request: DataExportRequest) => {
      setBusy(true);
      setStepUpFor("download");
      await stepUp.start(async (proof) => {
        // The route answers the package itself as JSON; apiFetch carries the
        // session, so nothing about the account leaves in a URL.
        const pkg = await apiFetch(buildExportDownloadPath(request.id), {
          method: EXPORT_DOWNLOAD_METHOD,
          body: JSON.stringify(buildExportStepUpBody(proof)),
        });
        const filename = exportPackageFilename(request.id);
        const uri = await exportFileUri(filename);
        if (!uri) throw new Error("A writable temporary directory is not available on this device.");
        await FileSystem.writeAsStringAsync(uri, JSON.stringify(pkg, null, 2), {
          encoding: FileSystem.EncodingType.UTF8,
        });
        await shareFile(uri, { mimeType: "application/json", dialogTitle: filename, uti: "public.json" });
        await load();
      }, onDownloadError);
      setBusy(false);
    },
    [stepUp, load, onDownloadError],
  );

  const onClosureError = useCallback(
    (err: unknown) => {
      const known = closureRequestFailure(err);
      if (known) {
        setClosureError(known.message);
        if (known.reload) void load();
        return;
      }
      setClosureError(toSafeUserError(err, { message: "Could not request account closure." }).message);
    },
    [load],
  );

  const requestClosure = useCallback(async () => {
    if (!closure || !confirmationMatches(confirmText, closure)) return;
    setBusy(true);
    setClosureError(null);
    setStepUpFor("closure");
    await stepUp.start(async (proof) => {
      // The route's schema field is `confirmation` (account-closure.routes.ts);
      // the phrase is validated there, never trusted from here.
      await apiFetch(ACCOUNT_CLOSURE_PATH, {
        method: "POST",
        body: JSON.stringify(buildClosureRequestBody(confirmText, reason, proof)),
      });
      setConfirmText("");
      setReason("");
      addToast("Closure requested. The cancellation window is now open.", "info");
      await load();
    }, onClosureError);
    setBusy(false);
  }, [closure, confirmText, reason, stepUp, addToast, load, onClosureError]);

  const cancelClosure = useCallback(async () => {
    if (!closure?.request) return;
    setBusy(true);
    try {
      await apiFetch(buildClosureCancelPath(closure.request.id), {
        method: "POST",
        body: JSON.stringify({}),
      });
      addToast("Closure cancelled. Your account stays open.", "success");
      await load();
    } catch (err) {
      addToast(toSafeUserError(err).message, "error");
    } finally {
      setBusy(false);
    }
  }, [closure, addToast, load]);

  const active = isClosureActive(closure?.request ?? null);
  const countdown = closure ? closureCountdown(closure) : null;

  return (
    <ProovraScreen shell testID="settings-privacy">
      <ProovraPageHeader
        title="Privacy"
        eyebrow="Settings"
        subtitle="Take a copy of your data, or close your account."
        secondaryActions={
          <ProovraButton label="Back" variant="ghost" fullWidth={false} onPress={() => router.back()} />
        }
      />

      {failed ? (
        <ProovraErrorState message="Privacy settings could not be loaded." onRetry={() => void load()} />
      ) : null}

      {/* T-14 — the recorded cookie consent (web PrivacySection A), read-only. */}
      <ProovraPageSection title="Privacy preferences">
        <CookieConsentRecord />
      </ProovraPageSection>

      {/* T-14 — Policies & consent (web PrivacySection B + LegalAcceptanceStatusCard). */}
      <ProovraPageSection title="Policies & consent">
        <LegalRecordsSection />
      </ProovraPageSection>

      <ProovraPageSection title="Your data">
        {exports === null ? (
          <ProovraLoadingState label="Loading exports" />
        ) : (
          <>
            <ProovraCard>
              {/* The web's words for what the package holds, and what it never holds (PrivacySection :256). */}
              <ProovraText variant="bodySm" color={theme.color.ink.secondary}>
                Request a copy of your personal account data — profile, login methods, preferences, consent records,
                account activity, sessions, and organization memberships. Evidence and organization records are excluded
                and remain available through their own authorized surfaces.
              </ProovraText>
              <ProovraButton
                label="Request a data export"
                loading={busy}
                // The server refuses a second request while one is in flight,
                // so the control says so instead of producing that refusal.
                disabled={hasExportInFlight(exports)}
                onPress={() => void requestExport()}
              />
              {hasExportInFlight(exports) ? (
                <ProovraText variant="label" color={theme.color.ink.muted}>
                  {exports.some((x) => x.status.toUpperCase() === "READY")
                    ? "An export is ready. Download it, or wait for it to expire, before requesting another."
                    : "An export is already being prepared."}
                </ProovraText>
              ) : null}
            </ProovraCard>

            {exports.length === 0 ? (
              <ProovraEmpty presence="inline" title="No exports requested yet." />
            ) : (
              <ProovraCard>
                {exports.map((e) => (
                  <View key={e.id} style={{ gap: theme.space.s1, paddingVertical: theme.space.s2 }}>
                    <View style={{ flexDirection: "row", justifyContent: "space-between", gap: theme.space.s2 }}>
                      <ProovraText variant="bodySm">
                        {e.requestedAtIso ? formatUserDateTime(e.requestedAtIso) : "Requested"}
                      </ProovraText>
                      <ProovraBadge label={exportStatusLabel(e)} tone={exportStatusTone(e.status)} />
                    </View>
                    {e.status === "FAILED" || e.failureCode ? (
                      <ProovraText variant="label" color={theme.color.status.risk.fg}>
                        The export could not be generated. You can request a new one below.
                      </ProovraText>
                    ) : null}
                    {e.status === "READY" && e.sha256 ? (
                      <ProovraText variant="label" mono selectable color={theme.color.ink.muted}>
                        {`Checksum (SHA-256): ${e.sha256.slice(0, 16)}…`}
                      </ProovraText>
                    ) : null}
                    {/*
                      An expired package is not a download that will fail — it
                      is one that should not be offered at all.
                    */}
                    {isExportDownloadable(e) ? (
                      <ProovraButton
                        label="Download"
                        variant="secondary"
                        fullWidth={false}
                        disabled={busy}
                        onPress={() => void downloadExport(e)}
                      />
                    ) : null}
                    {e.expiresAtIso ? (
                      <ProovraText variant="label" color={theme.color.ink.muted}>
                        {`Available until ${formatUserDateTime(e.expiresAtIso)}`}
                      </ProovraText>
                    ) : null}
                  </View>
                ))}
              </ProovraCard>
            )}
          </>
        )}
      </ProovraPageSection>

      <ProovraPageSection title="Close your account">
        {closure === null ? (
          <ProovraLoadingState label="Loading" />
        ) : active ? (
          <ProovraCard>
            <ProovraBadge
              label={closureStatusLabel(closure.request!.status)}
              tone={closureStatusTone(closure.request!.status)}
            />
            {/*
              "Pending" alone tells a user neither that it has not happened yet
              nor when it will.
            */}
            {countdown ? <ProovraText variant="body">{countdown}</ProovraText> : null}
            {closure.request!.status.toUpperCase() === "BLOCKED" && closure.blockers.length > 0
              ? closure.blockers.map((b, i) => (
                  <ProovraText key={i} variant="label" color={theme.color.status.pending.fg}>
                    {`• ${b}`}
                  </ProovraText>
                ))
              : null}
            {isClosureCancellable(closure.request) ? (
              <ProovraButton
                label="Cancel closure request"
                loading={busy}
                onPress={() => void cancelClosure()}
              />
            ) : null}
          </ProovraCard>
        ) : (
          <ProovraCard>
            {/*
              The server's blockers, shown before the form. A closure form that
              submits into a blocker produces a refusal the user cannot act on.
            */}
            {/* What closure does, and what it never does (PrivacySection :556). */}
            <ProovraText variant="bodySm" color={theme.color.ink.secondary}>
              {`Closing your account signs you out everywhere, removes your login methods, and anonymizes your personal details after a ${closure.coolingOffDays ?? 7}-day cancellation window. Evidence is never deleted by account closure — it stays governed by retention and legal-hold rules.`}
            </ProovraText>
            {closure.consequences.length > 0 ? (
              <>
                <ProovraText variant="body" weight="semibold">
                  Closing your account also:
                </ProovraText>
                {closure.consequences.map((c, i) => (
                  <ProovraText key={i} variant="label" color={theme.color.ink.secondary}>
                    {`• ${c}`}
                  </ProovraText>
                ))}
              </>
            ) : null}
            {closure.blockers.length > 0 ? (
              <>
                <ProovraText variant="body" weight="semibold">
                  These must be resolved before your account can close:
                </ProovraText>
                {closure.blockers.map((b, i) => (
                  <ProovraText key={i} variant="label" color={theme.color.status.pending.fg}>
                    {`• ${b}`}
                  </ProovraText>
                ))}
                {/* Visible but disabled, with its reason beside it — never a request the server must refuse. */}
                <ProovraButton label="Close my account…" accessibilityLabel="Close my account… Resolve the items above first." variant="secondary" disabled />
                <ProovraText variant="label" color={theme.color.ink.muted}>
                  Resolve the items above to enable account closure.
                </ProovraText>
              </>
            ) : (
              <>

                <ProovraFormField label="Why are you closing it? (optional)">
                  <ProovraInput
                    value={reason}
                    onChangeText={setReason}
                    placeholder="This helps us improve"
                    multiline
                    autoCapitalize="sentences"
                    accessibilityLabel="Reason for closing"
                  />
                </ProovraFormField>

                {closure.confirmationPhrase ? (
                  <ProovraFormField label={`Type "${closure.confirmationPhrase}" to confirm`}>
                    <ProovraInput
                      value={confirmText}
                      onChangeText={setConfirmText}
                      placeholder={closure.confirmationPhrase}
                      accessibilityLabel="Confirmation phrase"
                    />
                  </ProovraFormField>
                ) : (
                  <ProovraText variant="label" color={theme.color.ink.muted}>
                    The confirmation wording could not be read, so closure cannot be requested here
                    right now.
                  </ProovraText>
                )}

                <ProovraButton
                  label="Request account closure"
                  variant="danger"
                  loading={busy}
                  disabled={!confirmationMatches(confirmText, closure)}
                  onPress={() => void requestClosure()}
                />
                {closureError ? (
                  <View testID="closure-error">
                    <ProovraText variant="label" color={theme.color.status.risk.fg}>
                      {closureError}
                    </ProovraText>
                  </View>
                ) : null}
              </>
            )}
          </ProovraCard>
        )}
      </ProovraPageSection>

      <ProovraPageSection title="Privacy actions & references">
        <PrivacyReferences />
      </ProovraPageSection>

      <StepUpSheet
        challenge={stepUp.challenge}
        title={STEP_UP_TITLE[stepUpFor]}
        busy={busy}
        onSubmit={(proof) => {
          setBusy(true);
          const onError =
            stepUpFor === "closure" ? onClosureError : stepUpFor === "download" ? onDownloadError : onExportError;
          void stepUp.retry(proof, onError).finally(() => setBusy(false));
        }}
        onCancel={stepUp.dismiss}
      />
    </ProovraScreen>
  );
}
