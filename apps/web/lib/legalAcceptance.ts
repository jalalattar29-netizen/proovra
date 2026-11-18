"use client";

const KEY = "proovra_legal_acceptance";
const PENDING_OAUTH_KEY = "proovra_pending_oauth_legal_acceptance";

type LocalLegalAcceptanceState = {
  version: string;
  acceptedAt: string;
};

export type PendingOAuthLegalAcceptance = {
  source: "login" | "register";
  returnUrl: string;
  acceptances: Array<{
    policyKey: "terms" | "privacy" | "cookies";
    policyVersion: string;
  }>;
  createdAt: string;
};

function canUseStorage(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

function canUseSessionStorage(): boolean {
  return typeof window !== "undefined" && typeof window.sessionStorage !== "undefined";
}

function readState(): LocalLegalAcceptanceState | null {
  if (!canUseStorage()) return null;

  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as Partial<LocalLegalAcceptanceState>;

    if (
      typeof parsed.version !== "string" ||
      !parsed.version.trim() ||
      typeof parsed.acceptedAt !== "string" ||
      !parsed.acceptedAt.trim()
    ) {
      return null;
    }

    return {
      version: parsed.version,
      acceptedAt: parsed.acceptedAt,
    };
  } catch {
    return null;
  }
}

export function hasAcceptedLegal(version: string): boolean {
  const state = readState();
  return state?.version === version;
}

export function acceptLegal(version: string): void {
  if (!canUseStorage()) return;

  const next: LocalLegalAcceptanceState = {
    version,
    acceptedAt: new Date().toISOString(),
  };

  try {
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // ignore storage failures
  }
}

export function clearAcceptedLegal(): void {
  if (!canUseStorage()) return;

  try {
    window.localStorage.removeItem(KEY);
  } catch {
    // ignore storage failures
  }
}

export function savePendingOAuthLegalAcceptance(
  value: PendingOAuthLegalAcceptance
): void {
  if (!canUseSessionStorage()) return;

  try {
    window.sessionStorage.setItem(PENDING_OAUTH_KEY, JSON.stringify(value));
  } catch {
    // ignore storage failures
  }
}

export function readPendingOAuthLegalAcceptance(): PendingOAuthLegalAcceptance | null {
  if (!canUseSessionStorage()) return null;

  try {
    const raw = window.sessionStorage.getItem(PENDING_OAUTH_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as Partial<PendingOAuthLegalAcceptance>;

    if (
      !parsed ||
      (parsed.source !== "login" && parsed.source !== "register") ||
      typeof parsed.returnUrl !== "string" ||
      !parsed.returnUrl.startsWith("/") ||
      !Array.isArray(parsed.acceptances)
    ) {
      return null;
    }

    const acceptances = parsed.acceptances.filter(
      (item): item is PendingOAuthLegalAcceptance["acceptances"][number] =>
        !!item &&
        (item.policyKey === "terms" ||
          item.policyKey === "privacy" ||
          item.policyKey === "cookies") &&
        typeof item.policyVersion === "string" &&
        item.policyVersion.trim().length > 0
    );

    if (acceptances.length === 0) return null;

    return {
      source: parsed.source,
      returnUrl: parsed.returnUrl,
      acceptances,
      createdAt:
        typeof parsed.createdAt === "string" && parsed.createdAt.trim()
          ? parsed.createdAt
          : new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

export function clearPendingOAuthLegalAcceptance(): void {
  if (!canUseSessionStorage()) return;

  try {
    window.sessionStorage.removeItem(PENDING_OAUTH_KEY);
  } catch {
    // ignore storage failures
  }
}
/**
 * PRO-A1-06 — the consent a person gave by ticking the box on /register, held
 * on THIS browser until their verification link signs them in. The verify page
 * records the acceptance only when this hold exists for the same address (the
 * person who ticked is the person verifying, on the same browser). A link
 * opened anywhere else records nothing; the post-sign-in acceptance step then
 * asks, showing the documents. Never a credential; expires after a day.
 */
const PENDING_REGISTER_KEY = "proovra_pending_register_legal_acceptance";
const PENDING_REGISTER_TTL_MS = 24 * 60 * 60 * 1000;

export type PendingRegisterLegalAcceptance = {
  email: string;
  acceptances: PendingOAuthLegalAcceptance["acceptances"];
  createdAt: string;
};

export function savePendingRegisterLegalAcceptance(value: PendingRegisterLegalAcceptance): void {
  if (!canUseStorage()) return;
  try {
    window.localStorage.setItem(
      PENDING_REGISTER_KEY,
      JSON.stringify({ ...value, email: value.email.trim().toLowerCase() }),
    );
  } catch {
    // ignore storage failures
  }
}

/** The hold for `email`, when one was made on this browser in the last day. */
export function takePendingRegisterLegalAcceptance(
  email: string | null | undefined,
): PendingRegisterLegalAcceptance | null {
  if (!canUseStorage() || !email) return null;
  try {
    const raw = window.localStorage.getItem(PENDING_REGISTER_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PendingRegisterLegalAcceptance>;
    const created = typeof parsed.createdAt === "string" ? Date.parse(parsed.createdAt) : NaN;
    if (
      typeof parsed.email !== "string" ||
      parsed.email !== email.trim().toLowerCase() ||
      !Number.isFinite(created) ||
      Date.now() - created > PENDING_REGISTER_TTL_MS ||
      !Array.isArray(parsed.acceptances) ||
      parsed.acceptances.length === 0
    ) {
      return null;
    }
    window.localStorage.removeItem(PENDING_REGISTER_KEY);
    return parsed as PendingRegisterLegalAcceptance;
  } catch {
    return null;
  }
}
