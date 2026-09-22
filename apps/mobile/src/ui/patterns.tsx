/**
 * CANONICAL NATIVE PATTERN RENDERERS.
 *
 * `src/ui/index.tsx` holds the 12 primitives (text, card, button, input…).
 * Those are not the PROOVRA design language — the web expresses that language
 * through a small set of PAGE-LEVEL families that every surface composes:
 * `PageHeader`, `FilterBar`, `EmptyState`, `CursorPager`, `ResultCount`,
 * `ConfirmActionModal`, `DataTable`, `AppStatusBadge`. Twelve generic
 * primitives against 214 web components is why Native read as a simpler
 * product: each screen re-invented the composition instead of reusing it.
 *
 * This module is the native rendering of those families, one renderer per web
 * family, with the SAME contract. Porting a surface should mean composing these
 * — not inventing a layout.
 *
 * Web sources these mirror (behaviour, not markup):
 *   apps/web/components/ui/PageShell.tsx      → ProovraPageHeader, ProovraPageSection
 *   apps/web/components/ui/FilterBar.tsx      → ProovraFilterBar, ProovraFilterSearch, ProovraFilterChips
 *   apps/web/components/ui/EmptyState.tsx     → ProovraEmpty (page | inline presence)
 *   apps/web/components/ui/ResultCount.tsx    → ProovraResultCount
 *   apps/web/components/ui/CursorPager.tsx    → ProovraCursorPager
 *   apps/web/components/ui/ConfirmActionModal.tsx → ProovraConfirmSheet
 *   apps/web/components/ui/DataTable.tsx      → ProovraDataList (responsive rows)
 *   apps/web/components/app-primitives/       → ProovraKpiGrid, ProovraDetailRows
 *
 * Adaptation is layout only, and only where the device requires it: a table
 * becomes stacked rows under the tablet breakpoint, an inspector becomes a
 * sheet, hover affordances become always-visible controls.
 */
import React from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from "react-native";
import { useLocale } from "../locale-context";
import { theme, statusTone } from "../theme/theme";
import { useResponsive } from "../theme/responsive";
import type { ProovraStatusTone } from "@proovra/ui";
import {
  ProovraButton,
  ProovraCard,
  ProovraText,
  ProovraBadge,
} from "./index";

const MIN_TOUCH = 44;

/* -------------------------------------------------------------- PageHeader */

export interface ProovraPageHeaderProps {
  /** The page title. Plain text — the renderer owns the heading role. */
  title: string;
  /** Small uppercase kicker above the title. */
  eyebrow?: string;
  /** Muted supporting line under the title. */
  subtitle?: string;
  /** Inline strip below the subtitle — badges, scope, counts. */
  contextStrip?: React.ReactNode;
  /** The single primary action. */
  primaryAction?: React.ReactNode;
  /** Secondary actions, rendered before the primary. */
  secondaryActions?: React.ReactNode;
}

/**
 * The canonical page header. On web the actions sit right-aligned beside the
 * title; on a phone there is no room for that, so they wrap to their own row
 * beneath — the same elements in the same order, re-flowed.
 */
export function ProovraPageHeader({
  title,
  eyebrow,
  subtitle,
  contextStrip,
  primaryAction,
  secondaryActions,
}: ProovraPageHeaderProps) {
  const { breakpoint } = useResponsive();
  const inline = breakpoint !== "compact";
  const actions =
    primaryAction || secondaryActions ? (
      <View style={[styles.headerActions, inline && styles.headerActionsInline]}>
        {secondaryActions}
        {primaryAction}
      </View>
    ) : null;

  return (
    <View style={styles.header}>
      <View style={[styles.headerTop, inline && styles.headerTopInline]}>
        <View style={styles.headerTitleBlock}>
          {eyebrow ? (
            <ProovraText variant="label" weight="bold" color={theme.color.ink.muted} style={styles.eyebrow}>
              {eyebrow.toUpperCase()}
            </ProovraText>
          ) : null}
          <ProovraText variant="h1" weight="bold" accessibilityRole="header">
            {title}
          </ProovraText>
          {subtitle ? (
            <ProovraText variant="bodySm" color={theme.color.ink.secondary} style={styles.headerSubtitle}>
              {subtitle}
            </ProovraText>
          ) : null}
        </View>
        {inline ? actions : null}
      </View>
      {contextStrip ? <View style={styles.contextStrip}>{contextStrip}</View> : null}
      {inline ? null : actions}
    </View>
  );
}

