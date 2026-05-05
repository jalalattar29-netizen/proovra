import { z } from "zod";

export const AiTaskEnum = z.enum([
  "SUPPORT_CHAT",
  "CAPTURE_SESSION_REVIEW",
  "CAPTURE_ITEM_REVIEW",
]);

export const AiTask = {
  SUPPORT_CHAT: "SUPPORT_CHAT",
  CAPTURE_SESSION_REVIEW: "CAPTURE_SESSION_REVIEW",
  CAPTURE_ITEM_REVIEW: "CAPTURE_ITEM_REVIEW",
} as const;

export type AiTask = z.infer<typeof AiTaskEnum>;
export type AiSeverity = "info" | "warning" | "danger";

export const AiFlagSchema = z.object({
  severity: z.enum(["info", "warning", "danger"]),
  title: z.string().min(1).max(200),
  detail: z.string().min(1).max(800),
  affectedItemId: z.string().min(1).max(120).optional(),
  affectedStepId: z.string().min(1).max(120).optional(),
});

export const AiResultSchema = z.object({
  status: z.enum(["ok", "blocked", "disabled", "error"]),
  summary: z.string().min(1).max(1000),
  warnings: z.array(z.string().min(1).max(400)),
  suggestions: z.array(z.string().min(1).max(400)),
  flags: z.array(AiFlagSchema),
  legalDisclaimer: z.string().min(1).max(400),
});

export type AiFlag = z.infer<typeof AiFlagSchema>;
export type AiResult = z.infer<typeof AiResultSchema>;

export interface AiProvider {
  run(task: AiTask, input: unknown): Promise<AiResult>;
}
