/**
 * CANONICAL NATIVE UI KIT (Phase 2). RN primitives that consume the ONE theme
 * adapter (src/theme) — no hardcoded palette hex, no legacy app-theme glass.
 * This is the forward-canonical set; components/ui.tsx is legacy and is retired
 * in Phase 12 after every screen migrates onto these (Law of One, no mid-flight
 * breakage). Accessibility (roles/labels/44pt targets) and RTL are built in.
 */
import React from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleProp,
  StyleSheet,
  Text,
  TextStyle,
  View,
  ViewStyle,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocale } from "../locale-context";
import { theme, statusTone } from "../theme/theme";
import type { ProovraStatusTone } from "@proovra/ui";

const MIN_TOUCH = 44; // WCAG / platform minimum touch target

/* ------------------------------------------------------------------ Screen */

export function ProovraScreen({
  children,
  scroll = true,
  padded = true,
  footer,
  testID,
}: {
  children: React.ReactNode;
  scroll?: boolean;
  padded?: boolean;
  footer?: React.ReactNode;
  testID?: string;
}) {
  const body = (
    <View style={[padded && styles.screenPadded, styles.screenBody]}>{children}</View>
  );
  return (
    <SafeAreaView style={styles.screen} edges={["top", "left", "right"]} testID={testID}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        {scroll ? (
          <ScrollView
            style={styles.flex}
            contentContainerStyle={styles.scrollContent}
            keyboardShouldPersistTaps="handled"
          >
            {body}
          </ScrollView>
        ) : (
          body
        )}
        {footer ? <View style={styles.footer}>{footer}</View> : null}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

/* -------------------------------------------------------------------- Text */

type TextVariant = "display" | "h1" | "h2" | "h3" | "body" | "bodySm" | "label";

export function ProovraText({
  children,
  variant = "body",
  weight,
  color,
  center,
  mono,
  style,
  numberOfLines,
  accessibilityRole,
}: {
  children: React.ReactNode;
  variant?: TextVariant;
  weight?: keyof typeof theme.type.weight;
  color?: string;
  center?: boolean;
  mono?: boolean;
  style?: StyleProp<TextStyle>;
  numberOfLines?: number;
  accessibilityRole?: "header" | "text";
}) {
  const { fontFamily, fontFamilyBold, isRTL } = useLocale();
  const size = theme.type.size[variant === "bodySm" ? "bodySm" : variant];
  const lineHeight = theme.type.lineHeight[variant === "bodySm" ? "bodySm" : variant];
  const resolvedWeight = weight ?? (variant === "body" || variant === "bodySm" || variant === "label" ? "regular" : "semibold");
  const heavy = resolvedWeight === "semibold" || resolvedWeight === "bold";
  return (
    <Text
      numberOfLines={numberOfLines}
      accessibilityRole={accessibilityRole ?? (variant === "display" || variant === "h1" || variant === "h2" ? "header" : undefined)}
      style={[
        {
          fontSize: size,
          lineHeight,
          fontFamily: mono ? undefined : heavy ? fontFamilyBold : fontFamily,
          fontWeight: theme.type.weight[resolvedWeight],
          color: color ?? theme.color.ink.primary,
          textAlign: center ? "center" : isRTL ? "right" : "left",
          writingDirection: isRTL ? "rtl" : "ltr",
        },
        style,
      ]}
    >
      {children}
    </Text>
  );
}

/* ------------------------------------------------------------ Card/Section */

export function ProovraCard({
  children,
  style,
  onPress,
  accessibilityLabel,
}: {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  onPress?: () => void;
  accessibilityLabel?: string;
}) {
  if (onPress) {
    return (
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        style={({ pressed }) => [styles.card, pressed && styles.pressed, style]}
      >
        {children}
      </Pressable>
    );
  }
  return <View style={[styles.card, style]}>{children}</View>;
}

export function ProovraSection({
  title,
  action,
  children,
}: {
  title?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  const { isRTL } = useLocale();
  return (
    <View style={styles.section}>
      {title ? (
        <View style={[styles.sectionHead, { flexDirection: isRTL ? "row-reverse" : "row" }]}>
          <ProovraText variant="h3" weight="semibold">
            {title}
          </ProovraText>
          {action}
        </View>
      ) : null}
      {children}
    </View>
  );
}

/* ------------------------------------------------------------------ Button */

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

export function ProovraButton({
  label,
  onPress,
  variant = "primary",
  loading = false,
  disabled = false,
  left,
  fullWidth = true,
  testID,
}: {
  label: string;
  onPress?: () => void;
  variant?: ButtonVariant;
  loading?: boolean;
  disabled?: boolean;
  left?: React.ReactNode;
  fullWidth?: boolean;
  testID?: string;
}) {
  const { fontFamilyBold } = useLocale();
  const isDisabled = disabled || loading;
  const palette = buttonPalette(variant);
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      disabled={isDisabled}
      accessibilityRole="button"
      accessibilityState={{ disabled: isDisabled, busy: loading }}
      accessibilityLabel={label}
      style={({ pressed }) => [
        styles.button,
        fullWidth && styles.buttonFull,
        { backgroundColor: palette.bg, borderColor: palette.border },
        pressed && !isDisabled && styles.pressed,
        isDisabled && styles.buttonDisabled,
      ]}
    >
      <View style={styles.buttonInner}>
        {loading ? <ActivityIndicator size="small" color={palette.fg} /> : left}
        <Text style={[styles.buttonLabel, { color: palette.fg, fontFamily: fontFamilyBold }]}>{label}</Text>
      </View>
    </Pressable>
  );
}

function buttonPalette(variant: ButtonVariant): { bg: string; fg: string; border: string } {
  switch (variant) {
    case "primary":
      return { bg: theme.color.accent.a500, fg: theme.color.ink.inverse, border: theme.color.accent.a500 };
    case "danger":
      return { bg: theme.color.semantic.error, fg: theme.color.ink.inverse, border: theme.color.semantic.error };
    case "ghost":
      return { bg: "transparent", fg: theme.color.accent.a600, border: "transparent" };
    case "secondary":
    default:
      return { bg: theme.color.surface.card, fg: theme.color.ink.primary, border: theme.color.border.strong };
  }
}

/* ---------------------------------------------------------- Badge / Status */

export function ProovraBadge({ label, tone = "neutral" }: { label: string; tone?: ProovraStatusTone }) {
  const { fontFamilyBold } = useLocale();
  const c = statusTone(tone);
  return (
    <View
      accessibilityRole="text"
      accessibilityLabel={label}
      style={[styles.badge, { backgroundColor: c.bg, borderColor: c.border }]}
    >
      <View style={[styles.badgeDot, { backgroundColor: c.solid }]} />
      <Text style={[styles.badgeText, { color: c.fg, fontFamily: fontFamilyBold }]}>{label}</Text>
    </View>
  );
}

/* ---------------------------------------------------------------- List row */

export function ProovraListRow({
  title,
  subtitle,
  trailing,
  onPress,
  testID,
}: {
  title: string;
  subtitle?: string;
  trailing?: React.ReactNode;
  onPress?: () => void;
  testID?: string;
}) {
  const { isRTL } = useLocale();
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      accessibilityRole={onPress ? "button" : undefined}
      accessibilityLabel={title}
      style={({ pressed }) => [styles.row, pressed && onPress && styles.pressed]}
    >
      <View style={[styles.rowInner, { flexDirection: isRTL ? "row-reverse" : "row" }]}>
        <View style={styles.rowText}>
          <ProovraText variant="body" weight="semibold" numberOfLines={1}>
            {title}
          </ProovraText>
          {subtitle ? (
            <ProovraText variant="bodySm" color={theme.color.ink.secondary} numberOfLines={1}>
              {subtitle}
            </ProovraText>
          ) : null}
        </View>
        {trailing}
      </View>
    </Pressable>
  );
}

/* ----------------------------------------------------- Empty/Error/Loading */

export function ProovraLoadingState({ label }: { label?: string }) {
  return (
    <View style={styles.stateCenter} accessibilityRole="progressbar" accessibilityLabel={label ?? "Loading"}>
      <ActivityIndicator color={theme.color.accent.a500} />
      {label ? (
        <ProovraText variant="bodySm" color={theme.color.ink.muted} center style={styles.stateGap}>
          {label}
        </ProovraText>
      ) : null}
    </View>
  );
}

export function ProovraEmptyState({
  title,
  message,
  action,
}: {
  title: string;
  message?: string;
  action?: React.ReactNode;
}) {
  return (
    <View style={styles.stateCenter}>
      <ProovraText variant="h3" weight="semibold" center>
        {title}
      </ProovraText>
      {message ? (
        <ProovraText variant="bodySm" color={theme.color.ink.secondary} center style={styles.stateGap}>
          {message}
        </ProovraText>
      ) : null}
      {action ? <View style={styles.stateGap}>{action}</View> : null}
    </View>
  );
}

export function ProovraErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <View style={styles.stateCenter}>
      <View style={[styles.badge, { backgroundColor: theme.color.status.risk.bg, borderColor: theme.color.status.risk.border }]}>
        <ProovraText variant="label" color={theme.color.status.risk.fg} weight="semibold">
          Something went wrong
        </ProovraText>
      </View>
      <ProovraText variant="bodySm" color={theme.color.ink.secondary} center style={styles.stateGap}>
        {message}
      </ProovraText>
      {onRetry ? (
        <View style={styles.stateGap}>
          <ProovraButton label="Try again" variant="secondary" fullWidth={false} onPress={onRetry} />
        </View>
      ) : null}
    </View>
  );
}

