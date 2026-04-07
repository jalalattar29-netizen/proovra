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