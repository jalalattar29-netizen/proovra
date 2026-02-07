import pino from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
});

export function withJobContext(params: {
  requestId?: string;
  jobId?: string | number | null;
  evidenceId?: string;
  attempt?: number;
  durationMs?: number;
  status?: string;
}) {
  return {
    requestId: params.requestId ?? null,
    jobId: params.jobId ?? null,
    evidenceId: params.evidenceId ?? null,
    attempt: params.attempt ?? null,
    durationMs: params.durationMs ?? null,
    status: params.status ?? null,
  };
}