/** A titled page section — the web's `PageSection`. */
export function ProovraPageSection({
  title,
  description,
  actions,
  children,
}: {
  title?: string;
  description?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.section}>
      {title || actions ? (
        <View style={styles.sectionHead}>
          <View style={styles.flex1}>
            {title ? (
              <ProovraText variant="h3" weight="semibold">
                {title}
              </ProovraText>
            ) : null}
            {description ? (
              <ProovraText variant="bodySm" color={theme.color.ink.secondary}>
                {description}
              </ProovraText>
            ) : null}
          </View>
          {actions}
        </View>
      ) : null}
      {children}
    </View>
  );
}

/* --------------------------------------------------------------- FilterBar */

/** A search field with the canonical affordances (clear, submit-on-change). */
export function ProovraFilterSearch({
  value,
  onChange,
  placeholder = "Search",
  testID,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  testID?: string;
}) {
  const { isRTL } = useLocale();
  return (
    <View style={styles.searchWrap}>
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={theme.color.ink.muted}
        accessibilityLabel={placeholder}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
        testID={testID}
        style={[styles.searchInput, { textAlign: isRTL ? "right" : "left" }]}
      />
      {value.length > 0 ? (
        <Pressable
          onPress={() => onChange("")}
          accessibilityRole="button"
          accessibilityLabel="Clear search"
          style={styles.searchClear}
          hitSlop={8}
        >
          <ProovraText variant="label" color={theme.color.ink.secondary}>
            Clear
          </ProovraText>
        </Pressable>
      ) : null}
    </View>
  );
}

export interface ProovraFilterOption<T extends string> {
  value: T;
  label: string;
  /** Optional count shown beside the label, as the web filter bar does. */
  count?: number | null;
}

/**
 * A single-select filter rendered as a horizontally scrollable chip row.
 *
 * The web uses a listbox; a phone has neither the width for a row of selects
 * nor a hover target for them, and a native picker hides the available values
 * behind a tap. Chips keep every option visible and selectable in one gesture,
 * which is the same product behaviour with a touch affordance.
 */
