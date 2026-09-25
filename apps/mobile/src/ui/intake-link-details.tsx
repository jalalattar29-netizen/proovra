/**
 * INTAKE LINK DETAILS (T-14) — the touch port of the web DetailsDrawer
 * (apps/web/app/(app)/intake-links/_components/DetailsDrawer.tsx): Overview,
 * Delivery, Activity, Submissions and Access, read from the same list
 * projection and the same state model as the row badge above it.
 */
import React from "react";
import { View } from "react-native";

import { formatUserDateTime } from "../lib/date";
import { theme } from "../theme/theme";
import {
  DISABLE_LINK_COPY,
  LINK_STATE_VOCABULARY,
  SESSION_STATE_VOCABULARY,
  deliveryAttemptLine,
  deliveryErrorLine,
  deliveryPresentation,
  getLatestSessionState,
  intakeChannelLabel,
  intakeModeLabel,
  submissionsLine,
  type IntakeLinkItem,
  type LinkOperationalState,
} from "../product/intake-links";
import { ProovraBadge, ProovraButton, ProovraText } from "./index";

function Fact({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.space.s2 }}>
      <ProovraText variant="label" color={theme.color.ink.muted} style={{ minWidth: 118 }}>{label}</ProovraText>
      <ProovraText variant="bodySm" color={muted ? theme.color.ink.muted : theme.color.ink.primary} style={{ flexShrink: 1 }} selectable>
        {value}
      </ProovraText>
    </View>
  );
}
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={{ gap: theme.space.s1, marginTop: theme.space.s2 }}>
      <ProovraText variant="bodySm" weight="semibold">{title}</ProovraText>
      {children}
    </View>
  );
}
const at = (iso: string | null) => (iso ? formatUserDateTime(iso) : "—");

export function IntakeLinkDetails({
  item,
  onOpenDelivery,
  onOpenSubmissions,
  onArchive,
  archivePending = false,
  onDisable,
}: {
  item: IntakeLinkItem;
  onOpenDelivery: () => void;
  /** DetailsDrawer.tsx:209 — offered only when the link has sessions (rowModel hasSessions). */
  onOpenSubmissions?: (() => void) | null;
  /** DetailsDrawer.tsx:230 — Archive / Restore from archive, in the Access section. */
  onArchive?: (() => void) | null;
  archivePending?: boolean;
  onDisable: (() => void) | null;
}) {
  const d = item.detail;
  const lifecycle = LINK_STATE_VOCABULARY[item.status as LinkOperationalState] ?? LINK_STATE_VOCABULARY.ACTIVE;
  const session = SESSION_STATE_VOCABULARY[getLatestSessionState(d.activity)];
  const delivery = deliveryPresentation(d.delivery);
  const channel = intakeChannelLabel(d.delivery.latestChannel);
  const expired = item.expiresAtUtc ? Date.parse(item.expiresAtUtc) <= Date.now() : false;
  const noRecipient = !d.recipientName && !d.recipientEmail && !d.recipientPhone;
  const errorLine = deliveryErrorLine(d.delivery);

  return (
    <View style={{ gap: theme.space.s1 }} testID="intake-link-details">
      <ProovraText variant="label" color={theme.color.ink.muted} selectable>{`Link ID ${item.id.slice(0, 8)}…`}</ProovraText>
      <Section title="Overview">
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.space.s1 }}>
          <ProovraBadge tone={lifecycle.tone} label={lifecycle.label} />
          <ProovraBadge tone={session.tone} label={session.label} />
        </View>
        <ProovraText variant="label" color={theme.color.ink.secondary}>{lifecycle.explanation}</ProovraText>
        <Fact label="Request" value={`${item.templateName}${d.templateSlug ? ` · ${d.templateSlug}` : ""}`} />
        <Fact label="Link type" value={intakeModeLabel(d.intakeMode)} />
        <Fact label="Customer ID" value={d.customerId ?? "Not set"} muted={!d.customerId} />
        <Fact
          label="Recipient"
          value={noRecipient ? "No recipient" : [d.recipientName, d.recipientEmail, d.recipientPhone].filter(Boolean).join(" · ")}
          muted={noRecipient}
        />
        <Fact label="Channel" value={channel} />
        <Fact label="Submissions used" value={`${item.usedCount} of ${item.maxUses ?? "—"}`} />
        <Fact label="Created" value={at(d.createdAt)} />
        <Fact label={expired ? "Expired" : "Expires"} value={at(item.expiresAtUtc)} />
        {d.revokedAtUtc ? <Fact label="Disabled" value={`${at(d.revokedAtUtc)}${d.revokedReason ? ` · ${d.revokedReason}` : ""}`} /> : null}
        {d.archivedAtUtc ? <Fact label="Archived" value={at(d.archivedAtUtc)} /> : null}
      </Section>

      <Section title="Delivery">
        {d.delivery.attemptCount > 0 ? (
          <>
            <ProovraText variant="label">{`${delivery.label} via ${channel} · ${delivery.explanation}`}</ProovraText>
            <ProovraText variant="label">{deliveryAttemptLine(d.delivery)}</ProovraText>
            {errorLine ? <ProovraText variant="label" color={theme.color.status.risk.fg}>{errorLine}</ProovraText> : null}
            <ProovraButton label="Open delivery history" variant="ghost" fullWidth={false} onPress={onOpenDelivery} />
          </>
        ) : (
          <ProovraText variant="label" color={theme.color.ink.secondary}>Nothing has been sent for this link — it is shared manually.</ProovraText>
        )}
      </Section>

      <Section title="Activity">
        <Fact label="Created" value={at(d.createdAt)} />
        <Fact label="Sent" value={at(d.delivery.latestSentAtUtc ?? d.delivery.latestAtUtc)} />
        <Fact label="Opened" value={at(d.activity.firstOpenedAtUtc)} />
        <Fact label="Upload started" value={at(d.activity.firstStartedAtUtc)} />
        <Fact label="Submitted" value={at(d.activity.firstSubmittedAtUtc)} />
        {d.revokedAtUtc ? <Fact label="Disabled" value={at(d.revokedAtUtc)} /> : null}
        {d.archivedAtUtc ? <Fact label="Archived" value={at(d.archivedAtUtc)} /> : null}
      </Section>

      <Section title="Submissions">
        <ProovraText variant="label">{submissionsLine(d.activity)}</ProovraText>
        {onOpenSubmissions ? <ProovraButton label="View submissions" variant="secondary" fullWidth={false} onPress={onOpenSubmissions} /> : null}
      </Section>

      <Section title="Access">
        <ProovraText variant="label" color={theme.color.ink.secondary}>{DISABLE_LINK_COPY.access}</ProovraText>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.space.s2 }}>
          {onArchive ? (
            <ProovraButton
              label={archivePending ? "Working…" : item.archived ? "Restore from archive" : "Archive"}
              variant="secondary"
              fullWidth={false}
              disabled={archivePending}
              onPress={onArchive}
            />
          ) : null}
          {onDisable ? <ProovraButton label={DISABLE_LINK_COPY.actionLabel} variant="danger" fullWidth={false} onPress={onDisable} /> : null}
        </View>
        {onDisable ? <ProovraText variant="label" color={theme.color.ink.muted}>{DISABLE_LINK_COPY.note}</ProovraText> : null}
      </Section>
    </View>
  );
}
