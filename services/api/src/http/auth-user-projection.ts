/**
 * THE ONLY SHAPE A USER MAY LEAVE THIS SERVER IN.
 *
 * =============================================================================
 * WHAT WENT WRONG
 * =============================================================================
 * Five auth routes ended with some variant of:
 *
 *     return reply.code(200).send({ token, user });
 *
 * where `user` was the row `prisma.user.findFirst` returned. Prisma selects
 * every column when no `select` is given, so the row carried `passwordHash`,
 * and `reply.send` serialises whatever it is handed. A successful login
 * therefore returned the user's scrypt password hash to the client — over the
 * wire, into whatever the client persisted, and into any proxy or log that
 * recorded response bodies.
 *
 * The routes were not careless with a secret; they never mentioned one. The
 * secret arrived because the persistence model was used as the transport
 * model, and nothing stood between the two.
 *
 * =============================================================================
 * WHY AN ALLOW-LIST, AND NOT `delete user.passwordHash`
 * =============================================================================
 * Deleting the field at each send fixes exactly the column someone thought of.
 * The next credential column added to the User model — an MFA secret, a
 * recovery-code digest, a refresh-token hash — would ship to clients the day it
 * was added, silently, through all five routes, and nothing would fail.
 *
 * A deny-list is a list of mistakes already made. This is an allow-list: a
 * field reaches a client because it is named HERE, and a new column is
 * invisible until somebody adds it deliberately. That is the whole security
 * property, and it is why this must not be "simplified" into a spread with
 * omissions later.
 *
 * =============================================================================
 * WHY IT IS EVERY NON-SECRET FIELD, NOT A SMALLER SET
 * =============================================================================
 * The fields below are the ones the response already carried. Narrowing the
 * contract further — dropping SSO or workspace metadata a client may read — is
 * a product decision about the auth contract, not a security fix, and doing it
 * inside a security change would risk breaking sign-in for a reason unrelated
 * to the leak. The security property does not depend on the list being short.
 * It depends on the list being CLOSED.
 *
 * =============================================================================
 * WHAT MUST NEVER BE ADDED HERE
 * =============================================================================
 * Password hashes, password-reset secrets, verification tokens, MFA/TOTP
 * secrets, recovery codes, OAuth provider tokens, refresh-token hashes,
 * session hashes, and API secrets. `assertNoCredentialMaterial` in the test
 * helper enforces this from the outside; if you are here to add one of them,
 * the test is not the thing that is wrong.
 */

/** Every field the auth contract exposes. Structural, so a missing key fails typecheck. */
export type AuthUserProjection = {
  id: string;
  email: string | null;
  displayName: string | null;
  firstName: string | null;
  lastName: string | null;
  avatarUrl: string | null;
  bio: string | null;
  country: string | null;
  locale: string | null;
  timezone: string | null;
  provider: string;
  providerUserId: string | null;
  platformRole: string | null;
  identityMode: string | null;
  managingOrganizationId: string | null;
  managedIdentitySource: string | null;
  managedBySsoConnectionId: string | null;
  organizationVerificationState: string | null;
  currentWorkspaceId: string | null;
  emailVerifiedAt: Date | string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
};

/**
 * The input is deliberately WIDER than the output.
 *
 * It accepts any object carrying at least these fields, which is what a Prisma
 * user row is. Typing the parameter as the Prisma model would make this module
 * depend on the schema and, worse, would make a newly added secret column part
 * of the input type — the projection would still be correct, but the type would
 * stop saying so.
 */
type ProjectableUser = {
  [K in keyof AuthUserProjection]: AuthUserProjection[K];
} & Record<string, unknown>;

/**
 * Build the client-facing user object.
 *
 * Every key is written out. There is no spread and no computed key anywhere in
 * this function, so reading it tells you exactly what a client receives.
 */
export function toAuthUserProjection(user: ProjectableUser): AuthUserProjection {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    firstName: user.firstName,
    lastName: user.lastName,
    avatarUrl: user.avatarUrl,
    bio: user.bio,
    country: user.country,
    locale: user.locale,
    timezone: user.timezone,
    provider: user.provider,
    providerUserId: user.providerUserId,
    platformRole: user.platformRole,
    identityMode: user.identityMode,
    managingOrganizationId: user.managingOrganizationId,
    managedIdentitySource: user.managedIdentitySource,
    managedBySsoConnectionId: user.managedBySsoConnectionId,
    organizationVerificationState: user.organizationVerificationState,
    currentWorkspaceId: user.currentWorkspaceId,
    emailVerifiedAt: user.emailVerifiedAt,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

/**
 * The keys this projection emits, for tests that want to assert the contract
 * did not silently grow. Derived from a real projection rather than typed out
 * again, so the two cannot disagree.
 */
export const AUTH_USER_PROJECTION_KEYS: readonly string[] = Object.keys(
  toAuthUserProjection({
    id: "",
    email: "",
    displayName: null,
    firstName: null,
    lastName: null,
    avatarUrl: null,
    bio: null,
    country: null,
    locale: null,
    timezone: null,
    provider: "",
    providerUserId: null,
    platformRole: null,
    identityMode: null,
    managingOrganizationId: null,
    managedIdentitySource: null,
    managedBySsoConnectionId: null,
    organizationVerificationState: null,
    currentWorkspaceId: null,
    emailVerifiedAt: null,
    createdAt: "",
    updatedAt: "",
  }),
);
