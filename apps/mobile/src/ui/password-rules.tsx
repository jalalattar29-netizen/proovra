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
}: {
  password: string;
  visible?: boolean;
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

      {password.length > 0 ? (
        <ProovraText variant="label" color={evaluation.color}>
          {evaluation.label}
        </ProovraText>
      ) : null}

      {PASSWORD_RULES.map((rule) => {
        const met = evaluation.ruleResults.find((r) => r.id === rule.id)?.met === true;
        return (
          <ProovraText
            key={rule.id}
            variant="label"
            color={met ? theme.color.status.verified.fg : theme.color.ink.muted}
            // The tick is decorative; the accessible name carries the state,
            // because a screen reader announcing "check mark Minimum 12
            // characters" says nothing about whether it was met.
            accessibilityLabel={`${rule.label}: ${met ? "met" : "not met"}`}
          >
            {`${met ? "✓" : "○"} ${rule.label}`}
          </ProovraText>
        );
      })}
    </View>
  );
}
