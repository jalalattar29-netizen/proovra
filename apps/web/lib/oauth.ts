export function buildGoogleAuthUrl(params: { state: string }): string {
  const clientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ?? "";
  const redirectUri =
    process.env.NEXT_PUBLIC_GOOGLE_REDIRECT_URI ??
    (typeof window !== "undefined"
      ? `${window.location.origin}/auth/apple/callback`
      : "https://www.proovra.com/auth/apple/callback");
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", params.state);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  return url.toString();
}

export function buildAppleAuthUrl(params: {
  state: string;
  scope?: string;
}): string {
  const clientId = process.env.NEXT_PUBLIC_APPLE_CLIENT_ID ?? "com.proovra.web";
  const redirectUri =
    process.env.NEXT_PUBLIC_APPLE_REDIRECT_URI ??
    (typeof window !== "undefined"
      ? `${window.location.origin}/auth/apple/callback`
      : "https://www.proovra.com/auth/apple/callback");
  const scope = params.scope ?? "name email";
  const url = new URL("https://appleid.apple.com/auth/authorize");
  url.searchParams.set("response_type", "code id_token");
  url.searchParams.set("response_mode", "form_post");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", scope);
  url.searchParams.set("state", params.state);
  return url.toString();
}
