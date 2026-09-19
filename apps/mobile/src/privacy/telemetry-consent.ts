/**
 * Telemetry (crash-reporting) consent (Phase 4). Web treats reliability
 * monitoring as the consent-gated analytics category; native must match rather
 * than send unconditionally whenever a DSN is set. Consent is opt-in
 * (default OFF) and changeable from Settings. Sentry initializes only after
 * consent is granted; captureException already no-ops until then.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import { initSentry } from "../sentry";

const KEY = "proovra-telemetry-consent";

let granted = false;

export function isTelemetryGranted(): boolean {
  return granted;
}

export async function loadTelemetryConsent(): Promise<boolean> {
  try {
    granted = (await AsyncStorage.getItem(KEY)) === "granted";
  } catch {
    granted = false;
  }
  return granted;
}

export async function setTelemetryConsent(next: boolean): Promise<void> {
  granted = next;
  try {
    await AsyncStorage.setItem(KEY, next ? "granted" : "denied");
  } catch {
    /* persistence best-effort */
  }
  if (next) initSentry(); // starts reporting now; there is no de-init this session
}

/** Boot hook: initialize telemetry only if the user previously consented. */
export async function initTelemetryIfConsented(): Promise<void> {
  if (await loadTelemetryConsent()) initSentry();
}
