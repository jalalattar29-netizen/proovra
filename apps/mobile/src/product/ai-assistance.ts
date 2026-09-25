/**
 * WHAT AI DOES IN THIS WORKSPACE, AND WHO DECIDED IT — pure.
 *
 * The native app used AI-assisted surfaces and could not answer the one
 * question a person is owed about them: is AI on here, which capabilities, and
 * who decides. The web answers it on `/settings`, a NATIVE_REQUIRED surface,
 * from `GET /v1/workspaces/ai-assistance-status?teamId` — a read behind
 * `governance.policy.read`, which EVERY membership role holds, precisely so
 * that a VIEWER can learn what governs them without being granted
 * `intelligence.read` (twenty-six endpoints including budgets and reviewer
 * quality scores).
 *
 * TRANSPARENCY IS NOT AUTHORITY. There are no switches on the native surface
 * and no disabled ones either: a greyed-out toggle invites a tap and then
 * refuses it, which is a worse answer than a sentence naming who decides.
 * Changing the policy is `PUT /v1/workspaces/ai-policy`, an administration
 * action the web keeps behind `intelligence.policy.manage`; native reads.
 *
 * Every value here comes from the server's own resolved projection. Nothing
 * infers availability from a plan name or a role string — the platform gate
 * runs BEFORE the workspace's switches, so a deployment with no provider
 * configured must not render "enabled" over a product that answers
 * unavailable.
 */
import type { ProovraStatusTone } from "@proovra/ui";

/** `projectAiAssistance` (ai-assistance-projection.ts:79) — the whole set. */
export const AI_ASSISTANCE_STATUSES = [
  "AVAILABLE",
  "NOT_INCLUDED_IN_PLAN",
  "NOT_PERMITTED_FOR_ROLE",
  "TEMPORARILY_UNAVAILABLE",
  "DISABLED_FOR_WORKSPACE",
] as const;

export type AiAssistanceStatus = (typeof AI_ASSISTANCE_STATUSES)[number];

export type AiFeatureState = "ENABLED" | "DISABLED" | "UNAVAILABLE" | "NOT_INCLUDED";

export interface AiFeature {
  id: string;
  label: string;
  description: string;
  state: AiFeatureState;
}

/**
 * The one case where two facts differ and both matter (web AiStatusRow :112):
 * the workspace has AI on, but the platform is not serving it. "Unavailable"
 * alone would send an administrator hunting for a setting already right.
 */
export const AI_ENABLED_BUT_UNAVAILABLE =
  "This workspace has AI assistance enabled; the platform is not serving AI requests at the moment. No change is needed here.";

export function aiStatusDetail(status: string | null, enabled: boolean, fallback: string): string {
  return status === "TEMPORARILY_UNAVAILABLE" && enabled ? AI_ENABLED_BUT_UNAVAILABLE : fallback;
}

export interface AiAssistanceSettings {
  status: AiAssistanceStatus | null;
  available: boolean;
  enabled: boolean;
  features: AiFeature[];
  processing: {
    mode: string | null;
    rawEvidenceSentByDefault: boolean;
    decisions: string | null;
  };
}

export function buildAiAssistanceStatusPath(teamId: string): string {
  return `/v1/workspaces/ai-assistance-status?teamId=${encodeURIComponent(teamId)}`;
}

