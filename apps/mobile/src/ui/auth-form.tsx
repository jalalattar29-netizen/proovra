/**
 * AUTH FORM PARTS — the pieces every web auth card is built from, once.
 *
 * login/page.tsx, register/page.tsx and reset-password/page.tsx draw the same
 * card head (a shield eyebrow chip, a heading, a lede), the same password field
 * with a show/hide control (components/auth/PasswordVisibilityToggle.tsx), the
 * same Terms/Privacy/Cookie consent box, and the same status and error notes.
 * Native built each of those per screen or not at all; this is the one place
 * they are defined so the three screens cannot drift from each other.
 *
 * Imported directly by the auth screens (not re-exported from ./index), like
 * ./brand, so there is no import cycle.
 */
import React, { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import Feather from "@expo/vector-icons/Feather";
import { ProovraInput, ProovraText } from "./index";
import { theme } from "../theme/theme";

/* ------------------------------------------------------------- card head */

/**
 * The web card head: the eyebrow chip with its shield (login/page.tsx:766-781
 * "Account access", register "Account setup" / "Verify your email",
 * reset-password "Password Access"), then the heading and the lede.
 */
export function AuthCardHead({ eyebrow, title, subtitle }: { eyebrow: string; title: string; subtitle?: string }) {
  return (
    <View style={styles.head} testID="auth-card-head">
      <View style={styles.eyebrow}>
        <Feather name="shield" size={14} color={theme.color.accent.a600} />
        <ProovraText variant="label" weight="semibold" style={styles.eyebrowText}>
          {eyebrow}
        </ProovraText>
      </View>
      <ProovraText variant="h2" weight="semibold" accessibilityRole="header">
        {title}
      </ProovraText>
      {subtitle ? (
        <ProovraText variant="bodySm" color={theme.color.ink.secondary}>
          {subtitle}
        </ProovraText>
      ) : null}
    </View>
  );
}

/* --------------------------------------------------------- password field */

/**
 * A password input with the web's show/hide control. Hidden by default; the
 * toggle flips visibility and nothing else, so the typed value survives it.
 * `toggleNoun` names what is revealed ("password", "confirm password"), as the
 * web's aria-label does ("Show confirm password").
 */
export function AuthPasswordInput({
  value,
  onChangeText,
  placeholder,
  accessibilityLabel,
  toggleNoun = "password",
  onSubmitEditing,
  editable = true,
  testID,
}: {
  value: string;
  onChangeText: (v: string) => void;
  placeholder?: string;
  accessibilityLabel?: string;
  toggleNoun?: string;
  onSubmitEditing?: () => void;
  editable?: boolean;
  testID?: string;
}) {
  const [visible, setVisible] = useState(false);
  const label = `${visible ? "Hide" : "Show"} ${toggleNoun}`;
  return (
    <View style={styles.pwRow}>
      <View style={styles.flex}>
        <ProovraInput
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          secureTextEntry={!visible}
          autoComplete="password"
          editable={editable}
          onSubmitEditing={onSubmitEditing}
          accessibilityLabel={accessibilityLabel}
          testID={testID}
        />
      </View>
      <Pressable
        onPress={() => setVisible((v) => !v)}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ selected: visible }}
        hitSlop={8}
        style={styles.pwToggle}
        testID={testID ? `${testID}-toggle` : undefined}
      >
        <Feather name={visible ? "eye-off" : "eye"} size={18} color={theme.color.ink.secondary} />
      </Pressable>
    </View>
  );
}

/* ---------------------------------------------------------------- consent */

/**
 * "I agree to the Terms of Service, Privacy Policy and Cookie Policy." — the
 * web's consent box on sign-in and sign-up (login/page.tsx:899-943,
 * register/page.tsx:1440-1480). Each document opens the in-app reader.
 */
