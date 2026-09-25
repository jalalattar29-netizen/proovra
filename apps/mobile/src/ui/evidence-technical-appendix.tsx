/**
 * TECHNICAL APPENDIX (native) — the web EvidenceTechnicalAppendixTab and its
 * "Technical Evidence Context" cards, over src/product/evidence-technical-appendix.ts.
 *
 * Collapsed by default where the web collapses (every <details> is a
 * Disclosure here); identifiers carry the canonical copy control. The raw
 * `?debug=1` JSON dump is NOT ported: it is a URL-flag support affordance with
 * no native equivalent, and the web itself hides it from normal review.
 */
import React from "react";
import { View } from "react-native";

import {
  TECHNICAL_APPENDIX_COPY as COPY,
  MULTIPART_HASH_ADVISORY,
  type AppendixRow,
  type TechnicalAppendixModel,
} from "../product/evidence-technical-appendix";
import { theme } from "../theme/theme";
import { CopyButton } from "./copy-button";
import { Disclosure } from "./evidence-record-sections";
import { ProovraBadge, ProovraButton, ProovraCard, ProovraText } from "./index";

function Rows({ rows, empty }: { rows: AppendixRow[]; empty: string }) {
  if (rows.length === 0) return <ProovraText variant="label" color={theme.color.ink.muted}>{empty}</ProovraText>;
  return (
    <View style={{ gap: theme.space.s2 }}>
      {rows.map((r) => (
        <View key={r.label} style={{ gap: 2 }}>
          <ProovraText variant="label" color={theme.color.ink.muted}>{r.label}</ProovraText>
          <ProovraText variant="bodySm" mono={r.mono} selectable={r.mono}>{r.value}</ProovraText>
          {r.copyable ? <CopyButton value={r.value} accessibilityLabel={`Copy ${r.label}`} /> : null}
        </View>
      ))}
    </View>
  );
}

function Card({ title, subtitle, badge, children, testID }: { title: string; subtitle: string; badge?: React.ReactNode; children: React.ReactNode; testID: string }) {
  return (
    <ProovraCard testID={testID}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: theme.space.s2 }}>
        <View style={{ flex: 1 }}>
          <ProovraText variant="bodySm" weight="semibold">{title}</ProovraText>
          <ProovraText variant="label" color={theme.color.ink.muted}>{subtitle}</ProovraText>
        </View>
        {badge}
      </View>
      <View style={{ marginTop: theme.space.s2, gap: theme.space.s2 }}>{children}</View>
    </ProovraCard>
  );
}

function Advisory({ children }: { children: string }) {
  return <ProovraText variant="label" color={theme.color.ink.muted}>{children}</ProovraText>;
}

export function TechnicalAppendixIntro() {
  return (
    <ProovraCard testID="technical-appendix-intro">
      <ProovraText variant="h3" weight="semibold">{COPY.title}</ProovraText>
      <ProovraText variant="label" color={theme.color.ink.secondary}>{COPY.subtitle}</ProovraText>
      <ProovraText variant="label" color={theme.color.ink.muted}>{COPY.lede}</ProovraText>
    </ProovraCard>
  );
}

