/**
 * FIXTURE — mints an extension capture token for a `fex-` user on the LOCAL
 * acceptance stack, exactly as POST /v1/oauth/extension/token would
 * (services/api/src/routes/extension-oauth.routes.ts): same claims, same
 * capture.direct scope, same 1 h TTL, and the session is REGISTERED with
 * recordAuthenticatedSession so requireAuth, revocation and sign-out reach it.
 *
 * Exists ONLY because the running `fa` stack was started without
 * EXTENSION_OAUTH_REDIRECT_ALLOW, so the real authorize step refuses every
 * extension redirect (400 INVALID_CLIENT_OR_REDIRECT, fail closed). Run through
 * `node e2e/acceptance/stack.mjs tsx <this file> --email=fex-...` (fixture env,
 * no .env). Refuses any non-local database and any non-`fex-` user.
 */
import { prisma } from "../../../services/api/src/db.js";
import { signJwt } from "../../../services/api/src/services/jwt.js";
import { recordAuthenticatedSession } from "../../../services/api/src/services/access-control/session-inventory.service.js";
import { EXTENSION_CAPTURE_SCOPE } from "../../../services/api/src/services/auth/extension-scope.js";
import { EXTENSION_ACCESS_TOKEN_TTL_SECONDS } from "../../../services/api/src/services/auth/extension-oauth.service.js";

async function main() {
  const db = new URL(process.env.DATABASE_URL ?? "");
  if (!/^(localhost|127\.0\.0\.1)$/.test(db.hostname)) throw new Error("refusing: database is not local");
  const email = (process.argv.find((a) => a.startsWith("--email=")) ?? "").slice(8).toLowerCase();
  if (!email.startsWith("fex-")) throw new Error("refusing: only fex- users");
  const secret = process.env.AUTH_JWT_SECRET;
  if (!secret || !secret.startsWith("fixture-local-only")) throw new Error("refusing: not the fixture JWT secret");
  const user = await prisma.user.findFirst({ where: { email }, select: { id: true, provider: true, email: true, currentWorkspaceId: true } });
  if (!user) throw new Error(`no user ${email}`);
  const now = Math.floor(Date.now() / 1000);
  const accessToken = signJwt(
    { sub: user.id, provider: user.provider, email: user.email, authMethod: "PASSWORD", authAt: now, scope: EXTENSION_CAPTURE_SCOPE } as never,
    secret,
    EXTENSION_ACCESS_TOKEN_TTL_SECONDS,
  );
  const claims = JSON.parse(Buffer.from(accessToken.split(".")[1]!, "base64url").toString("utf8")) as { sid: string; iat: number; exp: number };
  await recordAuthenticatedSession({
    userId: user.id,
    teamId: user.currentWorkspaceId ?? null,
    sid: claims.sid,
    iat: claims.iat,
    exp: claims.exp,
    ssoConnectionId: null,
    ipPreview: "127.0.0.•••",
    uaPreview: "PROOVRA browser extension · FIXTURE-minted (free-extension acceptance)",
  });
  process.stdout.write(`MINTED ${JSON.stringify({ access_token: accessToken, expires_in: EXTENSION_ACCESS_TOKEN_TTL_SECONDS, account: user.email, sid: claims.sid })}\n`);
  await prisma.$disconnect();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
