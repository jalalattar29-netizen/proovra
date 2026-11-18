import { NextResponse } from "next/server";

/**
 * PRO-A1-15 — provider redirect callbacks.
 *
 * The provider's credentials (`code`, `id_token`) and `state` are handed to
 * the page in the URL FRAGMENT, never the query: a fragment is not sent to any
 * server, so the values do not reach request logs on the way to the page. The
 * page then refuses any callback whose `state` does not match the one this
 * browser stored when it started the flow (see callback/ui/page.tsx).
 */
const SECRET_KEYS = new Set(["code", "id_token", "state"]);

function toCallbackPage(request: Request, values: Array<[string, string]>, defaultProvider: string) {
  const redirectUrl = new URL("/auth/callback/ui", request.url);
  const fragment = new URLSearchParams();
  for (const [key, value] of values) {
    if (!value) continue;
    if (SECRET_KEYS.has(key)) fragment.set(key, value);
    else redirectUrl.searchParams.set(key, value);
  }
  if (!redirectUrl.searchParams.get("provider")) {
    redirectUrl.searchParams.set("provider", defaultProvider);
  }
  const hash = fragment.toString();
  if (hash) redirectUrl.hash = hash;
  return NextResponse.redirect(redirectUrl);
}

export async function POST(request: Request) {
  const formData = await request.formData();
  const pick = (k: string) => formData.get(k)?.toString() ?? "";
  return toCallbackPage(
    request,
    [
      ["code", pick("code")],
      ["id_token", pick("id_token")],
      ["state", pick("state")],
      ["error", pick("error")],
      ["error_description", pick("error_description")],
      ["provider", "apple"],
    ],
    "apple",
  );
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  return toCallbackPage(request, [...url.searchParams.entries()], "google");
}
