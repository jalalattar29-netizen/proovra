/**
 * CANONICAL NATIVE UI KIT (Phase 2). RN primitives that consume the ONE theme
 * adapter (src/theme) — no hardcoded palette hex, no legacy app-theme glass.
 * This is the forward-canonical set; components/ui.tsx is legacy and is retired
 * in Phase 12 after every screen migrates onto these (Law of One, no mid-flight
 * breakage). Accessibility (roles/labels/44pt targets) and RTL are built in.
 */
import React from "react";
import * as Clipboard from "expo-clipboard";
import { AUTH_SURFACE, AuthBackdrop, SHELL_SURFACE, useSurfaceKind } from "./shell-surface";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  KeyboardTypeOptions,
  Platform,
  Pressable,
  ScrollView,
  StyleProp,
  StyleSheet,
  Text,
  TextInput,
  TextStyle,
  View,
  ViewStyle,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { useLocale } from "../locale-context";
import { theme, statusTone } from "../theme/theme";
import { useResponsive, FORM_MAX_WIDTH } from "../theme/responsive";
import type { ProovraStatusTone } from "@proovra/ui";

export * from "./shell";
import { ProovraShell } from "./shell";
export * from "./patterns";

const MIN_TOUCH = 44; // WCAG / platform minimum touch target

/* ------------------------------------------------------------------ Screen */

