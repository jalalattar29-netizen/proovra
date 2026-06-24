"use client";

import {
  Suspense,
  FormEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useToast } from "../../components/ui";
import { useAuth, useLocale } from "../providers";
import { apiFetch, ApiError } from "../../lib/api";
import { authLogger } from "../../lib/auth-logger";
import { loadAppleIdentity, loadGoogleIdentity } from "../../lib/oauth";
import { MarketingHeader } from "../../components/marketing/MarketingHeader";
import {
  clearPendingOAuthLegalAcceptance,
  savePendingOAuthLegalAcceptance,
} from "../../lib/legalAcceptance";
import { evaluatePassword } from "../../lib/passwordRules";

type GoogleCredentialResponse = { credential?: string };

type GoogleAccountsId = {
  initialize: (options: {
    client_id: string;
    callback: (response: GoogleCredentialResponse) => void;
    cancel_on_tap_outside?: boolean;
  }) => void;
  renderButton?: (
    parent: HTMLElement,
    options: {
      type?: "standard" | "icon";
      theme?: "outline" | "filled_blue" | "filled_black";
      size?: "large" | "medium" | "small";
      text?: "signin_with" | "signup_with" | "continue_with" | "signin";
      shape?: "rectangular" | "pill" | "circle" | "square";
      logo_alignment?: "left" | "center";
      width?: number;
      locale?: string;
    }
  ) => void;
};

type GoogleGlobal = Window & {
  google?: { accounts?: { id?: GoogleAccountsId } };
};

type AppleSignInResponse = { authorization?: { code?: string; id_token?: string } };

type AppleAuth = {
  init: (options: {
    clientId: string;
    scope: string;
    redirectURI: string;
    usePopup: boolean;
  }) => void;
  signIn: () => Promise<AppleSignInResponse>;
};

type AppleGlobal = Window & {
  AppleID?: { auth?: AppleAuth };
};

// ============================================================
// Inline icons (no library dependency; matches existing style)
// ============================================================

function EmailIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M20 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2Zm0 4.236-8 4.8-8-4.8V6l8 4.8L20 6v2.236Z"
      />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M17 9h-1V7a4 4 0 0 0-8 0v2H7a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2Zm-7-2a2 2 0 0 1 4 0v2h-4V7Zm3 10.73V19h-2v-1.27a2 2 0 1 1 2 0Z"
      />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path fill="currentColor" d="m9 16.2-3.5-3.5L4.1 14.1 9 19l11-11-1.4-1.4L9 16.2Z" />
    </svg>
  );
}

function AppleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M16.365 1.43c0 1.14-.465 2.18-1.22 2.93-.77.77-1.94 1.37-3.03 1.27-.14-1.1.42-2.26 1.19-3.03.8-.8 2.05-1.36 3.06-1.17zM20.6 17.13c-.55 1.27-.81 1.84-1.51 2.93-.97 1.54-2.34 3.46-4.04 3.48-1.52.02-1.91-.99-3.97-.98-2.06.01-2.49.99-4 .97-1.7-.02-3-1.75-3.97-3.29-2.71-4.33-3-9.42-1.32-12.01 1.19-1.85 3.07-2.94 4.84-2.94 1.81 0 2.95 1 3.97 1 1 0 2.57-1.23 4.33-1.05.74.03 2.82.3 4.16 2.27-.11.07-2.49 1.46-2.46 4.35.03 3.45 3.03 4.6 3.07 4.61z"
      />
    </svg>
  );
}

function ShieldIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M12 2l7 3v6c0 5.25-3.438 10.125-7 11-3.562-.875-7-5.75-7-11V5l7-3Zm0 2.18L7 6.32V11c0 4.164 2.61 8.11 5 8.95 2.39-.84 5-4.786 5-8.95V6.32l-5-2.14Z"
      />
    </svg>
  );
}

function EyeIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M12 5c-5 0-9.27 3.11-11 7 1.73 3.89 6 7 11 7s9.27-3.11 11-7c-1.73-3.89-6-7-11-7Zm0 12a5 5 0 1 1 0-10 5 5 0 0 1 0 10Zm0-8a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z"
      />
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M2.39 1.73 1 3.14l3.11 3.11A12.7 12.7 0 0 0 1 12c1.73 3.89 6 7 11 7 1.83 0 3.55-.41 5.07-1.14L20.85 21l1.41-1.41L2.39 1.73ZM12 17a5 5 0 0 1-4.92-5.92l1.86 1.86A3 3 0 0 0 12 16l1.06-.06 1.86 1.86c-.61.13-1.26.2-1.92.2Zm.86-9.94 6.96 6.96A12.74 12.74 0 0 0 23 12c-1.73-3.89-6-7-11-7-.86 0-1.7.11-2.51.31l3.37 3.37Z"
      />
    </svg>
  );
}

function AlertTriangleIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M12 2 1 21h22L12 2Zm0 4.5L19.53 19H4.47L12 6.5ZM11 10v5h2v-5h-2Zm0 6v2h2v-2h-2Z"
      />
    </svg>
  );
}

function RuleCheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M9 16.2 4.8 12l-1.4 1.4L9 19l12-12-1.4-1.4L9 16.2Z"
      />
    </svg>
  );
}

function RuleCrossIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M19 6.4 17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12 19 6.4Z"
      />
    </svg>
  );
}

function RuleDotIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="3.2" fill="currentColor" />
    </svg>
  );
}

function ShieldCheckIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="m12 1 9 4v6c0 5.55-3.84 10.74-9 12-5.16-1.26-9-6.45-9-12V5l9-4Zm-1.06 14.46L17.18 9.2l-1.42-1.41-4.82 4.82-2.12-2.12-1.41 1.41 3.53 3.56Z"
      />
    </svg>
  );
}

function SpinnerIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      style={{ animation: "auth-spin 0.9s linear infinite" }}
    >
      <circle
        cx="12"
        cy="12"
        r="9"
        fill="none"
        stroke="currentColor"
        strokeOpacity="0.25"
        strokeWidth="3"
      />
      <path
        d="M21 12a9 9 0 0 1-9 9"
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}

// ============================================================
// Password validation rules and helpers live in lib/passwordRules.ts
// (see imports at top). Shared with the reset-password page so the two
// flows present identical validation UX.
// ============================================================

// Conservative client-side email format check (server still re-validates).
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const REQUIRED_LEGAL_VERSIONS = {
  terms: "2026-04-06",
  privacy: "2026-04-06",
  cookies: "2026-04-06",
} as const;

// 4-step onboarding loading sequence — each step maps to a real backend
// event (POST, server-side workspace bootstrap, legal acceptance write,
// redirect). 0 = idle.
type RegisterStep = 0 | 1 | 2 | 3 | 4;

