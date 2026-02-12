import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const formData = await request.formData();
  const code = formData.get("code")?.toString() ?? "";
  const idToken = formData.get("id_token")?.toString() ?? "";
  const state = formData.get("state")?.toString() ?? "";
  const error = formData.get("error")?.toString() ?? "";
  const errorDescription = formData.get("error_description")?.toString() ?? "";
  const redirectUrl = new URL("/auth/callback/ui", request.url);
  if (code) redirectUrl.searchParams.set("code", code);
  if (idToken) redirectUrl.searchParams.set("id_token", idToken);
  if (state) redirectUrl.searchParams.set("state", state);
  if (error) redirectUrl.searchParams.set("error", error);
  if (errorDescription) redirectUrl.searchParams.set("error_description", errorDescription);
  redirectUrl.searchParams.set("provider", "apple");
  return NextResponse.redirect(redirectUrl);
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const redirectUrl = new URL("/auth/callback/ui", request.url);
  url.searchParams.forEach((value, key) => {
    redirectUrl.searchParams.set(key, value);
  });
  if (!redirectUrl.searchParams.get("provider")) {
    redirectUrl.searchParams.set("provider", "google");
  }
  return NextResponse.redirect(redirectUrl);
}
