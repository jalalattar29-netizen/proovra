/**
 * PROOVRA Phase 2B Closure — Portal SAML ACS receiver.
 *
 * Catches the IdP's HTTP-POST binding callback for the External
 * Reviewer Portal. The IdP posts a `SAMLResponse` form field (plus
 * an optional `RelayState`) to this route. We forward the bounded
 * payload to the API's `/v1/portal/sso/callback` endpoint, then
 * redirect the user back to `/portal/accept/[grantId]` so the
 * accept page can resume the bounded portal session.
 *
 * Hard rules:
 *   * The grant id comes from the URL path — we never trust a grant
 *     id from the SAML attributes.
 *   * We forward the payload exactly as received; the API's
 *     `validateSamlResponse` does the real cryptographic work and is
 *     the only place that touches the IdP certificate.
 *   * The route handler never logs the raw SAMLResponse.
 *   * Bounded denial codes only — the API returns them and we mirror
 *     them as the `reason` query param on the redirect.
 */

import { NextResponse, type NextRequest } from "next/server";

const DEFAULT_API_BASE = "https://api.proovra.com";

function apiBase(): string {
  const raw =
    process.env.API_INTERNAL_BASE ??
    process.env.NEXT_PUBLIC_API_BASE ??
    DEFAULT_API_BASE;
  return raw.replace(/\/+$/, "");
}

function safeReason(value: unknown): string {
  if (typeof value !== "string") return "POLICY_REJECTED";
  // Bounded to avoid URL fuzzing the accept page.
  return value.replace(/[^A-Z_]/g, "").slice(0, 64) || "POLICY_REJECTED";
}

async function readSamlForm(req: NextRequest): Promise<{
  samlResponse: string | null;
  relayState: string | null;
}> {
  // SAML HTTP-POST binding always sends application/x-www-form-urlencoded.
  try {
    const fd = await req.formData();
    const samlResponse = fd.get("SAMLResponse");
    const relayState = fd.get("RelayState");
    return {
      samlResponse:
        typeof samlResponse === "string" && samlResponse.length > 0
          ? samlResponse
          : null,
      relayState:
        typeof relayState === "string" && relayState.length > 0
          ? relayState
          : null,
    };
  } catch {
    return { samlResponse: null, relayState: null };
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ grantId: string }> },
) {
  const { grantId } = await params;
  const acceptUrl = new URL(
    `/portal/accept/${encodeURIComponent(grantId)}`,
    req.url,
  );
  if (!/^[0-9a-fA-F-]{36}$/.test(grantId)) {
    acceptUrl.searchParams.set("sso", "denied");
    acceptUrl.searchParams.set("reason", "INVALID_GRANT_ID");
    return NextResponse.redirect(acceptUrl, { status: 303 });
  }

  const { samlResponse } = await readSamlForm(req);
  if (!samlResponse) {
    acceptUrl.searchParams.set("sso", "denied");
    acceptUrl.searchParams.set("reason", "SAML_RESPONSE_MISSING");
    return NextResponse.redirect(acceptUrl, { status: 303 });
  }

  try {
    const apiUrl = `${apiBase()}/v1/portal/sso/callback`;
    const apiRes = await fetch(apiUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grantId,
        samlResponseBase64: samlResponse,
        expectedInResponseTo: null,
      }),
    });
    if (apiRes.ok) {
      acceptUrl.searchParams.set("sso", "ok");
      return NextResponse.redirect(acceptUrl, { status: 303 });
    }
    let denial: string | null = null;
    let samlCategory: string | null = null;
    try {
      const body = (await apiRes.json()) as {
        denial?: string;
        samlCategory?: string | null;
      };
      denial = body.denial ?? null;
      samlCategory = body.samlCategory ?? null;
    } catch {
      /* swallow */
    }
    acceptUrl.searchParams.set("sso", "denied");
    acceptUrl.searchParams.set(
      "reason",
      safeReason(denial ?? samlCategory ?? "POLICY_REJECTED"),
    );
    return NextResponse.redirect(acceptUrl, { status: 303 });
  } catch {
    acceptUrl.searchParams.set("sso", "denied");
    acceptUrl.searchParams.set("reason", "SSO_CALLBACK_NETWORK");
    return NextResponse.redirect(acceptUrl, { status: 303 });
  }
}

// Some IdPs perform a GET probe; honestly redirect to the bounded
// fallback so we never silently accept an unsigned GET.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ grantId: string }> },
) {
  const { grantId } = await params;
  const url = new URL(
    `/portal/accept/${encodeURIComponent(grantId)}?sso=denied&reason=SAML_REQUIRES_POST`,
    _req.url,
  );
  return NextResponse.redirect(url, { status: 303 });
}
