/**
 * AI CAPABILITY DISCLOSURE (T-14 AiCapabilityStatusTable) — the live,
 * server-computed per-capability status for the active workspace:
 *   GET /v1/workspaces/ai-policy?teamId → { …, capabilities: AiCapabilityDisclosure[] }
 * (workspace-ai-policy.routes.ts → ai-capability-disclosure.service.ts).
 * Status is NEVER inferred here; a stub reads as a stub.
 *
 * Pure: no React, no fetch.
 */

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const rows = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

export function buildAiCapabilitiesPath(teamId: string): string {
  return `/v1/workspaces/ai-policy?teamId=${encodeURIComponent(teamId)}`;
}

export interface AiCapability {
  capability: string;
  purpose: string | null;
  provider: string | null;
  region: string | null;
  transferMechanism: string | null;
  dataCategory: string | null;
  defaultState: string | null;
  workspaceOptInRequired: boolean;
  operationalStatus: string | null;
  trainingMode: string | null;
  retentionMode: string | null;
  lastVerifiedAtUtc: string | null;
}

export function parseAiCapabilities(payload: unknown): AiCapability[] {
  return rows(obj(payload).capabilities)
    .map(obj)
    .filter((c) => str(c.capability))
    .map((c) => ({
      capability: str(c.capability) as string,
      purpose: str(c.purpose),
      provider: str(c.provider),
      region: str(c.region),
      transferMechanism: str(c.transferMechanism),
      dataCategory: str(c.dataCategory),
      defaultState: str(c.defaultState),
      workspaceOptInRequired: c.workspaceOptInRequired === true,
      operationalStatus: str(c.operationalStatus),
      trainingMode: str(c.trainingMode),
      retentionMode: str(c.retentionMode),
      lastVerifiedAtUtc: str(c.lastVerifiedAtUtc),
    }));
}

/** The web's statusLabel / data-category wording: the enum, lower-cased, underscores as spaces. */
export function aiEnumWords(v: string | null): string {
  return v ? v.replace(/_/g, " ").toLowerCase() : "—";
}

/** Only an enabled capability reads positive; disabled / stub read as a warning; the rest neutral. */
export function aiCapabilityTone(status: string | null): "verified" | "pending" | "neutral" {
  if (status === "ENABLED_FOR_THIS_WORKSPACE") return "verified";
  if (status === "DISABLED_BY_WORKSPACE_POLICY" || status === "DISABLED_BY_PLATFORM_CONFIGURATION" || status === "STUB_NOT_OPERATIONAL") return "pending";
  return "neutral";
}

/** A refusal is not an outage (the web's two sentences). */
export function aiCapabilitiesFailure(status: number | null): string {
  return status === 403 || status === 401
    ? "Live capability status isn't shown for your role in this workspace. The disclosures below still apply."
    : "Live capability status is unavailable right now.";
}