const REGISTER_STEP_LABELS: Readonly<Record<Exclude<RegisterStep, 0>, string>> = {
  1: "Creating account...",
  2: "Provisioning workspace...",
  3: "Finalizing setup...",
  4: "Almost ready...",
};

export default function RegisterPage() {
  return (
    <Suspense fallback={null}>
      <RegisterPageContent />
    </Suspense>
  );
}

function RegisterPageContent() {
  const { t } = useLocale();
  const { setToken } = useAuth();
  const { addToast } = useToast();
  const router = useRouter();
  const searchParams = useSearchParams();
  const returnUrl = searchParams.get("returnUrl") || "/home";

  // Existing state — preserved verbatim so OAuth/Apple/Guest paths
  // continue to work without behavioural change.
  const [acceptLegal, setAcceptLegal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [appleReady, setAppleReady] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");

  // New state — UX hardening only. No effect on OAuth/Apple/Guest flows.
  const [showPwd, setShowPwd] = useState(false);
  const [showPwd2, setShowPwd2] = useState(false);
  const [emailTouched, setEmailTouched] = useState(false);
  const [passwordTouched, setPasswordTouched] = useState(false);
  const [passwordFocused, setPasswordFocused] = useState(false);
  const [capsLockOn, setCapsLockOn] = useState(false);
  const [registerStep, setRegisterStep] = useState<RegisterStep>(0);
  const [registerSuccess, setRegisterSuccess] = useState(false);
  // EV5 — email-verification "check your email" state.
  //  - registeredEmail freezes the address we sent the link to, so
  //    the success card can show it even after the input is cleared
  //  - resendStatus surfaces "Sending..." / "Sent" / cooldown
  //  - resendBusy debounces the button (the backend also rate-limits)
  const [registeredEmail, setRegisteredEmail] = useState<string | null>(null);
  const [resendBusy, setResendBusy] = useState(false);
  const [resendStatus, setResendStatus] = useState<string | null>(null);

  // Email availability state machine — runs only after a syntactically
  // valid email is typed. Backend endpoint is rate-limited per IP; we
  // debounce on the client to avoid hammering it on every keystroke.
  //  - "idle"           = field empty, no check
  //  - "invalid-format" = client-side regex rejected (no backend call)
  //  - "checking"       = debounce window elapsed, request in-flight
  //  - "available"      = backend confirmed not taken
  //  - "exists"         = backend confirmed an account already exists
  //  - "error"          = network/availability call failed
  type EmailAvailability =
    | "idle"
    | "invalid-format"
    | "checking"
    | "available"
    | "exists"
    | "error";
  const [emailAvailability, setEmailAvailability] = useState<EmailAvailability>("idle");

  const inFlightRef = useRef(false);
  const googleInitOnceRef = useRef(false);
  const googleBtnWrapRef = useRef<HTMLDivElement | null>(null);
  const googleBtnHostRef = useRef<HTMLDivElement | null>(null);
  const acceptLegalRef = useRef(false);
  const returnUrlRef = useRef(returnUrl);

  const ui = useMemo(() => {
    const cardShadow = "0 26px 70px rgba(2, 9, 22, 0.16)";
    const border = "1px solid rgba(79, 112, 107, 0.18)";
    const socialMaxW = 360;
    const inputShadow = "0 12px 28px rgba(6, 16, 22, 0.08)";
    return { cardShadow, border, socialMaxW, inputShadow };
  }, []);

  const passwordEval = useMemo(() => evaluatePassword(password), [password]);
  const emailFormatValid = email.length === 0 ? null : EMAIL_REGEX.test(email);
  const showEmailInvalid = emailTouched && email.length > 0 && emailFormatValid === false;
  // Show the rules panel only when:
  //  - the password (or confirm) field has focus, OR
  //  - the user already typed something AND it does NOT pass all
  //    rules — i.e. an active validation error keeps the panel up so
  //    the operator can see what's missing on submit failure.
  // Once focus leaves password AND every rule passes (or the field is
  // empty), the panel collapses — no more "always-on" panel after
  // typing, and no panel hanging open for a never-touched empty field.
  const showPasswordRules =
    passwordFocused ||
    (passwordTouched && password.length > 0 && !passwordEval.allMet);
  const passwordsMismatch = password2.length > 0 && password !== password2;

  useEffect(() => {
    acceptLegalRef.current = acceptLegal;
  }, [acceptLegal]);

  useEffect(() => {
    returnUrlRef.current = returnUrl;
  }, [returnUrl]);

  // Debounced email availability check. Fires only when the email is
  // syntactically valid; transitions through checking → available |
  // exists | error. The request is racey by nature (user keeps typing)
  // so we discard responses for stale email values via the captured
  // `current` snapshot.
  useEffect(() => {
    const trimmed = email.trim();
    if (trimmed.length === 0) {
      setEmailAvailability("idle");
      return;
    }
    if (!EMAIL_REGEX.test(trimmed)) {
      setEmailAvailability("invalid-format");
      return;
    }

    setEmailAvailability("checking");
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const data = (await apiFetch(
          `/v1/auth/email/availability?email=${encodeURIComponent(trimmed)}`,
          { method: "GET" },
          { auth: false },
        )) as { available?: boolean; reason?: string } | null;
        if (cancelled) return;
        if (data?.available === true) {
          setEmailAvailability("available");
        } else if (data?.reason === "EMAIL_ALREADY_EXISTS") {
          setEmailAvailability("exists");
        } else if (data?.reason === "INVALID_FORMAT") {
          setEmailAvailability("invalid-format");
        } else {
          setEmailAvailability("error");
        }
      } catch {
        if (!cancelled) setEmailAvailability("error");
      }
    }, 500);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [email]);

  const getRequiredAcceptances = () => [
    {
      policyKey: "terms" as const,
      policyVersion: REQUIRED_LEGAL_VERSIONS.terms,
    },
    {
      policyKey: "privacy" as const,
      policyVersion: REQUIRED_LEGAL_VERSIONS.privacy,
    },
    {
      policyKey: "cookies" as const,
      policyVersion: REQUIRED_LEGAL_VERSIONS.cookies,
    },
  ];

  const persistPendingOAuthLegalAcceptance = () => {
    savePendingOAuthLegalAcceptance({
      source: "register",
      returnUrl: returnUrlRef.current.startsWith("/") ? returnUrlRef.current : "/home",
      acceptances: getRequiredAcceptances(),
      createdAt: new Date().toISOString(),
    });
  };

  const setReturnUrl = (url: string) => {
    try {
      sessionStorage.setItem("proovra-return-url", url);
    } catch {
      // ignore
    }
  };

  const recordRequiredLegalAcceptances = async () => {
    await apiFetch("/v1/users/legal-acceptance", {
      method: "POST",
      body: JSON.stringify({
        source: "register",
        acceptances: getRequiredAcceptances(),
      }),
    });
  };

  // Caps Lock detector — fires on every keystroke in a password field.
  // Uses the standardized KeyboardEvent.getModifierState contract.
  const handleCapsLockKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (typeof e.getModifierState === "function") {
      setCapsLockOn(e.getModifierState("CapsLock"));
    }
  };

  const handleAuth = async (
    path: string,
    idToken?: string,
    code?: string,
    extraBody?: Record<string, unknown>
  ) => {
    if (inFlightRef.current) return;

    const accepted = acceptLegalRef.current;
    const currentReturnUrl = returnUrlRef.current.startsWith("/") ? returnUrlRef.current : "/home";

    if (!accepted) {
      const msg =
        "You must accept the Terms of Service, Privacy Policy, and Cookie Policy to create an account.";
      setError(msg);
      addToast(msg, "error");
      return;
    }

    inFlightRef.current = true;
    setBusy(true);
    setError(null);

    const provider = path.includes("google")
      ? "google"
      : path.includes("apple")
        ? "apple"
        : path.includes("guest")
          ? "guest"
          : "email";

    // 4-step loading sequence is driven only by the email-register
    // path. OAuth flows continue to use the existing single-line
    // `status` string so their callback semantics don't shift.
    const isEmailRegisterFlow = path === "/v1/auth/email/register";

    if (provider === "google" || provider === "apple") {
      persistPendingOAuthLegalAcceptance();
    } else {
      clearPendingOAuthLegalAcceptance();
    }

    if (isEmailRegisterFlow) {
      setRegisterStep(1);
      setStatus(REGISTER_STEP_LABELS[1]);
    } else {
      setStatus(`Signing in via ${provider}...`);
    }

    const guestToken =
      typeof window !== "undefined" ? localStorage.getItem("proovra-token") : null;

    try {
      setReturnUrl(currentReturnUrl);

      const payload = extraBody ?? (idToken ? { idToken } : code ? { code } : {});
      const data = await apiFetch(
        path,
        { method: "POST", body: JSON.stringify(payload) },
        { auth: false }
      );

      // R8.1.2 — login-time MFA challenge (same flow as login page).
      // OAuth registration may resolve to an existing user that has
      // MFA enrolled — in that case the backend reports mfaRequired
      // and we bounce to /auth/mfa-challenge.
      if (data?.mfaRequired === true) {
        const next = encodeURIComponent(currentReturnUrl);
        router.push(`/auth/mfa-challenge?next=${next}`);
        return;
      }

      // EV5 — email-register branches off here. The backend no
      // longer issues a JWT on register; it sends a verification
      // email and returns `{ verificationSent, email }`. We freeze
      // the email and flip to the "check your email" success card.
      // Legal acceptance is deferred until /v1/auth/email/verify
      // succeeds — that endpoint mints the session JWT, and the
      // verify-email page records the acceptances + claim then.
      if (isEmailRegisterFlow) {
        setRegisterStep(4);
        setStatus(REGISTER_STEP_LABELS[4]);
        setRegisteredEmail((data?.email as string | undefined) ?? email);
        setRegisterSuccess(true);
        return;
      }

      if (!data?.token) {
        throw new Error("Authentication failed: missing token");
      }

      setToken(data.token);

      try {
        await recordRequiredLegalAcceptances();
        clearPendingOAuthLegalAcceptance();
      } catch {
        addToast(
          "Account created, but legal acceptance logging could not be saved.",
          "warning"
        );
      }

      if (guestToken) {
        try {
          await apiFetch("/v1/evidence/claim", {
            method: "POST",
            body: JSON.stringify({ guestToken }),
          });
        } catch {
          // ignore
        }
      }

      router.push(currentReturnUrl);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Registration failed";
      const requestId = err instanceof ApiError ? err.requestId : undefined;
      const errCode = err instanceof ApiError ? err.code : undefined;

      authLogger.log("AUTH_SESSION_FAILED", "error", { message: msg, requestId }, provider);
      // Race / rate-limit-skipped path: the availability poll may not
      // have caught the existing account before the user hit submit.
      // The backend returns 409 EMAIL_ALREADY_EXISTS in that case;
      // flip the availability state so the inline "Sign in / Forgot
      // password?" affordance appears with proper deep-links.
      if (isEmailRegisterFlow && errCode === "EMAIL_ALREADY_EXISTS") {
        setEmailAvailability("exists");
        setError(
          "An account already exists for this email. Sign in or reset your password instead."
        );
      } else {
        setError(requestId ? `${msg} (requestId: ${requestId})` : msg);
      }
      setStatus("Sign in failed.");
      addToast(requestId ? `${msg} (requestId: ${requestId})` : msg, "error", 6000);
      if (isEmailRegisterFlow) {
        setRegisterStep(0);
        setRegisterSuccess(false);
      }
    } finally {
      setBusy(false);
      inFlightRef.current = false;
    }
  };

  const renderGoogleButton = () => {
    const host = googleBtnHostRef.current;
    const wrap = googleBtnWrapRef.current;
    if (!host || !wrap) return;

    const google = (window as GoogleGlobal).google;
    const id = google?.accounts?.id;
    if (!id?.renderButton) return;

    const width = Math.min(ui.socialMaxW, host.getBoundingClientRect().width || ui.socialMaxW);

    wrap.innerHTML = "";
    id.renderButton(wrap, {
      type: "standard",
      theme: "outline",
      size: "large",
      text: "continue_with",
      shape: "pill",
      logo_alignment: "left",
      width: Math.round(width),
      locale: "en",
    });
  };

  useEffect(() => {
    if (typeof window === "undefined") return;

    loadGoogleIdentity()
      .then(() => {
        const clientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ?? "";
        if (!clientId) return;

        const google = (window as GoogleGlobal).google;
        const id = google?.accounts?.id;
        if (!id?.initialize) return;

        if (!googleInitOnceRef.current) {
          googleInitOnceRef.current = true;
          id.initialize({
            client_id: clientId,
            cancel_on_tap_outside: true,
            callback: (response: GoogleCredentialResponse) => {
              const idToken = response.credential;
              if (!idToken) {
                setError("Google sign-up failed.");
                return;
              }
              void handleAuth("/v1/auth/google", idToken);
            },
          });
        }

        renderGoogleButton();

        const ro = new ResizeObserver(() => renderGoogleButton());
        if (googleBtnHostRef.current) ro.observe(googleBtnHostRef.current);
        return () => ro.disconnect();
      })
      .catch(() => {
        // ignore
      });

    loadAppleIdentity()
      .then(() => {
        const appleClientId = process.env.NEXT_PUBLIC_APPLE_CLIENT_ID ?? "";
        if (!appleClientId) {
          setAppleReady(false);
          return;
        }

        const AppleID = (window as AppleGlobal).AppleID;
        const auth = AppleID?.auth;
        if (!auth?.init) {
          setAppleReady(false);
          return;
        }

        const redirectUri =
          process.env.NEXT_PUBLIC_APPLE_REDIRECT_URI ??
          `${window.location.origin}/auth/callback`;

        auth.init({
          clientId: appleClientId,
          scope: "name email",
          redirectURI: redirectUri,
          usePopup: true,
        });

        setAppleReady(true);
      })
      .catch(() => setAppleReady(false));
  }, [ui.socialMaxW]);

  const startApple = async () => {
    setReturnUrl(returnUrlRef.current);

    if (!acceptLegalRef.current) {
      const msg =
        "You must accept the Terms of Service, Privacy Policy, and Cookie Policy to create an account.";
      setError(msg);
      addToast(msg, "error");
      return;
    }

    persistPendingOAuthLegalAcceptance();

    if (busy || inFlightRef.current) return;

    const AppleID = (window as AppleGlobal).AppleID;
    const auth = AppleID?.auth;

    if (!appleReady || !auth?.signIn) {
      const msg = "Apple sign-up is not ready yet.";
      setError(msg);
      addToast(msg, "error");
      return;
    }

    try {
      const response = await auth.signIn();
      const idToken = response.authorization?.id_token;
      const code = response.authorization?.code;

      if (!idToken && !code) {
        const msg = "Apple sign-up failed: No token received.";
        setError(msg);
        addToast(msg, "error");
        return;
      }

      await handleAuth("/v1/auth/apple", idToken, code);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Apple sign-up failed";
      setError(msg);
      addToast(msg, "error");
    }
  };

  // EV5 — resend the verification email for the address the user just
  // registered. Backend is rate-limited per IP + per email; the UI
  // defends with `resendBusy` so a frantic double-click doesn't
  // immediately trip the cooldown. Response is neutral by design — we
  // surface a generic confirmation regardless of backend outcome.
  const onResendVerification = async () => {
    if (resendBusy || !registeredEmail) return;
    setResendBusy(true);
    setResendStatus("Sending verification email…");
    try {
      await apiFetch(
        "/v1/auth/email/resend-verification",
        {
          method: "POST",
          body: JSON.stringify({ email: registeredEmail }),
        },
        { auth: false },
      );
      setResendStatus("Verification email sent.");
    } catch {
      setResendStatus(
        "Please wait before requesting another verification email.",
      );
    } finally {
      // Match the backend per-email cooldown so the button stays
      // disabled for the full window even if the network was instant.
      window.setTimeout(() => setResendBusy(false), 60_000);
    }
  };

  // EV5 — abandon the "check your email" card and bring the user back
  // to the empty form so they can retry with a different address.
  const onChangeEmail = () => {
    setRegisterSuccess(false);
    setRegisteredEmail(null);
    setResendStatus(null);
    setResendBusy(false);
    setRegisterStep(0);
    setStatus(null);
    setEmail("");
    setEmailTouched(false);
    setEmailAvailability("idle");
  };

  const onEmailRegister = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setEmailTouched(true);
    setPasswordTouched(true);

    if (!email || !password || !password2) {
      setError("Please fill in your email and choose a password.");
      return;
    }

    if (!EMAIL_REGEX.test(email)) {
      setError("Please enter a valid email address.");
      return;
    }

    if (emailAvailability === "exists") {
      setError(
        "An account already exists for this email. Sign in or reset your password instead."
      );
      return;
    }

    if (!passwordEval.allMet) {
      setError(
        "Your password does not meet the requirements listed below the password field."
      );
      return;
    }

    if (password !== password2) {
      setError("Passwords do not match.");
      return;
    }

    void handleAuth("/v1/auth/email/register", undefined, undefined, { email, password });
  };

  const SocialHostStyle: CSSProperties = {
    width: "100%",
    maxWidth: ui.socialMaxW,
    margin: "0 auto",
  };

  // Field-id constants so labels/aria-* references stay in sync.
  const EMAIL_FIELD_ID = "register-email";
  const PASSWORD_FIELD_ID = "register-password";
  const PASSWORD_CONFIRM_FIELD_ID = "register-password-confirm";
  const PASSWORD_RULES_DESC_ID = "register-password-rules";
  const EMAIL_FEEDBACK_ID = "register-email-feedback";
  const STATUS_LIVE_ID = "register-status-live";

  return (
    <div className="page landing-page">
      <style jsx global>{`
        @keyframes auth-spin {
          to {
            transform: rotate(360deg);
          }
        }
      `}</style>
      <div className="relative min-h-screen overflow-hidden">
        <div className="absolute inset-0">
          <img
            src="/assets/hero/register-logo...png"
            alt=""
            className="h-full w-full object-cover object-center"
          />
        </div>

        {/* Warm readability overlay — only as much as needed to keep
            the auth card legible against the bright sunrise artwork. */}
        <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(255,229,207,0.10)_0%,rgba(255,255,255,0.02)_45%,rgba(33,22,45,0.10)_100%)]" />

        <div className="relative z-10 flex min-h-screen flex-col">
          <MarketingHeader />

          <main className="flex flex-1 items-center px-6 pb-14 pt-24 md:px-8 md:pb-20 md:pt-28">
            <div className="mx-auto w-full max-w-7xl">
              <div className="grid gap-10 lg:grid-cols-[0.92fr_0.88fr] lg:items-start">
                {/* Left column is offset down on desktop only so its
                    "Create Account" eyebrow lines up with the right
                    card's "Create your account" headline. The right
                    card has 36px padding + ~38px eyebrow chip + 16px
                    margin = ~90px from card-top to the headline.
                    Mobile stays at zero offset. */}
                <section className="hidden lg:block lg:pt-[88px]">
                  <div className="max-w-[900px]">
                    <div className="inline-flex items-center gap-2.5 rounded-full border border-[rgba(230,72,128,0.22)] bg-white/70 px-4 py-2 text-[0.74rem] font-semibold uppercase tracking-[0.2em] text-[#21162D] shadow-[0_10px_24px_rgba(33,22,45,0.10)] backdrop-blur-md">
                      <span style={{ color: "#E64880" }}>
                        <ShieldIcon />
                      </span>
                      Create Account
                    </div>

                    <h1 className="mt-5 max-w-[760px] text-[2rem] font-medium leading-[0.98] tracking-[-0.045em] text-[#1B1230] md:text-[2.7rem] xl:text-[3.25rem]">
                      Create your secure{" "}
                      <span
                        style={{
                          background:
                            "linear-gradient(90deg,#C92C63 0%,#D63E76 38%,#E14A68 68%,#8B3DE6 100%)",
                          WebkitBackgroundClip: "text",
                          WebkitTextFillColor: "transparent",
                          backgroundClip: "text",
                          color: "transparent",
                        }}
                      >
                        PROOVRA
                      </span>{" "}
                      account.
                    </h1>

                    <p className="mt-5 max-w-[760px] text-[1rem] leading-[1.82] tracking-[-0.006em] text-[#4B3B4F]">
                      Register to manage evidence records, verification pages, reports, and
                      protected review workflows from one place.
                    </p>

                    <div className="mt-6 flex flex-wrap gap-2.5">
                      {[
                        "Evidence Operations Platform",
                        "Verification-First Architecture",
                        "Trusted Workflows for Legal, Compliance & Review Workspaces",
                      ].map((label) => (
                        <div
                          key={label}
                          className="rounded-full border px-3.5 py-2 text-[0.78rem] font-medium text-[#21162D] backdrop-blur-md"
                          style={{
                            background: "rgba(255,255,255,0.16)",
                            borderColor: "rgba(255,255,255,0.32)",
                            backdropFilter: "blur(10px)",
                            WebkitBackdropFilter: "blur(10px)",
                          }}
                        >
                          <span className="mr-2" style={{ color: "#E64880" }}>✓</span>
                          {label}
                        </div>
                      ))}
                    </div>
                  </div>
                </section>
                <section className="mx-auto w-full max-w-[520px]">
                  <div
                    className="auth-card auth-premium relative overflow-hidden rounded-[28px]"
                    style={{
                      boxShadow: "0 28px 80px rgba(59,28,74,0.22)",
                      border: "1px solid rgba(255,255,255,0.45)",
                      background: "rgba(255,255,255,0.74)",
                      backdropFilter: "blur(22px) saturate(1.1)",
                      WebkitBackdropFilter: "blur(22px) saturate(1.1)",
                    }}
                  >
                    {/* Warm corner highlights on the glass surface */}
                    <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_85%_15%,rgba(255,179,107,0.16),transparent_40%)]" />
                    <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_12%_8%,rgba(255,255,255,0.55),transparent_30%)]" />

                    <div className="relative z-10 p-8 lg:p-9">
                      {registerSuccess ? (
                        <div role="status" aria-live="polite" aria-atomic="true">
                          <div
                            className="inline-flex items-center gap-2.5 rounded-full px-4 py-2.5 text-[0.74rem] font-semibold uppercase tracking-[0.18em]"
                            style={{
                              color: "#21162D",
                              background: "rgba(230,72,128,0.08)",
                              border: "1px solid rgba(230,72,128,0.20)",
                            }}
                          >
                            <span style={{ color: "#E64880" }}>
                              <ShieldIcon />
                            </span>
                            Verify your email
                          </div>

                          <h2 className="mt-4 text-[1.9rem] font-semibold tracking-[-0.04em] text-[#1B1230] md:text-[2.15rem]">
                            Verify your email address
                          </h2>

                          <p className="mt-3 text-[0.96rem] leading-[1.78] text-[#4B3B4F]">
                            We&rsquo;ve sent a verification email to{" "}
                            <strong style={{ color: "#1B1230", wordBreak: "break-all" }}>
                              {registeredEmail ?? email}
                            </strong>
                            . Please open the email and click the verification link to
                            activate your PROOVRA account.
                          </p>

                          <p className="mt-3 text-[0.86rem] leading-[1.68] text-[#7A687D]">
                            If you don&rsquo;t see the email within a minute, check your
                            spam folder. Verification links expire after 24&nbsp;hours.
                          </p>

                          <div className="mt-6 flex flex-wrap items-center gap-3">
                            <button
                              type="button"
                              onClick={() => void onResendVerification()}
                              disabled={resendBusy}
                              className="auth-social-btn"
                              style={{
                                background: resendBusy
                                  ? "rgba(230,72,128,0.18)"
                                  : "linear-gradient(90deg, #E64880 0%, #FF6B6B 52%, #FF8A6A 100%)",
                                color: resendBusy ? "#7A687D" : "#ffffff",
                                border: "1px solid rgba(230,72,128,0.45)",
                                boxShadow: resendBusy
                                  ? "none"
                                  : "0 14px 28px rgba(230,72,128,0.22)",
                                fontWeight: 600,
                                cursor: resendBusy ? "not-allowed" : "pointer",
                              }}
                            >
                              {resendBusy ? "Resend pending…" : "Resend email"}
                            </button>
                            <button
                              type="button"
                              onClick={onChangeEmail}
                              className="auth-link"
                              style={{
                                color: "#1B1230",
                                background: "rgba(255,255,255,0.42)",
                                border: "1px solid rgba(255,255,255,0.45)",
                                borderRadius: 999,
                                padding: "10px 16px",
                                fontWeight: 500,
                                fontSize: 14,
                              }}
                            >
                              Change email
                            </button>
                            <Link
                              href="/login"
                              className="auth-link"
                              style={{ color: "#D63E76", fontWeight: 600, fontSize: 14 }}
                            >
                              Back to sign in
                            </Link>
                          </div>

                          {resendStatus ? (
                            <div
                              role="status"
                              aria-live="polite"
                              className="mt-4 text-[13px]"
                              style={{
                                color: "#4B3B4F",
                                background: "rgba(255,255,255,0.52)",
                                border: "1px solid rgba(230,72,128,0.18)",
                                borderRadius: 14,
                                padding: "10px 12px",
                              }}
                            >
                              {resendStatus}
                            </div>
                          ) : null}
                        </div>
                      ) : (
                        <>
                          <div className="mb-6">
                            <div
                              className="inline-flex items-center gap-2.5 rounded-full px-4 py-2.5 text-[0.74rem] font-semibold uppercase tracking-[0.18em]"
                              style={{
                                color: "#21162D",
                                background: "rgba(230,72,128,0.08)",
                                border: "1px solid rgba(230,72,128,0.20)",
                              }}
                            >
                              <span style={{ color: "#E64880" }}>
                                <ShieldIcon />
                              </span>
                              Account setup
                            </div>

                            <h2 className="mt-4 text-[1.9rem] font-semibold tracking-[-0.04em] text-[#1B1230] md:text-[2.15rem]">
                              Create your account
                            </h2>

                            <p className="mt-3 text-[0.96rem] leading-[1.78] text-[#4B3B4F]">
                              Create your account using Google, Apple, or email and continue
                              directly into your PROOVRA workspace.
                            </p>
                          </div>

                          <div className="auth-actions" style={{ display: "grid", gap: 12 }}>
                            <div
                              ref={googleBtnHostRef}
                              style={SocialHostStyle}
                              aria-label="Continue with Google"
                            >
                              <div
                                ref={googleBtnWrapRef}
                                style={{
                                  width: "100%",
                                  display: "flex",
                                  justifyContent: "center",
                                  opacity: busy ? 0.7 : 1,
                                  pointerEvents: busy ? "none" : "auto",
                                }}
                              />
                            </div>

                            <div style={SocialHostStyle}>
                              <button
                                type="button"
                                aria-label="Continue with Apple"
                                disabled={busy}
                                onClick={() => void startApple()}
                                className="auth-social-btn"
                                style={{
                                  background:
                                    "linear-gradient(180deg, #2A1C36 0%, #15101F 100%)",
                                  color: "#ffffff",
                                  border: "1px solid rgba(33,22,45,0.45)",
                                  boxShadow: "0 14px 28px rgba(33,22,45,0.22)",
                                  fontWeight: 600,
                                }}
                              >
                                <span className="auth-social-icon" aria-hidden="true">
                                  <AppleIcon />
                                </span>
                                Continue with Apple
                              </button>
                            </div>

                            <div
                              className="auth-divider"
                              style={{
                                color: "#7A687D",
                              }}
                            >
                              {t("orDivider")}
                            </div>

                            <form onSubmit={onEmailRegister} style={{ display: "grid", gap: 10 }} noValidate>
                              {/* EMAIL */}
                              <label
                                htmlFor={EMAIL_FIELD_ID}
                                className="sr-only"
                                style={{
                                  position: "absolute",
                                  width: 1,
                                  height: 1,
                                  padding: 0,
                                  margin: -1,
                                  overflow: "hidden",
                                  clip: "rect(0,0,0,0)",
                                  whiteSpace: "nowrap",
                                  border: 0,
                                }}
                              >
                                Email address
                              </label>
                              <div className="auth-input-wrap">
                                <span
                                  className="auth-input-icon"
                                  aria-hidden="true"
                                  style={{ color: "#7A687D" }}
                                >
                                  <EmailIcon />
                                </span>
                                <input
                                  id={EMAIL_FIELD_ID}
                                  name="email"
                                  className="auth-input"
                                  placeholder="Email"
                                  type="email"
                                  autoComplete="email"
                                  inputMode="email"
                                  spellCheck={false}
                                  required
                                  value={email}
                                  onChange={(e) => setEmail(e.target.value)}
                                  onBlur={() => setEmailTouched(true)}
                                  aria-invalid={
                                    showEmailInvalid ||
                                    emailAvailability === "exists" ||
                                    emailAvailability === "invalid-format"
                                  }
                                  aria-describedby={EMAIL_FEEDBACK_ID}
                                  disabled={busy}
                                  style={{
                                    background: "rgba(255,255,255,0.9)",
                                    border:
                                      showEmailInvalid ||
                                      emailAvailability === "exists" ||
                                      emailAvailability === "invalid-format"
                                        ? "1px solid rgba(209,67,67,0.6)"
                                        : "1px solid rgba(79,112,107,0.16)",
                                    boxShadow: ui.inputShadow,
                                    color: "#102126",
                                  }}
                                />
                              </div>
                              <div
                                id={EMAIL_FEEDBACK_ID}
                                role="status"
                                aria-live="polite"
                                style={{
                                  minHeight:
                                    email.length > 0 && emailAvailability !== "idle" ? 18 : 0,
                                  fontSize: 12.5,
                                  lineHeight: "18px",
                                  paddingLeft: 4,
                                  transition: "min-height 120ms ease",
                                }}
                              >
                                {showEmailInvalid || emailAvailability === "invalid-format" ? (
                                  <span style={{ color: "#B42318" }}>
                                    Enter a valid email address.
                                  </span>
                                ) : emailAvailability === "checking" ? (
                                  <span
                                    style={{
                                      color: "#5c6a6e",
                                      display: "inline-flex",
                                      alignItems: "center",
                                      gap: 6,
                                    }}
                                  >
                                    <SpinnerIcon />
                                    Checking email…
                                  </span>
                                ) : emailAvailability === "available" ? (
                                  <span style={{ color: "#0F8A5F" }}>Email is available.</span>
                                ) : emailAvailability === "exists" ? (
                                  <span
                                    style={{
                                      color: "#B42318",
                                      display: "inline-flex",
                                      alignItems: "center",
                                      gap: 8,
                                      flexWrap: "wrap",
                                    }}
                                  >
                                    An account already exists for this email.
                                    <Link
                                      href={`/login?email=${encodeURIComponent(email.trim())}`}
                                      className="auth-link"
                                      style={{ color: "#D63E76", fontWeight: 600 }}
                                    >
                                      Sign in
                                    </Link>
                                    <span style={{ color: "#5c6a6e" }}>·</span>
                                    <Link
                                      href={`/forgot-password?email=${encodeURIComponent(email.trim())}`}
                                      className="auth-link"
                                      style={{ color: "#D63E76", fontWeight: 600 }}
                                    >
                                      Forgot password?
                                    </Link>
                                  </span>
                                ) : emailAvailability === "error" ? (
                                  <span style={{ color: "#B45309" }}>
                                    Could not verify email — you can still try to register.
                                  </span>
                                ) : null}
                              </div>

                              {/* PASSWORD with show/hide */}
                              <label
                                htmlFor={PASSWORD_FIELD_ID}
                                className="sr-only"
                                style={{
                                  position: "absolute",
                                  width: 1,
                                  height: 1,
                                  padding: 0,
                                  margin: -1,
                                  overflow: "hidden",
                                  clip: "rect(0,0,0,0)",
                                  whiteSpace: "nowrap",
                                  border: 0,
                                }}
                              >
                                Password
                              </label>
                              <div
                                className="auth-input-wrap"
                                style={{ position: "relative" }}
                              >
                                <span
                                  className="auth-input-icon"
                                  aria-hidden="true"
                                  style={{ color: "#7A687D" }}
                                >
                                  <LockIcon />
                                </span>
                                <input
                                  id={PASSWORD_FIELD_ID}
                                  name="new-password"
                                  className="auth-input"
                                  placeholder="Password"
                                  type={showPwd ? "text" : "password"}
                                  autoComplete="new-password"
                                  required
                                  value={password}
                                  onChange={(e) => setPassword(e.target.value)}
                                  onFocus={() => setPasswordFocused(true)}
                                  onBlur={() => {
                                    setPasswordFocused(false);
                                    setPasswordTouched(true);
                                  }}
                                  onKeyDown={handleCapsLockKey}
                                  onKeyUp={handleCapsLockKey}
                                  aria-describedby={PASSWORD_RULES_DESC_ID}
                                  aria-invalid={passwordTouched && !passwordEval.allMet}
                                  disabled={busy}
                                  style={{
                                    background: "rgba(255,255,255,0.9)",
                                    border:
                                      passwordTouched && !passwordEval.allMet
                                        ? "1px solid rgba(209,67,67,0.4)"
                                        : "1px solid rgba(79,112,107,0.16)",
                                    boxShadow: ui.inputShadow,
                                    color: "#102126",
                                    paddingRight: 44,
                                  }}
                                />
                                <button
                                  type="button"
                                  aria-label={showPwd ? "Hide password" : "Show password"}
                                  aria-pressed={showPwd}
                                  onClick={() => setShowPwd((v) => !v)}
                                  disabled={busy}
                                  style={{
                                    position: "absolute",
                                    right: 10,
                                    top: "50%",
                                    transform: "translateY(-50%)",
                                    width: 28,
                                    height: 28,
                                    display: "inline-flex",
                                    alignItems: "center",
                                    justifyContent: "center",
                                    borderRadius: 8,
                                    border: "1px solid transparent",
                                    background: "transparent",
                                    color: "#446166",
                                    cursor: busy ? "not-allowed" : "pointer",
                                  }}
                                >
                                  {showPwd ? <EyeOffIcon /> : <EyeIcon />}
                                </button>
                              </div>

                              {/* Caps Lock + strength meter + rules panel */}
                              {capsLockOn ? (
                                <div
                                  role="status"
                                  aria-live="polite"
                                  style={{
                                    display: "inline-flex",
                                    alignItems: "center",
                                    gap: 6,
                                    fontSize: 12.5,
                                    color: "#9A5A20",
                                    padding: "4px 8px",
                                    borderRadius: 8,
                                    background: "rgba(230,128,40,0.10)",
                                    border: "1px solid rgba(230,128,40,0.28)",
                                    width: "fit-content",
                                  }}
                                >
                                  <AlertTriangleIcon /> Caps Lock is enabled
                                </div>
                              ) : null}

                              {showPasswordRules ? (
                                <>
                                  {/* Strength bar */}
                                  <div
                                    aria-hidden="true"
                                    style={{
                                      display: "grid",
                                      gridTemplateColumns: "repeat(5, 1fr)",
                                      gap: 4,
                                      marginTop: 2,
                                    }}
                                  >
                                    {[0, 1, 2, 3, 4].map((i) => {
                                      const filled =
                                        password.length > 0 && i <= passwordEval.score;
                                      return (
                                        <span
                                          key={i}
                                          style={{
                                            height: 4,
                                            borderRadius: 2,
                                            background: filled
                                              ? passwordEval.color
                                              : "rgba(86,99,102,0.16)",
                                            transition:
                                              "background 220ms ease, opacity 220ms ease",
                                            opacity: filled ? 1 : 0.7,
                                          }}
                                        />
                                      );
                                    })}
                                  </div>
                                  <div
                                    style={{
                                      display: "flex",
                                      justifyContent: "space-between",
                                      fontSize: 12,
                                      color: "#5c6a6e",
                                      marginTop: -2,
                                    }}
                                  >
                                    <span>Password strength</span>
                                    <span
                                      style={{
                                        color:
                                          password.length === 0
                                            ? "#5c6a6e"
                                            : passwordEval.color,
                                        fontWeight: 600,
                                      }}
                                    >
                                      {password.length === 0 ? "—" : passwordEval.label}
                                    </span>
                                  </div>

                                  {/* Rules checklist */}
                                  <ul
                                    id={PASSWORD_RULES_DESC_ID}
                                    aria-label="Password requirements"
                                    style={{
                                      listStyle: "none",
                                      padding: 0,
                                      margin: "4px 0 2px 0",
                                      display: "grid",
                                      gap: 4,
                                      fontSize: 12.5,
                                      lineHeight: "18px",
                                    }}
                                  >
                                    {passwordEval.ruleResults.map((r) => {
                                      const interactedFail = passwordTouched && !r.met;
                                      const color = r.met
                                        ? "#0F8A5F"
                                        : interactedFail
                                          ? "#B42318"
                                          : "#5c6a6e";
                                      const icon = r.met ? (
                                        <RuleCheckIcon />
                                      ) : interactedFail ? (
                                        <RuleCrossIcon />
                                      ) : (
                                        <RuleDotIcon />
                                      );
                                      return (
                                        <li
                                          key={r.id}
                                          style={{
                                            display: "inline-flex",
                                            alignItems: "center",
                                            gap: 6,
                                            color,
                                            transition: "color 200ms ease",
                                          }}
                                        >
                                          <span aria-hidden="true">{icon}</span>
                                          <span>{r.label}</span>
                                        </li>
                                      );
                                    })}
                                  </ul>
                                </>
                              ) : null}

                              {/* CONFIRM PASSWORD with separate show/hide */}
                              <label
                                htmlFor={PASSWORD_CONFIRM_FIELD_ID}
                                className="sr-only"
                                style={{
                                  position: "absolute",
                                  width: 1,
                                  height: 1,
                                  padding: 0,
                                  margin: -1,
                                  overflow: "hidden",
                                  clip: "rect(0,0,0,0)",
                                  whiteSpace: "nowrap",
                                  border: 0,
                                }}
                              >
                                Confirm password
                              </label>
                              <div
                                className="auth-input-wrap"
                                style={{ position: "relative" }}
                              >
                                <span
                                  className="auth-input-icon"
                                  aria-hidden="true"
                                  style={{ color: "#7A687D" }}
                                >
                                  <CheckIcon />
                                </span>
                                <input
                                  id={PASSWORD_CONFIRM_FIELD_ID}
                                  name="new-password-confirm"
                                  className="auth-input"
                                  placeholder="Confirm password"
                                  type={showPwd2 ? "text" : "password"}
                                  autoComplete="new-password"
                                  required
                                  value={password2}
                                  onChange={(e) => setPassword2(e.target.value)}
                                  onKeyDown={handleCapsLockKey}
                                  onKeyUp={handleCapsLockKey}
                                  onFocus={() => setPasswordFocused(false)}
                                  aria-invalid={passwordsMismatch}
                                  disabled={busy}
                                  style={{
                                    background: "rgba(255,255,255,0.9)",
                                    border: passwordsMismatch
                                      ? "1px solid rgba(209,67,67,0.6)"
                                      : "1px solid rgba(79,112,107,0.16)",
                                    boxShadow: ui.inputShadow,
                                    color: "#102126",
                                    paddingRight: 44,
                                  }}
                                />
                                <button
                                  type="button"
                                  aria-label={
                                    showPwd2 ? "Hide confirm password" : "Show confirm password"
                                  }
                                  aria-pressed={showPwd2}
                                  onClick={() => setShowPwd2((v) => !v)}
                                  disabled={busy}
                                  style={{
                                    position: "absolute",
                                    right: 10,
                                    top: "50%",
                                    transform: "translateY(-50%)",
                                    width: 28,
                                    height: 28,
                                    display: "inline-flex",
                                    alignItems: "center",
                                    justifyContent: "center",
                                    borderRadius: 8,
                                    border: "1px solid transparent",
                                    background: "transparent",
                                    color: "#446166",
                                    cursor: busy ? "not-allowed" : "pointer",
                                  }}
                                >
                                  {showPwd2 ? <EyeOffIcon /> : <EyeIcon />}
                                </button>
                              </div>
                              {passwordsMismatch ? (
                                <div
                                  role="status"
                                  aria-live="polite"
                                  style={{
                                    fontSize: 12.5,
                                    color: "#B42318",
                                    paddingLeft: 4,
                                  }}
                                >
                                  Passwords do not match.
                                </div>
                              ) : null}

                              <label
                                className="auth-legal-check"
                                style={{
                                  display: "flex",
                                  alignItems: "flex-start",
                                  gap: 12,
                                  padding: "12px 14px",
                                  borderRadius: 16,
                                  background: "rgba(255,255,255,0.34)",
                                  border: "1px solid rgba(79,112,107,0.12)",
                                  boxShadow: "inset 0 1px 0 rgba(255,255,255,0.22)",
                                  fontSize: 14,
                                  lineHeight: 1.75,
                                  color: "#506166",
                                }}
                              >
                                <input
                                  type="checkbox"
                                  checked={acceptLegal}
                                  onChange={(e) => setAcceptLegal(e.target.checked)}
                                  disabled={busy}
                                  className="auth-legal-checkbox"
                                  style={{ accentColor: "#E64880" }}
                                />
                                <span style={{ display: "block", paddingTop: 1 }}>
                                  I agree to the{" "}
                                  <Link
                                    href="/legal/terms"
                                    className="auth-link"
                                    style={{ color: "#D63E76", fontWeight: 600 }}
                                  >
                                    Terms of Service
                                  </Link>
                                  {", "}
                                  <Link
                                    href="/legal/privacy"
                                    className="auth-link"
                                    style={{ color: "#D63E76", fontWeight: 600 }}
                                  >
                                    Privacy Policy
                                  </Link>
                                  {" and "}
                                  <Link
                                    href="/legal/cookies"
                                    className="auth-link"
                                    style={{ color: "#D63E76", fontWeight: 600 }}
                                  >
                                    Cookie Policy
                                  </Link>
                                  .
                                </span>
                              </label>
                              <button
                                className="auth-social-btn"
                                type="submit"
                                disabled={busy}
                                style={{
                                  background:
                                    "linear-gradient(90deg, #E64880 0%, #FF6B6B 52%, #FF8A6A 100%)",
                                  color: "#ffffff",
                                  border: "1px solid rgba(230,72,128,0.45)",
                                  boxShadow: "0 14px 28px rgba(230,72,128,0.22)",
                                  fontWeight: 600,
                                }}
                              >
                                {busy && registerStep > 0 ? (
                                  <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                                    <SpinnerIcon />
                                    Creating account…
                                  </span>
                                ) : (
                                  "Create account with Email"
                                )}
                              </button>
                            </form>

                            {error && (
                              <div
                                className="error-text"
                                role="alert"
                                style={{
                                  color: "#b42318",
                                  background: "rgba(255,255,255,0.52)",
                                  border: "1px solid rgba(180,35,24,0.12)",
                                  borderRadius: 14,
                                  padding: "10px 12px",
                                }}
                              >
                                {error}
                              </div>
                            )}

                            {/* 4-step progress for email-register; for OAuth this falls back to the existing status string. */}
                            {registerStep > 0 ? (
                              <div
                                id={STATUS_LIVE_ID}
                                role="status"
                                aria-live="polite"
                                style={{
                                  background: "rgba(255,255,255,0.42)",
                                  border: "1px solid rgba(79,112,107,0.10)",
                                  borderRadius: 14,
                                  padding: "10px 12px",
                                  color: "#3F5E62",
                                  fontSize: 13,
                                }}
                              >
                                <div
                                  style={{
                                    display: "flex",
                                    alignItems: "center",
                                    gap: 8,
                                    fontWeight: 600,
                                    color: "#23373b",
                                  }}
                                >
                                  <SpinnerIcon />
                                  {REGISTER_STEP_LABELS[registerStep as 1 | 2 | 3 | 4]}
                                </div>
                                <div
                                  aria-hidden="true"
                                  style={{
                                    display: "grid",
                                    gridTemplateColumns: "repeat(4, 1fr)",
                                    gap: 4,
                                    marginTop: 8,
                                  }}
                                >
                                  {[1, 2, 3, 4].map((s) => (
                                    <span
                                      key={s}
                                      style={{
                                        height: 4,
                                        borderRadius: 2,
                                        background:
                                          s <= registerStep
                                            ? "#3F5E62"
                                            : "rgba(86,99,102,0.16)",
                                        transition: "background 240ms ease",
                                      }}
                                    />
                                  ))}
                                </div>
                              </div>
                            ) : status ? (
                              <div
                                id={STATUS_LIVE_ID}
                                role="status"
                                aria-live="polite"
                                className="auth-status"
                                style={{
                                  color: "#496268",
                                  background: "rgba(255,255,255,0.42)",
                                  border: "1px solid rgba(79,112,107,0.10)",
                                  borderRadius: 14,
                                  padding: "10px 12px",
                                }}
                              >
                                {status}
                              </div>
                            ) : null}
                          </div>

                          <div
                            className="auth-switch"
                            style={{
                              marginTop: 18,
                              color: "#617074",
                            }}
                          >
                            <span>{t("login")}? </span>
                            <Link
                              href="/login"
                              style={{ color: "#D63E76", fontWeight: 600 }}
                            >
                              {t("login")}
                            </Link>
                          </div>
                        </>
                      )}
                    </div>
                  </div>

                  {/* Security signals row — factual only, no marketing claims. */}
                  <ul
                    aria-label="Security and privacy commitments"
                    style={{
                      listStyle: "none",
                      padding: 0,
                      margin: "14px auto 0",
                      maxWidth: 540,
                      display: "flex",
                      flexWrap: "wrap",
                      justifyContent: "center",
                      gap: 8,
                      fontSize: 12,
                      color: "#1B1230",
                    }}
                  >
                    {[
                      "TLS Protected",
                      "Privacy-First Design",
                      "GDPR-Aware Data Handling",
                      "No Credit Card Required",
                    ].map((label) => (
                      <li
                        key={label}
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 6,
                          padding: "5px 10px",
                          borderRadius: 999,
                          border: "1px solid rgba(255,255,255,0.32)",
                          background: "rgba(255,255,255,0.16)",
                          backdropFilter: "blur(10px)",
                          WebkitBackdropFilter: "blur(10px)",
                        }}
                      >
                        <span style={{ color: "#E64880" }}>
                          <ShieldCheckIcon />
                        </span>
                        {label}
                      </li>
                    ))}
                  </ul>
                </section>
              </div>
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}