export function ProovraScreen({
  children,
  scroll = true,
  padded = true,
  footer,
  width = "content",
  testID,
  shell = false,
  backdrop,
}: {
  /**
   * "auth" paints the web auth hero behind the screen (NEW:VIS-AUTH-HERO):
   * login, register, reset-password, forgot-password and verify-email.
   */
  backdrop?: "auth";
  children: React.ReactNode;
  /**
   * Render inside the app shell: header, navigation and the shell gates.
   *
   * RC-10: every authenticated stack screen (Reports, Billing, Search, Intake
   * links, case and evidence detail, ...) rendered OUTSIDE the shell, so picking
   * Reports from the tablet rail made the rail and the header disappear, and
   * the workspace-recovery and Personal-Space gates never ran there. The web
   * wraps every authenticated route in AppShellV2. Opt-in, because auth,
   * public token flows and full-screen capture must NOT carry the chrome.
   */
  shell?: boolean;
  scroll?: boolean;
  padded?: boolean;
  footer?: React.ReactNode;
  /**
   * Clamp for the readable column on tablet widths. "content" is the canonical
   * readable measure (720); "form" is the tighter single-column measure (480)
   * for auth/create/reset. Phones (compact) always render full-bleed.
   */
  width?: "content" | "form";
  testID?: string;
}) {
  const { breakpoint, contentMaxWidth } = useResponsive();
  // ONE canonical clamp: phones stay full-bleed; tablets center a readable
  // column so stack/auth/detail surfaces never stretch edge-to-edge (M4).
  const clamp = breakpoint !== "compact";
  const maxWidth = width === "form" ? FORM_MAX_WIDTH : contentMaxWidth;
  const inner = (
    <View style={[padded && styles.screenPadded, styles.screenBody, clamp && { width: "100%", maxWidth }]}>
      {children}
    </View>
  );
  const body = clamp ? <View style={styles.centerColumn}>{inner}</View> : inner;
  const footerNode = footer ? (
    <View style={styles.footer}>
      <View style={clamp ? { width: "100%", maxWidth, alignSelf: "center" } : undefined}>{footer}</View>
    </View>
  ) : null;
  if (shell) {
    return (
      <ProovraShell layout="bare" scroll={scroll} footer={footerNode}>
        <View style={styles.flex} testID={testID}>
          {body}
        </View>
      </ProovraShell>
    );
  }
  const screen = (
    <SafeAreaView style={[styles.screen, backdrop && styles.screenOnArtwork]} edges={["top", "left", "right"]} testID={testID}>
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
        {footerNode}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
  return backdrop === "auth" ? <AuthBackdrop>{screen}</AuthBackdrop> : screen;
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
  selectable,
  accessibilityRole,
  accessibilityLabel,
  onPress,
  testID,
}: {
  children: React.ReactNode;
  variant?: TextVariant;
  weight?: keyof typeof theme.type.weight;
  color?: string;
  center?: boolean;
  mono?: boolean;
  style?: StyleProp<TextStyle>;
  numberOfLines?: number;
  /**
   * Text the reader has to be able to take with them — a TOTP setup key, a
   * recovery code, a request id in an error. Text is NOT selectable by default
   * on Android, so a value that only exists once would otherwise be trapped on
   * the screen it was shown on.
   */
  selectable?: boolean;
  accessibilityRole?: "header" | "text" | "link";
  accessibilityLabel?: string;
  /**
   * A tap target on the text itself. Present for INLINE links — a link inside
   * a paragraph cannot be a Pressable without breaking the text flow, and
   * legal documents are full of them. Block-level actions still belong to
   * ProovraButton / ProovraListRow.
   */
  onPress?: () => void;
  testID?: string;
}) {
  const { fontFamily, fontFamilyBold, isRTL } = useLocale();
  const size = theme.type.size[variant === "bodySm" ? "bodySm" : variant];
  const lineHeight = theme.type.lineHeight[variant === "bodySm" ? "bodySm" : variant];
  const resolvedWeight = weight ?? (variant === "body" || variant === "bodySm" || variant === "label" ? "regular" : "semibold");
  const heavy = resolvedWeight === "semibold" || resolvedWeight === "bold";
  return (
    <Text
      testID={testID}
      numberOfLines={numberOfLines}
      selectable={selectable}
      onPress={onPress}
      accessibilityLabel={accessibilityLabel}
      accessibilityRole={
        accessibilityRole ??
        (onPress
          ? "link"
          : variant === "display" || variant === "h1" || variant === "h2"
            ? "header"
            : undefined)
      }
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
  testID,
}: {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  onPress?: () => void;
  accessibilityLabel?: string;
  testID?: string;
}) {
  // Over the shell artwork the web re-scopes cards to 92% white (app-shell-v2.css:611);
  // over the auth hero the card is the web glass card (login/page.tsx:759-764).
  const kind = useSurfaceKind();
  const surface = kind === "shell" ? { backgroundColor: SHELL_SURFACE.card } : kind === "auth" ? AUTH_SURFACE.card : null;
  if (onPress) {
    return (
      <Pressable
        testID={testID}
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        style={({ pressed }) => [styles.card, surface, pressed && styles.pressed, style]}
      >
        {children}
      </Pressable>
    );
  }
  return <View testID={testID} style={[styles.card, surface, style]}>{children}</View>;
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
  accessibilityLabel,
}: {
  label: string;
  onPress?: () => void;
  variant?: ButtonVariant;
  loading?: boolean;
  disabled?: boolean;
  left?: React.ReactNode;
  fullWidth?: boolean;
  testID?: string;
  /** A fuller name than the visible label, as the web sets aria-label (e.g. "View billing and upgrade options"). */
  accessibilityLabel?: string;
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
      accessibilityLabel={accessibilityLabel ?? label}
      style={({ pressed }) => [
        styles.button,
        fullWidth && styles.buttonFull,
        { backgroundColor: palette.bg, borderColor: palette.border },
        pressed && !isDisabled && styles.pressed,
        isDisabled && styles.buttonDisabled,
      ]}
    >
      {/*
        T-07 — the primary variant is a gradient on the web. The layer sits
        BEHIND the label (absolute fill) so the label keeps its own colour and
        the Pressable keeps ownership of shape, border and press state. Other
        variants are flat on the web too, so they render no layer at all.
      */}
      {variant === "primary" && !isDisabled ? (
        <LinearGradient
          colors={[...PRIMARY_GRADIENT]}
          start={PRIMARY_GRADIENT_START}
          end={PRIMARY_GRADIENT_END}
          style={[StyleSheet.absoluteFill, { borderRadius: theme.radius.md }]}
          pointerEvents="none"
        />
      ) : null}
      <View style={styles.buttonInner}>
        {loading ? <ActivityIndicator size="small" color={palette.fg} /> : left}
        <Text style={[styles.buttonLabel, { color: palette.fg, fontFamily: fontFamilyBold }]}>{label}</Text>
      </View>
    </Pressable>
  );
}

/**
 * T-07 / RC-07 — the PWA's primary action is a GRADIENT, not a flat fill:
 * `app-primitives.css:196` — `linear-gradient(135deg, #7C3AED 0%, #6D28D9 100%)`.
 * Native rendered a flat `accent.a500`, losing the depth the web's primary has
 * on every screen. `PRIMARY_GRADIENT` is consumed by ProovraButton through
 * expo-linear-gradient; `bg` stays as the flat fallback for any surface that
 * cannot host a gradient layer.
 */
