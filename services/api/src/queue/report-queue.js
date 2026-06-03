import { Queue } from "bullmq";
import IORedis from "ioredis";
import { buildReportJobId, buildReportJobPayload, decideReportJobEnqueueAction, generateReportJobName, } from "@proovra/shared";
const reportQueueName = "report";
function must(name) {
    const v = process.env[name];
    if (!v || !v.trim()) {
        throw new Error(`${name} is not set`);
    }
    return v.trim();
}
const redisConnection = new IORedis(must("REDIS_URL"), {
    maxRetriesPerRequest: null,
});
export const reportQueue = new Queue(reportQueueName, {
    connection: redisConnection,
    defaultJobOptions: {
        attempts: 5,
        backoff: { type: "exponential", delay: 1000 },
        removeOnComplete: 100,
        removeOnFail: false,
    },
});
export async function enqueueGenerateReportJob(evidenceId, options) {
    const normalizedEvidenceId = evidenceId.trim();
    if (!normalizedEvidenceId) {
        throw new Error("enqueueGenerateReportJob: evidenceId is required");
    }
    const payload = buildReportJobPayload(normalizedEvidenceId, options);
    const jobId = buildReportJobId(normalizedEvidenceId, options);
    const existing = await reportQueue.getJob(jobId);
    if (existing) {
        const state = await existing.getState();
        const decision = decideReportJobEnqueueAction(state);
        if (decision.action === "skip") {
            return { enqueued: false, reason: decision.reason };
        }
        try {
            await existing.remove();
        }
        catch {
            // ignore remove race conditions
        }
    }
    await reportQueue.add(generateReportJobName, payload, {
        jobId,
        attempts: options?.forceRegenerate ? 3 : 5,
        backoff: { type: "exponential", delay: 1000 },
        removeOnComplete: 100,
        removeOnFail: false,
    });
    return { enqueued: true };
}
