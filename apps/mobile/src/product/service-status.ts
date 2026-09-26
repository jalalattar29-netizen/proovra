/**
 * GET /v1/runtime/status — the native parser, bound by the contract audit.
 *
 * The envelope keys are read here, where the audit can compare them with the
 * route; the INTERPRETATION is the shared one (`parseTenantServiceStatus`), so
 * web and native cannot read the same response differently.
 */
import { parseTenantServiceStatus, type TenantServiceStatus } from "@proovra/shared";

export const RUNTIME_STATUS_PATH = "/v1/runtime/status";

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {};

export function parseServiceStatus(payload: unknown): TenantServiceStatus {
  const d = obj(payload);
  return parseTenantServiceStatus({
    status: d.status,
    capabilities: d.capabilities,
    checkedAt: d.checkedAt,
  });
}
