/**
 * INTAKE LINKS CONSOLE — the touch port of the web list surface
 * (apps/web/app/(app)/intake-links/_components/States.tsx, KpiGrid.tsx,
 * FilterToolbar.tsx, RecordsSurface.tsx RecordCard, Pagination.tsx,
 * SubmissionsDrawer.tsx). Every label, tone and eligibility decision comes
 * from src/product/intake-links.ts; this file only lays them out.
 *
 * Touch adaptations: listboxes are chip rows, the row "Actions" menu is a
 * bottom sheet, and the web's visually-hidden cell captions become
 * accessibility labels.
 */
import React from "react";
import { Pressable, View } from "react-native";

import { formatUserDate, formatUserDateTime } from "../lib/date";
import { describeRelativeTime } from "../lib/relative-time";
import { theme, statusTone } from "../theme/theme";
import type { IntakePurpose } from "../product/intake-create";
import {
  INTAKE_CHANNEL_FILTERS,
  INTAKE_DELIVERY_FILTERS,
  INTAKE_KPIS,
  INTAKE_LIFECYCLE_FILTERS,
  INTAKE_LINKS_COPY as COPY,
  INTAKE_PAGE_SIZES,
  INTAKE_SORTS,
  KPI_OVERLAP_NOTE,
  LINK_STATE_VOCABULARY,
  SESSION_STATE_VOCABULARY,
  canOpenSubmissionEvidence,
  deliveryDetailLine,
  deliveryPresentation,
  expiryStateOf,
  getLatestSessionState,
  intakeChannelLabel,
  intakeModeShortLabel,
  latestActivityIso,
  linkHasSessions,
  submissionContributor,
  submissionSessionDisplay,
  submissionWaitingNote,
  submissionsCell,
  submissionsSummaryLine,
  type IntakeFilterState,
  type IntakeKpiKey,
  type IntakeLinkItem,
  type IntakeSubmission,
  type IntakeTab,
  type LinkOperationalState,
} from "../product/intake-links";
import { ProovraBadge, ProovraButton, ProovraCard, ProovraInput, ProovraText } from "./index";
import { ProovraFilterChips, ProovraKpiGrid } from "./patterns";

/* ------------------------------------------------------------------ States */

/** States.tsx ErrorState / RestrictedState / FeatureUnavailableState: one anatomy, tone + action differ. */
export function IntakeLinksStateCard({
  tone,
  title,
  message,
  onRetry,
  action,
  testID,
}: {
  tone: "risk" | "neutral";
  title: string;
  message: string;
  /** Only the retryable error offers it — a refusal the server will repeat must not. */
  onRetry?: () => void;
  action?: React.ReactNode;
  testID?: string;
}) {
  const c = statusTone(tone);
  return (
    <ProovraCard testID={testID} style={{ borderColor: c.border, alignItems: "center", gap: theme.space.s2 }}>
      <ProovraText variant="h3" weight="semibold" center color={tone === "risk" ? c.fg : theme.color.ink.primary}>
        {title}
      </ProovraText>
      <ProovraText variant="bodySm" center color={theme.color.ink.secondary}>
        {message}
      </ProovraText>
      {onRetry ? <ProovraButton label="Try again" variant="secondary" fullWidth={false} onPress={onRetry} /> : null}
      {action}
    </ProovraCard>
  );
}

/** States.tsx InlineMutationError: WHICH action failed, the safe sentence, and Dismiss. */
export function IntakeLinksMutationError({ action, message, onDismiss }: { action: string; message: string; onDismiss: () => void }) {
  const c = statusTone("risk");
  return (
    <View
      accessibilityRole="alert"
      testID="intake-links-mutation-error"
      style={{ flexDirection: "row", alignItems: "center", gap: theme.space.s2, padding: theme.space.s3, borderRadius: theme.radius.md, borderWidth: 1, borderColor: c.border, backgroundColor: c.bg }}
    >
      <ProovraText variant="bodySm" color={c.fg} style={{ flex: 1 }}>
        {`${action} ${message}`}
      </ProovraText>
      <ProovraButton label="Dismiss" accessibilityLabel="Dismiss error" variant="ghost" fullWidth={false} onPress={onDismiss} />
    </View>
  );
}

