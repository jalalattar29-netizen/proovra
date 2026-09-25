import { useCallback, useEffect, useState } from "react";
import { CopyButton } from "../src/ui/copy-button";
import { Image, Linking, Share, View, StyleSheet } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { apiFetch } from "../src/api";
import { toSafeUserError, type SafeError } from "../src/errors/safe-error";
import { formatUserDateTime } from "../src/lib/date";
import { extractVerificationId } from "../src/deep-link";
import {
  VERIFY_COPY,
  verifyStatusTone,
  formatVerifyDuration,
  hasVerificationMaterials,
  parseVerifyView,
  publicVerifyUrl,
  parseVerifyCaptureIntegrity,
  verifyArtifactsLine,
  VERIFY_ANCHORING_COPY,
  VERIFY_CONTENT_COPY,
  VERIFY_DIVERGENCE_COPY,
  VERIFY_INTEGRITY_SIGNAL_KEYS,
  VERIFY_PACKAGE_COPY,
  VERIFY_PANEL_COPY,
  VERIFY_REDACTION_COPY,
  VERIFY_REVIEW_COPY,
  VERIFY_TECHNICAL_COPY,
  VERIFY_TRUST_COPY,
  buildVerifyMismatchExplanations,
  buildVerifyReviewerActions,
  buildVerifyVerdict,
  parseVerifyAnchoring,
  parseVerifyContentReview,
  parseVerifyCustody,
  parseVerifyDivergence,
  parseVerifyIntegritySignals,
  parseVerifyOutputContext,
  parseVerifyPackage,
  parseVerifyRedaction,
  parseVerifyTrustDecision,
  verifyBadgeTone,
  verifyExecutiveBadges,
  verifyIntegrityTab,
  verifyMismatchMessages,
  verifyPublicationPending,
  verifyRecordFields,
  verifyScopeText,
  verifyStatusPillLabel,
  type VerifyContentItem,
  type VerifyMaterialField,
  type VerifyTimelineEvent,
  type VerifyTrustSignalView,
} from "../src/product/public-verify";
import { webOrigin } from "../src/product/intake-create";
import {
  VERIFY_BOUNDARIES,
  VERIFY_FINAL_CTA,
  VERIFY_HERO,
  VERIFY_MATERIALS,
  VERIFY_OPENS,
  VERIFY_TOKEN_CARD,
  VERIFY_USE_CASES,
} from "../src/product/verify-landing";
import {
  PROOVRA_ALLOWED_CLAIMS,
  PROOVRA_FORBIDDEN_CLAIMS,
} from "@proovra/shared-evidence-presentation";

import { theme } from "../src/theme/theme";
import {
  ProovraScreen,
  ProovraCard,
  ProovraSection,
  ProovraText,
  ProovraButton,
  ProovraBadge,
  ProovraInput,
  ProovraFormField,
  ProovraListRow,
  ProovraEmptyState,
  ProovraLoadingState,
} from "../src/ui";
import { AuthBrandHeader } from "../src/ui/brand";
import { CaptureLocationMap } from "../src/ui/capture-location-map";
import { parseVerifyCaptureContext } from "../src/product/public-verify";

/** The raw response; everything the screen shows goes through parseVerifyView. */
type VerifyData = Record<string, unknown>;

/**
 * Public verification (server-authoritative). Renders ONLY fields the server
 * returns for GET /public/verify/:id — no fabricated hashes, type, timestamp or
 * signature (the previous mock is gone). Honest loading/error/empty states.
 */
