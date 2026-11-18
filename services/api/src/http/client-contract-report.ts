/**
 * PRO-PSZ-05 — the ONE reader of the client contract a request reports.
 *
 * Native and extension builds (and, once the API advertises acceptance, the
 * web) send `x-proovra-client-contract` and `x-proovra-client-capabilities`
 * (@proovra/shared release-contract). Routes that need to stage an
 * enforcement per client ask here, and may only branch on what a client
 * POSITIVELY declares: an absent header is a legacy client and is never, by
 * itself, a reason to refuse (DEC-23: no minimum-version enforcement until
 * compatible builds are distributed).
 */
import type { FastifyRequest } from "fastify";

import {
  CLIENT_CAPABILITIES_HEADER,
  CLIENT_REPORTED_CONTRACT_HEADER,
  parseClientContractReport,
  type ClientContractReport,
} from "@proovra/shared";

function header(req: FastifyRequest, name: string): string | null {
  const v = req.headers[name];
  if (Array.isArray(v)) return v[0] ?? null;
  return typeof v === "string" ? v : null;
}

export function readClientContractReport(req: FastifyRequest): ClientContractReport {
  return parseClientContractReport(header(req, CLIENT_REPORTED_CONTRACT_HEADER), header(req, CLIENT_CAPABILITIES_HEADER));
}

/** True only when the client positively declares `capability`. */
export function clientDeclaresCapability(req: FastifyRequest, capability: string): boolean {
  return readClientContractReport(req).capabilities.includes(capability);
}
