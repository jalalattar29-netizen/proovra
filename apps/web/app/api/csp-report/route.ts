/**
 * PRO-PW-09 — CSP violation reports from the Report-Only named-origin policy
 * (lib/security/csp-report-only.ts). All limits and sanitization live in
 * lib/security/csp-report.ts; see docs/operations/csp-report-only.md.
 */
import { getClientIp } from "../_marketing-leads";
import { createCspReportLimiter, handleCspReport } from "../../../lib/security/csp-report";

export const dynamic = "force-dynamic";

const allow = createCspReportLimiter();

export async function POST(req: Request) {
  return handleCspReport(req, {
    allow,
    clientKey: getClientIp,
    // One structured line per violation; only sanitized fields reach it.
    log: (line) => console.info(line),
  });
}
