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
 */
import { useCallback, useEffect, useState } from "react";
import { Linking, View } from "react-native";
import { useRouter } from "expo-router";

import { apiBaseUrl, apiFetch } from "../../../src/api";
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
  buildClosureCancelPath,
  buildExportDownloadPath,
  closureCountdown,
  closureStatusTone,
  confirmationMatches,
  exportStatusLabel,
  exportStatusTone,
  hasExportInFlight,
  isClosureActive,
  isExportDownloadable,
  parseClosure,
  parseDataExports,
  type ClosureView,
  type DataExportRequest,
} from "../../../src/product/account-privacy";

export default function PrivacyScreen() {
  const router = useRouter();
  const { addToast } = useToast();

  const [exports, setExports] = useState<DataExportRequest[] | null>(null);
  const [closure, setClosure] = useState<ClosureView | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [reason, setReason] = useState("");

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

  const requestExport = useCallback(async () => {
    setBusy(true);
    try {
      await apiFetch(DATA_EXPORT_PATH, { method: "POST", body: JSON.stringify({}) });
      addToast("Export requested. You will be told when it is ready.", "success");
      await load();
    } catch (err) {
      addToast(toSafeUserError(err).message, "error");
    } finally {
      setBusy(false);
    }
  }, [addToast, load]);

  const requestClosure = useCallback(async () => {
    if (!closure || !confirmationMatches(confirmText, closure)) return;
    setBusy(true);
    try {
      await apiFetch(ACCOUNT_CLOSURE_PATH, {
        method: "POST",
        body: JSON.stringify({
          confirmationPhrase: confirmText.trim(),
          reason: reason.trim() || undefined,
        }),
      });
      setConfirmText("");
      setReason("");
      addToast("Closure requested.", "info");
      await load();
    } catch (err) {
      addToast(toSafeUserError(err).message, "error");
    } finally {
      setBusy(false);
    }
  }, [closure, confirmText, reason, addToast, load]);

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
    <ProovraScreen testID="settings-privacy">
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

      <ProovraPageSection title="Your data">
        {exports === null ? (
          <ProovraLoadingState label="Loading exports" />
        ) : (
          <>
            <ProovraCard>
              <ProovraText variant="bodySm" color={theme.color.ink.secondary}>
                A data export is a package of your account's records, prepared once and available
                for a limited time.
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
                  An export is already being prepared.
                </ProovraText>
              ) : null}
            </ProovraCard>

            {exports.length === 0 ? (
              <ProovraEmpty presence="inline" title="You have not requested an export yet." />
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
                    {e.failureCode ? (
                      <ProovraText variant="label" color={theme.color.status.risk.fg}>
                        {`This export did not complete (${e.failureCode}).`}
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
                        onPress={() =>
                          void Linking.openURL(
                            `${apiBaseUrl().replace(/\/+$/, "")}${buildExportDownloadPath(e.id)}`,
                          )
                        }
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
              label={closure.request!.status}
              tone={closureStatusTone(closure.request!.status)}
            />
            {/*
              "Pending" alone tells a user neither that it has not happened yet
              nor when it will.
            */}
            {countdown ? <ProovraText variant="body">{countdown}</ProovraText> : null}
            <ProovraButton
              label="Cancel closure and keep my account"
              loading={busy}
              onPress={() => void cancelClosure()}
            />
          </ProovraCard>
        ) : (
          <ProovraCard>
            {/*
              The server's blockers, shown before the form. A closure form that
              submits into a blocker produces a refusal the user cannot act on.
            */}
            {closure.blockers.length > 0 ? (
              <>
                <ProovraText variant="body" weight="semibold">
                  Closure cannot proceed yet
                </ProovraText>
                {closure.blockers.map((b, i) => (
                  <ProovraText key={i} variant="label" color={theme.color.status.pending.fg}>
                    {`• ${b}`}
                  </ProovraText>
                ))}
              </>
            ) : (
              <>
                <ProovraText variant="bodySm" color={theme.color.ink.secondary}>
                  {closure.coolingOffDays !== null
                    ? `Closing your account is not immediate: there is a ${closure.coolingOffDays}-day cooling-off period, and you can cancel at any point during it.`
                    : "Closing your account starts a cooling-off period during which you can cancel."}
                </ProovraText>

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
              </>
            )}
          </ProovraCard>
        )}
      </ProovraPageSection>
    </ProovraScreen>
  );
}