/** States.tsx EmptyState: create, plus the quick-start purposes (first six of the catalog). */
export function IntakeLinksEmpty({
  canCreate,
  purposes,
  onCreate,
  onPickPurpose,
}: {
  canCreate: boolean;
  purposes: ReadonlyArray<IntakePurpose>;
  onCreate: () => void;
  onPickPurpose: (slug: string) => void;
}) {
  return (
    <View style={{ gap: theme.space.s3 }} testID="intake-links-empty">
      <ProovraCard style={{ alignItems: "center", gap: theme.space.s2 }}>
        <ProovraText variant="h3" weight="semibold" center>
          {COPY.emptyTitle}
        </ProovraText>
        <ProovraText variant="bodySm" center color={theme.color.ink.secondary}>
          {COPY.emptyBody}
        </ProovraText>
        {canCreate ? <ProovraButton label={COPY.newLink} fullWidth={false} onPress={onCreate} testID="intake-links-empty-create" /> : null}
      </ProovraCard>
      {canCreate ? (
        <ProovraCard style={{ gap: theme.space.s2 }} testID="intake-links-quick-start">
          <ProovraText variant="bodySm" weight="semibold">
            {COPY.quickStartTitle}
          </ProovraText>
          {purposes.slice(0, 6).map((p) => (
            <Pressable
              key={p.slug}
              onPress={() => onPickPurpose(p.slug)}
              accessibilityRole="button"
              accessibilityLabel={`Start from ${p.label}`}
              style={({ pressed }) => ({
                gap: 2,
                padding: theme.space.s3,
                borderRadius: theme.radius.md,
                borderWidth: 1,
                borderColor: theme.color.border.default,
                opacity: pressed ? 0.85 : 1,
              })}
            >
              <ProovraText variant="bodySm" weight="semibold">
                {p.label}
              </ProovraText>
              <ProovraText variant="label" color={theme.color.ink.secondary}>
                {p.description}
              </ProovraText>
            </Pressable>
          ))}
        </ProovraCard>
      ) : null}
    </View>
  );
}

/** States.tsx RefreshingNotice: the list stays, a polite busy line appears above it. */
export function IntakeLinksRefreshing() {
  return (
    <View accessibilityRole="text" accessibilityLiveRegion="polite" testID="intake-links-refreshing">
      <ProovraText variant="label" color={theme.color.ink.secondary}>
        {COPY.refreshing}
      </ProovraText>
    </View>
  );
}

/* --------------------------------------------------------------------- KPIs */

/** KpiGrid.tsx: each card IS a filter; the overlap note says the counts are not a breakdown. */
export function IntakeLinksKpis({
  kpis,
  currentTab,
  onSelect,
}: {
  kpis: Record<IntakeKpiKey, number>;
  currentTab: IntakeTab;
  onSelect: (tab: IntakeTab) => void;
}) {
  return (
    <View style={{ gap: theme.space.s1 }} testID="intake-links-kpis">
      <ProovraKpiGrid
        items={INTAKE_KPIS.map((k) => ({
          key: k.key,
          label: k.label,
          value: String(kpis[k.key]),
          caption: k.explanation,
          tone: k.tone,
          selected: currentTab === k.tab,
          onPress: () => onSelect(k.tab),
        }))}
      />
      <ProovraText variant="label" color={theme.color.ink.muted}>
        {KPI_OVERLAP_NOTE}
      </ProovraText>
    </View>
  );
}

/* ----------------------------------------------------------------- Toolbar */