/* ----------------------------------------------------------------- Styles */

const styles = StyleSheet.create({
  flex: { flex: 1 },
  screen: { flex: 1, backgroundColor: theme.color.surface.app },
  screenBody: { flex: 1 },
  screenPadded: { paddingHorizontal: theme.space.s4 },
  scrollContent: { paddingBottom: theme.space.s10, flexGrow: 1 },
  footer: {
    paddingHorizontal: theme.space.s4,
    paddingVertical: theme.space.s3,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.color.border.default,
    backgroundColor: theme.color.surface.card,
  },
  card: {
    backgroundColor: theme.color.surface.card,
    borderRadius: theme.radius.card,
    padding: theme.space.s5,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.border.default,
    ...theme.elevation.card,
  },
  pressed: { opacity: 0.94 },
  section: { marginBottom: theme.space.s6 },
  sectionHead: { alignItems: "center", justifyContent: "space-between", marginBottom: theme.space.s3 },
  button: {
    minHeight: MIN_TOUCH,
    paddingVertical: theme.space.s3,
    paddingHorizontal: theme.space.s5,
    borderRadius: theme.radius.pill,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  buttonFull: { alignSelf: "stretch" },
  buttonDisabled: { opacity: 0.5 },
  buttonInner: { flexDirection: "row", alignItems: "center", gap: theme.space.s2 },
  buttonLabel: { fontSize: theme.type.size.body, fontWeight: "600" },
  badge: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space.s2,
    paddingVertical: 6,
    paddingHorizontal: theme.space.s3,
    borderRadius: theme.radius.pill,
    borderWidth: 1,
    alignSelf: "flex-start",
  },
  badgeDot: { width: 8, height: 8, borderRadius: 4 },
  badgeText: { fontSize: theme.type.size.label },
  row: { minHeight: MIN_TOUCH, paddingVertical: theme.space.s3 },
  rowInner: { alignItems: "center", gap: theme.space.s3 },
  rowText: { flex: 1, gap: 2 },
  stateCenter: { alignItems: "center", justifyContent: "center", paddingVertical: theme.space.s10 },
  stateGap: { marginTop: theme.space.s3 },
});