function o(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}
function s(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

const FEATURE_STATES = new Set<AiFeatureState>([
  "ENABLED",
  "DISABLED",
  "UNAVAILABLE",
  "NOT_INCLUDED",
]);

/**
 * Parse the settings envelope.
 *
 * A status this build does not know becomes `null` rather than being coerced
 * to AVAILABLE: "we do not recognise this answer" and "AI is available" are
 * different statements, and only one of them is safe to make by default.
 */
export function parseAiAssistanceSettings(data: unknown): AiAssistanceSettings {
  const d = o(data);
  const raw = s(d["status"]);
  const status = (AI_ASSISTANCE_STATUSES as readonly string[]).includes(raw ?? "")
    ? (raw as AiAssistanceStatus)
    : null;

  const features: AiFeature[] = [];
  for (const entry of Array.isArray(d["features"]) ? (d["features"] as unknown[]) : []) {
    const f = o(entry);
    const id = s(f["id"]);
    const state = s(f["state"]) as AiFeatureState | null;
    if (!id || !state || !FEATURE_STATES.has(state)) continue;
    features.push({
      id,
      label: s(f["label"]) ?? id,
      description: s(f["description"]) ?? "",
      state,
    });
  }

  const processing = o(d["processing"]);
  return {
    status,
    available: d["available"] === true,
    enabled: d["enabled"] === true,
    features,
    processing: {
      mode: s(processing["mode"]),
      rawEvidenceSentByDefault: processing["rawEvidenceSentByDefault"] === true,
      decisions: s(processing["decisions"]),
    },
  };
}

/**
 * The headline, said in the words the product uses.
 *
 * "Not included in your plan" and "temporarily unavailable" are different
 * facts with different remedies, and collapsing them into "off" would send
 * somebody to the wrong place.
 */
export function aiStatusDisplay(status: AiAssistanceStatus | null): {
  label: string;
  tone: ProovraStatusTone;
  detail: string;
} {
  switch (status) {
    case "AVAILABLE":
      return {
        label: "Available",
        tone: "verified",
        detail: "AI assistance is available in this workspace.",
      };
    case "NOT_INCLUDED_IN_PLAN":
      return {
        label: "Not included",
        tone: "neutral",
        detail: "AI assistance is not part of this workspace's plan.",
      };
    case "NOT_PERMITTED_FOR_ROLE":
      return {
        label: "Not available to you",
        tone: "neutral",
        detail: "Your role in this workspace does not include AI assistance.",
      };
    case "TEMPORARILY_UNAVAILABLE":
      return {
        label: "Temporarily unavailable",
        tone: "pending",
        detail: "AI assistance is not answering right now. Nothing is wrong with your evidence.",
      };
    case "DISABLED_FOR_WORKSPACE":
      return {
        label: "Turned off",
        tone: "neutral",
        detail: "AI assistance has been turned off for this workspace.",
      };
    default:
      return {
        label: "Unknown",
        tone: "neutral",
        detail: "This app could not read the AI status for this workspace.",
      };
  }
}

export function aiFeatureStateDisplay(state: AiFeatureState): {
  label: string;
  tone: ProovraStatusTone;
} {
  switch (state) {
    case "ENABLED":
      return { label: "Enabled", tone: "verified" };
    case "DISABLED":
      return { label: "Disabled", tone: "neutral" };
    case "UNAVAILABLE":
      return { label: "Unavailable", tone: "pending" };
    case "NOT_INCLUDED":
      return { label: "Not included", tone: "neutral" };
  }
}

/**
 * Who decides, said plainly.
 *
 * A person who cannot change a setting is owed the name of the authority that
 * can, not a disabled control. A personal workspace has no administrator other
 * than its owner, and saying "ask your administrator" there would send someone
 * looking for a person who does not exist.
 */
export function aiManagedByCopy(workspaceKind: "PERSONAL" | "ORGANIZATION" | null): string {
  if (workspaceKind === "PERSONAL") {
    return "This is your personal workspace, so you decide this on the web app.";
  }
  if (workspaceKind === "ORGANIZATION") {
    return "Workspace administrators decide this, on the web app.";
  }
  return "This is decided for the workspace, on the web app.";
}

/**
 * The processing boundary, in sentences rather than codes.
 *
 * `METADATA_FIRST` and `ADVISORY_ONLY` are the server's vocabulary. Rendering
 * them raw would put an internal constant in front of somebody trying to find
 * out whether their evidence leaves the system.
 */
export function aiProcessingLines(processing: AiAssistanceSettings["processing"]): string[] {
  const lines: string[] = [];
  if (processing.mode === "METADATA_FIRST") {
    lines.push("AI reads information ABOUT your evidence first, not the evidence itself.");
  } else if (processing.mode) {
    lines.push(`Processing mode: ${processing.mode}.`);
  }
  lines.push(
    processing.rawEvidenceSentByDefault
      ? "Original files can be sent for processing."
      : "Original files are not sent for processing by default.",
  );
  if (processing.decisions === "ADVISORY_ONLY") {
    lines.push("AI never decides anything about a record. A person does.");
  } else if (processing.decisions) {
    lines.push(`Decisions: ${processing.decisions}.`);
  }
  return lines;
}

/* ===================================================================== */
/* WEB PARITY — AiReadOnlyView.tsx / lib/ai/assistanceStatus.ts          */
/* ===================================================================== */

export type AiManagedBy = "YOU" | "WORKSPACE_ADMINS" | "ORGANIZATION" | "PLAN" | "PLATFORM";

/**
 * Who decides (lib/ai/assistanceStatus.ts resolveManagedBy). `canManage` is
 * the SERVER capability `SETTINGS_MANAGE` for the active workspace; null =
 * unknown, which never claims the viewer decides.
 */
export function resolveAiManagedBy(input: {
  status: AiAssistanceStatus | null;
  workspaceKind: "PERSONAL" | "ORGANIZATION" | null;
  canManage: boolean | null;
}): AiManagedBy {
  if (input.status === "TEMPORARILY_UNAVAILABLE") return "PLATFORM";
  if (input.status === "NOT_INCLUDED_IN_PLAN") return "PLAN";
  if (input.workspaceKind === "ORGANIZATION") {
    return input.canManage === true ? "WORKSPACE_ADMINS" : "ORGANIZATION";
  }
  return input.canManage === true ? "YOU" : "WORKSPACE_ADMINS";
}

export function aiManagedByLabel(managedBy: AiManagedBy): string {
  switch (managedBy) {
    case "YOU":
      return "Managed by you";
    case "WORKSPACE_ADMINS":
      return "Managed by workspace administrators";
    case "ORGANIZATION":
      return "Managed by your organization";
    case "PLAN":
      return "Determined by your plan";
    case "PLATFORM":
    default:
      return "PROOVRA platform availability";
  }
}

/**
 * The web's "How AI uses your data" rows, from the server's own processing
 * block — the web hard-codes the words; native keeps them tied to the data,
 * and a vocabulary it does not know is shown rather than hidden.
 */
export function aiProcessingRows(processing: AiAssistanceSettings["processing"]): Array<{ name: string; value: string }> {
  return [
    {
      name: "Processing mode",
      value: processing.mode === "METADATA_FIRST" ? "Metadata first" : processing.mode || "Not stated",
    },
    {
      name: "Raw evidence content",
      value: processing.rawEvidenceSentByDefault
        ? "Sent to the AI provider by default"
        : "Not sent to the AI provider by default",
    },
    {
      name: "AI decisions",
      value: processing.decisions === "ADVISORY_ONLY" ? "Advisory only" : processing.decisions || "Not stated",
    },
  ];
}

export const AI_ADVISORY_NOTICE =
  "AI-assisted features in PROOVRA are advisory only and do not determine factual truth, authenticity, or legal admissibility.";

export const AI_NOT_INCLUDED_COPY =
  "AI assistance is not included in your plan. Plans with AI assistance include a monthly operation allowance for advisory features like the support assistant and capture assistance.";
