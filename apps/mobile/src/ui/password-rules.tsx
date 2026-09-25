/**
 * PASSWORD RULES PANEL — the same rules and the same meter as the web.
 *
 * Both consume `@proovra/shared/password-rules`, which is where the rules
 * moved when Native needed them. Before this, the native register and
 * reset-password screens checked ONLY `password.length >= 12`, so a user could
 * submit a twelve-character all-lowercase password, be refused by the server,
 * and be told nothing about which of the four remaining rules they had missed.
 *
 * The rules panel is a superset of the server's floor and is not the gate. The
 * server remains the authority; this exists so a user can see what is wanted
 * before they are refused.
 */
import { View } from "react-native";

import {
  PASSWORD_RULES,
  evaluatePassword,
  type PasswordEvaluation,
  // From the package ROOT. Metro does not resolve package `exports` by
  // default, so a subpath import fails to resolve at all — this one took the
  // Android bundle down the moment the graph reached it.
} from "@proovra/shared";

import { theme } from "../theme/theme";
import { ProovraText } from "./index";

export { evaluatePassword };
export type { PasswordEvaluation };

/** Every rule met — what a surface should require before enabling submit. */
export function passwordMeetsRules(password: string): boolean {
  return evaluatePassword(password).allMet;
}

export function ProovraPasswordRules({
  password,
  /**
   * Hide the panel until the user has engaged with the field. An empty form
   * that opens with five red crosses reads as a list of failures before
   * anything was attempted.
   */
  visible = true,
  touched = false,
}: {
  password: string;
  visible?: boolean;
  /**
   * The person has tried to submit. The web then marks an unmet rule as a
   * FAILURE — a red cross (register/page.tsx:1383-1394) — instead of a
   * neutral dot, so what is still missing stands out.
   */
  touched?: boolean;
}) {
  if (!visible) return null;

  const evaluation = evaluatePassword(password);

  return (
    <View style={{ gap: theme.space.s1 }} testID="password-rules">
      {/*
        The strength meter's five colours are the shared scale's, not theme
        tokens: it is a SCALE rather than a set of semantic statuses, and it
        has to read the same on both platforms.
      */}
      <View
        style={{ flexDirection: "row", gap: 4 }}
        accessibilityRole="progressbar"
        accessibilityLabel={`Password strength: ${evaluation.label}`}
      >
        {[0, 1, 2, 3, 4].map((step) => (
          <View
            key={step}
            style={{
              flex: 1,
              height: 4,
              borderRadius: 2,
              backgroundColor:
                password.length > 0 && step <= evaluation.score
                  ? evaluation.color
                  : theme.color.border.subtle,
            }}
          />
        ))}
      </View>

      {/* The web's caption row: "Password strength" … the level ("—" before any input). */}
      <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
        <ProovraText variant="label" color={theme.color.ink.secondary}>Password strength</ProovraText>
        <ProovraText variant="label" weight="semibold" color={password.length > 0 ? evaluation.color : theme.color.ink.secondary}>
          {password.length > 0 ? evaluation.label : "—"}
        </ProovraText>
      </View>

      {/* T-12 — the web's checklist is a LIST named "Password requirements"
          (register/page.tsx:1377), so assistive tech announces it as one
          group of five rather than five unrelated lines. */}
      <View role="list" accessibilityLabel="Password requirements" testID="password-requirements" style={{ gap: theme.space.s1 }}>
      {PASSWORD_RULES.map((rule) => {
        const met = evaluation.ruleResults.find((r) => r.id === rule.id)?.met === true;
        const failed = !met && touched;
        return (
          <ProovraText
            key={rule.id}
            variant="label"
            color={met ? theme.color.status.verified.fg : failed ? theme.color.status.risk.fg : theme.color.ink.muted}
            // The tick is decorative; the accessible name carries the state,
            // because a screen reader announcing "check mark Minimum 12
            // characters" says nothing about whether it was met.
            accessibilityLabel={`${rule.label}: ${met ? "met" : "not met"}`}
          >
            {`${met ? "✓" : failed ? "✕" : "○"} ${rule.label}`}
          </ProovraText>
        );
      })}
      </View>
    </View>
  );
}
