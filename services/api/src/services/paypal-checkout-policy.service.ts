import * as prismaPkg from "@prisma/client";
import {
  isPayPalRecurringPlan,
  normalizePayPalCurrency,
  resolvePayPalPlanId,
} from "./paypal-plan-map.service.js";

export type PayPalCheckoutMode = "ORDER" | "SUBSCRIPTION";

export function getPayPalCheckoutModeForPlan(
  plan: prismaPkg.PlanType
): PayPalCheckoutMode {
  if (plan === prismaPkg.PlanType.PAYG) return "ORDER";
  if (isPayPalRecurringPlan(plan)) return "SUBSCRIPTION";
  throw new Error(`PayPal does not support plan ${plan}`);
}

export function getPayPalPlanId(params: {
  plan: prismaPkg.PlanType;
  currency?: string | null;
}): string | null {
  if (!isPayPalRecurringPlan(params.plan)) {
    return null;
  }

  return resolvePayPalPlanId({
    plan: params.plan,
    currency: normalizePayPalCurrency(params.currency),
  });
}

export function assertPayPalPlanConfigured(params: {
  plan: prismaPkg.PlanType;
  currency?: string | null;
}) {
  const mode = getPayPalCheckoutModeForPlan(params.plan);

  if (mode === "ORDER") return;

  const planId = getPayPalPlanId(params);
  if (!planId) {
    throw new Error(
      `Missing PayPal billing plan id for ${params.plan} (${normalizePayPalCurrency(
        params.currency
      )})`
    );
  }
}

export function buildPayPalCustomId(params: {
  userId: string;
  plan: prismaPkg.PlanType | "PRO" | "TEAM" | "PAYG";
  teamId?: string | null;
}) {
  const plan = String(params.plan).trim().toUpperCase();
  const teamId = params.teamId?.trim() || "";
  return `${params.userId}:${teamId}:${plan}`;
}

/**
 * PayPal's hard limit on `custom_id` (Orders v2 purchase_unit and Billing
 * Subscriptions alike). A longer value is rejected with 400 INVALID_REQUEST
 * before any approval URL exists.
 */
export const PAYPAL_CUSTOM_ID_MAX_LENGTH = 127;

/** Version tag of the compact storage add-on custom_id. */
const STORAGE_ADDON_CUSTOM_ID_PREFIX = "sa1";

/**
 * The compact add-on codes on the wire (origin/main b9b8b54 introduced these;
 * subscriptions already created at PayPal may carry them, so they are what is
 * written). The full StorageAddonKey is ALSO accepted when parsing, so a
 * subscription created with either spelling of sa1 is attributable.
 */
const STORAGE_ADDON_WIRE_CODES: Readonly<Record<prismaPkg.StorageAddonKey, string>> = {
  PERSONAL_10_GB: "p10",
  PERSONAL_50_GB: "p50",
  PERSONAL_200_GB: "p200",
  TEAM_100_GB: "t100",
  TEAM_500_GB: "t500",
  TEAM_1_TB: "t1t",
};

function storageAddonKeyFromWire(code: string): prismaPkg.StorageAddonKey | null {
  for (const [key, wire] of Object.entries(STORAGE_ADDON_WIRE_CODES)) {
    if (code === wire || code === key) return key as prismaPkg.StorageAddonKey;
  }
  return null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The storage add-on subscription custom_id: `sa1|<userId>|<teamId or ->|<addonCode>`.
 *
 * It replaces a JSON object (`{"userId":…,"teamId":…,"storageAddonKey":…,
 * "billingCycle":…,"workspacePlan":…}`) that was 147+ characters for a UUID
 * user — over PayPal's 127-character limit, so every PayPal storage add-on
 * checkout was refused with 400 INVALID_REQUEST. The billing cycle is always
 * MONTHLY (the only cycle sold) and the workspace plan is re-read from the
 * database when the add-on is applied, so neither needs to travel.
 */
export function buildPayPalStorageAddonCustomId(params: {
  userId: string;
  teamId?: string | null;
  addonKey: prismaPkg.StorageAddonKey;
}): string {
  const teamId = params.teamId?.trim() || "-";
  const value = [
    STORAGE_ADDON_CUSTOM_ID_PREFIX,
    params.userId.trim(),
    teamId,
    STORAGE_ADDON_WIRE_CODES[params.addonKey],
  ].join("|");
  if (Buffer.byteLength(value, "utf8") > PAYPAL_CUSTOM_ID_MAX_LENGTH) {
    throw new Error(
      `PayPal custom_id exceeds ${PAYPAL_CUSTOM_ID_MAX_LENGTH} bytes`,
    );
  }
  return value;
}

export function parsePayPalStorageAddonCustomId(
  value: string | null | undefined,
): {
  userId: string;
  teamId: string | null;
  storageAddonKey: prismaPkg.StorageAddonKey;
} | null {
  const raw = (value ?? "").trim();
  if (!raw.startsWith(`${STORAGE_ADDON_CUSTOM_ID_PREFIX}|`)) return null;
  const parts = raw.split("|");
  if (parts.length !== 4) return null;
  const [, userIdRaw, teamIdRaw, codeRaw] = parts;
  const userId = userIdRaw?.trim() ?? "";
  const teamId = teamIdRaw?.trim() ?? "";
  const key = storageAddonKeyFromWire(codeRaw?.trim() ?? "");
  if (!UUID_RE.test(userId) || !key) return null;
  if (teamId !== "-" && !UUID_RE.test(teamId)) return null;
  return {
    userId,
    teamId: teamId === "-" ? null : teamId,
    storageAddonKey: key,
  };
}

export function parsePayPalCustomId(value: string | null | undefined): {
  userId: string | null;
  plan: prismaPkg.PlanType | null;
  teamId: string | null;
} {
  const raw = (value ?? "").trim();

  // A storage add-on custom_id names no plan and must never be read as one.
  if (!raw || raw.startsWith(`${STORAGE_ADDON_CUSTOM_ID_PREFIX}|`)) {
    return {
      userId: null,
      plan: null,
      teamId: null,
    };
  }

  try {
    const parsed = JSON.parse(raw) as {
      userId?: unknown;
      plan?: unknown;
      teamId?: unknown;
    };

    const userId =
      typeof parsed.userId === "string" && parsed.userId.trim()
        ? parsed.userId.trim()
        : null;

    const teamId =
      typeof parsed.teamId === "string" && parsed.teamId.trim()
        ? parsed.teamId.trim()
        : null;

    const rawPlan =
      typeof parsed.plan === "string" ? parsed.plan.trim().toUpperCase() : "";

    const plan =
      rawPlan === prismaPkg.PlanType.FREE ||
      rawPlan === prismaPkg.PlanType.PAYG ||
      rawPlan === prismaPkg.PlanType.PRO ||
      rawPlan === prismaPkg.PlanType.TEAM
        ? (rawPlan as prismaPkg.PlanType)
        : null;

    return { userId, plan, teamId };
  } catch {
    const [userIdRaw, teamIdRaw, planRaw] = raw.split(":");
    const userId = userIdRaw?.trim() || null;
    const teamId = teamIdRaw?.trim() || null;
    const normalizedPlan = planRaw?.trim().toUpperCase() || "";

    const plan =
      normalizedPlan === prismaPkg.PlanType.FREE ||
      normalizedPlan === prismaPkg.PlanType.PAYG ||
      normalizedPlan === prismaPkg.PlanType.PRO ||
      normalizedPlan === prismaPkg.PlanType.TEAM
        ? (normalizedPlan as prismaPkg.PlanType)
        : null;

    return {
      userId,
      plan,
      teamId,
    };
  }
}