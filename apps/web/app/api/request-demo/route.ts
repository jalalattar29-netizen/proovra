import { requestDemoSchema } from "../../../lib/request-demo-schema";
import { handleLeadSubmission } from "../_marketing-leads";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  return handleLeadSubmission(req, {
    intent: "request_demo",
    sourcePage: "request-demo",
    schema: requestDemoSchema,
    honeypotField: "website",
    upstreamPath: "/v1/demo-requests",
    upstreamHeaderSource: "x-demo-source",
    successMessage:
      "Demo request received. We'll review your request and reply within 1 business day.",
    upstreamMessageFallback: "Demo request received.",
  });
}
