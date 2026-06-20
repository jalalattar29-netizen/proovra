import { contactSalesSchema } from "../../../lib/contact-sales-schema";
import { handleLeadSubmission } from "../_marketing-leads";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  return handleLeadSubmission(req, {
    intent: "contact_sales",
    sourcePage: "contact-sales",
    schema: contactSalesSchema,
    honeypotField: "website",
    upstreamPath: "/v1/contact-sales",
    upstreamHeaderSource: "x-lead-source",
    successMessage:
      "Enterprise inquiry received. The right PROOVRA team will review your request and respond.",
    upstreamMessageFallback: "Enterprise inquiry received.",
  });
}
