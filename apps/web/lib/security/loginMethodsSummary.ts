/**
 * Login-method presentation model (2026-07-17 Settings remediation).
 *
 * ONE pure derivation from GET /v1/identity/links that both the Settings
 * overview summary and the Account Security "Login methods" card consume,
 * so the two surfaces can never disagree:
 *
 *   - three canonical personal methods (email & password, Google, Apple)
 *     rendered as uniform rows — never an unrelated standalone button;
 *   - the LAST-USABLE-METHOD rule derived client-side (the backend's
 *     `last_login_method_protected` guard stays authoritative): a method
 *     that is the only usable sign-in never offers an enabled Disconnect.
 *
 * Organization SSO/SAML is not a personal method and never appears here.
 */

export type LoginLinkRow = {
  id: string;
  provider: string;
  normalizedEmail: string | null;
  linkedAtUtc: string;
  lastUsedAtUtc: string | null;
};

export type LoginMethodsState = {
  passwordConfigured: boolean;
  links: LoginLinkRow[];
  legacyProvider: string | null;
  usableMethods: number;
};

export type LoginMethodPresentation = {
  key: "password" | "google" | "apple";
  label: string;
  status: "configured" | "connected" | "not_connected";
  /** ISO timestamp of last use when known (providers only). */
  lastUsedAtUtc: string | null;
  /** Link id when this row is disconnectable via DELETE /links/:id. */
  linkId: string | null;
  /** Which action the row offers. */
  action: "add_password" | "connect" | "disconnect" | "none";
  /**
   * True when disconnect must be DISABLED because this is the final
   * usable login method (mirrors the backend guard so the UI never
   * submits a request it already knows must fail).
   */
  disconnectBlocked: boolean;
  /** Guidance shown when the action is blocked. */
  blockedReason: string | null;
};

const PROVIDER_LABEL: Record<string, string> = {
  GOOGLE: "Google",
  APPLE: "Apple",
};

/** Count of methods the user could actually sign in with right now. */
export function usableMethodCount(state: LoginMethodsState): number {
  // The backend ships its own count; trust it when present and sane.
  if (Number.isFinite(state.usableMethods) && state.usableMethods > 0) {
    return state.usableMethods;
  }
  const providers = new Set(state.links.map((l) => l.provider));
  if (state.legacyProvider) providers.add(state.legacyProvider);
  return providers.size + (state.passwordConfigured ? 1 : 0);
}

/**
 * The three canonical rows, in stable order. Every personal login method
 * renders through this — including Apple when not connected.
 */
export function presentLoginMethods(
  state: LoginMethodsState,
): LoginMethodPresentation[] {
  const usable = usableMethodCount(state);

  const providerRow = (
    key: "google" | "apple",
    provider: "GOOGLE" | "APPLE",
  ): LoginMethodPresentation => {
    const link = state.links.find((l) => l.provider === provider) ?? null;
    const legacyOnly = !link && state.legacyProvider === provider;
    const connected = link !== null || legacyOnly;
    if (!connected) {
      return {
        key,
        label: PROVIDER_LABEL[provider]!,
        status: "not_connected",
        lastUsedAtUtc: null,
        linkId: null,
        action: "connect",
        disconnectBlocked: false,
        blockedReason: null,
      };
    }
    // Disconnect requires a link row (legacy-only rows predate the link
    // model) AND at least one OTHER usable method remaining.
    const lastUsable = usable <= 1;
    const blocked = lastUsable || link === null;
    return {
      key,
      label: PROVIDER_LABEL[provider]!,
      status: "connected",
      lastUsedAtUtc: link?.lastUsedAtUtc ?? null,
      linkId: link?.id ?? null,
      action: "disconnect",
      disconnectBlocked: blocked,
      blockedReason: blocked
        ? lastUsable
          ? `Add another login method before disconnecting ${PROVIDER_LABEL[provider]}.`
          : "This is your original sign-in method. Add a password or another provider first."
        : null,
    };
  };

  return [
    {
      key: "password",
      label: "Email & password",
      status: state.passwordConfigured ? "configured" : "not_connected",
      lastUsedAtUtc: null,
      linkId: null,
      action: state.passwordConfigured ? "none" : "add_password",
      disconnectBlocked: false,
      blockedReason: null,
    },
    providerRow("google", "GOOGLE"),
    providerRow("apple", "APPLE"),
  ];
}

/** Concise summary value, e.g. "Google", "Google · Password". */
export function summarizeLoginMethods(state: LoginMethodsState): string {
  const parts: string[] = [];
  const providers = new Set(state.links.map((l) => l.provider));
  if (state.legacyProvider) providers.add(state.legacyProvider);
  for (const p of ["GOOGLE", "APPLE"]) {
    if (providers.has(p)) parts.push(PROVIDER_LABEL[p]!);
  }
  if (state.passwordConfigured) parts.push("Password");
  return parts.length > 0 ? parts.join(" · ") : "—";
}