/** FilterToolbar.tsx: search, channel, lifecycle, delivery state, sort, clear, result bar. */
export function IntakeLinksToolbar({
  search,
  onSearch,
  filters,
  onChange,
  showClear,
  onClear,
  resultSummary,
  pageSummary,
}: {
  search: string;
  onSearch: (v: string) => void;
  filters: IntakeFilterState;
  onChange: (patch: Partial<IntakeFilterState>) => void;
  showClear: boolean;
  onClear: () => void;
  resultSummary: string;
  pageSummary: string | null;
}) {
  return (
    <View style={{ gap: theme.space.s2 }} testID="intake-filters">
      <ProovraInput
        value={search}
        onChangeText={onSearch}
        placeholder="Search by request, recipient, or link id"
        accessibilityLabel="Search intake links"
        autoCapitalize="none"
      />
      <ProovraFilterChips label="Filter by delivery channel" options={INTAKE_CHANNEL_FILTERS} value={filters.channel} onChange={(channel) => onChange({ channel })} />
      <ProovraFilterChips label="Filter by lifecycle" options={INTAKE_LIFECYCLE_FILTERS} value={filters.lifecycle} onChange={(lifecycle) => onChange({ lifecycle })} />
      <ProovraFilterChips label="Filter by delivery state" options={INTAKE_DELIVERY_FILTERS} value={filters.delivery} onChange={(delivery) => onChange({ delivery })} />
      <ProovraFilterChips label="Sort intake links" options={INTAKE_SORTS} value={filters.sort} onChange={(sort) => onChange({ sort })} />
      <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: theme.space.s2 }}>
        <ProovraText variant="label" weight="semibold" color={theme.color.ink.secondary}>
          {resultSummary}
        </ProovraText>
        {pageSummary ? (
          <ProovraText variant="label" color={theme.color.ink.muted}>
            {pageSummary}
          </ProovraText>
        ) : null}
        {showClear ? <ProovraButton label={COPY.clearFilters} variant="secondary" fullWidth={false} onPress={onClear} /> : null}
      </View>
    </View>
  );
}

/* -------------------------------------------------------------- Record card */

function ToneText({ tone, label, accessibilityLabel }: { tone: Parameters<typeof statusTone>[0]; label: string; accessibilityLabel: string }) {
  return (
    <ProovraText variant="label" weight="semibold" color={statusTone(tone).fg} accessibilityLabel={accessibilityLabel}>
      {label}
    </ProovraText>
  );
}

