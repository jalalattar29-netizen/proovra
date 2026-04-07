const GOOGLE_CLIENT_ID_FALLBACK =
  "548168595768-8uddhhcmdgl9108juth8fke4boncenut.apps.googleusercontent.com";

export function buildGoogleAuthUrl(params: { state: string; origin?: string }): string {
  const clientId =
    process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ?? GOOGLE_CLIENT_ID_FALLBACK;

  const redirectUri =
    process.env.NEXT_PUBLIC_GOOGLE_REDIRECT_URI ?? "https://www.proovra.com/auth/callback";

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

let googleScriptPromise: Promise<void> | null = null;
let appleScriptPromise: Promise<void> | null = null;

function loadScriptOnce(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (typeof document === "undefined") return resolve();

    const existing = document.querySelector(`script[src="${src}"]`) as HTMLScriptElement | null;

    if (existing?.dataset.loaded === "true") {
      resolve();
      return;
    }

    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener(
        "error",
        () => reject(new Error(`Failed to load ${src}`)),
        { once: true }
      );
      return;
    }

    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.defer = true;

    script.addEventListener(
      "load",
      () => {
        script.dataset.loaded = "true";
        resolve();
      },
      { once: true }
    );

    script.addEventListener(
      "error",
      () => reject(new Error(`Failed to load ${src}`)),
      { once: true }
    );

    document.head.appendChild(script);
  });
}

export function loadGoogleIdentity(): Promise<void> {
  if (!googleScriptPromise) {
    googleScriptPromise = loadScriptOnce("https://accounts.google.com/gsi/client");
  }
  return googleScriptPromise;
}

export function loadAppleIdentity(): Promise<void> {
  if (!appleScriptPromise) {
    appleScriptPromise = loadScriptOnce(
      "https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js"
    );
  }
  return appleScriptPromise;
}

export function buildAppleAuthUrl(params: {
  state: string;
  scope?: string;
  origin?: string;
}): string {
  const clientId =
    process.env.NEXT_PUBLIC_APPLE_CLIENT_ID ?? "com.proovra.web";

  const redirectUri =
    process.env.NEXT_PUBLIC_APPLE_REDIRECT_URI ?? "https://www.proovra.com/auth/callback";

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