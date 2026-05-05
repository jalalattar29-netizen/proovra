import { AiTask } from "./ai-types.js";

const DAY_KEY_FORMAT = "YYYY-MM-DD";
const MONTH_KEY_FORMAT = "YYYY-MM";

function getCurrentDayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function getCurrentMonthKey(): string {
  return new Date().toISOString().slice(0, 7);
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export type AiCostGuardResult = {
  allowed: boolean;
  reason?: string;
};

export class AiCostGuard {
  private dailyChatCount = new Map<string, { day: string; count: number }>();
  private captureAnalysisCount = new Map<string, { day: string; count: number }>();
  private monthlySpend = { month: getCurrentMonthKey(), eur: 0 };

  private maxChatMessagesPerUserPerDay = parsePositiveInt(
    process.env.AI_MAX_CHAT_MESSAGES_PER_USER_PER_DAY,
    30
  );

  private maxCaptureAnalysesPerEvidence = parsePositiveInt(
    process.env.AI_MAX_CAPTURE_ANALYSES_PER_EVIDENCE,
    10
  );

  private monthlyBudgetEur = parsePositiveInt(process.env.AI_MONTHLY_BUDGET_EUR, 50);

  private estimateCost(task: AiTask): number {
    switch (task) {
      case "CAPTURE_SESSION_REVIEW":
      case "CAPTURE_ITEM_REVIEW":
        return 0.25;
      case "SUPPORT_CHAT":
      default:
        return 0.02;
    }
  }

  private resetIfNeeded(): void {
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

  canSendChatMessage(userId: string): AiCostGuardResult {
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

  recordChatMessage(userId: string): void {
    this.resetIfNeeded();
    const day = getCurrentDayKey();
    const entry = this.dailyChatCount.get(userId);
    if (entry && entry.day === day) {
      entry.count += 1;
    } else {
      this.dailyChatCount.set(userId, { day, count: 1 });
    }
    this.monthlySpend.eur += this.estimateCost("SUPPORT_CHAT");
  }

  canAnalyzeCapture(userId: string, evidenceId?: string): AiCostGuardResult {
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

  recordCaptureAnalysis(userId: string, evidenceId?: string): void {
    this.resetIfNeeded();
    const key = evidenceId ? `${userId}:${evidenceId}` : userId;
    const day = getCurrentDayKey();
    const entry = this.captureAnalysisCount.get(key);
    if (entry && entry.day === day) {
      entry.count += 1;
    } else {
      this.captureAnalysisCount.set(key, { day, count: 1 });
    }
    this.monthlySpend.eur += this.estimateCost("CAPTURE_SESSION_REVIEW");
  }
}