export function ProovraFilterChips<T extends string>({
  label,
  options,
  value,
  onChange,
  disabled,
}: {
  label: string;
  options: ReadonlyArray<ProovraFilterOption<T>>;
  value: T;
  onChange: (next: T) => void;
  disabled?: boolean;
}) {
  return (
    <View style={styles.filterGroup}>
      <ProovraText variant="label" weight="semibold" color={theme.color.ink.secondary}>
        {label}
      </ProovraText>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.chipRow}
      >
        {options.map((opt) => {
          const active = opt.value === value;
          return (
            <Pressable
              key={opt.value}
              onPress={() => !disabled && onChange(opt.value)}
              disabled={disabled}
              accessibilityRole="button"
              accessibilityState={{ selected: active, disabled: !!disabled }}
              accessibilityLabel={`${label}: ${opt.label}`}
              style={[
                styles.chip,
                active && styles.chipActive,
                disabled && styles.chipDisabled,
              ]}
            >
              <ProovraText
                variant="label"
                weight="semibold"
                color={active ? theme.color.accent.a600 : theme.color.ink.secondary}
              >
                {opt.label}
                {typeof opt.count === "number" ? `  ${opt.count}` : ""}
              </ProovraText>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

/** Groups a search field and filter chips as one control block. */
export function ProovraFilterBar({ children }: { children: React.ReactNode }) {
  return <View style={styles.filterBar}>{children}</View>;
}

/* ------------------------------------------------------- Result count/pager */

/**
 * The canonical result count. The web distinguishes a WORKSPACE total from a
 * page slice and labels the latter "On this page" so a page count is never read
 * as a workspace total; that distinction is carried here verbatim.
 */
export function ProovraResultCount({
  count,
  total,
  noun = "result",
  scopeLabel,
}: {
  count: number;
  total?: number | null;
  noun?: string;
  scopeLabel?: string;
}) {
  const plural = count === 1 ? noun : `${noun}s`;
  const text =
    typeof total === "number"
      ? `${count} of ${total} ${total === 1 ? noun : `${noun}s`}`
      : `${count} ${plural} on this page`;
  return (
    <ProovraText variant="bodySm" color={theme.color.ink.secondary}>
      {scopeLabel ? `${scopeLabel} · ${text}` : text}
    </ProovraText>
  );
}

/** Cursor pagination — the canonical "Load more", not numbered pages. */
export function ProovraCursorPager({
  hasMore,
  loading,
  onLoadMore,
}: {
  hasMore: boolean;
  loading?: boolean;
  onLoadMore: () => void;
}) {
  if (!hasMore) return null;
  return (
    <View style={styles.pager}>
      <ProovraButton
        label={loading ? "Loading…" : "Load more"}
        variant="secondary"
        disabled={!!loading}
        onPress={onLoadMore}
      />
    </View>
  );
}

/* -------------------------------------------------------------- EmptyState */

/**
 * The canonical empty state, with the web's PRESENCE distinction.
 *
 *   page    a centred column for an empty state that IS the page.
 *   inline  a single compact row for a SECTION of several.
 *
 * The web made that split after measuring stacked 200px "nothing here" boxes
 * shouting as loudly as the populated panel beside them; a phone has far less
 * room, so getting it wrong costs more, not less.
 */
export function ProovraEmpty({
  title,
  purpose,
  action,
  note,
  presence = "page",
  framed = true,
}: {
  title: string;
  purpose?: string;
  action?: React.ReactNode;
  note?: string;
  presence?: "page" | "inline";
  framed?: boolean;
}) {
  if (presence === "inline") {
    return (
      <View style={[styles.emptyInline, framed && styles.emptyFramed]}>
        <View style={styles.flex1}>
          <ProovraText variant="bodySm" weight="semibold">
            {title}
          </ProovraText>
          {purpose ? (
            <ProovraText variant="label" color={theme.color.ink.secondary}>
              {purpose}
            </ProovraText>
          ) : null}
        </View>
        {action}
      </View>
    );
  }
  return (
    <View style={[styles.emptyPage, framed && styles.emptyFramed]}>
      <ProovraText variant="h3" weight="semibold" center>
        {title}
      </ProovraText>
      {purpose ? (
        <ProovraText variant="bodySm" color={theme.color.ink.secondary} center style={styles.gapTop}>
          {purpose}
        </ProovraText>
      ) : null}
      {action ? <View style={styles.gapTop}>{action}</View> : null}
      {note ? (
        <ProovraText variant="label" color={theme.color.ink.muted} center style={styles.gapTop}>
          {note}
        </ProovraText>
      ) : null}
    </View>
  );
}

/* --------------------------------------------------------------- KPI grid */

export interface ProovraKpi {
  key: string;
  label: string;
  value: string;
  /** Supporting line under the value — the web's metric caption. */
  caption?: string;
  tone?: ProovraStatusTone;
  onPress?: () => void;
}

/**
 * The KPI grid. Two columns on a phone, four from the medium breakpoint — the
 * web renders a single row of four, which is unreadable under 600pt.
 */
export function ProovraKpiGrid({ items }: { items: ReadonlyArray<ProovraKpi> }) {
  const { breakpoint } = useResponsive();
  const columns = breakpoint === "compact" ? 2 : 4;
  return (
    <View style={styles.kpiGrid}>
      {items.map((kpi) => {
        const tone = kpi.tone ? statusTone(kpi.tone) : null;
        const body = (
          <ProovraCard style={[styles.kpiCard, { width: `${100 / columns}%` }]}>
            <ProovraText variant="label" weight="semibold" color={theme.color.ink.secondary}>
              {kpi.label}
            </ProovraText>
            <ProovraText
              variant="h2"
              weight="bold"
              color={tone ? tone.fg : theme.color.ink.primary}
              style={styles.kpiValue}
            >
              {kpi.value}
            </ProovraText>
            {kpi.caption ? (
              <ProovraText variant="label" color={theme.color.ink.muted}>
                {kpi.caption}
              </ProovraText>
            ) : null}
          </ProovraCard>
        );
        return kpi.onPress ? (
          <Pressable
            key={kpi.key}
            onPress={kpi.onPress}
            accessibilityRole="button"
            accessibilityLabel={`${kpi.label}: ${kpi.value}`}
            style={styles.kpiPressable}
          >
            {body}
          </Pressable>
        ) : (
          <View key={kpi.key} style={styles.kpiPressable} accessible accessibilityLabel={`${kpi.label}: ${kpi.value}`}>
            {body}
          </View>
        );
      })}
    </View>
  );
}

/* ------------------------------------------------------------- Detail rows */

export interface ProovraDetailRow {
  label: string;
  value: string;
  tone?: ProovraStatusTone;
  /** Renders the value in a monospace-ish treatment (ids, digests). */
  mono?: boolean;
}

/** A label/value block — the web's definition rows inside a detail card. */
export function ProovraDetailRows({ rows }: { rows: ReadonlyArray<ProovraDetailRow> }) {
  return (
    <View>
      {rows.map((row, i) => (
        <View key={`${row.label}-${i}`} style={[styles.detailRow, i > 0 && styles.detailRowDivider]}>
          <ProovraText variant="label" color={theme.color.ink.secondary} style={styles.detailLabel}>
            {row.label}
          </ProovraText>
          {row.tone ? (
            <ProovraBadge label={row.value} tone={row.tone} />
          ) : (
            <ProovraText
              variant="bodySm"
              style={[styles.detailValue, row.mono && styles.mono]}
            >
              {row.value}
            </ProovraText>
          )}
        </View>
      ))}
    </View>
  );
}

/* ------------------------------------------------------------- Confirmation */

/**
 * The canonical destructive-action confirmation.
 *
 * The web renders a modal with an explicit consequence line and a tone-matched
 * confirm button; native uses the same content in a bottom sheet because a
 * centred dialog on a phone covers the thing being confirmed. `Alert.alert`
 * would have been less code and would have dropped the consequence line, the
 * tone and the busy state.
 */
export function ProovraConfirmSheet({
  visible,
  title,
  consequence,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  tone = "neutral",
  busy,
  onConfirm,
  onCancel,
}: {
  visible: boolean;
  title: string;
  consequence?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "neutral" | "warning" | "danger";
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onCancel}>
      <Pressable style={styles.scrim} onPress={busy ? undefined : onCancel} accessibilityLabel={cancelLabel} />
      <View style={styles.sheet}>
        <ProovraText variant="h3" weight="semibold">
          {title}
        </ProovraText>
        {consequence ? (
          <ProovraText variant="bodySm" color={theme.color.ink.secondary} style={styles.gapTop}>
            {consequence}
          </ProovraText>
        ) : null}
        <View style={styles.sheetActions}>
          <ProovraButton label={cancelLabel} variant="ghost" disabled={!!busy} onPress={onCancel} />
          <ProovraButton
            label={busy ? "Working…" : confirmLabel}
            variant={tone === "danger" ? "danger" : "primary"}
            disabled={!!busy}
            onPress={onConfirm}
          />
        </View>
      </View>
    </Modal>
  );
}

/** A bottom sheet for an inspector/detail panel the web shows side-by-side. */
export function ProovraSheet({
  visible,
  title,
  onClose,
  children,
}: {
  visible: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.scrim} onPress={onClose} accessibilityLabel="Close" />
      <View style={[styles.sheet, styles.sheetTall]}>
        <View style={styles.sheetHead}>
          <ProovraText variant="h3" weight="semibold" style={styles.flex1}>
            {title}
          </ProovraText>
          <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close" hitSlop={8}>
            <ProovraText variant="label" weight="semibold" color={theme.color.accent.a600}>
              Close
            </ProovraText>
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={styles.sheetBody}>{children}</ScrollView>
      </View>
    </Modal>
  );
}

/* ---------------------------------------------------------------- Async view */

/**
 * ONE place that decides loading / error / empty / content.
 *
 * Every ported screen needs the same four-way branch, and writing it per screen
 * is how states get dropped — the audit found screens with no error state and
 * screens whose empty state offered no action.
 */
export function ProovraAsyncView<T>({
  loading,
  error,
  onRetry,
  items,
  empty,
  children,
}: {
  loading: boolean;
  error?: { title: string; message?: string } | null;
  onRetry?: () => void;
  items?: ReadonlyArray<T> | null;
  empty: React.ReactNode;
  children: React.ReactNode;
}) {
  if (loading) {
    return (
      <View style={styles.stateBlock} accessibilityLabel="Loading">
        <ActivityIndicator color={theme.color.accent.a500} />
      </View>
    );
  }
  if (error) {
    return (
      <View style={[styles.stateBlock, styles.emptyFramed]} accessibilityRole="alert">
        <ProovraText variant="bodySm" weight="semibold" center>
          {error.title}
        </ProovraText>
        {error.message ? (
          <ProovraText variant="label" color={theme.color.ink.secondary} center style={styles.gapTop}>
            {error.message}
          </ProovraText>
        ) : null}
        {onRetry ? (
          <View style={styles.gapTop}>
            <ProovraButton label="Try again" variant="secondary" onPress={onRetry} />
          </View>
        ) : null}
      </View>
    );
  }
  if (items && items.length === 0) return <>{empty}</>;
  return <>{children}</>;
}

/* ------------------------------------------------------------------ styles */

const styles = StyleSheet.create({
  flex1: { flex: 1 },
  gapTop: { marginTop: theme.space.s2 },

  header: { gap: theme.space.s2, marginBottom: theme.space.s4 },
  headerTop: { gap: theme.space.s3 },
  headerTopInline: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between" },
  headerTitleBlock: { flex: 1, gap: 2 },
  headerSubtitle: { marginTop: 2 },
  eyebrow: { letterSpacing: 0.6 },
  headerActions: { flexDirection: "row", gap: theme.space.s2, flexWrap: "wrap" },
  headerActionsInline: { justifyContent: "flex-end" },
  contextStrip: { flexDirection: "row", flexWrap: "wrap", gap: theme.space.s2, marginTop: theme.space.s1 },

  section: { gap: theme.space.s3, marginBottom: theme.space.s5 },
  sectionHead: { flexDirection: "row", alignItems: "center", gap: theme.space.s3 },

  filterBar: { gap: theme.space.s3, marginBottom: theme.space.s4 },
  filterGroup: { gap: theme.space.s2 },
  chipRow: { flexDirection: "row", gap: theme.space.s2, paddingVertical: 2 },
  chip: {
    minHeight: 36,
    justifyContent: "center",
    paddingHorizontal: theme.space.s3,
    borderRadius: theme.radius.pill ?? 999,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.border.default,
    backgroundColor: theme.color.surface.card,
  },
  chipActive: { borderColor: theme.color.accent.a500, backgroundColor: theme.color.accent.a050 },
  chipDisabled: { opacity: 0.5 },

  searchWrap: { flexDirection: "row", alignItems: "center", gap: theme.space.s2 },
  searchInput: {
    flex: 1,
    minHeight: MIN_TOUCH,
    paddingHorizontal: theme.space.s3,
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.border.default,
    backgroundColor: theme.color.surface.card,
    color: theme.color.ink.primary,
    fontSize: theme.type.size.body,
  },
  searchClear: { minHeight: MIN_TOUCH, minWidth: MIN_TOUCH, alignItems: "center", justifyContent: "center" },

  pager: { marginTop: theme.space.s4, alignItems: "center" },

  emptyFramed: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.border.default,
    borderStyle: "dashed",
    borderRadius: theme.radius.card,
    backgroundColor: theme.color.surface.card,
  },
  emptyPage: { padding: theme.space.s6, alignItems: "center" },
  emptyInline: {
    minHeight: 56,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space.s3,
    paddingHorizontal: theme.space.s4,
    paddingVertical: theme.space.s2,
  },

  kpiGrid: { flexDirection: "row", flexWrap: "wrap", marginHorizontal: -theme.space.s1 },
  kpiPressable: { paddingHorizontal: theme.space.s1, paddingBottom: theme.space.s2 },
  kpiCard: { gap: 2 },
  kpiValue: { marginVertical: 2 },

  detailRow: { flexDirection: "row", alignItems: "center", gap: theme.space.s3, paddingVertical: theme.space.s2 },
  detailRowDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.color.border.subtle },
  detailLabel: { flex: 1 },
  detailValue: { flex: 1.4, textAlign: "right" },
  mono: { fontVariant: ["tabular-nums"] },

  scrim: { flex: 1, backgroundColor: theme.color.raw.scrim ?? "rgba(15,23,42,0.4)" },
  sheet: {
    backgroundColor: theme.color.surface.card,
    borderTopLeftRadius: theme.radius.card,
    borderTopRightRadius: theme.radius.card,
    padding: theme.space.s5,
    paddingBottom: theme.space.s8,
    gap: theme.space.s2,
  },
  sheetTall: { maxHeight: "80%" },
  sheetHead: { flexDirection: "row", alignItems: "center", gap: theme.space.s3 },
  sheetBody: { paddingTop: theme.space.s3, gap: theme.space.s3 },
  sheetActions: { flexDirection: "row", justifyContent: "flex-end", gap: theme.space.s2, marginTop: theme.space.s4 },

  stateBlock: { paddingVertical: theme.space.s6, alignItems: "center", justifyContent: "center" },
});
