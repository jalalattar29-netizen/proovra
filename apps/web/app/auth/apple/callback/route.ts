import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const formData = await request.formData();
  const code = formData.get("code")?.toString() ?? "";
  const idToken = formData.get("id_token")?.toString() ?? "";
  const state = formData.get("state")?.toString() ?? "";
  const redirectUrl = new URL("/auth/apple/callback", request.url);
  if (code) redirectUrl.searchParams.set("code", code);
  if (idToken) redirectUrl.searchParams.set("id_token", idToken);
  if (state) redirectUrl.searchParams.set("state", state);
  redirectUrl.searchParams.set("provider", "apple");
  return NextResponse.redirect(redirectUrl);
}