export const PRIMARY_GRADIENT = [theme.color.accent.a500, theme.color.accent.a600] as const;
/** 135deg in CSS === top-left → bottom-right in RN's unit square. */
export const PRIMARY_GRADIENT_START = { x: 0, y: 0 } as const;
export const PRIMARY_GRADIENT_END = { x: 1, y: 1 } as const;

function buttonPalette(variant: ButtonVariant): { bg: string; fg: string; border: string } {
  switch (variant) {
    case "primary":
      // app-primitives.css:196-203 — #ffffff foreground (NOT ink.inverse
      // #F8FAFC) and a translucent violet border, both taken verbatim.
      return { bg: PRIMARY_GRADIENT[0], fg: theme.color.ink.onAccent, border: "rgba(109, 40, 217, 0.5)" };
    case "danger":
      return { bg: theme.color.semantic.error, fg: theme.color.ink.onAccent, border: theme.color.semantic.error };
    case "ghost":
      return { bg: "transparent", fg: theme.color.accent.a600, border: "transparent" };
    case "secondary":
    default:
      return { bg: theme.color.surface.card, fg: theme.color.ink.primary, border: theme.color.border.strong };
  }
}

/* ------------------------------------------------------------ Input/Field */

export function ProovraInput({
  value,
  onChangeText,
  placeholder,
  secureTextEntry,
  keyboardType,
  autoCapitalize = "none",
  autoComplete,
  editable = true,
  onSubmitEditing,
  accessibilityLabel,
  multiline,
  testID,
}: {
  value: string;
  onChangeText: (t: string) => void;
  placeholder?: string;
  secureTextEntry?: boolean;
  keyboardType?: KeyboardTypeOptions;
  autoCapitalize?: "none" | "sentences" | "words" | "characters";
  autoComplete?: "email" | "password" | "off";
  editable?: boolean;
  onSubmitEditing?: () => void;
  /**
   * The field's accessible name.
   *
   * This used to fall back to `placeholder` alone, so a field whose label sits
   * OUTSIDE the input — which is every ProovraFormField — had no accessible
   * name at all. A placeholder is also not a label: it disappears as soon as
   * the user types.
   */
  accessibilityLabel?: string;
  /**
   * A field that holds more than a line — a discussion reply, a note. It grows
   * to a readable height and keeps Return as a newline rather than a submit.
   */
  multiline?: boolean;
  testID?: string;
}) {
  const { isRTL } = useLocale();
  const [focused, setFocused] = React.useState(false);
  return (
    <TextInput
      testID={testID}
      value={value}
      onChangeText={onChangeText}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      placeholder={placeholder}
      placeholderTextColor={theme.color.ink.muted}
      secureTextEntry={secureTextEntry}
      keyboardType={keyboardType}
      autoCapitalize={autoCapitalize}
      autoComplete={autoComplete}
      editable={editable}
      onSubmitEditing={onSubmitEditing}
      multiline={multiline}
      textAlignVertical={multiline ? "top" : undefined}
      accessibilityLabel={accessibilityLabel ?? placeholder}
      style={[
        multiline ? { minHeight: 96, paddingTop: 12 } : null,
        styles.input,
        { textAlign: isRTL ? "right" : "left", borderColor: focused ? theme.color.accent.a500 : theme.color.border.strong },
        !editable && styles.inputDisabled,
      ]}
    />
  );
}