/** EvidenceTechnicalAppendix.tsx — the ten context cards. */
export function TechnicalEvidenceContext({
  model,
  phase,
  onOpenCustody,
}: {
  model: TechnicalAppendixModel;
  phase: "loading" | "ready" | "error";
  onOpenCustody: () => void;
}) {
  if (phase === "loading") {
    return <ProovraText variant="label" color={theme.color.ink.muted}>Loading technical evidence context…</ProovraText>;
  }
  return (
    <View style={{ gap: theme.space.s3 }} testID="evidence-technical-appendix">
      <View>
        <ProovraText variant="h3" weight="semibold">{COPY.contextTitle}</ProovraText>
        <ProovraText variant="label" color={theme.color.ink.muted}>{COPY.contextSub}</ProovraText>
      </View>
      <Card
        testID="ta-section-acquisition"
        title="Evidence Acquisition"
        subtitle="How this evidence entered PROOVRA"
        badge={<ProovraBadge tone={model.acquisition.isIntake ? "info" : "neutral"} label={model.acquisition.isIntake ? "Secure Intake Link" : "Authenticated upload"} />}
      >
        <Rows rows={model.acquisition.rows} empty="Acquisition context was not recorded." />
        {model.acquisition.roleModel.length > 0 ? (
          <View style={{ gap: theme.space.s1 }}>
            <ProovraText variant="label" weight="semibold">Submitter & identity</ProovraText>
            <Rows rows={model.acquisition.roleModel} empty="Not recorded." />
          </View>
        ) : null}
      </Card>
      <Card testID="ta-section-capture-device" title="Capture Device" subtitle="Client-reported device & submission channel">
        <Rows rows={model.captureDevice} empty="No device metadata was recorded for this evidence." />
        {model.captureDevice.length > 0 ? <Advisory>{COPY.deviceAdvisory}</Advisory> : null}
      </Card>
      <Card testID="ta-section-camera" title="Camera / EXIF" subtitle="File-embedded camera metadata">
        {model.camera.length > 0 ? (
          <>
            <Rows rows={model.camera} empty="No EXIF camera metadata recorded." />
            {model.fullExif.length > 0 ? (
              <Disclosure title="View full EXIF" testID="ta-full-exif">
                <Rows rows={model.fullExif} empty="No EXIF metadata recorded." />
                {model.multipart ? (
                  <Advisory>
                    Representative EXIF is shown for the primary media item. Full per-file EXIF for every part is included in the Verification Package.
                  </Advisory>
                ) : null}
              </Disclosure>
            ) : null}
          </>
        ) : (
          <ProovraText variant="label" color={theme.color.ink.muted}>{COPY.noExif}</ProovraText>
        )}
      </Card>
      {model.exposure.length > 0 ? (
        <Card testID="ta-section-exposure" title="Exposure" subtitle="Photographic exposure settings">
          <Rows rows={model.exposure} empty="No exposure metadata recorded." />
        </Card>
      ) : null}
      <Card testID="ta-section-client-env" title="Client / Browser Environment" subtitle="Reported client software environment">
        <Rows rows={model.clientEnv} empty="No browser metadata available for this evidence." />
        {model.clientAdvanced.length > 0 ? (
          <Disclosure title="Advanced client details" testID="ta-client-advanced">
            <Rows rows={model.clientAdvanced} empty="Not recorded." />
            <Advisory>{COPY.rawClientAdvisory}</Advisory>
          </Disclosure>
        ) : null}
      </Card>
      <Card testID="ta-section-upload-session" title="Upload Session" subtitle="Ingest session & composition">
        <Rows rows={model.uploadSession} empty="No upload session metadata recorded." />
      </Card>
      <Card testID="ta-section-integrity" title="Security & Integrity" subtitle="Cryptographic, timestamp, anchoring and storage state">
        <Rows rows={model.integrity} empty="No integrity materials were recorded for this evidence." />
        <Advisory>{COPY.integrityAdvisory}</Advisory>
      </Card>
      <Card testID="ta-section-custody-summary" title="Chain of Custody" subtitle="Forensic event summary">
        <Rows rows={model.custodySummary} empty="No custody events recorded." />
        <ProovraButton label="Open full custody timeline" variant="secondary" fullWidth={false} onPress={onOpenCustody} />
      </Card>
      {phase === "error" ? <ProovraText variant="label" color={theme.color.ink.muted}>{COPY.loadFailed}</ProovraText> : null}
    </View>
  );
}

/** EvidenceTechnicalAppendixTab.tsx:120-236 — the four disclosure blocks. */
export function TechnicalAppendixBlocks({
  hashRows,
  multipartContext,
  eventCounts,
  divergence,
  custodyChain,
}: {
  hashRows: AppendixRow[];
  multipartContext: boolean;
  eventCounts: AppendixRow[];
  divergence: Array<{ label: string; detail: string }> | null;
  custodyChain: string | null;
}) {
  return (
    <ProovraCard testID="technical-appendix-blocks">
      <Disclosure title="How verification hashes are computed" testID="ta-block-hashes">
        <Rows rows={hashRows} empty="No hash material was recorded for this record." />
        {multipartContext ? <Advisory>{MULTIPART_HASH_ADVISORY}</Advisory> : null}
      </Disclosure>
      <Disclosure title="Event counts (forensic and access)" testID="ta-block-event-counts">
        <Rows rows={eventCounts} empty="No event counts were recorded for this record." />
        <Advisory>{COPY.eventCountsAdvisory}</Advisory>
      </Disclosure>
      {divergence ? (
        <Disclosure title="Boundary divergence detail" testID="ta-block-divergence">
          <Advisory>{COPY.divergenceAdvisory}</Advisory>
          {divergence.length > 0 ? (
            divergence.map((d, i) => (
              <ProovraText key={`${d.label}-${i}`} variant="label" color={theme.color.ink.secondary}>{`${d.label}. ${d.detail}`}</ProovraText>
            ))
          ) : (
            <ProovraText variant="label" color={theme.color.ink.muted}>No per-reason detail recorded.</ProovraText>
          )}
        </Disclosure>
      ) : null}
      <Disclosure title="Custody chain detail" testID="ta-block-custody-chain">
        <Rows rows={custodyChain ? [{ label: "Custody chain validity", value: custodyChain }] : []} empty="No custody chain state was recorded for this record." />
      </Disclosure>
    </ProovraCard>
  );
}
