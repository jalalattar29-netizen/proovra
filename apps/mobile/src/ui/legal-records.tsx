/**
 * POLICIES & CONSENT (T-14) — the touch port of the web PrivacySection
 * "Policies & consent" block: the server's legal status (with the accept
 * action when something is owed), the acceptance history, and the privacy
 * references. Acceptance posts exactly the server's outstanding versions.
 */
import React, { useCallback, useEffect, useState } from "react";
import { Linking, View } from "react-native";
import { useRouter } from "expo-router";

import { apiFetch } from "../api";
import { buildLegalAcceptanceBody } from "../auth/auth-api";
import { toSafeUserError } from "../errors/safe-error";
import { formatUserDateTime } from "../lib/date";
import {
  ACCEPTANCE_HISTORY_FIRST,
  LEGAL_ACCEPTANCE_PATH,
  LEGAL_RECORDS_COPY as C,
  LEGAL_STATUS_PATH,
  COOKIE_CONSENT_COPY,
  COOKIE_CONSENT_PATH,
  parseCookieConsent,
  parseLegalAcceptances,
  type CookieConsentView,
  parseLegalStatusView,
  policyLabel,
  PRIVACY_REFERENCES,
  type LegalAcceptanceRecord,
  type LegalStatusView,
} from "../product/legal-records";
import { webOrigin } from "../product/intake-create";
import { theme } from "../theme/theme";
import { ProovraBadge, ProovraButton, ProovraCard, ProovraText } from "./index";

type StatusState = { kind: "loading" } | { kind: "ready"; view: LegalStatusView } | { kind: "error"; message: string };

export function LegalRecordsSection() {
  const router = useRouter();
  const [status, setStatus] = useState<StatusState>({ kind: "loading" });
  const [records, setRecords] = useState<LegalAcceptanceRecord[] | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    setStatus({ kind: "loading" });
    try {
      setStatus({ kind: "ready", view: parseLegalStatusView(await apiFetch(LEGAL_STATUS_PATH)) });
    } catch (err) {
      setStatus({ kind: "error", message: toSafeUserError(err).message });
    }
  }, []);
  const loadRecords = useCallback(async () => {
    try {
      setRecords(parseLegalAcceptances(await apiFetch(LEGAL_ACCEPTANCE_PATH)));
    } catch {
      setRecords([]);
    }
  }, []);
  useEffect(() => {
    void loadStatus();
    void loadRecords();
  }, [loadStatus, loadRecords]);

  const accept = useCallback(async () => {
    if (status.kind !== "ready" || busy) return;
    const owed = status.view.missing.filter((m) => m.requiredVersion);
    if (owed.length === 0) return;
    setBusy(true);
    setActionError(null);
    try {
      await apiFetch(LEGAL_ACCEPTANCE_PATH, {
        method: "POST",
        body: JSON.stringify(buildLegalAcceptanceBody(owed.map((m) => ({ policyKey: m.policyKey, version: m.requiredVersion as string })), "settings")),
      });
      // The status is re-read, never assumed.
      await Promise.all([loadStatus(), loadRecords()]);
    } catch (err) {
      setActionError(toSafeUserError(err).message);
    } finally {
      setBusy(false);
    }
  }, [status, busy, loadStatus, loadRecords]);

  const shown = records ? (showAll ? records : records.slice(0, ACCEPTANCE_HISTORY_FIRST)) : [];

  return (
    <View style={{ gap: theme.space.s3 }} testID="legal-records">
      <ProovraCard>
        <ProovraText variant="label" color={theme.color.ink.secondary}>{C.intro}</ProovraText>
        {status.kind === "loading" ? <ProovraText variant="label" color={theme.color.ink.muted}>{C.checking}</ProovraText> : null}
        {status.kind === "error" ? (
          <View style={{ gap: theme.space.s1 }}>
            <ProovraText variant="label" color={theme.color.status.risk.fg}>{status.message}</ProovraText>
            <ProovraButton label={C.checkAgain} variant="secondary" fullWidth={false} onPress={() => void loadStatus()} />
          </View>
        ) : null}
        {status.kind === "ready" && status.view.requiresReacceptance ? (
          <View style={{ gap: theme.space.s2 }} testID="legal-status-action-required">
            <ProovraBadge label={C.actionNeeded} tone="pending" />
            <ProovraText variant="label" color={theme.color.ink.secondary}>{C.locked}</ProovraText>
            {status.view.missing.map((m) => (
              <View key={m.policyKey} style={{ gap: 2 }}>
                <ProovraButton
                  label={`Read the ${policyLabel(m.policyKey)} →`}
                  variant="ghost"
                  fullWidth={false}
                  onPress={() => router.push(`/legal/${m.policyKey}`)}
                />
                <ProovraText variant="label" color={theme.color.ink.muted}>{m.line}</ProovraText>
              </View>
            ))}
            <ProovraButton label={C.accept} variant="secondary" loading={busy} disabled={busy} onPress={() => void accept()} />
            {actionError ? <ProovraText variant="label" color={theme.color.status.risk.fg}>{actionError}</ProovraText> : null}
          </View>
        ) : null}
        {status.kind === "ready" && !status.view.requiresReacceptance ? (
          <ProovraText variant="label" color={theme.color.status.verified.fg} testID="legal-status-current">{C.current}</ProovraText>
        ) : null}
      </ProovraCard>

      <ProovraCard>
        <ProovraButton
          label={`${historyOpen ? C.hideHistory : C.showHistory}${records && records.length > 0 ? ` (${records.length})` : ""}`}
          variant="ghost"
          fullWidth={false}
          onPress={() => setHistoryOpen((v) => !v)}
        />
        {historyOpen ? (
          <View style={{ gap: theme.space.s2 }}>
            <ProovraText variant="label" color={theme.color.ink.muted}>{C.explicitOnly}</ProovraText>
            {records && records.length === 0 ? <ProovraText variant="label" color={theme.color.ink.muted}>{C.noRecords}</ProovraText> : null}
            {shown.map((r) => (
              <View key={r.id} style={{ gap: 2 }}>
                <ProovraText variant="bodySm" weight="semibold">{r.title}</ProovraText>
                <ProovraText variant="label" color={theme.color.ink.secondary}>
                  {[r.acceptanceType, r.version ? `v${r.version}` : null, r.acceptedAtIso ? formatUserDateTime(r.acceptedAtIso) : null].filter(Boolean).join(" · ")}
                </ProovraText>
              </View>
            ))}
            {records && !showAll && records.length > ACCEPTANCE_HISTORY_FIRST ? (
              <ProovraButton label={`View ${records.length - ACCEPTANCE_HISTORY_FIRST} more`} variant="ghost" fullWidth={false} onPress={() => setShowAll(true)} />
            ) : null}
          </View>
        ) : null}
      </ProovraCard>
    </View>
  );
}

