const DAY_KEY_FORMAT = "YYYY-MM-DD";
const MONTH_KEY_FORMAT = "YYYY-MM";
function getCurrentDayKey() {
    return new Date().toISOString().slice(0, 10);
}
function getCurrentMonthKey() {
    return new Date().toISOString().slice(0, 7);
}
function parsePositiveInt(value, fallback) {
    if (!value)
        return fallback;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}
export class AiCostGuard {
    dailyChatCount = new Map();
    captureAnalysisCount = new Map();
    monthlySpend = { month: getCurrentMonthKey(), eur: 0 };
    maxChatMessagesPerUserPerDay = parsePositiveInt(process.env.AI_MAX_CHAT_MESSAGES_PER_USER_PER_DAY, 30);
    maxCaptureAnalysesPerEvidence = parsePositiveInt(process.env.AI_MAX_CAPTURE_ANALYSES_PER_EVIDENCE, 10);
    monthlyBudgetEur = parsePositiveInt(process.env.AI_MONTHLY_BUDGET_EUR, 50);
    estimateCost(task) {
        switch (task) {
            case "CAPTURE_SESSION_REVIEW":
            case "CAPTURE_ITEM_REVIEW":
            case "EVIDENCE_METADATA_CATEGORIZATION":
                return 0.25;
            case "SUPPORT_CHAT":
            default:
                return 0.02;
        }
    }
    resetIfNeeded() {
        const today = getCurrentDayKey();
        for (const [key, entry] of this.dailyChatCount.entries()) {
            if (entry.day !== today) {
                this.dailyChatCount.delete(key);
            }
        }
        for (const [key, entry] of this.captureAnalysisCount.entries()) {
            if (entry.day !== today) {
                this.captureAnalysisCount.delete(key);
            }
        }
        const month = getCurrentMonthKey();
        if (this.monthlySpend.month !== month) {
            this.monthlySpend.month = month;
            this.monthlySpend.eur = 0;
        }
    }
    canSendChatMessage(userId) {
        this.resetIfNeeded();
        const entry = this.dailyChatCount.get(userId);
        const count = entry?.day === getCurrentDayKey() ? entry.count : 0;
        if (count >= this.maxChatMessagesPerUserPerDay) {
            return {
                allowed: false,
                reason: "Daily chat message limit reached.",
            };
        }
        const cost = this.estimateCost("SUPPORT_CHAT");
        if (this.monthlySpend.eur + cost > this.monthlyBudgetEur) {
            return {
                allowed: false,
                reason: "AI budget limit reached for the month.",
            };
        }
        return { allowed: true };
    }
    recordChatMessage(userId) {
        this.resetIfNeeded();
        const day = getCurrentDayKey();
        const entry = this.dailyChatCount.get(userId);
        if (entry && entry.day === day) {
            entry.count += 1;
        }
        else {
            this.dailyChatCount.set(userId, { day, count: 1 });
        }
        this.monthlySpend.eur += this.estimateCost("SUPPORT_CHAT");
    }
    canAnalyzeCapture(userId, evidenceId) {
        this.resetIfNeeded();
        const key = evidenceId ? `${userId}:${evidenceId}` : userId;
        const entry = this.captureAnalysisCount.get(key);
        const count = entry?.day === getCurrentDayKey() ? entry.count : 0;
        if (count >= this.maxCaptureAnalysesPerEvidence) {
            return {
                allowed: false,
                reason: "Capture analysis limit reached for this evidence or session.",
            };
        }
        const cost = this.estimateCost("CAPTURE_SESSION_REVIEW");
        if (this.monthlySpend.eur + cost > this.monthlyBudgetEur) {
            return {
                allowed: false,
                reason: "AI budget limit reached for the month.",
            };
        }
        return { allowed: true };
    }
    recordCaptureAnalysis(userId, evidenceId) {
        this.resetIfNeeded();
        const key = evidenceId ? `${userId}:${evidenceId}` : userId;
        const day = getCurrentDayKey();
        const entry = this.captureAnalysisCount.get(key);
        if (entry && entry.day === day) {
            entry.count += 1;
        }
        else {
            this.captureAnalysisCount.set(key, { day, count: 1 });
        }
        this.monthlySpend.eur += this.estimateCost("CAPTURE_SESSION_REVIEW");
    }
    canCategorizeEvidence(userId, evidenceId) {
        return this.canAnalyzeCapture(userId, evidenceId);
    }
    recordEvidenceCategorization(userId, evidenceId) {
        this.recordCaptureAnalysis(userId, evidenceId);
    }
}
