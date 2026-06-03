import * as prismaPkg from "@prisma/client";
import { isPayPalRecurringPlan, normalizePayPalCurrency, resolvePayPalPlanId, } from "./paypal-plan-map.service.js";
export function getPayPalCheckoutModeForPlan(plan) {
    if (plan === prismaPkg.PlanType.PAYG)
        return "ORDER";
    if (isPayPalRecurringPlan(plan))
        return "SUBSCRIPTION";
    throw new Error(`PayPal does not support plan ${plan}`);
}
export function getPayPalPlanId(params) {
    if (!isPayPalRecurringPlan(params.plan)) {
        return null;
    }
    return resolvePayPalPlanId({
        plan: params.plan,
        currency: normalizePayPalCurrency(params.currency),
    });
}
export function assertPayPalPlanConfigured(params) {
    const mode = getPayPalCheckoutModeForPlan(params.plan);
    if (mode === "ORDER")
        return;
    const planId = getPayPalPlanId(params);
    if (!planId) {
        throw new Error(`Missing PayPal billing plan id for ${params.plan} (${normalizePayPalCurrency(params.currency)})`);
    }
}
export function buildPayPalCustomId(params) {
    const plan = String(params.plan).trim().toUpperCase();
    const teamId = params.teamId?.trim() || "";
    return `${params.userId}:${teamId}:${plan}`;
}
export function parsePayPalCustomId(value) {
    const raw = (value ?? "").trim();
    if (!raw) {
        return {
            userId: null,
            plan: null,
            teamId: null,
        };
    }
    try {
        const parsed = JSON.parse(raw);
        const userId = typeof parsed.userId === "string" && parsed.userId.trim()
            ? parsed.userId.trim()
            : null;
        const teamId = typeof parsed.teamId === "string" && parsed.teamId.trim()
            ? parsed.teamId.trim()
            : null;
        const rawPlan = typeof parsed.plan === "string" ? parsed.plan.trim().toUpperCase() : "";
        const plan = rawPlan === prismaPkg.PlanType.FREE ||
            rawPlan === prismaPkg.PlanType.PAYG ||
            rawPlan === prismaPkg.PlanType.PRO ||
            rawPlan === prismaPkg.PlanType.TEAM
            ? rawPlan
            : null;
        return { userId, plan, teamId };
    }
    catch {
        const [userIdRaw, teamIdRaw, planRaw] = raw.split(":");
        const userId = userIdRaw?.trim() || null;
        const teamId = teamIdRaw?.trim() || null;
        const normalizedPlan = planRaw?.trim().toUpperCase() || "";
        const plan = normalizedPlan === prismaPkg.PlanType.FREE ||
            normalizedPlan === prismaPkg.PlanType.PAYG ||
            normalizedPlan === prismaPkg.PlanType.PRO ||
            normalizedPlan === prismaPkg.PlanType.TEAM
            ? normalizedPlan
            : null;
        return {
            userId,
            plan,
            teamId,
        };
    }
}