/** The account's recorded cookie consent, read-only (web PrivacySection A). */
export function CookieConsentRecord() {
  const [consent, setConsent] = useState<CookieConsentView | null | undefined>(undefined);
  useEffect(() => {
    apiFetch(COOKIE_CONSENT_PATH)
      .then((d) => setConsent(parseCookieConsent(d)))
      .catch(() => setConsent(null));
  }, []);
  if (consent === undefined) return null;
  return (
    <ProovraCard testID="cookie-consent-record">
      {consent ? (
        <View style={{ gap: 2 }}>
          {consent.version ? <ProovraText variant="label" color={theme.color.ink.secondary}>{`Consent version · v${consent.version}`}</ProovraText> : null}
          {consent.recordedAtIso ? <ProovraText variant="label" color={theme.color.ink.secondary}>{`Recorded · ${formatUserDateTime(consent.recordedAtIso)}`}</ProovraText> : null}
          <ProovraText variant="label" color={theme.color.ink.secondary}>{`Allowed categories · ${consent.categories}`}</ProovraText>
        </View>
      ) : (
        <ProovraText variant="label" color={theme.color.ink.muted}>{COOKIE_CONSENT_COPY.none}</ProovraText>
      )}
      <ProovraText variant="label" color={theme.color.ink.muted}>{COOKIE_CONSENT_COPY.where}</ProovraText>
    </ProovraCard>
  );
}

/** The web "Privacy actions & references" block: the in-app reader, then the public Trust Center. */
export function PrivacyReferences() {
  const router = useRouter();
  const trustUrl = webOrigin() ? `${webOrigin()}/trust` : null;
  return (
    <ProovraCard testID="privacy-references">
      {PRIVACY_REFERENCES.map((r) => (
        <ProovraButton
          key={r.slug}
          label={r.label}
          variant="ghost"
          fullWidth={false}
          onPress={() => router.push(`/legal/${r.slug}`)}
        />
      ))}
      <ProovraText variant="label" color={theme.color.ink.secondary}>{C.library}</ProovraText>
      {trustUrl ? (
        <>
          <ProovraButton label={C.openTrust} variant="secondary" fullWidth={false} onPress={() => void Linking.openURL(trustUrl)} />
          <ProovraText variant="label" color={theme.color.ink.muted}>{C.opensOutside}</ProovraText>
        </>
      ) : null}
    </ProovraCard>
  );
}