/** RecordsSurface.tsx RecordCard: the same cells the web table renders, stacked. */
export function IntakeLinkRecord({
  item,
  onOpenDetails,
  onOpenSubmissions,
  onOpenDelivery,
  onArchive,
  archivePending,
  onDisable,
  now = Date.now(),
}: {
  item: IntakeLinkItem;
  onOpenDetails: () => void;
  onOpenSubmissions: () => void;
  onOpenDelivery: () => void;
  onArchive: () => void;
  archivePending: boolean;
  /** Null when the link cannot be disabled (archived, or already disabled). */
  onDisable: (() => void) | null;
  now?: number;
}) {
  const hasSessions = linkHasSessions(item);
  const d = item.detail;
  const lifecycle = LINK_STATE_VOCABULARY[item.status as LinkOperationalState] ?? LINK_STATE_VOCABULARY.ACTIVE;
  const activity = SESSION_STATE_VOCABULARY[getLatestSessionState(d.activity)];
  const delivery = deliveryPresentation(d.delivery);
  const channelWire = String(d.delivery.latestChannel ?? "MANUAL").toUpperCase();
  const detail = deliveryDetailLine(d.delivery);
  const latest = latestActivityIso(d);
  const expiry = expiryStateOf(item.expiresAtUtc, now);
  const subs = submissionsCell(d.activity);
  const noRecipient = !d.recipientName && !d.recipientEmail && !d.recipientPhone;
  const maskedNote = d.recipientContactIsMasked ? " (masked)" : "";

  return (
    <ProovraCard testID={`intake-link-row-${item.id}`} style={{ gap: theme.space.s2 }}>
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: theme.space.s2 }}>
        <Pressable
          onPress={onOpenDetails}
          accessibilityRole="button"
          accessibilityLabel={`Open details for ${item.templateName}`}
          style={{ flex: 1, gap: 2 }}
        >
          <ProovraText variant="body" weight="semibold" color={theme.color.accent.a600}>
            {item.templateName}
          </ProovraText>
          <ProovraText variant="label" color={theme.color.ink.muted}>
            {intakeModeShortLabel(d.intakeMode)}
          </ProovraText>
        </Pressable>
        <ProovraBadge tone={lifecycle.tone} label={lifecycle.label} />
      </View>

      {/* Recipient & reference: four independent facts, none standing in for another. */}
      <View style={{ gap: 2 }} accessibilityLabel="Recipient & reference">
        {noRecipient ? (
          <>
            <ProovraText variant="bodySm" color={theme.color.ink.secondary}>No recipient</ProovraText>
            {channelWire === "MANUAL" ? <ProovraText variant="label" color={theme.color.ink.muted}>Manual link</ProovraText> : null}
          </>
        ) : (
          <>
            {d.recipientName ? <ProovraText variant="bodySm" weight="semibold">{d.recipientName}</ProovraText> : null}
            {d.recipientEmail ? (
              <ProovraText variant="label" color={theme.color.ink.secondary} selectable accessibilityLabel={`Email${maskedNote}: ${d.recipientEmail}`}>
                {d.recipientEmail}
              </ProovraText>
            ) : null}
            {d.recipientPhone ? (
              <ProovraText variant="label" color={theme.color.ink.secondary} selectable accessibilityLabel={`Phone${maskedNote}: ${d.recipientPhone}`}>
                {d.recipientPhone}
              </ProovraText>
            ) : null}
          </>
        )}
        {d.customerId ? (
          <ProovraText variant="label" color={theme.color.ink.muted} selectable>
            {`Customer ID · ${d.customerId}`}
          </ProovraText>
        ) : null}
      </View>

      <View style={{ gap: 2 }}>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.space.s2, alignItems: "center" }}>
          <ProovraText variant="label" color={theme.color.ink.secondary}>{intakeChannelLabel(channelWire)}</ProovraText>
          <ToneText tone={delivery.tone} label={delivery.label} accessibilityLabel={`Delivery status: ${delivery.label}`} />
        </View>
        {detail ? <ProovraText variant="label" color={theme.color.ink.muted}>{detail}</ProovraText> : null}
        <ToneText tone={activity.tone} label={activity.label} accessibilityLabel={`Contributor activity: ${activity.label}`} />
        <ProovraText variant="label" color={theme.color.ink.secondary}>
          {`Latest ${latest ? describeRelativeTime(latest, now) : "—"}`}
        </ProovraText>
        <ProovraText
          variant="label"
          color={expiry === "soon" ? theme.color.status.pending.fg : theme.color.ink.secondary}
          accessibilityLabel={item.expiresAtUtc ? `Expires ${formatUserDateTime(item.expiresAtUtc)}` : undefined}
        >
          {`Expires ${item.expiresAtUtc ? formatUserDate(item.expiresAtUtc) : "—"}`}
        </ProovraText>
      </View>

      <View style={{ flexDirection: "row", alignItems: "center", gap: theme.space.s2, flexWrap: "wrap" }}>
        {subs.action === "view" ? (
          <ProovraButton label={subs.label} variant="secondary" fullWidth={false} onPress={onOpenSubmissions} />
        ) : (
          <ProovraText variant="label" color={theme.color.ink.muted}>{subs.label}</ProovraText>
        )}
      </View>

      {/* The web row menu (RecordsSurface.tsx buildActions), laid out as touch targets. */}
      <View
        style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.space.s1, borderTopWidth: 1, borderTopColor: theme.color.border.default, paddingTop: theme.space.s2 }}
        accessibilityLabel={`Actions for ${item.templateName}`}
      >
        <ProovraButton label="View details" accessibilityLabel={`View details: ${item.templateName}`} variant="ghost" fullWidth={false} onPress={onOpenDetails} />
        <ProovraButton label="Delivery history" accessibilityLabel={`Delivery history: ${item.templateName}`} variant="ghost" fullWidth={false} onPress={onOpenDelivery} />
        {hasSessions && subs.action !== "view" ? (
          <ProovraButton label="View submissions" accessibilityLabel={`View submissions: ${item.templateName}`} variant="ghost" fullWidth={false} onPress={onOpenSubmissions} />
        ) : null}
        <ProovraButton
          label={archivePending ? "Working…" : item.archived ? "Restore from archive" : "Archive"}
          accessibilityLabel={`${item.archived ? "Restore from archive" : "Archive"}: ${item.templateName}`}
          variant="ghost"
          fullWidth={false}
          disabled={archivePending}
          onPress={onArchive}
        />
        {onDisable ? (
          <ProovraButton label="Disable link" accessibilityLabel={`Disable link: ${item.templateName}`} variant="danger" fullWidth={false} onPress={onDisable} />
        ) : null}
      </View>
    </ProovraCard>
  );
}