export function AuthLegalConsent({
  checked,
  onToggle,
  onOpenDocument,
  disabled,
}: {
  checked: boolean;
  onToggle: () => void;
  onOpenDocument: (slug: "terms" | "privacy" | "cookies") => void;
  disabled?: boolean;
}) {
  const link = (slug: "terms" | "privacy" | "cookies", text: string) => (
    <ProovraText
      variant="label"
      weight="semibold"
      color={theme.color.accent.a600}
      accessibilityRole="link"
      accessibilityLabel={text}
      onPress={() => onOpenDocument(slug)}
    >
      {text}
    </ProovraText>
  );
  return (
    <View style={styles.consent} testID="auth-legal-consent">
      <Pressable
        accessibilityRole="checkbox"
        accessibilityState={{ checked, disabled: !!disabled }}
        accessibilityLabel="I agree to the Terms of Service, Privacy Policy and Cookie Policy"
        disabled={disabled}
        onPress={onToggle}
        hitSlop={10}
        style={[styles.checkbox, checked && styles.checkboxOn]}
      >
        {checked ? <Feather name="check" size={14} color={theme.color.ink.onAccent} /> : null}
      </Pressable>
      <ProovraText variant="label" color={theme.color.ink.secondary} style={styles.flex}>
        {"I agree to the "}
        {link("terms", "Terms of Service")}
        {", "}
        {link("privacy", "Privacy Policy")}
        {" and "}
        {link("cookies", "Cookie Policy")}
        {"."}
      </ProovraText>
    </View>
  );
}

/* ----------------------------------------------------------------- notes */

/** The web's alert (error) and status notes under the form. */
export function AuthNote({ tone, children, testID }: { tone: "error" | "status"; children: React.ReactNode; testID?: string }) {
  const error = tone === "error";
  return (
    <View
      style={[styles.note, error ? styles.noteError : styles.noteStatus]}
      accessibilityRole={error ? "alert" : undefined}
      accessibilityLiveRegion="polite"
      testID={testID}
    >
      <ProovraText variant="bodySm" color={error ? theme.color.status.risk.fg : theme.color.ink.secondary}>
        {children}
      </ProovraText>
    </View>
  );
}

/* ---------------------------------------------------- verification resend */

/** The web resend copy (login/page.tsx:1044-1066, register/page.tsx:745-768). */
export const RESEND_COPY = {
  sending: "Sending verification email…",
  sent: "Verification email sent.",
  wait: "Please wait before requesting another verification email.",
  pending: "Resend pending…",
} as const;

/**
 * Resend with the web's hold: the control stays disabled for the backend's
 * 60-second per-email cooldown even when the request was instant, and the
 * answer is neutral — sent, or "please wait".
 */
export function useVerificationResend(send: () => Promise<void>, holdMs = 60_000) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const resend = async () => {
    if (busy) return;
    setBusy(true);
    setStatus(RESEND_COPY.sending);
    try {
      await send();
      setStatus(RESEND_COPY.sent);
    } catch {
      setStatus(RESEND_COPY.wait);
    } finally {
      timer.current = setTimeout(() => setBusy(false), holdMs);
    }
  };
  const reset = () => {
    if (timer.current) clearTimeout(timer.current);
    setBusy(false);
    setStatus(null);
  };
  return { busy, status, resend, reset };
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  head: { gap: theme.space.s2, marginBottom: theme.space.s4 },
  eyebrow: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space.s2,
    paddingHorizontal: theme.space.s3,
    paddingVertical: 6,
    borderRadius: theme.radius.pill,
    borderWidth: 1,
    borderColor: theme.color.accent.a200,
    backgroundColor: theme.color.accent.a050,
  },
  eyebrowText: { textTransform: "uppercase", letterSpacing: 1.6 },
  pwRow: { flexDirection: "row", alignItems: "center", gap: theme.space.s2 },
  pwToggle: {
    minWidth: 44,
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.md,
  },
  consent: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.space.s3,
    padding: theme.space.s3,
    marginVertical: theme.space.s2,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: theme.color.accent.a200,
    backgroundColor: "rgba(255, 255, 255, 0.42)",
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 1.5,
    borderColor: theme.color.border.strong,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.color.surface.card,
  },
  checkboxOn: { backgroundColor: theme.color.accent.a600, borderColor: theme.color.accent.a600 },
  note: { borderRadius: 14, borderWidth: 1, paddingHorizontal: theme.space.s3, paddingVertical: 10, marginTop: theme.space.s2 },
  noteError: { backgroundColor: theme.color.status.risk.bg, borderColor: theme.color.status.risk.border },
  noteStatus: { backgroundColor: "rgba(255, 255, 255, 0.52)", borderColor: theme.color.border.default },
});
