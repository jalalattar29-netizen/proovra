/**
 * THE password complexity rules for every auth surface.
 *
 * Used by the web's register and reset-password pages and by the Native app's
 * equivalents, so all four present the same rules panel and the same strength
 * meter. The backend enforces its own floor in `email-password-auth.service.ts`
 * (`isPasswordPolicyCompliant`); the rules here are a strict superset intended
 * to drive the live UI — the server is the source of truth for the actual gate.
 *
 * It moved here from `apps/web/lib/passwordRules.ts` when Native needed it.
 * The alternative was a second copy of the rules, and two password panels that
 * disagree about what a valid password is would be worse than either of them
 * alone: a user would be told their password was fine on one surface and
 * refused on the other, with the server siding with neither.
 *
 * STRENGTH_COLORS are literal hex rather than tokens because they are a
 * five-step SCALE, not semantic status colours, and the scale has to read the
 * same on both platforms.
 */

export type PasswordRuleId =
  | "length"
  | "upper"
  | "lower"
  | "digit"
  | "special";

export type PasswordRule = {
  id: PasswordRuleId;
  label: string;
  test: (p: string) => boolean;
};

export const PASSWORD_RULES: ReadonlyArray<PasswordRule> = [
  { id: "length", label: "Minimum 12 characters", test: (p) => p.length >= 12 },
  { id: "upper", label: "One uppercase letter", test: (p) => /[A-Z]/.test(p) },
  { id: "lower", label: "One lowercase letter", test: (p) => /[a-z]/.test(p) },
  { id: "digit", label: "One number", test: (p) => /\d/.test(p) },
  { id: "special", label: "One special character", test: (p) => /[^A-Za-z0-9]/.test(p) },
];

export type StrengthLevel = 0 | 1 | 2 | 3 | 4;

export const STRENGTH_LABELS: ReadonlyArray<string> = [
  "Very Weak",
  "Weak",
  "Good",
  "Strong",
  "Excellent",
];

// Warm enterprise palette aligned with the rose/coral/violet auth
// redesign. Excellent stays green so the user has clear confirmation
// the password actually exceeds the floor, not just hits the brand
// accent. No neon.
export const STRENGTH_COLORS: ReadonlyArray<string> = [
  "#D14343", // soft red — Very Weak
  "#E68028", // orange — Weak
  "#D9A640", // amber — Good
  "#E64880", // rose — Strong (brand primary)
  "#0F8A5F", // emerald — Excellent
];

export type PasswordEvaluation = {
  ruleResults: Array<PasswordRule & { met: boolean }>;
  passedCount: number;
  allMet: boolean;
  score: StrengthLevel;
  label: string;
  color: string;
};

export function evaluatePassword(pwd: string): PasswordEvaluation {
  const ruleResults = PASSWORD_RULES.map((r) => ({ ...r, met: r.test(pwd) }));
  const passedCount = ruleResults.filter((r) => r.met).length;
  const allMet = passedCount === PASSWORD_RULES.length;

  let score: StrengthLevel = 0;
  if (pwd.length === 0) {
    score = 0;
  } else if (passedCount <= 1) {
    score = 0;
  } else if (passedCount === 2) {
    score = 1;
  } else if (passedCount === 3) {
    score = 2;
  } else if (passedCount === 4) {
    score = 3;
  } else {
    // All five rules met. Bonus length step gates "Excellent".
    score = pwd.length >= 16 ? 4 : 3;
  }

  return {
    ruleResults,
    passedCount,
    allMet,
    score,
    label: STRENGTH_LABELS[score],
    color: STRENGTH_COLORS[score],
  };
}
