"use client";

const KEY = "proovra_legal_acceptance";

type LocalLegalAcceptanceState = {
  version: string;
  acceptedAt: string;
};

function canUseStorage(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
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