export function ProovraFormField({
  label,
  error,
  children,
}: {
  label: string;
  error?: string | null;
  children: React.ReactNode;
}) {
  /**
   * Name the control from the field label, and append the error when there is
   * one, so a screen reader announces "Email, Enter a valid email address."
   * rather than an unnamed text box beside an unattached sentence.
   *
   * React Native has no `htmlFor` / `aria-describedby`, so the association has
   * to be made by passing the name down — which is why ProovraInput now takes
   * an explicit `accessibilityLabel` instead of borrowing the placeholder. A
   * placeholder was never a label: it disappears as soon as the user types.
   */
  const named = React.isValidElement(children)
    ? React.cloneElement(children as React.ReactElement<{ accessibilityLabel?: string }>, {
        accessibilityLabel:
          (children.props as { accessibilityLabel?: string }).accessibilityLabel ??
          (error ? `${label}, ${error}` : label),
      })
    : children;

  return (
    <View style={styles.field}>
      <ProovraText variant="label" weight="semibold" color={theme.color.ink.secondary}>
        {label}
      </ProovraText>
      {named}
      {error ? (
        <ProovraText variant="label" color={theme.color.status.risk.fg}>
          {error}
        </ProovraText>
      ) : null}
    </View>
  );
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
  onLongPress,
  accessibilityHint,
  testID,
}: {
  title: string;
  subtitle?: string;
  trailing?: React.ReactNode;
  onPress?: () => void;
  /**
   * A secondary action on the row — today, removing an evidence link.
   *
   * A long press is invisible, so a row that carries one states it in
   * `accessibilityHint` and the surface says so in words beside the list.
   */
  onLongPress?: () => void;
  accessibilityHint?: string;
  testID?: string;
}) {
  const { isRTL } = useLocale();
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      onLongPress={onLongPress}
      accessibilityRole={onPress ? "button" : undefined}
      accessibilityLabel={title}
      accessibilityHint={accessibilityHint}
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

/**
 * The web ProovraSupportReference (components/feedback/ProovraSupportReference.tsx):
 * the ONLY way an internal request/trace id reaches a person — a labelled,
 * low-contrast "Support reference" with Copy, never an id inside a sentence.
 */
export function ProovraSupportReference({ reference }: { reference: string | null | undefined }) {
  const value = (reference ?? "").trim();
  const [copied, setCopied] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  if (!value) return null;
  const onCopy = async () => {
    try {
      await Clipboard.setStringAsync(value);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard refused — the reference is still on screen to read aloud */
    }
  };
  return (
    <View style={[styles.stateGap, { flexDirection: "row", alignItems: "center", gap: theme.space.s2, flexWrap: "wrap", justifyContent: "center" }]} testID="support-reference">
      <ProovraText variant="label" color={theme.color.ink.muted}>Support reference</ProovraText>
      <ProovraText variant="label" mono selectable color={theme.color.ink.secondary}>{value}</ProovraText>
      <ProovraButton label={copied ? "Copied" : "Copy"} accessibilityLabel="Copy support reference" variant="ghost" fullWidth={false} onPress={() => void onCopy()} />
    </View>
  );
}

export function ProovraErrorState({ message, onRetry, requestId }: { message: string; onRetry?: () => void; requestId?: string | null }) {
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
      {/* The support correlation id, the web way (ProovraSupportReference). */}
      <ProovraSupportReference reference={requestId} />
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
  screenOnArtwork: { backgroundColor: "transparent" },
  centerColumn: { flex: 1, width: "100%", alignItems: "center" },
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
  /**
   * T-07 / RC-07 — canonical shape, taken from the PWA reference.
   *
   * `apps/web/components/app-primitives/app-primitives.css:188-206`
   * (`.app-primary-action`) is the authority:
   *     border-radius: 8px;  padding: 0 14px;  height: 36px;
   *     border: 1px solid rgba(109, 40, 217, 0.5);
   *     box-shadow: 0 1px 2px rgba(15, 23, 42, 0.12);
   *
   * Native previously used `radius.pill` (999), a completely different
   * silhouette — a rounded rectangle read as a capsule on every screen.
   *
   * THE ONE DELIBERATE DIVERGENCE: the web's 36px height is below the 44pt
   * minimum touch target. `minHeight: MIN_TOUCH` is kept and the horizontal
   * padding follows the web (14px). This is the platform adaptation the mandate
   * permits; the SHAPE now matches.
   */
  button: {
    minHeight: MIN_TOUCH,
    paddingVertical: theme.space.s3,
    paddingHorizontal: 14,
    borderRadius: theme.radius.md,
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
  field: { gap: theme.space.s2, marginBottom: theme.space.s4 },
  /**
   * T-07 / RC-07 — `.app-input, .app-select, .app-textarea`
   * (app-primitives.css:2304-2312) is the authority:
   *   min-block-size: 44px;  padding: 8px 12px;
   *   border: 1px solid var(--border-standard);
   *   border-radius: var(--radius-sm);   <- 6px, NOT the 8px native used
   *
   * Note the web already sets a 44px minimum here, so `MIN_TOUCH` is not a
   * native divergence on this primitive — the two agree.
   */
  input: {
    minHeight: MIN_TOUCH,
    borderWidth: 1,
    borderRadius: theme.radius.sm,
    paddingHorizontal: theme.space.s3,
    paddingVertical: theme.space.s3,
    fontSize: theme.type.size.body,
    color: theme.color.ink.primary,
    backgroundColor: theme.color.surface.card,
  },
  inputDisabled: { opacity: 0.5 },
});