/* --------------------------------------------------------------- Pagination */

/** Pagination.tsx: rows per page + previous / page N of M / next. */
export function IntakeLinksPager({
  page,
  pageCount,
  pageSize,
  onPage,
  onPageSize,
}: {
  page: number;
  pageCount: number;
  pageSize: number;
  onPage: (p: number) => void;
  onPageSize: (s: number) => void;
}) {
  return (
    <View style={{ gap: theme.space.s2 }} testID="intake-links-pagination">
      <ProovraFilterChips
        label={COPY.rowsPerPage}
        options={INTAKE_PAGE_SIZES.map((s) => ({ value: String(s), label: String(s) }))}
        value={String(pageSize)}
        onChange={(v) => onPageSize(Number(v))}
      />
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: theme.space.s2 }}>
        <ProovraButton label="Previous" variant="secondary" fullWidth={false} disabled={page <= 1} onPress={() => onPage(Math.max(1, page - 1))} />
        <ProovraText variant="label" color={theme.color.ink.secondary}>{`Page ${page} of ${pageCount}`}</ProovraText>
        <ProovraButton label="Next" variant="secondary" fullWidth={false} disabled={page >= pageCount} onPress={() => onPage(Math.min(pageCount, page + 1))} />
      </View>
    </View>
  );
}

/* -------------------------------------------------------------- Submissions */

/** SubmissionsDrawer.tsx body: counts line, empty state, numbered sessions. */
export function IntakeLinkSubmissionsList({
  submissions,
  onOpenEvidence,
}: {
  submissions: IntakeSubmission[];
  onOpenEvidence: (evidenceId: string) => void;
}) {
  return (
    <View style={{ gap: theme.space.s2 }}>
      <ProovraText variant="label" color={theme.color.ink.secondary}>{submissionsSummaryLine(submissions)}</ProovraText>
      {submissions.length === 0 ? (
        <ProovraCard style={{ alignItems: "center", gap: theme.space.s1 }}>
          <ProovraText variant="bodySm" weight="semibold" center>{COPY.submissionsEmptyTitle}</ProovraText>
          <ProovraText variant="label" center color={theme.color.ink.secondary}>{COPY.submissionsEmptyBody}</ProovraText>
        </ProovraCard>
      ) : (
        submissions.map((sub, idx) => {
          const st = submissionSessionDisplay(sub.status);
          const waiting = submissionWaitingNote(sub);
          return (
            <ProovraCard key={sub.id} style={{ gap: theme.space.s1 }}>
              <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: theme.space.s2 }}>
                <ProovraText variant="bodySm" weight="semibold">{`Submission #${idx + 1}`}</ProovraText>
                <ProovraBadge tone={st.tone} label={st.label} />
              </View>
              {/* Masked by the server, for everybody; the raw address has one audited route out. */}
              <ProovraText variant="label" color={theme.color.ink.secondary} selectable>
                {`Contributor · ${submissionContributor(sub)}`}
              </ProovraText>
              <ProovraText variant="label" color={theme.color.ink.secondary}>
                {`Opened · ${sub.openedAtIso ? describeRelativeTime(sub.openedAtIso) : "Not opened"}`}
              </ProovraText>
              <ProovraText variant="label" color={theme.color.ink.secondary}>
                {`Submitted · ${sub.submittedAtIso ? describeRelativeTime(sub.submittedAtIso) : "—"}`}
              </ProovraText>
              {canOpenSubmissionEvidence(sub) && sub.evidenceId ? (
                <ProovraButton label="Open evidence" variant="secondary" fullWidth={false} onPress={() => onOpenEvidence(sub.evidenceId as string)} />
              ) : waiting ? (
                <ProovraText variant="label" color={theme.color.ink.muted}>{waiting}</ProovraText>
              ) : null}
            </ProovraCard>
          );
        })
      )}
    </View>
  );
}
