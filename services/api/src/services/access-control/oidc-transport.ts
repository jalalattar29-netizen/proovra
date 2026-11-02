/**
 * THE ONE WAY THIS SERVICE TALKS TO AN OIDC PROVIDER (IDENT-014).
 *
 * `issuerUrl` is customer input and the initiate route is public once a
 * connection is ACTIVE, so every call here is treated as untrusted: the URL goes
 * through the same refusal webhooks use (private, link-local, metadata and
 * loopback addresses, including what DNS answers), redirects are not followed,
 * and a slow or endless answer is cut off.
 */
import { validateDestinationUrlWithDns } from "../automation/automation-webhook.service.js";

const OIDC_TIMEOUT_MS = 10_000;
const OIDC_MAX_RESPONSE_BYTES = 256 * 1024;

export class OidcTransportError extends Error {
  constructor(public readonly reason: string) {
    super(`oidc transport: ${reason}`);
    this.name = "OidcTransportError";
  }
}

export async function assertIdpUrlAllowed(url: string): Promise<void> {
  const verdict = await validateDestinationUrlWithDns(url);
  if (!verdict.ok) throw new OidcTransportError(verdict.reason);
}

async function readBounded(res: Response): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > OIDC_MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new OidcTransportError("response_too_large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export type OidcResponse = { ok: boolean; status: number; body: unknown };

/** The body is null when the provider did not answer with JSON. */
export async function oidcRequest(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<OidcResponse> {
  await assertIdpUrlAllowed(url);
  const res = await fetch(url, {
    ...init,
    redirect: "error",
    signal: AbortSignal.timeout(OIDC_TIMEOUT_MS),
  });
  const text = await readBounded(res);
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { ok: res.ok, status: res.status, body };
}