export default function VerifyScreen() {
  const params = useLocalSearchParams<{ id?: string }>();
  const paramId = params.id ?? "";
  const [id, setId] = useState(paramId);
  const [manual, setManual] = useState("");
  const [state, setState] = useState<"loading" | "ready" | "error" | "empty">(paramId ? "loading" : "empty");
  const [error, setError] = useState<SafeError | null>(null);
  const [data, setData] = useState<VerifyData | null>(null);
  // Web parity view state: the selected evidence item, the technical tab,
  // Forensic Review Mode and the OTS technical-details disclosure.
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [techTab, setTechTab] = useState<TechTab>("record");
  const [forensicMode, setForensicMode] = useState(false);
  const [showOtsTechnical, setShowOtsTechnical] = useState(false);

  const verify = useCallback(async (verificationId: string) => {
    setState("loading");
    setError(null);
    try {
      const res = (await apiFetch(`/public/verify/${encodeURIComponent(verificationId)}`)) as VerifyData;
      setData(res);
      setState("ready");
    } catch (err) {
      setError(toSafeUserError(err));
      setState("error");
    }
  }, []);

  useEffect(() => {
    if (paramId) void verify(paramId);
  }, [paramId, verify]);

  const submitManual = useCallback(() => {
    if (!manual.trim()) {
      setError({ kind: "input", title: "Check the details", message: VERIFY_TOKEN_CARD.emptyError });
      return;
    }
    const extracted = extractVerificationId(manual);
    if (!extracted) {
      setError({ kind: "input", title: "Check the details", message: "Paste a PROOVRA verification link or id." });
      return;
    }
    setId(extracted);
    void verify(extracted);
  }, [manual, verify]);

  if (state === "loading") return <ProovraScreen scroll={false}><ProovraLoadingState label="Verifying" /></ProovraScreen>;
  // No id yet: let the user paste a public verification link/id (server-authoritative).
  if (state === "empty" || (state === "error" && !id)) {
    return (
      <ProovraScreen width="form">
        <AuthBrandHeader tagline="Verify the authenticity of a PROOVRA record." />
        {/* T-14 — the web /verify landing (VerifyHero + its five sections), verbatim. */}
        <View style={styles.card} testID="verify-landing">
          <ProovraText variant="label" weight="semibold" color={theme.color.accent.a500}>{VERIFY_HERO.eyebrow}</ProovraText>
          <ProovraText variant="h2" weight="bold">{`${VERIFY_HERO.title} ${VERIFY_HERO.titleAccent}`}</ProovraText>
          <ProovraText variant="bodySm" color={theme.color.ink.secondary}>{VERIFY_HERO.body}</ProovraText>
          <ProovraText variant="label" color={theme.color.ink.secondary}>{VERIFY_HERO.chips.join(" · ")}</ProovraText>
        </View>
        <ProovraCard style={styles.card}>
          <ProovraText variant="bodySm" weight="semibold">{VERIFY_TOKEN_CARD.title}</ProovraText>
          <ProovraText variant="label" color={theme.color.ink.secondary}>{VERIFY_TOKEN_CARD.subtitle}</ProovraText>
          <ProovraFormField label={VERIFY_TOKEN_CARD.label} error={error ? error.message : null}>
            <ProovraInput
              value={manual}
              onChangeText={(v) => {
                setManual(v);
                if (error) setError(null);
              }}
              placeholder={VERIFY_TOKEN_CARD.placeholder}
              autoCapitalize="none"
              onSubmitEditing={submitManual}
            />
          </ProovraFormField>
          {error ? null : <ProovraText variant="label" color={theme.color.ink.muted}>{VERIFY_TOKEN_CARD.help}</ProovraText>}
          <ProovraButton label={VERIFY_TOKEN_CARD.submit} onPress={submitManual} />
        </ProovraCard>
        <ProovraCard style={styles.card}>
          <ProovraText variant="label" color={theme.color.ink.secondary}>
            <ProovraText variant="label" weight="semibold">{`${VERIFY_HERO.boundaryLead} `}</ProovraText>
            {VERIFY_HERO.boundary}
          </ProovraText>
          {VERIFY_HERO.helpers.map((line) => (
            <ProovraText key={line} variant="label" color={theme.color.ink.secondary}>{`• ${line}`}</ProovraText>
          ))}
        </ProovraCard>
        <ProovraCard style={styles.card}>
          <ProovraText variant="bodySm" weight="semibold">{VERIFY_MATERIALS.title}</ProovraText>
          <ProovraText variant="label" color={theme.color.ink.secondary}>{VERIFY_MATERIALS.body}</ProovraText>
          <ProovraText variant="label" color={theme.color.ink.secondary}>{VERIFY_MATERIALS.items.join(" · ")}</ProovraText>
        </ProovraCard>
        <ProovraCard style={styles.card}>
          <ProovraText variant="bodySm" weight="semibold">{VERIFY_OPENS.title}</ProovraText>
          <ProovraText variant="label" color={theme.color.ink.secondary}>{VERIFY_OPENS.body}</ProovraText>
          {VERIFY_OPENS.cards.map((c) => (
            <View key={c.title} style={styles.hashRow}>
              <ProovraText variant="label" weight="semibold">{c.title}</ProovraText>
              <ProovraText variant="label" color={theme.color.ink.secondary}>{c.body}</ProovraText>
            </View>
          ))}
        </ProovraCard>
        <ProovraCard style={styles.card}>
          <ProovraText variant="label" weight="semibold" color={theme.color.ink.muted}>{VERIFY_BOUNDARIES.eyebrow}</ProovraText>
          <ProovraText variant="bodySm" weight="semibold">{`${VERIFY_BOUNDARIES.title} ${VERIFY_BOUNDARIES.titleAccent}`}</ProovraText>
          <ProovraText variant="label" color={theme.color.ink.secondary}>{VERIFY_BOUNDARIES.body}</ProovraText>
          <ProovraText variant="label" weight="semibold">{VERIFY_BOUNDARIES.outOfScopeLabel}</ProovraText>
          <ProovraText variant="label" color={theme.color.ink.secondary}>{VERIFY_BOUNDARIES.outOfScope.join(" · ")}</ProovraText>
        </ProovraCard>
        <ProovraCard style={styles.card}>
          <ProovraText variant="label" weight="semibold" color={theme.color.ink.muted}>{VERIFY_USE_CASES.eyebrow}</ProovraText>
          <ProovraText variant="bodySm" weight="semibold">{VERIFY_USE_CASES.title}</ProovraText>
          {VERIFY_USE_CASES.cards.map((c) => (
            <View key={c.title} style={styles.hashRow}>
              <ProovraText variant="label" weight="semibold">{c.title}</ProovraText>
              <ProovraText variant="label" color={theme.color.ink.secondary}>{c.body}</ProovraText>
            </View>
          ))}
        </ProovraCard>
        <View style={styles.card}>
          <ProovraText variant="bodySm" weight="semibold">{VERIFY_FINAL_CTA.title}</ProovraText>
          <ProovraText variant="label" color={theme.color.ink.secondary}>{VERIFY_FINAL_CTA.body}</ProovraText>
        </View>
      </ProovraScreen>
    );
  }
  // The web's failure state, by title (verify/[token]/page.tsx:4610-4625).
  if (state === "error" && error) {
    return (
      <ProovraScreen scroll={false}>
        <ProovraEmptyState
          title={VERIFY_COPY.failedTitle}
          message={error.message || VERIFY_COPY.failedFallback}
          action={<ProovraButton label={VERIFY_COPY.tryAgain} onPress={() => void verify(id)} />}
        />
      </ProovraScreen>
    );
  }

  // A 200 with nothing to verify is NOT a verified record (page.tsx:4626-4640).
  if (!hasVerificationMaterials(data)) {
    return (
      <ProovraScreen scroll={false}>
        <ProovraEmptyState title={VERIFY_COPY.notFoundTitle} message={VERIFY_COPY.notFoundBody} />
      </ProovraScreen>
    );
  }

  const v = parseVerifyView(data);
  const acq = parseVerifyCaptureIntegrity(data);
  const captureCtx = parseVerifyCaptureContext(data);
  const shareUrl = publicVerifyUrl(webOrigin(), id);
  const Row = ({ k, value, mono }: { k: string; value: string | null; mono?: boolean }) =>
    value ? (
      <View style={styles.hashRow}>
        <ProovraText variant="label" color={theme.color.ink.muted}>{k}</ProovraText>
        <ProovraText variant="bodySm" mono={mono} numberOfLines={mono ? 3 : undefined} selectable>{value}</ProovraText>
      </View>
    ) : null;

  // WEB PARITY (verify/[token]/page.tsx) — every section below reads a field
  // GET /public/verify/:id actually sends, and renders nothing without it.
  const fmt = (iso: string) => formatUserDateTime(iso);
  const trust = parseVerifyTrustDecision(data);
  const outputContext = parseVerifyOutputContext(data);
  const signals = parseVerifyIntegritySignals(data);
  const verdict = buildVerifyVerdict(trust, signals);
  const reviewerActions = buildVerifyReviewerActions(verdict, signals);
  const mismatchExplanations = buildVerifyMismatchExplanations(signals);
  const mismatchMessages = verifyMismatchMessages(signals);
  const divergence = parseVerifyDivergence(data);
  const anchoring = parseVerifyAnchoring(data, fmt);
  const redaction = parseVerifyRedaction(data, fmt);
  const content = parseVerifyContentReview(data, fmt);
  const custody = parseVerifyCustody(data);
  const recordFields = verifyRecordFields(data, trust, fmt);
  const integrityTab = verifyIntegrityTab(data, signals, fmt, trust?.verdict === "REVIEW_REQUIRED");
  const pkg = parseVerifyPackage(data);
  const recordStatus = (data?.["overview"] as Record<string, unknown> | undefined)?.["recordStatus"];
  const selected: VerifyContentItem | null = content
    ? content.items.find((i) => i.id === selectedItemId) ?? content.items.find((i) => i.id === content.defaultItemId) ?? content.items[0] ?? null
    : null;
  const open = (url: string) => void Linking.openURL(url);

  return (
    <ProovraScreen>
      <ProovraSection title="Verification">
        <ProovraText variant="h2" weight="bold" accessibilityRole="header">{VERIFY_TRUST_COPY.pageTitle}</ProovraText>
        <ProovraText variant="bodySm" color={theme.color.ink.secondary}>{VERIFY_TRUST_COPY.pageSubtitle}</ProovraText>
        <ProovraText variant="label" mono selectable color={theme.color.ink.muted} style={styles.gap}>{`Token: ${id}`}</ProovraText>
        <ProovraCard style={styles.card}>
          {/* The server's state, or nothing — never an invented "Verified record". */}
          {v.statusLabel ? <ProovraBadge tone={verifyStatusTone(v.statusLabel)} label={v.statusLabel} /> : null}
          {v.title ? <ProovraText variant="h2" weight="bold" style={styles.gap}>{v.title}</ProovraText> : null}
          {v.evidenceType ? <ProovraText variant="bodySm" color={theme.color.ink.secondary}>{v.evidenceType}</ProovraText> : null}
          {v.capturedAt ? <ProovraText variant="bodySm" color={theme.color.ink.secondary}>{formatUserDateTime(v.capturedAt)}</ProovraText> : null}
          {v.integrityHeadline ? <ProovraText variant="bodySm">{v.integrityHeadline}</ProovraText> : null}
          {v.summary ? <ProovraText variant="label" color={theme.color.ink.secondary}>{v.summary}</ProovraText> : null}
        </ProovraCard>

        {/* ---- Evidence Trust Decision (web TrustDecisionCard) — `trustDecision`. ---- */}
        {trust ? (
          <ProovraCard style={styles.card} testID="verify-trust-decision">
            <Kicker>{VERIFY_TRUST_COPY.overallKicker}</Kicker>
            <ProovraBadge tone={verifyBadgeTone(trust.tone)} label={trust.verdictLabel} />
            <ProovraText variant="h3" weight="bold">{trust.verdictLabel}</ProovraText>
            <ProovraText variant="bodySm">{trust.narrative}</ProovraText>
            <View style={styles.inset}>
              <Kicker>{VERIFY_TRUST_COPY.confidenceKicker}</Kicker>
              <ProovraText variant="bodySm" weight="bold">{trust.confidenceLabel}</ProovraText>
              <Kicker>{VERIFY_TRUST_COPY.classificationKicker}</Kicker>
              <ProovraText variant="label" weight="semibold" color={theme.color.ink.secondary}>{trust.verdictLabel.toUpperCase()}</ProovraText>
            </View>
            <View style={styles.inset}>
              <Kicker>{VERIFY_TRUST_COPY.basisKicker}</Kicker>
              {trust.primaryReason ? <ProovraText variant="label">{trust.primaryReason}</ProovraText> : null}
              <ProovraText variant="label">{trust.publicationPostureLine}</ProovraText>
              {trust.reviewerAction ? <ProovraText variant="label" weight="semibold">{trust.reviewerAction}</ProovraText> : null}
            </View>
          </ProovraCard>
        ) : null}

        {/* ---- Web OutputContextBadge — `outputContext`. ---- */}
        {outputContext ? (
          <ProovraCard style={styles.card} testID="verify-output-context">
            <ProovraText variant="label" weight="semibold">{outputContext.sourceLine}</ProovraText>
            {outputContext.snapshotGeneratedAtUtc ? <ProovraText variant="label">{`Snapshot generated: ${fmt(outputContext.snapshotGeneratedAtUtc)}`}</ProovraText> : null}
            {outputContext.liveObservedAtUtc ? <ProovraText variant="label">{`Live observed: ${fmt(outputContext.liveObservedAtUtc)}`}</ProovraText> : null}
            {outputContext.deltas.length > 0 ? (
              <ProovraText variant="label" color={theme.color.ink.secondary}>{`May have advanced since snapshot: ${outputContext.deltas.join(", ")}`}</ProovraText>
            ) : null}
            {outputContext.legalBoundary ? <ProovraText variant="label" color={theme.color.ink.muted}>{outputContext.legalBoundary}</ProovraText> : null}
          </ProovraCard>
        ) : null}

        {/* ---- Trust Signal Breakdown — `trustDecision.signals`. ---- */}
        {trust && trust.signals.length > 0 ? (
          <ProovraCard style={styles.card} testID="verify-trust-signals">
            <Kicker>{VERIFY_TRUST_COPY.breakdownKicker}</Kicker>
            <ProovraText variant="h3" weight="semibold">{VERIFY_TRUST_COPY.breakdownTitle}</ProovraText>
            <ProovraText variant="label" color={theme.color.ink.secondary}>{VERIFY_TRUST_COPY.breakdownBody}</ProovraText>
            <SignalList signals={trust.signals} />
          </ProovraCard>
        ) : null}

        {/* ---- Legal Review Boundary / Recommended Reviewer Actions / Integrity Issue Explanation — `integrityProof`. ---- */}
        {signals.present ? (
          <>
            <ProovraCard style={styles.card} testID="verify-legal-boundary">
              <Kicker color={verdict.tone === "danger" ? theme.color.status.risk.fg : undefined}>{VERIFY_REVIEW_COPY.legalKicker}</Kicker>
              <ProovraText variant="bodySm">{verdict.legalStatement}</ProovraText>
            </ProovraCard>
            <ProovraCard style={styles.card} testID="verify-reviewer-actions">
              <Kicker>{VERIFY_REVIEW_COPY.actionsKicker}</Kicker>
              <ProovraText variant="label" color={theme.color.ink.secondary}>{VERIFY_REVIEW_COPY.actionsBody}</ProovraText>
              {reviewerActions.map((a, i) => (
                <ProovraText key={a} variant="label">{`${i + 1}. ${a}`}</ProovraText>
              ))}
            </ProovraCard>
            {mismatchExplanations.length > 0 ? (
              <ProovraCard style={styles.card} testID="verify-integrity-issues">
                <Kicker color={theme.color.status.risk.fg}>{VERIFY_REVIEW_COPY.issuesKicker}</Kicker>
                <ProovraText variant="label" color={theme.color.ink.secondary}>{VERIFY_REVIEW_COPY.issuesBody}</ProovraText>
                {mismatchExplanations.map((m) => (
                  <View key={m.title} style={styles.hashRow}>
                    <ProovraBadge tone={m.severity === "danger" ? "risk" : "pending"} label={m.title} />
                    <ProovraText variant="label">{m.body}</ProovraText>
                  </View>
                ))}
              </ProovraCard>
            ) : null}
          </>
        ) : null}

        {/* ---- Supporting Technical Signals — `trustDecision` + consistency/snapshot/live fields. ---- */}
        {trust ? (
          <ProovraCard style={styles.card} testID="verify-supporting-signals">
            <Kicker>{VERIFY_TRUST_COPY.supportingKicker}</Kicker>
            <ProovraText variant="h3" weight="semibold">{VERIFY_TRUST_COPY.supportingTitle}</ProovraText>
            <ProovraText variant="label" color={theme.color.ink.secondary}>{VERIFY_TRUST_COPY.supportingBody}</ProovraText>
            {typeof recordStatus === "string" && recordStatus ? <ProovraBadge tone="neutral" label={verifyStatusPillLabel(recordStatus)} /> : null}
            <View style={styles.wrap}>
              {verifyExecutiveBadges(trust).map((b) => (
                <ProovraBadge key={b.label} tone={verifyBadgeTone(b.tone)} label={b.label} />
              ))}
            </View>
            {trust.reviewerAction ? (
              <View style={styles.inset}>
                <Kicker>{VERIFY_TRUST_COPY.reviewerActionKicker}</Kicker>
                <ProovraText variant="bodySm" weight="semibold">{trust.reviewerAction}</ProovraText>
                <ProovraText variant="label">{VERIFY_TRUST_COPY.reviewerActionBoundary}</ProovraText>
              </View>
            ) : null}
            {divergence ? (
              <View style={styles.inset} testID="verify-divergence">
                <Kicker>{divergence.kicker}</Kicker>
                <ProovraText variant="bodySm" weight="semibold">{divergence.headline}</ProovraText>
                <ProovraText variant="label">{VERIFY_DIVERGENCE_COPY.boundary}</ProovraText>
                {divergence.reasons.length > 0 ? <ProovraText variant="label" weight="semibold">{VERIFY_DIVERGENCE_COPY.why}</ProovraText> : null}
                {divergence.reasons.map((r, i) => (
                  <ProovraText key={`${r.label}-${i}`} variant="label">{`• ${r.label}. ${r.detail}`}</ProovraText>
                ))}
              </View>
            ) : null}
            {anchoring ? (
              <>
                <View style={styles.inset} testID="verify-snapshot">
                  <Kicker>{VERIFY_ANCHORING_COPY.snapshotKicker}</Kicker>
                  <ProovraText variant="label">{VERIFY_ANCHORING_COPY.snapshotBody}</ProovraText>
                  {anchoring.snapshotRows.map((r) => (
                    <Row key={r.label} k={r.label} value={r.value} />
                  ))}
                </View>
                <View style={styles.inset} testID="verify-live-anchoring">
                  <Kicker>{VERIFY_ANCHORING_COPY.liveKicker}</Kicker>
                  <ProovraText variant="label">{VERIFY_ANCHORING_COPY.liveBody}</ProovraText>
                  {anchoring.advanced ? <ProovraText variant="label" weight="semibold">{VERIFY_ANCHORING_COPY.advanced}</ProovraText> : null}
                  {anchoring.otsPending ? <ProovraText variant="label" weight="semibold">{VERIFY_ANCHORING_COPY.otsPending}</ProovraText> : null}
                  {anchoring.liveRows.map((r) => (
                    <Row key={r.label} k={r.label} value={r.value} mono={r.label === "Bitcoin Transaction" && r.value !== "Not recorded"} />
                  ))}
                </View>
              </>
            ) : null}
            {signals.present ? (
              <View style={styles.inset}>
                <Kicker>{VERIFY_PANEL_COPY.legalOutcome}</Kicker>
                <ProovraText variant="label">{verdict.legalStatement}</ProovraText>
                <ProovraText variant="label" color={theme.color.ink.secondary}>{verdict.actionRequired}</ProovraText>
              </View>
            ) : null}
            {custody.present ? (
              <View style={styles.inset}>
                <Kicker>{VERIFY_PANEL_COPY.custodyPosture}</Kicker>
                <ProovraText variant="label">{custody.forensicNarrative}</ProovraText>
                <ProovraText variant="label" color={theme.color.ink.secondary}>{custody.accessNarrative}</ProovraText>
              </View>
            ) : null}
            <View style={styles.inset}>
              <Kicker>{VERIFY_PANEL_COPY.scope}</Kicker>
              <ProovraText variant="label">{verifyScopeText(data)}</ProovraText>
              <ProovraText variant="label" color={theme.color.ink.secondary}>{VERIFY_PANEL_COPY.scopeFooter}</ProovraText>
            </View>
            {verifyPublicationPending(trust) ? (
              <View style={styles.inset}>
                <Kicker>{VERIFY_TRUST_COPY.publicationPostureKicker}</Kicker>
                <ProovraText variant="label">{VERIFY_TRUST_COPY.publicationPostureBody}</ProovraText>
              </View>
            ) : null}
            {signals.custodyChainFailureReason ? (
              <View style={styles.inset}>
                <Kicker color={theme.color.status.risk.fg}>{VERIFY_TRUST_COPY.verificationWarningKicker}</Kicker>
                <ProovraText variant="label">{`Custody chain check reported: ${signals.custodyChainFailureReason}`}</ProovraText>
              </View>
            ) : null}
          </ProovraCard>
        ) : null}

        {/* ---- Web VerifyRedactionSection — `redaction`; nothing when the projection is null. ---- */}
        {redaction ? (
          <ProovraCard style={styles.card} testID="verify-redaction">
            <ProovraText variant="bodySm" weight="semibold">{VERIFY_REDACTION_COPY.title}</ProovraText>
            <ProovraText variant="label" color={theme.color.ink.secondary}>{VERIFY_REDACTION_COPY.body}</ProovraText>
            {redaction.rows.map((r) => (
              <Row key={r.label} k={r.label} value={r.value} />
            ))}
            {redaction.limitations.map((l) => (
              <ProovraText key={l} variant="label" color={theme.color.ink.muted}>{`• ${l}`}</ProovraText>
            ))}
          </ProovraCard>
        ) : null}

        {/* ---- Evidence Content Review — `evidenceContent`, `contentAccessPolicy`, `contentExposureDecision`. ---- */}
        {content && selected ? (
          <ProovraCard style={styles.card} testID="verify-content-review">
            <Kicker>{VERIFY_CONTENT_COPY.kicker}</Kicker>
            <ProovraText variant="h3" weight="semibold">{`${selected.kindLabel} review surface`}</ProovraText>
            <ProovraText variant="label" color={theme.color.ink.secondary}>{content.rationale}</ProovraText>
            <View style={styles.wrap}>
              {content.sectionDescription ? <ProovraBadge tone="neutral" label={content.sectionDescription} /> : null}
              {content.accessModeLabel ? <ProovraBadge tone="governance" label={content.accessModeLabel} /> : null}
            </View>
            <View style={styles.inset}>
              <Kicker>{VERIFY_CONTENT_COPY.accessNoteKicker}</Kicker>
              <ProovraText variant="label">{content.accessNote}</ProovraText>
              <ProovraText variant="label" color={theme.color.ink.secondary}>{content.privacyNote}</ProovraText>
            </View>
            <View style={styles.inset}>
              <Kicker>{VERIFY_CONTENT_COPY.whatChangedKicker}</Kicker>
              {content.whatChanged.length > 0 ? (
                content.whatChanged.map((w) => <ProovraText key={w} variant="label">{w}</ProovraText>)
              ) : (
                <ProovraText variant="label">{VERIFY_CONTENT_COPY.whatChangedEmpty}</ProovraText>
              )}
            </View>
            <View style={styles.inset}>
              <Kicker color={mismatchMessages.length > 0 ? theme.color.status.risk.fg : undefined}>{VERIFY_CONTENT_COPY.mismatchKicker}</Kicker>
              {mismatchMessages.length > 0 ? (
                mismatchMessages.map((m) => <ProovraText key={m} variant="label">{m}</ProovraText>)
              ) : signals.present ? (
                <ProovraText variant="label">{VERIFY_CONTENT_COPY.mismatchEmpty}</ProovraText>
              ) : null}
            </View>
            {content.items.length > 1 ? (
              <View style={{ gap: theme.space.s2 }}>
                {content.items.map((it) => (
                  <ProovraListRow
                    key={it.id}
                    title={`${it.id === selected.id ? "● " : ""}${it.label}`}
                    subtitle={it.roleLine}
                    onPress={() => setSelectedItemId(it.id)}
                  />
                ))}
              </View>
            ) : null}
            <ContentMedia item={selected} onOpen={open} />
            <View style={styles.inset}>
              <Kicker>{VERIFY_CONTENT_COPY.representationKicker}</Kicker>
              <ProovraText variant="label">{VERIFY_CONTENT_COPY.representationBody}</ProovraText>
            </View>
            <View style={styles.inset} testID="verify-selected-item">
              <Kicker>{VERIFY_CONTENT_COPY.selectedKicker}</Kicker>
              <ProovraText variant="bodySm" weight="semibold">{selected.label}</ProovraText>
              <ProovraText variant="label">{`Kind: ${selected.kindLabel}`}</ProovraText>
              {selected.mimeType ? <ProovraText variant="label">{`MIME Type: ${selected.mimeType}`}</ProovraText> : null}
              {selected.sizeLabel ? <ProovraText variant="label">{`Size: ${selected.sizeLabel}`}</ProovraText> : null}
              {selected.duration ? <ProovraText variant="label">{`Duration: ${selected.duration}`}</ProovraText> : null}
              {selected.accessRole ? <ProovraText variant="label">{`Access role: ${selected.accessRole}`}</ProovraText> : null}
              {selected.sha256 ? <ProovraText variant="label" mono selectable>{`SHA-256: ${selected.sha256}`}</ProovraText> : null}
              {selected.originalPreservationNote ? <ProovraText variant="label">{`Original: ${selected.originalPreservationNote}`}</ProovraText> : null}
              {selected.reviewerRepresentationLabel ? <ProovraText variant="label">{`Reviewer surface: ${selected.reviewerRepresentationLabel}`}</ProovraText> : null}
              {selected.viewUrl ? <ProovraButton label={VERIFY_CONTENT_COPY.openPreserved} onPress={() => open(selected.viewUrl as string)} /> : null}
              {selected.viewUrl && selected.downloadable ? (
                <ProovraButton label={VERIFY_CONTENT_COPY.download} variant="secondary" onPress={() => open(selected.viewUrl as string)} />
              ) : null}
            </View>
            {selected.reviewerRepresentationNote ? (
              <View style={styles.inset}>
                <Kicker>{VERIFY_CONTENT_COPY.reviewerRepresentationKicker}</Kicker>
                <ProovraText variant="label">{selected.reviewerRepresentationNote}</ProovraText>
              </View>
            ) : null}
            {selected.verificationMaterialsNote ? (
              <View style={styles.inset}>
                <Kicker>{VERIFY_CONTENT_COPY.materialsNoteKicker}</Kicker>
                <ProovraText variant="label">{selected.verificationMaterialsNote}</ProovraText>
              </View>
            ) : null}
            {content.primaryItemId && selected.id !== content.primaryItemId ? (
              <View style={styles.inset}>
                <Kicker>{VERIFY_CONTENT_COPY.primaryKicker}</Kicker>
                <ProovraText variant="bodySm" weight="semibold">{content.items.find((i) => i.id === content.primaryItemId)?.label ?? ""}</ProovraText>
                <ProovraButton label={VERIFY_CONTENT_COPY.jumpToPrimary} variant="ghost" onPress={() => setSelectedItemId(content.primaryItemId)} />
              </View>
            ) : null}
          </ProovraCard>
        ) : null}

        {/* The evidence items (verify page multi-item viewer): kind, original name, duration, size, role. */}
        {v.items.length > 0 ? (
          <ProovraCard style={styles.card}>
            <ProovraText variant="label" weight="semibold" color={theme.color.ink.secondary}>
              {v.items.length === 1 ? "Evidence item" : `Evidence items (${v.items.length})`}
            </ProovraText>
            {v.items.map((it) => (
              <View key={it.id} style={styles.hashRow} testID={`verify-item-${it.id}`}>
                <ProovraText variant="bodySm" weight="semibold">{`${it.isPrimary ? "Primary evidence item · " : ""}${it.label}`}</ProovraText>
                <ProovraText variant="label" color={theme.color.ink.secondary}>
                  {[
                    it.kind.toUpperCase(),
                    it.roleLabel,
                    formatVerifyDuration(it.durationMs) ? `Duration: ${formatVerifyDuration(it.durationMs)}` : null,
                    it.sizeLabel,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </ProovraText>
                {it.originalFileName ? <ProovraText variant="label" color={theme.color.ink.muted}>{`Original: ${it.originalFileName}`}</ProovraText> : null}
              </View>
            ))}
          </ProovraCard>
        ) : null}

        {/* Integrity materials (verify page Integrity tab): hashes, signature, key, timestamping, anchoring. */}
        <ProovraCard style={styles.card}>
          <ProovraText variant="label" weight="semibold" color={theme.color.ink.secondary}>Integrity</ProovraText>
          <Row k="SHA-256" value={v.materials.fileSha256} mono />
          <Row k="Ed25519 fingerprint" value={v.materials.fingerprint} mono />
          <Row k="Signature" value={v.materials.signatureBase64} mono />
          <Row k="Signing key" value={v.materials.signingKey} mono />
          <Row k="Public key" value={v.materials.publicKeyPem} mono />
          <Row k="Timestamp (RFC 3161)" value={[v.tsa.status, v.tsa.provider, v.tsa.genTimeUtc ? formatUserDateTime(v.tsa.genTimeUtc) : null].filter(Boolean).join(" · ") || null} />
          <Row k="Timestamp serial" value={v.tsa.serialNumber} mono />
          <Row k="OpenTimestamps" value={[v.ots.status, v.ots.proofPresent ? "proof present" : null, v.ots.anchoredAtUtc ? formatUserDateTime(v.ots.anchoredAtUtc) : null].filter(Boolean).join(" · ") || null} />
          <Row k="TxID:" value={v.ots.bitcoinTxid ?? v.anchorTransactionId} mono />
        </ProovraCard>

        {v.acquisition.length > 0 ? (
          <ProovraCard style={styles.card}>
            <ProovraText variant="label" weight="semibold" color={theme.color.ink.secondary}>Evidence Acquisition</ProovraText>
            {v.acquisition.map((r) => (
              <Row key={r.label} k={r.label} value={r.value} />
            ))}
          </ProovraCard>
        ) : null}
        {v.device.length > 0 ? (
          <ProovraCard style={styles.card}>
            <ProovraText variant="label" weight="semibold" color={theme.color.ink.secondary}>Capture device</ProovraText>
            {v.device.map((r) => (
              <Row key={r.label} k={r.label} value={r.value} />
            ))}
          </ProovraCard>
        ) : null}

        {v.custody.length > 0 ? (
          <ProovraCard style={styles.card}>
            <ProovraText variant="label" weight="semibold" color={theme.color.ink.secondary}>Chain of custody</ProovraText>
            {v.custody.map((ev, i) => (
              <ProovraListRow
                key={`${ev.eventType}-${i}`}
                title={ev.summary ?? ev.eventType}
                subtitle={ev.atUtc ? formatUserDateTime(ev.atUtc) : undefined}
              />
            ))}
            {v.accessEventCount ? (
              <ProovraText variant="label" color={theme.color.ink.muted}>{`${v.accessEventCount} later access event${v.accessEventCount === 1 ? "" : "s"} are not integrity-relevant.`}</ProovraText>
            ) : null}
          </ProovraCard>
        ) : null}

        {/* ---- Technical Review Materials (web tabs + Forensic Review Mode). ---- */}
        <ProovraCard style={styles.card} testID="verify-technical">
          <ProovraText variant="h3" weight="semibold">{VERIFY_TECHNICAL_COPY.title}</ProovraText>
          <ProovraText variant="label" color={theme.color.ink.secondary}>{VERIFY_TECHNICAL_COPY.body}</ProovraText>
          <View style={styles.inset}>
            <Kicker>{VERIFY_TECHNICAL_COPY.forensicKicker}</Kicker>
            <ProovraText variant="label">{forensicMode ? VERIFY_TECHNICAL_COPY.forensicOn : VERIFY_TECHNICAL_COPY.forensicOff}</ProovraText>
            <ProovraButton
              label={forensicMode ? VERIFY_TECHNICAL_COPY.disable : VERIFY_TECHNICAL_COPY.enable}
              variant={forensicMode ? "primary" : "secondary"}
              onPress={() => setForensicMode((m) => !m)}
            />
          </View>
          <View style={styles.wrap}>
            {TECH_TABS.map((t) => (
              <ProovraButton
                key={t}
                label={VERIFY_TECHNICAL_COPY.tabs[t]}
                variant={techTab === t ? "secondary" : "ghost"}
                fullWidth={false}
                onPress={() => setTechTab(t)}
              />
            ))}
          </View>

          {techTab === "record" ? (
            <View style={{ gap: theme.space.s2 }} testID="verify-tab-record">
              <ProovraText variant="label" color={theme.color.ink.secondary}>{VERIFY_TECHNICAL_COPY.recordRail}</ProovraText>
              {recordFields.map((f) => (
                <Row key={f.label} k={f.label} value={f.value} />
              ))}
            </View>
          ) : null}

          {techTab === "integrity" ? (
            <View style={{ gap: theme.space.s2 }} testID="verify-tab-integrity">
              {trust ? <SignalList signals={trust.signals.filter((s) => (VERIFY_INTEGRITY_SIGNAL_KEYS as readonly string[]).includes(s.key))} /> : null}
              <Kicker>{VERIFY_TECHNICAL_COPY.integrityScopeKicker}</Kicker>
              <ProovraText variant="label">{VERIFY_TECHNICAL_COPY.integrityScope}</ProovraText>
              {integrityTab.hashField ? <MaterialField field={integrityTab.hashField} forensicMode={forensicMode} /> : null}
              {integrityTab.multipart ? (
                <View style={styles.inset}>
                  <Kicker>{VERIFY_TECHNICAL_COPY.multipartKicker}</Kicker>
                  <ProovraText variant="label">{VERIFY_TECHNICAL_COPY.multipartBody}</ProovraText>
                </View>
              ) : null}
              {integrityTab.timestampedDigest ? <MaterialField field={integrityTab.timestampedDigest} forensicMode={forensicMode} /> : null}
              {integrityTab.legacyMode ? <ProovraText variant="label" color={theme.color.ink.muted}>{VERIFY_TECHNICAL_COPY.legacyMode}</ProovraText> : null}
              {integrityTab.otherFields.map((f) => (
                <MaterialField key={f.label} field={f} forensicMode={forensicMode} />
              ))}
              {integrityTab.statusCards.map((c) => (
                <View key={c.label} style={styles.hashRow}>
                  <ProovraText variant="label" color={theme.color.ink.muted}>{c.label}</ProovraText>
                  {c.tone ? <ProovraBadge tone={verifyBadgeTone(c.tone)} label={c.value} /> : <ProovraText variant="bodySm" selectable>{c.value}</ProovraText>}
                </View>
              ))}
              {integrityTab.tsaFailureReason ? (
                <View style={styles.inset}>
                  <Kicker color={theme.color.status.risk.fg}>{VERIFY_TECHNICAL_COPY.tsaFailureKicker}</Kicker>
                  <ProovraText variant="label">{integrityTab.tsaFailureReason}</ProovraText>
                </View>
              ) : null}
              {integrityTab.otsFailure ? (
                <View style={styles.inset}>
                  <Kicker color={theme.color.status.risk.fg}>{VERIFY_TECHNICAL_COPY.otsNoteKicker}</Kicker>
                  <ProovraText variant="label">{integrityTab.otsFailure.message}</ProovraText>
                  <ProovraButton label={VERIFY_TECHNICAL_COPY.showTechnical} variant="ghost" fullWidth={false} onPress={() => setShowOtsTechnical((x) => !x)} />
                  {showOtsTechnical ? <ProovraText variant="label" mono selectable>{integrityTab.otsFailure.technical}</ProovraText> : null}
                </View>
              ) : null}
            </View>
          ) : null}

          {techTab === "package" ? (
            <View style={{ gap: theme.space.s2 }} testID="verify-tab-package">
              {pkg ? (
                <>
                  <Kicker>{VERIFY_PACKAGE_COPY.kicker}</Kicker>
                  <ProovraText variant="bodySm" weight="bold">{pkg.decisionLabel}</ProovraText>
                  <ProovraText variant="label">{pkg.decisionText}</ProovraText>
                  <ProovraBadge tone={verifyBadgeTone(pkg.tone)} label={pkg.badge} />
                  <Kicker>{VERIFY_PACKAGE_COPY.decisionKicker}</Kicker>
                  {pkg.version ? <ProovraText variant="label" weight="semibold">{pkg.version}</ProovraText> : null}
                  <View style={styles.inset}>
                    <Kicker>{VERIFY_PACKAGE_COPY.impactKicker}</Kicker>
                    <ProovraText variant="label">{pkg.impact}</ProovraText>
                    {pkg.generatedAtUtc ? <ProovraText variant="label">{`${VERIFY_PACKAGE_COPY.generatedAtPrefix}${fmt(pkg.generatedAtUtc)}`}</ProovraText> : null}
                  </View>
                  {pkg.rows.map((r) => (
                    <View key={r.label} style={styles.hashRow}>
                      <ProovraText variant="label" color={theme.color.ink.muted}>{r.label}</ProovraText>
                      <ProovraBadge tone={verifyBadgeTone(r.tone)} label={r.value} />
                    </View>
                  ))}
                </>
              ) : null}
              <View style={styles.inset}>
                <Kicker>{VERIFY_TECHNICAL_COPY.packageScopeKicker}</Kicker>
                <ProovraText variant="label">{VERIFY_TECHNICAL_COPY.packageScope}</ProovraText>
              </View>
            </View>
          ) : null}

          {techTab === "custody" ? (
            <Timeline
              testID="verify-tab-custody"
              title={VERIFY_TECHNICAL_COPY.custodyTitle}
              subtitle={VERIFY_TECHNICAL_COPY.custodySubtitle}
              note={custody.fullNote}
              countLabel={custody.fullCountLabel ?? `${custody.fullTimeline.length} Event${custody.fullTimeline.length === 1 ? "" : "s"}`}
              events={custody.fullTimeline}
              emptyTitle={VERIFY_TECHNICAL_COPY.custodyEmptyTitle}
              emptyBody={VERIFY_TECHNICAL_COPY.custodyEmptyBody}
              forensicMode={forensicMode}
            />
          ) : null}

          {techTab === "access" ? (
            <View style={{ gap: theme.space.s2 }}>
              <View style={styles.inset}>
                <Kicker>{VERIFY_TECHNICAL_COPY.accessBoundaryKicker}</Kicker>
                <ProovraText variant="label">{VERIFY_TECHNICAL_COPY.accessBoundary}</ProovraText>
              </View>
              <Timeline
                testID="verify-tab-access"
                title={VERIFY_TECHNICAL_COPY.accessTitle}
                subtitle={VERIFY_TECHNICAL_COPY.accessSubtitle}
                note={null}
                countLabel={custody.accessCountLabel}
                events={custody.accessTimeline}
                emptyTitle={VERIFY_TECHNICAL_COPY.accessEmptyTitle}
                emptyBody={VERIFY_TECHNICAL_COPY.accessEmptyBody}
                forensicMode={forensicMode}
              />
            </View>
          ) : null}
        </ProovraCard>

        {/*
          WHAT A VERIFICATION DOES AND DOES NOT ESTABLISH.

          The web's verify landing carries this as VerifyBoundariesSection, and
          the native screen had hashes, a custody list and a green badge with
          nothing to bound them. A verification surface that shows a tick and
          says nothing about its limits is making precisely the overclaim the
          safe-language contract forbids — the reader supplies the missing
          sentence themselves, and they supply the wrong one.

          The claims come from @proovra/shared-evidence-presentation's
          claims-matrix, which is the canonical list the contract tests grep
          against. Nothing is written here.
        */}
        <ProovraCard style={styles.card}>
          <ProovraText variant="label" weight="semibold" color={theme.color.ink.secondary}>
            What this establishes
          </ProovraText>
          {PROOVRA_ALLOWED_CLAIMS.map((claim, i) => (
            <ProovraText key={`a${i}`} variant="label" color={theme.color.ink.secondary}>
              {`• ${claim}`}
            </ProovraText>
          ))}
        </ProovraCard>

        <ProovraCard style={styles.card}>
          <ProovraBadge tone="governance" label="Boundaries" />
          {/*
            The heading carries the negation ONCE and the claims are quoted
            verbatim. Rewriting each line into a denial would mean editing
            canonical text with string surgery on a legal-boundary surface —
            the one place where a clever transformation that mostly works is
            not good enough.
          */}
          <ProovraText variant="label" weight="semibold" color={theme.color.ink.secondary}>
            PROOVRA does not claim any of the following:
          </ProovraText>
          {PROOVRA_FORBIDDEN_CLAIMS.map((claim, i) => (
            <ProovraText key={`f${i}`} variant="label" color={theme.color.ink.muted}>
              {`• ${claim}`}
            </ProovraText>
          ))}
        </ProovraCard>

        {/* The web VerifyCaptureIntegritySection — only at its schema version. */}
        {acq ? (
          <ProovraCard style={styles.card} testID="verify-acquisition">
            <ProovraText variant="label" weight="semibold" color={theme.color.ink.secondary}>How this record was acquired</ProovraText>
            <ProovraText variant="bodySm" weight="semibold">{acq.label}</ProovraText>
            {acq.statement ? <ProovraText variant="bodySm">{acq.statement}</ProovraText> : null}
            {acq.backfilled ? <ProovraText variant="label" color={theme.color.ink.secondary}>Recorded later from this record’s secure intake session, not at the moment it was created.</ProovraText> : null}
            {acq.session ? (
              <ProovraText variant="bodySm">
                {`Submitted in a server-issued capture session${acq.session.startedAtIso ? ` opened ${formatUserDateTime(acq.session.startedAtIso)}` : ""}${acq.session.endedAtIso ? ` and completed ${formatUserDateTime(acq.session.endedAtIso)}` : ""}.${acq.session.digestsConfirmed > 0 ? ` ${acq.session.digestsConfirmed} file digest${acq.session.digestsConfirmed === 1 ? "" : "s"} declared by the app matched what PROOVRA received.` : ""}`}
              </ProovraText>
            ) : null}
            {acq.signatureLine ? <ProovraText variant="bodySm">{acq.signatureLine}</ProovraText> : null}
            {acq.attestationLine ? <ProovraText variant="bodySm">{acq.attestationLine}</ProovraText> : null}
            {acq.integrityEstablishedAtIso ? <ProovraText variant="bodySm">{`PROOVRA established integrity on its server at ${formatUserDateTime(acq.integrityEstablishedAtIso)}.`}</ProovraText> : null}
            <ProovraText variant="label" color={theme.color.ink.secondary}>{verifyArtifactsLine(acq.artifacts)}</ProovraText>
            {acq.limitations.map((l) => (
              <ProovraText key={l} variant="label" color={theme.color.ink.muted}>{`• ${l}`}</ProovraText>
            ))}
          </ProovraCard>
        ) : null}

        {/* NEW:VERIFY-CAPTURE-CONTEXT — the web Capture Context card (verify/[token]/page.tsx:4700-4860). */}
        {captureCtx ? (
          <ProovraCard style={styles.card} testID="verify-capture-context">
            <ProovraText variant="label" weight="semibold" color={theme.color.ink.muted}>Capture Context</ProovraText>
            <ProovraText variant="bodySm" weight="semibold">{`📍 ${captureCtx.statusLabel}`}</ProovraText>
            <ProovraText variant="label" color={theme.color.ink.secondary}>{captureCtx.description}</ProovraText>
            <ProovraText variant="label" weight="semibold" color={theme.color.ink.muted}>Supporting provenance context</ProovraText>
            <CaptureLocationMap lat={captureCtx.lat} lng={captureCtx.lng} accuracyMeters={captureCtx.accuracyMeters} />
            {captureCtx.rows.map((row) => (
              <View key={row.label} style={styles.hashRow}>
                <ProovraText variant="label" color={theme.color.ink.muted}>{row.label}</ProovraText>
                <ProovraText variant="bodySm" selectable>
                  {row.label === "Capture timestamp" && row.value !== "Not recorded" ? formatUserDateTime(row.value) : row.value}
                </ProovraText>
              </View>
            ))}
            <View style={{ flexDirection: "row", gap: theme.space.s2, flexWrap: "wrap" }}>
              <CopyButton value={captureCtx.coordinates} label="Copy coordinates" />
              {captureCtx.externalMapUrl ? (
                <ProovraButton label="Open map" variant="ghost" fullWidth={false} onPress={() => void Linking.openURL(captureCtx.externalMapUrl as string)} />
              ) : null}
            </View>
            <ProovraText variant="label" color={theme.color.ink.muted}>{captureCtx.legalBoundary}</ProovraText>
          </ProovraCard>
        ) : null}

        <ProovraCard style={styles.card}>
          <ProovraText variant="label" weight="semibold" color={theme.color.ink.secondary}>Actions</ProovraText>
          {shareUrl ? (
            <>
              {/* The web's "Copy Verification Link" (page.tsx:6888-6923). */}
              <ProovraText variant="label" color={theme.color.ink.secondary}>Copy the verification link to share this record.</ProovraText>
              <ProovraText variant="label" mono selectable testID="verify-share-url">{shareUrl}</ProovraText>
              <CopyButton value={shareUrl} label="Copy Verification Link" variant="secondary" testID="verify-copy-link" />
              <ProovraButton label="Share verification link" variant="secondary" onPress={() => void Share.share({ message: shareUrl, url: shareUrl })} />
            </>
          ) : null}
          <ProovraButton label="Check Latest Anchoring Status" variant="ghost" onPress={() => void verify(id)} />
        </ProovraCard>
      </ProovraSection>
    </ProovraScreen>
  );
}

type TechTab = "record" | "integrity" | "package" | "custody" | "access";
const TECH_TABS: readonly TechTab[] = ["record", "integrity", "package", "custody", "access"];

/** A web "kicker" (small uppercase section label). */
function Kicker({ children, color }: { children: string; color?: string }) {
  return (
    <ProovraText variant="label" weight="semibold" color={color ?? theme.color.ink.muted}>
      {children}
    </ProovraText>
  );
}

/** Web TrustSignalGrid: label, presentation label, summary, detail per signal. */
function SignalList({ signals }: { signals: VerifyTrustSignalView[] }) {
  return (
    <View style={{ gap: theme.space.s2 }}>
      {signals.map((s) => (
        <View key={s.key} style={styles.hashRow} testID={`verify-signal-${s.key}`}>
          <ProovraText variant="label" weight="semibold" color={theme.color.ink.muted}>{s.label}</ProovraText>
          <ProovraBadge tone={verifyBadgeTone(s.tone)} label={s.presentationLabel} />
          {s.summary ? <ProovraText variant="bodySm" weight="semibold">{s.summary}</ProovraText> : null}
          {s.detail ? <ProovraText variant="label" color={theme.color.ink.secondary}>{s.detail}</ProovraText> : null}
        </View>
      ))}
    </View>
  );
}

/**
 * Web MaterialField: values over 180 characters are cut until expanded, and
 * always shown whole in Forensic Review Mode. The web's Copy button has no
 * clipboard module here; the value is selectable instead.
 */
function MaterialField({ field, forensicMode }: { field: VerifyMaterialField; forensicMode: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const long = field.value.length > 180;
  const shown = forensicMode || expanded || !long ? field.value : `${field.value.slice(0, 180)}...`;
  return (
    <View style={styles.inset}>
      <Kicker>{field.label}</Kicker>
      <ProovraText variant="label" color={theme.color.ink.secondary}>{field.subtitle}</ProovraText>
      <ProovraText variant="label" mono selectable>{shown}</ProovraText>
      {long && !forensicMode ? (
        <ProovraButton
          label={expanded ? VERIFY_TECHNICAL_COPY.collapse : VERIFY_TECHNICAL_COPY.expand}
          accessibilityLabel={`${expanded ? VERIFY_TECHNICAL_COPY.collapse : VERIFY_TECHNICAL_COPY.expand} ${field.label}`}
          variant="ghost"
          fullWidth={false}
          onPress={() => setExpanded((x) => !x)}
        />
      ) : null}
    </View>
  );
}

/**
 * Web renderVerifyEvidenceMedia, touch form: the server's preview image or
 * text excerpt, the image itself when the item is an image with a view URL,
 * and otherwise the web's per-kind note with a button that opens the
 * preserved file. Inline video / audio / PDF players are not reproduced.
 */
function ContentMedia({ item, onOpen }: { item: VerifyContentItem; onOpen: (url: string) => void }) {
  const image = (uri: string, caption: string) => (
    <Image source={{ uri }} accessibilityLabel={caption} resizeMode="contain" style={styles.media} />
  );
  if (!item.viewUrl) {
    if (item.previewDataUrl) return image(item.previewDataUrl, item.previewCaption ?? item.label);
    if (item.previewTextExcerpt) return <ProovraText variant="label">{item.previewTextExcerpt}</ProovraText>;
    return (
      <View style={styles.inset} testID="verify-content-not-exposed">
        <ProovraText variant="bodySm" weight="semibold">{VERIFY_CONTENT_COPY.notExposedTitle}</ProovraText>
        <ProovraText variant="label">{VERIFY_CONTENT_COPY.notExposedBody}</ProovraText>
      </View>
    );
  }
  const url = item.viewUrl;
  if (item.kind === "image") return image(url, item.label);
  if (item.kind === "video" || item.kind === "pdf" || item.kind === "audio") {
    return (
      <View style={{ gap: theme.space.s2 }}>
        {item.previewDataUrl ? image(item.previewDataUrl, item.previewCaption ?? item.label) : null}
        {item.kind === "audio" ? <ProovraText variant="label">{VERIFY_CONTENT_COPY.audioBody}</ProovraText> : null}
      </View>
    );
  }
  if (item.kind === "text") {
    return (
      <View style={styles.inset}>
        <ProovraText variant="label">{VERIFY_CONTENT_COPY.textBody}</ProovraText>
        <ProovraButton label={VERIFY_CONTENT_COPY.openText} variant="secondary" onPress={() => onOpen(url)} />
      </View>
    );
  }
  return (
    <View style={styles.inset}>
      <ProovraText variant="bodySm" weight="semibold">{VERIFY_CONTENT_COPY.otherTitle}</ProovraText>
      <ProovraText variant="label">{VERIFY_CONTENT_COPY.otherBody}</ProovraText>
      <ProovraButton label={VERIFY_CONTENT_COPY.openFile} variant="secondary" onPress={() => onOpen(url)} />
    </View>
  );
}

/** Web TimelinePanel: Prev Hash / Event Hash are shown only in Forensic Review Mode. */
function Timeline({
  testID,
  title,
  subtitle,
  note,
  countLabel,
  events,
  emptyTitle,
  emptyBody,
  forensicMode,
}: {
  testID: string;
  title: string;
  subtitle: string;
  note: string | null;
  countLabel: string;
  events: VerifyTimelineEvent[];
  emptyTitle: string;
  emptyBody: string;
  forensicMode: boolean;
}) {
  return (
    <View style={{ gap: theme.space.s2 }} testID={testID}>
      <ProovraText variant="bodySm" weight="semibold">{title}</ProovraText>
      <ProovraText variant="label" color={theme.color.ink.secondary}>{subtitle}</ProovraText>
      {note ? <ProovraText variant="label" color={theme.color.status.pending.fg}>{note}</ProovraText> : null}
      <ProovraBadge tone="neutral" label={countLabel} />
      {events.length === 0 ? (
        <View style={styles.inset}>
          <ProovraText variant="label" weight="semibold">{emptyTitle}</ProovraText>
          <ProovraText variant="label">{emptyBody}</ProovraText>
        </View>
      ) : (
        events.map((e) => (
          <View key={e.key} style={styles.hashRow}>
            <ProovraText variant="bodySm" weight="semibold">{e.label}</ProovraText>
            <ProovraText variant="label" color={theme.color.ink.muted}>{formatUserDateTime(e.atUtc)}</ProovraText>
            <ProovraText variant="label" color={theme.color.ink.secondary}>{e.summary}</ProovraText>
            {forensicMode && e.prevEventHash ? (
              <ProovraText variant="label" mono selectable>{`${VERIFY_TECHNICAL_COPY.prevHash}: ${e.prevEventHash}`}</ProovraText>
            ) : null}
            {forensicMode && e.eventHash ? (
              <ProovraText variant="label" mono selectable>{`${VERIFY_TECHNICAL_COPY.eventHash}: ${e.eventHash}`}</ProovraText>
            ) : null}
          </View>
        ))
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { marginBottom: theme.space.s4, gap: theme.space.s2 },
  gap: { marginTop: theme.space.s2 },
  hashRow: { paddingVertical: theme.space.s2, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.color.border.subtle, gap: 2 },
  inset: {
    padding: theme.space.s3,
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.border.subtle,
    gap: theme.space.s1,
  },
  wrap: { flexDirection: "row", flexWrap: "wrap", gap: theme.space.s2 },
  media: { width: "100%", height: 240, borderRadius: theme.radius.md },
});
