/**
 * The document a refused runbook request receives.
 *
 * Middleware refuses a runbook before the page is composed (401 anonymous,
 * 403 signed in without `RUNBOOKS_VIEW`), so the app shell never renders. The
 * refusal used to be a bare `text/plain` sentence: a browser showed it with no
 * landmark, no heading, no way back and no way to sign in, and the admin
 * matrix recorded every refused role on this route as unrefused.
 *
 * This is a complete, static page. It carries no runbook text — not the
 * title, the summary or the slug — no script, and only inline presentation
 * (the CSP allows inline styles, never inline scripts).
 */

export type RunbookDenial = "UNAUTHENTICATED" | "FORBIDDEN";

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Only a same-origin path may be carried to the sign-in page. */
function safeReturnPath(pathname: string): string {
  return pathname.startsWith("/") && !pathname.startsWith("//") ? pathname : "/";
}

export function runbookDenialHtml(access: RunbookDenial, pathname: string): string {
  const signInHref = `/login?next=${encodeURIComponent(safeReturnPath(pathname))}`;
  const heading = access === "UNAUTHENTICATED" ? "Sign in to read runbooks" : "Platform administrator only";
  const detail =
    access === "UNAUTHENTICATED"
      ? "Runbooks are operator documents. Platform administrator only: sign in with a platform administrator account to continue."
      : "Runbooks are operator documents. Platform admin elevation is required for this surface, and your account does not have it.";
  const action =
    access === "UNAUTHENTICATED"
      ? `<a href="${escapeHtml(signInHref)}" style="${LINK}">Sign in</a>`
      : `<a href="/" style="${LINK}">Back to home</a>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Runbook — access required</title>
</head>
<body style="margin:0;background:#f8fafc;color:#0f172a;font-family:system-ui,-apple-system,'Segoe UI',sans-serif">
<main data-runbook-denied="${access === "UNAUTHENTICATED" ? "unauthenticated" : "forbidden"}" style="box-sizing:border-box;max-width:40rem;margin:0 auto;padding:48px 16px;overflow-wrap:anywhere">
<h1 style="font-size:1.5rem;line-height:1.3;margin:0 0 12px">${escapeHtml(heading)}</h1>
<p style="font-size:1rem;line-height:1.6;margin:0 0 20px">${escapeHtml(detail)}</p>
<p style="margin:0">${action}</p>
</main>
</body>
</html>
`;
}

const LINK =
  "display:inline-block;min-height:44px;line-height:44px;padding:0 16px;border-radius:8px;background:#0f172a;color:#fff;text-decoration:none;font-weight:600";
